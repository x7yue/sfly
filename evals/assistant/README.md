# 助手评测集

回答一个问题：原版 pi 加上 `sfly init` 带的两份 skill，模型能不能自己走完「写节点、单测、本地调试、联调、按失败修」。
以后换模型、升级 pi、改 skill 或命令行，都用它重新测一遍（#443）。

评测完全在容器里进行，判分完全自动、只看结果（单测、看不到的断言、控制面上的运行和节点输出、场景文档），不看助手自己怎么说。

## 前提

- Docker（Linux 或 macOS 的 Docker Desktop），宿主机上有 `python3`（3.10 及以上，只用标准库）和 git（离线包只打包被 git 跟踪的文件）。
- 磁盘：五个镜像约 7 GB（工作台、臂 B 的 pi、加固工作台三个各约 2 GB，共用大部分层），镜像站缓存约 50 MB，每次会话的记录几 MB。
- 三个镜像：
  - 控制面：默认 `ghcr.io/x7yue/sfly-server:0.5.0`。从 GitHub Release 下载 `sfly-server-<版本>-linux-<架构>.tar.gz` 后 `docker load -i`；
    要测当前源码，先 `pnpm bundle:server && pnpm pack:agents`，再
    `docker build -f apps/server/Dockerfile --build-arg NODE_MAJOR="$(cat .node-version)" -t sfly-server:dev out/server`，
    之后每条命令加 `--server-image sfly-server:dev`。
  - PostgreSQL：`postgres:18`。
  - 工作台：`sfly-aeval-workbench:pi-1.6.0`，`up` 发现没有时按 `workbench/Dockerfile` 自动构建
    （国内网络先设 `AEVAL_DEBIAN_MIRROR=http://mirrors.ustc.edu.cn AEVAL_NPM_REGISTRY=https://registry.npmmirror.com`）。
    镜像名里 `pi-` 后面是 pi 的版本：换 pi 的版本就换个镜像名（`--workbench-image sfly-aeval-workbench:pi-<版本>`）。

下面的命令都在 `evals/assistant/` 下运行。

## 起环境

```sh
./aeval.sh up            # 第一次要下载 uv 和 PyPI 包，两三分钟；之后每次重置约 5 秒
./aeval.sh down          # 删掉这套环境的全部容器、网络和卷
```

一套环境（一个「槽位」，`--slot N`，默认 1）是五个容器，名字都以 `sfly-aeval-<槽位>-` 开头：

| 容器 | 作用 |
|---|---|
| `mirror` | 镜像站：PyPI 和 GitHub Release，缺的文件从中科大镜像取并缓存在 `~/.local/share/sfly/evals/mirror-cache/`，控制面把它下发给 Agent 和 `sfly init` |
| `pg` | PostgreSQL，数据在内存里 |
| `cp` | 控制面，HTTP 映射到宿主机 `127.0.0.1:<18100 + 槽位>`，可以在浏览器里看 |
| `dev` | 开发环境容器（以后的工作台的雏形）：按用户文档 `install.sh --dev` 装的 Agent（`dev-root-dev`）、uv、`sfly` 命令行，加上 git、ripgrep、Node 和锁定版本的 pi |
| `sut` | 被测机：普通的 Agent（`sut-01`），上面常驻一个通用的 HTTP 被测服务（`http://sut:9000`，见 `container/demo_svc.py`） |

两个槽位互不影响，可以同时跑会话；这台机器的内存紧时只用一个。

评测目录不挂进 `dev` 和 `sut`（助手的命令够得着这两台）：里面有参考答案和看不到的断言。
容器里要运行的几个脚本复制到 `/opt/aeval/`，题目的文件在准备初始状态时复制进去，看不到的断言等会话结束、判分时才复制进去。

## 模型

容器里的 pi 不拿密钥。它指向一个模型地址（模型配置里的 `endpoint`），凭据由宿主机上的转发口在转发时加上：

```sh
HTTPS_PROXY=http://127.0.0.1:7890 python3 -m aeval.model_proxy --port 18900   # 上游要经代理时设 HTTPS_PROXY
```

转发口要在整轮评测期间一直运行（例如 `nohup … &`）；每次会话开始前会先确认连得上模型端点。

容器里访问宿主机用的是 `host.docker.internal`（`--add-host host.docker.internal:host-gateway`）。macOS 的 Docker Desktop 上它连得到宿主机的 127.0.0.1，转发口默认就监听这里。
**Linux 上**它指向 docker0 网桥的地址（通常是 172.17.0.1），监听 127.0.0.1 的转发口连不到：用 `--host <docker0 的地址>` 启动转发口（`ip -4 addr show docker0` 查）。
不要监听 `0.0.0.0`：转发口带着凭据、不验调用方，只该让本机的容器连到。它只转发调模型的接口（`chat/completions`、`responses`、`messages`、`models`），别的路径一律 403。

转发口在进程内读 pi 自己的配置（`~/.pi/agent/models.json` 的 `apiKey`、`auth.json`），按路径的第一段转发到同名的提供方：
`http://host.docker.internal:18900/<提供方>/…` → 该提供方的 `baseUrl/…`。凭据不打印、不写日志、不写文件；容器里的 pi 配置的是占位值。

### 加一个模型

模型配置是一个 JSON 文件，放在仓库之外（仓库是公开的，不放端点地址和账户名）：环境变量 `AEVAL_MODELS` 指定的文件，没有时用 `~/.local/share/sfly/evals/models.json`，都没有时用仓库里的示例 `models.example.json`（格式照它写）。假的模型端点 `fake` 是内置的。

在配置的 `models` 里加一项，键是评测里用的名字：

| 字段 | 含义 |
|---|---|
| `tier` | 档次，写进结果表（例如「上限」「内网能部署（27B 开放权重）」） |
| `api` | pi 的接口类型：`openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai` |
| `endpoint` | 容器里访问模型的地址：转发口（`http://host.docker.internal:18900/<pi 里的提供方名>`），或内网的模型服务 |
| `model` | 发给模型服务的模型 id |
| `contextWindow`、`maxTokens` | 上下文窗口和最大输出 token，写进 pi 的配置，也写进结果表 |
| `reasoning`、`thinking`、`thinkingLevelMap` | 是否是推理模型、用哪个思考强度、pi 的思考强度到这个模型的取值（同 pi 的 models.json） |
| `compat` | pi 的兼容开关（同 pi 的 models.json），只按验证过的差异开 |
| `toolCalls` | 是否支持工具调用（只记录） |

内网的模型服务不需要转发口：`endpoint` 直接写它的地址。要带凭据时在内网另起一个同样的转发口（`--pi-dir` 指向一份只放这个提供方的配置）。

## 跑一道题

```sh
./aeval.sh run --task write --model gpt-5.6-sol                       # 跑一次
./aeval.sh run --task write --task fix --model a --model b --repeat 3  # 每个模型、每道题各 3 次
```

每次会话：重置环境 → 准备这道题的初始状态 → 在开发环境容器里以 JSON 模式运行 pi（`--approve` 让它加载节点包目录里的两份 skill）→ 判分 → 保存记录。
上限默认 40 轮、20 分钟（`--max-turns`、`--max-seconds`），到了就停；`--budget`（默认 40）是这一条命令最多跑多少次会话，计划超过它就不开始。
加 `--fill` 时 `--repeat` 是目标次数：结果目录里已有的有效会话算进去，只跑缺的。模型端点出故障停下之后，重跑同一条命令接着跑。
`--cap a=37 --cap b=35` 按臂限制会话总数：结果目录里这一臂已有的会话（作废的也算）到了上限就不再跑这一臂，每跑一次之前都查。
给了几个臂时，同一道题的同一次重复两臂挨着跑（A、B、A、B……），上游的状态变化不会集中落在某一臂上。

每次重置会重启开发环境容器和被测机：上一次会话里助手起的后台进程不会留到下一次，`/tmp` 清空。家目录里 Agent、uv、sfly 之外的文件不清（uv 的缓存要留着）。

### 一个新模型要跑的全部会话

```sh
./aeval.sh campaign --model <名字>      # 结果在 ~/.local/share/sfly/evals/<日期>-<名字>/
```

依次是：第一轮（每道题 3 次，臂 A）；对照实验（每道题臂 A、臂 B 各 5 次，两臂交替，臂 A 沿用第一轮的）。
最后打印汇总表、过线检查（「写」「修」前 3 次各 ≥2 次、到 5 次时各 ≥4 次）和对照实验的判定。
臂 A、臂 B 各有 40 次的上限（`--budget`、`--budget-b`），按结果目录里已有的会话（作废的也算）每跑一次之前检查。中途停下后重跑同一条命令，从停下的地方接着跑。

调题目时可以分开做：

```sh
./aeval.sh seed fix        # 重置并准备初始状态
./aeval.sh reference fix   # 应用参考答案
./aeval.sh grade fix       # 判分（打印每一项检查）
./aeval.sh selfcheck       # 判分自检：每道题「什么都不做」0 分、「参考答案」满分、「参考答案之后改坏一处原有内容」0 分
```

## 看结果

结果在 `~/.local/share/sfly/evals/<日期>/`（`--results` 改），不进仓库。每次会话一个目录：

| 文件 | 内容 |
|---|---|
| `session.json` | 题目、模型、臂、判分（每一项检查）、轮数、用时、token、pi 的内存峰值、失败分类、是否作废和原因、端点重试次数、uv/Python/ruff 的版本 |
| `events.jsonl` | pi 的完整事件流 |
| `pi-session/` | pi 自己的会话文件，可以 `pi --session <文件>` 打开回看 |
| `workspace.diff` | 节点包目录相对初始状态的改动 |
| `runs.json` | 控制面上的运行：谁触发的（助手的运行记成「经 pi」）、状态、起止时间、失败的节点 |

```sh
./aeval.sh report ~/.local/share/sfly/evals/2026-11-21   # 汇总成 Markdown 表格
```

汇总有：按（模型、题目、臂）的通过次数和各项中位数；作废的次数和原因、有效会话里的端点重试次数；每个模型的过线检查；有臂 B 的模型的对照实验判定。

### 判分

每道题的检查分三类：

- **目标**：题目要求的结果（单测、看不到的断言、判分自己重新触发的运行成功且节点输出等于期望值）。什么都不做时全部不通过。
- **不许破坏**：原有的节点（输入、显示名称、备注、执行的 Agent）、默认 Agent、注释框，原场景，原有的单测（不能删、不能跳过），场景文档检查没有警告。破坏了整题 0 分。
- **只记录**：例如是否自己跑过 `sfly debug`、新节点是否写了备注，不计分。

得分是通过的目标占全部目标的比例（破坏了就是 0）；全部通过才算这道题通过。

### 失败分类

没通过的会话按事件流、退出原因和控制面上的运行自动归类（`aeval/classify.py`），取第一个命中的：
超时、上下文耗尽、工具调用格式错、编辑替换失败、等待时重复触发运行、读不懂错误、认不出的错误（模型调用以别的错误结束，例如 400，不记到模型头上，要人看）、其他。各类信号的次数也都记下来。

**作废**：会话**因为**模型端点的故障没能做完才作废（`session.json` 里 `invalid` 为 true）：pi 的自动重试用尽了，或者最后一次模型调用以端点错误结束。端点错误是连不上、连接中途断开、请求超时、401/402/403（鉴权、额度）、408、429、5xx。
作废时 `run` 停下不再跑后面的会话（不会把剩下的计划一次次跑空），`report` 不把它算进结果、但按臂列出作废的次数和原因。中途出过端点错误、pi 重试成功的会话照常算，记下重试了几次。
分类是启发式的，结论里引用前要打开会话记录核对。

## 题目

| id | 类别 | 给助手的话 | 判分 |
|---|---|---|---|
| `write` | 写 | 按一段需求写统计日志级别的节点和单测，`sfly debug` 跑通 | 单测、看不到的断言、判分自己跑 `sfly debug` 的输出 |
| `fix` | 修 | 联调副本最近一次运行失败了，修好节点让它跑通 | 看不到的断言、重新运行联调副本的输出；不许改坏场景、不许降低检查标准 |
| `orchestrate` | 编排 | 在场景里加一步，在另一台 Agent 上读被测机的日志，保持原有说明 | 新节点的类型、输入、执行的 Agent、位置、显示名称，重新运行的输出；原有说明和注释框、文档警告 |
| `cross` | 跨机器 | 写一个经 Agent 能力读另一台机器上日志的节点，加进联调副本跑通 | 单测、看不到的断言、联调副本里的新节点、重新运行的输出 |

题目内容都是通用的被测服务（HTTP 服务、日志文件），给助手的话在 `tasks/<id>/prompt.md`。

### 加一道题

1. 在 `tasks/<id>/` 下放：`prompt.md`（给助手的一句话，像用户会说的那样）、题目要用的文件（节点包源码 `package/src`、`package/tests`，日志等）、
   `hidden/test_hidden.py`（助手看不到的断言，按节点名找节点，见已有的题）、`reference/solve.sh`（参考答案，在节点包目录里运行）。
2. 在 `aeval/tasks/` 下写一个 `Task` 子类：`seed`（初始状态，可以用 `init_package`、`publish`、`create_scenario`）和 `grade`（返回检查项），在 `aeval/tasks/registry.py` 登记。
   `files` 里列出这道题用到的文件和目录（相对 `tasks/`）：只能用列出的，单测检查它们都被 git 跟踪（`*.log` 这类会被 `.gitignore` 挡掉）。
   `apply_breakage` 给一个「做完了但改坏了一处原有内容」的答案。
3. `./aeval.sh selfcheck <id>`：「什么都不做」必须 0 分，「参考答案」必须满分，「破坏了原有内容」必须 0 分。
4. 题目的文件只在需要时复制进容器（初始状态、判分），不放进助手够得着的容器；复制进去的脚本过禁用词检查（`tests/test_assistant_files.py`）。

## 对照实验：pi 的循环跑在哪

#442 里唯一没定的一处由对照实验决定（#443 的追加评论）：

- **臂 A**：pi 在开发环境容器里，工具在本地执行（上面的做法，`--arm a`，默认）；
- **臂 B**：pi 在单独的 `pi` 容器里，本地没有工作区，读、写、编辑、命令四个工具经扩展落到开发环境里 Agent 的能力端口（`--arm b`）。
  扩展和本地、远程的语义差别见 [remote-tools/README.md](remote-tools/README.md)。

```sh
./aeval.sh toolcheck                                          # 不花钱：假的模型端点照剧本调用四个工具，两臂逐步对比
./aeval.sh run --fill --task write --task fix --task orchestrate --task cross \
    --model <名字> --arm a --arm b --repeat 5                   # 两臂各 5 次
./aeval.sh report <结果目录>                                   # 汇总表按臂分开，最后是判定
```

判定照事先定下的标准算（`aeval/decide.py`）：臂 B 同时满足「通过的会话数比臂 A 少不超过 1」「轮数中位数不超过臂 A 的 1.3 倍」
「没有只在臂 B 出现两次以上的失败类型」就选方案甲（单独的助手容器加远程工具），否则选方案乙（循环就在工作台里）。
边界上恰好少 1、恰好 1.3 倍算满足，恰好 2 次算「两次以上」。两臂每道题的有效会话数不一样时不给判定；不到四道题各 5 次时标明只作参考；
两臂作废的次数相差悬殊时提醒；判为方案乙时提示 #443 里的前提（越权探测发现的问题要先证明堵得住）；最后列出对臂 B 有利的已知差别。
`toolcheck` 还核对两臂的系统提示里都有开发环境里的 skill 和 `AGENTS.md`。

另外两项测量：

```sh
./aeval.sh memory --model <名字>     # pi 的 RPC 进程空闲和处理一轮提示时的常驻内存
./aeval.sh probe --model <名字>      # 「循环在工作台里」的配置下，模型能不能改 pi 的设置和会话文件、读到令牌
./aeval.sh probe --model fake        # 同上，照剧本把每件事都试一遍：看配置允许什么，不看模型愿不愿意做
```

`probe` 的配置见 `hardened/` 和 `aeval/probe.py`：pi 以单独的用户运行；设置目录对 pi 可写（pi 要在里面建锁，目录整体只读时 pi 起不来），
加粘滞位，里面原有的文件归 root、对 pi 只读；不信任项目；skill 用只读副本；模型的命令经 pi 的 `shellPath` 以另一个用户、清空的环境执行；
pi 进程的环境里放一个每次随机生成的假令牌。每一项的结果只有三种：做得到、做不到（实际试了并失败）、没测（没去试）。

照剧本（`probe --model fake`）试出来的，这套加固配置下：

| 堵住了 | 没堵住 |
|---|---|
| 改 pi 的设置文件 `settings.json`、模型配置 `models.json`（文件归 root） | 在设置目录里**新建**文件：`extensions/*.ts`（**下一次会话 pi 会自动加载并执行它**，实测加载了）、`AGENTS.md`（进系统提示）、`trust.json` |
| 改 skill 的只读副本 | pi 自己的读工具读 `/proc/self/environ`，拿到 pi 进程环境里的令牌 |
| 模型的命令（另一个用户）进 pi 的家目录、读 pi 进程的环境 | pi 自己的写、编辑工具改 pi 自己的文件（它们在 pi 进程里执行，身份是 pi，不经过 `shellPath`） |

会话文件：默认工具列不出目录、命令进不了 pi 的家目录，所以找不到它的文件名，照剧本那次没去改它（记为「没测」）；pi 的编辑工具对同样归 pi 的文件是改得了的。

## 探针：助手服务的启动参数（#539）

```sh
./aeval.sh rpcprobe                  # 不花钱：第 1–10 题全部跑一遍，写 rpcprobe.md、rpcprobe.json
./aeval.sh rpcprobe q6 q7            # 只跑这几题
./aeval.sh bgcheck <结果目录>…        # 不调模型：已有的会话记录里，跨两次命令依赖后台进程的有几处
```

`rpcprobe` 用助手服务（#540）那条 pi 启动命令（RPC 模式、`--no-extensions -e` 远程工具扩展、`--no-skills --skill`、
`--no-context-files --append-system-prompt`、`--session-dir --session-id`……），在单独的探针容器
（`sfly-aeval-<槽位>-rpcprobe`，臂 B 的镜像，每次重建）里照问题做实验：工具是否都落到能力端口、只加载给的扩展、
系统提示里只有给的东西、会话恢复、kill -9 之后再起、abort 和 steer 的时机、关 stdin 和 SIGTERM 的收场、内存和启动时间、
扩展改系统提示里的工作目录。模型是探针容器里的假的模型端点（照 `container/rpcprobe-*.json` 的剧本，存下每个请求），
工作台上的命令什么时候消失由开发环境容器里的采样量（每 0.2 秒一次）。第 9 题另外在 Node 26 的 slim 镜像上试一次
（要先 `docker pull node:26-trixie-slim`，没有时只记下没测，结论不受影响）。断网的环境里也能跑（`up --offline --isolated`）。
升级 pi 之后重跑它，对照上一次的结论。容器里那一半在 `container/rpcprobe_run.py`，结论在 `aeval/rpcprobe.py` 里算。

判定写的是现在的预期行为，行为变了结论就变：第 5、6、8 题工作台上的命令结束之前在跑、之后不在了才算消失，
一直在是「不成立」，结束之前一次都没采到是「没跑完」（分不清「已经消失」和「没采到」）；第 6 题这一轮要被中止
（`agent_settled` 的 `aborted`、命令结果 `Command aborted`），之后同一个进程再发一轮要照常做完；第 7 题 `steering`
变空、并且随后这句插话作为用户消息出现才算送出（`clear_queue` 之后 `steering` 也会变空）；第 8 题一轮进行中关 stdin、
关 stdin 同时发 SIGTERM、只发 SIGTERM 三种都分出「中止」和「等做完」，预期是中止、10 秒内退出、会话文件最后一行完整；
第 4 题每次起 pi 会话里多一条 role=system 的消息。发给模型的请求没存下来时判「没跑完」，不判「不成立」。
原始采样复制到结果目录的 `rpcprobe-watch.log`。

各题共用一个探针容器，不是完全独立的：前面的题把工作台上的 AGENTS.md、skill 镜像到了探针容器本地，所以单独跑第 10 题时
系统提示里没有那几行 `<location>`，和整套跑时不一样。第 10 题只说明系统提示里写的工作目录能改；要去掉助手服务「两边路径相同」的要求，
还得先解决 skill 的位置（`<location>` 仍是本机 `--skill` 的路径，判定把它滤掉了）和工具的工作目录（没测）。第 9 题的内存是用假的模型端点、很短的一轮量的，是下限。
`tests/fixtures/rpcprobe/` 的夹具是同一次整套实跑的输出（第 1 题只留了工具结果，长输出截短了），第 8 题是之后单独重跑的
（加了对会话文件整行判断的 `session_tool_result`）。第 3 题测不出来的一处：设置目录和项目 `.pi/` 里的 `APPEND_SYSTEM.md` 连对照组里也没出现，看起来是被
`--append-system-prompt` 盖掉了；不传这个参数时它们会不会进系统提示，这里没有证据。

`bgcheck` 找「一次命令里把进程放到后台，之后另一次工具调用连它的端口或读它的输出文件」，按题目、臂、档次计数，
每一处列出前后各一步的命令。同一次命令里起后台进程又测它的不算；假的模型端点和作废的会话不算。
它是启发式的，会漏，也会误报：起服务的命令里没写端口的（`python3 -m http.server &` 之后连 `:8000`、`npm run dev &`
之后连 `:3000`）、之后用 `pkill`、`ps` 按名字找它的、`docker run -d` 起的都认不出来；URL 引号里的 `&` 会被当成放到后台。
所以输出里列出每一条起后台进程的命令，拿它数的时候要人工看一遍。

## 离线包

在联网的环境里，先把每道题至少跑过一遍（`selfcheck` 就行），镜像站的缓存才是全的；再打包：

```sh
./aeval.sh pack ~/.local/share/sfly/evals/offline   # 生成 sfly-aeval-offline-<时间>.tar，约 750 MB
```

包里有五个镜像（`images.tar`：控制面、PostgreSQL、工作台、臂 B 的 pi、`probe` 用的加固工作台）、这个评测目录（`evals/`）、镜像站的缓存（`mirror-cache/`）和 `MANIFEST.json`。在不能联网的机器上：

```sh
tar -xf sfly-aeval-offline-*.tar && cd sfly-aeval-offline-*
docker load -i images.tar
evals/aeval.sh up --offline --cache "$PWD/mirror-cache"     # 镜像站只用缓存
# 或者用内网已有的镜像：--pypi-mirror <地址> --github-mirror <地址>
（在 ~/.local/share/sfly/evals/models.json 里写上内网的模型，见上面「加一个模型」）
evals/aeval.sh campaign --model <内网模型>     # 第一轮、过线补跑、对照实验，见上面「一个新模型要跑的全部会话」
evals/aeval.sh report ~/.local/share/sfly/evals/<日期>-<内网模型>
```

验证离线包本身能用（不需要模型）：`up --offline --isolated` 把容器放进不通外网、也到不了宿主机的网络，并在网络里起一个假的模型端点（`container/fake_model.py`，照剧本执行参考答案），然后 `run --model fake --arm a --arm b`：两臂每道题都应该通过；`toolcheck` 两臂逐步一致。

## 维护

- 判分的纯逻辑（汇总规则、失败分类、`sfly debug` 输出的解析、会话驱动、转发口、假的模型端点、对照实验的判定、题目文件都被 git 跟踪、助手容器里的文件没有提示）有单元测试，在 `tests/` 下，几秒钟，不依赖 Docker 和网络。
  随 `pnpm test:py` 运行；单独跑用 `uv run --locked pytest evals/assistant`（`conftest.py` 不收集 `tasks/` 下题目里的节点包测试，它们要在那个包的 venv 里跑）。
  要起容器的判分自检是 `./aeval.sh selfcheck`，改了题目或判分时手动跑。两者分开，是为了不让 `pnpm test` 依赖 Docker 和网络。
- 工作台、臂 B 的 pi、加固工作台三个镜像带着源文件的内容哈希（标签 `sfly.aeval.source`），改了 Dockerfile 或扩展会自动重新构建。
- 这个目录不会进发布物：控制面的单文件和镜像只打包 `apps/server`，SDK 的 wheel 只打包 `sdk/python`。
- `tasks/` 下的节点包源码属于各自的节点包，`tasks/ruff.toml` 按节点包里的规则排 import。
