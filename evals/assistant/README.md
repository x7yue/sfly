# 助手评测集

回答一个问题：原版 pi 加上 `sfly init` 带的两份 skill，模型能不能自己走完「写节点、单测、本地调试、联调、按失败修」。
以后换模型、升级 pi、改 skill 或命令行，都用它重新测一遍（#443）。

评测完全在容器里进行，判分完全自动、只看结果（单测、看不到的断言、控制面上的运行和节点输出、场景文档），不看助手自己怎么说。

## 前提

- Docker（Linux 或 macOS 的 Docker Desktop），宿主机上有 `python3`（3.10 及以上，只用标准库）和 git（离线包只打包被 git 跟踪的文件）。
- 磁盘：五个镜像约 7 GB（工作台、臂 B 的 pi、加固工作台三个各约 2 GB，共用大部分层），镜像站缓存约 50 MB，每次会话的记录几 MB。
- 三个镜像：
  - 控制面：默认 `ghcr.io/x7yue/sfly-server:0.5.0`。从 GitHub Release 下载 `sfly-server-<版本>-linux-<架构>.tar.gz` 后 `docker load -i`；
    要测当前源码，照下面「从源码构建控制面镜像」构建 `sfly-server:dev`，再 `./aeval.sh up --server-image sfly-server:dev`；
    之后这个槽位的命令（`run`、`seed`、`reset`……）重建控制面时沿用 `up` 时的镜像，
    不用再写（工作台的 `--workbench-image` 一样）。`down` 之后再 `up` 不写就回到默认镜像。
  - PostgreSQL：`postgres:18`。
  - 工作台：`sfly-aeval-workbench:pi-1.6.0`，`up` 发现没有时按 `workbench/Dockerfile` 自动构建
    （国内网络先设 `AEVAL_DEBIAN_MIRROR=http://mirrors.ustc.edu.cn AEVAL_NPM_REGISTRY=https://registry.npmmirror.com`）。
    镜像名里 `pi-` 后面是 pi 的版本：换 pi 的版本就换个镜像名（`--workbench-image sfly-aeval-workbench:pi-<版本>`）。

### 从源码构建控制面镜像

控制面镜像里带着同版本的 Agent（供 `install.sh` 下载），所以先打 Agent 的包、再打控制面、最后构建镜像（在仓库根目录运行）。
Agent 只能在 Linux 上打包。

Linux：

```sh
pnpm pack:agents            # 两个架构的 Agent，放在 out/agent/
pnpm bundle:server          # 控制面、前端和 out/agent/ 里的 Agent，放在 out/server/
docker build -f apps/server/Dockerfile --build-arg NODE_MAJOR="$(cat .node-version)" -t sfly-server:dev out/server
```

macOS：`pnpm pack:agents` 要 `readelf`，本机没有。在 `pnpm linux` 的容器里打包，再把包从它的卷里拷出来：

```sh
pnpm linux pnpm pack:agents     # 第一次要编译几分钟；产物在 docker 卷 sfly-linux 里这个工作区的副本中
id=$(printf '%s' "$PWD" | git hash-object --stdin | cut -c1-12)    # 副本的目录名（scripts/linux/run.sh 这样算）
mkdir -p out/agent
docker run --rm -v sfly-linux:/vol:ro -v "$PWD/out/agent:/out" postgres:18 sh -c "cp /vol/$id/work/out/agent/* /out/"
pnpm bundle:server
docker build -f apps/server/Dockerfile --build-arg NODE_MAJOR="$(cat .node-version)" -t sfly-server:dev out/server
```

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
| `dev` | 开发环境容器（以后的工作台的雏形）：按用户文档 `install.sh --dev` 装的 Agent（`dev-root-dev`，`--dev --name` 起的名字：评测里不走注册，凭据是给这个名字签发的 Agent 凭据）、uv、`sfly` 命令行，加上 git、ripgrep、Node 和锁定版本的 pi |
| `sut` | 被测机：普通的 Agent（`sut-01`），上面常驻一个通用的 HTTP 被测服务（`http://sut:9000`，见 `container/demo_svc.py`） |
| `assistant` | 只有 `up --assistant` 时：平台的助手服务，见下面「平台的助手」 |

两个槽位互不影响，可以同时跑会话；这台机器的内存紧时只用一个。

评测目录不挂进 `dev` 和 `sut`（助手的命令够得着这两台）：里面有参考答案和看不到的断言。
容器里要运行的几个脚本复制到 `/opt/aeval/`，题目的文件在准备初始状态时复制进去，看不到的断言等会话结束、判分时才复制进去。

## 平台的助手（竖切，#543）

上面的评测是单独跑 pi，量的是模型和 skill。这一节起的是平台本身：控制面把会话交给助手服务，助手服务拉起 pi，
pi 的读、写、编辑、命令经 `dev` 上 Agent 的能力端口落到工作台上，过程回到控制面，在浏览器里看得到。

要两个从源码构建的镜像（在仓库根目录运行）：控制面（见上面「从源码构建控制面镜像」，会话模块在 0.5.0 之后），和助手：

```sh
pnpm bundle:assistant
docker build -f apps/assistant/Dockerfile --build-arg NODE_MAJOR="$(cat .node-version)" -t sfly-assistant:dev out/assistant
```

然后一条命令起好（在 `evals/assistant/` 下）：

```sh
./aeval.sh up --server-image sfly-server:dev --assistant                          # 假的模型端点
./aeval.sh up --server-image sfly-server:dev --assistant --assistant-model <模型名>  # 真实模型，经宿主机的转发口
```

- 多一个容器 `sfly-aeval-<槽位>-assistant`（网络别名 `assistant.internal`），助手镜像用 `--assistant-image` 换。
  控制面配上 `SFLY_ASSISTANT_URL`、`SFLY_ASSISTANT_SECRET`；工作台是 `dev` 上的 Agent（`dev-root-dev`），`up` 和 `reset` 在
  两台 Agent 用各自的 Agent 凭据连上来之后，以初始管理员的登录登记它（`PUT /projects/default/workbench`，和部署文档同一个接口，
  #549；控制面里没有指名工作台的环境变量）。共用的密钥每次 `up` 随机生成，只经环境变量带进两个容器，不打印、不写文件。
- `up` 完 Agent 在线、控制面说助手能用（`GET /projects/default/sessions` 的 `readiness.ready`）才结束。
  之后这个槽位的 `reset`、`seed`、`e2e` 重建控制面时照着助手容器接着用（镜像、模型、密钥），`reset` 也重建助手容器
  （上一次的会话和 pi 进程不留下）；`up` 不带 `--assistant` 会删掉以前留下的助手容器。
- **模型**：默认 `fake`，网络里的假的模型端点认出题目（第一句话里有 `tasks/<题目>/prompt.md` 的原文）就照剧本执行这道题的
  参考答案，不花钱，只验证这条路走得通。`--assistant-model` 写模型配置里的名字（见下面「模型」），助手容器挂的模型文件指向
  宿主机的转发口，里面的 `apiKey` 是占位值，凭据由转发口加上：转发口要先起好（Linux 上照「模型」一节监听 docker0 的地址）。
- **浏览器**：打开 `http://127.0.0.1:<18100 + 槽位>`（槽位 1 是 `http://127.0.0.1:18101`）。**建会话要先登录**（#547：会话令牌代发起人干活，
  会话要有发起人的用户）：第一次打开时登录页用初始管理员登录，登录名和密码在 `~/.local/share/sfly/evals/admin-slot<槽位>.txt`
  （`AEVAL_HOME` 改目录；`up` 结束时打印这个路径，只有你能读；每次 `up`、`reset` 密码都换一个，`down` 删掉这个文件，密码不打印到终端）。
  点侧边栏的「助手」（`/sessions`）：上面是助手此刻能不能用，输入框里说一句话就开始一个会话，
  点进一个会话看它的时间线（`/sessions/<ID>`），在做时可以停止。也可以经接口（`POST /projects/default/sessions` 要带登录的 Cookie（`POST /auth/login`）或个人令牌（`POST /account/tokens`），
  不带是 401；`GET /sessions/<ID>`）或下面的 `e2e` 看会话（`e2e` 自己用初始管理员登录）。
  在被测机上起着的被测服务、`seed` 准备好的节点包和场景都照常在。
  用假的模型端点在页面上看各种情况时，第一句话里写 `AEVAL-SCRIPT:<剧本>` 选 `container/` 下的剧本：
  `walkthrough`（带换行和引号的命令、控制字符和颜色码、写读改、被截断的长输出、失败的命令、带 Markdown 的长回复）、
  `walkthrough-stop`（一条 5 分钟的命令，看停止）、`walkthrough-instant`（马上就结束的一轮）、
  `walkthrough-many`（130 步，看到了上限和往前翻页）。剧本按会话的第一句话选，后面的话不换剧本。
- **断网和离线包**：`up --isolated --assistant` 能起（模型只能用 `fake`，假的模型端点在网络里），会话经控制面照常走，
  但断网的网络不映射控制面的端口：宿主机上的浏览器和 `e2e` 都连不到，`e2e` 会直接拒绝；要看只能在 `dev` 里
  `curl http://sfly.internal:8080/…`。离线包（`pack`）不带助手镜像，在不能联网的机器上要另外 `docker save` /
  `docker load` 助手镜像和源码构建的控制面镜像（包里的是默认的发布版控制面，没有会话的接口）。

### 端到端测试

```sh
./aeval.sh e2e           # 默认题目「写」；./aeval.sh e2e <题目>
```

重置环境、准备题目（假的模型端点时把参考答案放进 `dev`），经控制面的接口 `POST /projects/default/sessions` 发这道题的那句话，
跟着 `GET /sessions/:id/events`（SSE）等到这一轮的 `turn_end`，再读一次控制面存下的持久事件（`GET /sessions/:id`），
检查它们依次是 `user_message`、`turn_started`、工具调用和各自的结果、助手的话、`turn_end`（`completed`），之后没有别的，
序号从 1 起不跳号；再用评测的判分给这道题判分。两样都对才通过（退出码 0）。
没等到结局（超过 `--max-seconds`，默认 900 秒；没有事件时按控制面的心跳 15 秒检查一次）时停掉这个会话。
记录在 `~/.local/share/sfly/evals/<日期>-e2e/<题目>-<时间>/`：`events.jsonl`（事件流里收到的，没等到结局时是到那时为止的）、
`persisted.json`（读回的持久事件）、`e2e.json`（会话 ID、检查出的问题、判分、用时）。建会话就被拒（例如工作台不在线时 503）
也写一行原因和 `e2e.json`。
和 `selfcheck` 一样要 Docker、手动跑，不进 `pnpm test`（#552 扩成四道题、进 CI）。会话的工作目录是工作区 `/work`，
题目的节点包在它下面：假的模型端点照 `/tmp/aeval-reference/workdir` 进节点包目录再执行参考答案。

### 平台臂（`--arm p`，#552）

`run` 的第三个臂：题目经控制面的会话接口交给平台内的助手，量的是产品里的那条路。要先 `up --assistant`；断网的槽位也能跑。

```sh
./aeval.sh run --model fake --arm p --task write --task fix --task orchestrate --task cross
./aeval.sh run --fill --model <名字> --arm p --repeat 3 --task write …   # 真实模型：助手容器换成这个模型，经宿主机的转发口
```

- 每次会话：`reset`、准备题目，在镜像站容器（`mirror`，在评测网络里，助手的命令够不着它）里跑
  `container/platform_driver.py`：
  1. 开始前的检查：`GET /projects/default/sessions` 的 `readiness`（控制面可达、助手服务连上了、工作台在线）。
  2. `POST /projects/default/sessions` 发题目的那句话。
  3. 跟着 `GET /sessions/:id/events`（SSE）等到这一轮带序号的 `turn_end`。事件流断了（连接出错、结束了、45 秒没有任何
     字节；控制面每 15 秒发一条 `time` 心跳，即契约里的 `CONTROL_PLANE_TIME_EVENT`，不写进记录）就从最后一个序号之后
     重连，两次重连之间至少隔 1 秒。到了时限（平台的上限再加 60 秒）还没等到才 `stop`，再等 40 秒结局；计时器在建立
     连接之前就开始，在时限那一刻关掉连接，读不会超出时限，这一下也不记成一次断开。写不进自己的事件记录（例如磁盘满了）
     是评测自己的问题，不当成事件流断了，不重连。
  4. 不论结果如何，建了会话就 `POST /sessions/:id/end`，助手服务关掉这个会话的 pi 进程，不靠闲置回收。驱动遇到意外、
     收到 SIGTERM、SIGINT 也照常收尾；宿主机这边被打断或者等过了总的时限，给容器里的驱动发 SIGTERM。

  **登录**（#547：建会话只认用户的凭据，不带是 401）：驱动在第 1 步之前用初始管理员登录
  （`POST /auth/login`，带 `sec-fetch-site: same-origin`，登录名 `aeval_admin`），拿 `sfly_login` Cookie，
  之后的每个请求（检查、建会话、事件流、`stop`、`end`）都带它。会话记在这个用户名下，助手命令里的
  `SFLY_NICKNAME` 是它的**显示名**（带凭据的请求取显示名，没配时是登录名 `aeval_admin`）：控制面起来时
  初始管理员的显示名设成臂 A 的昵称（`SFLY_ADMIN_DISPLAY_NAME=eval`，`aeval/env.py` 的
  `ASSISTANT_NICKNAME`，臂 A 的命令、参考答案、联调的上一次运行、平台臂都引用这一个常量），所以两臂的助手是
  同一个身份：联调副本的名字（「demo 巡检-联调-eval」）、`run show latest` 找自己触发的运行才对得上，真实模型下
  两臂可比（评测自己的操作用 `grader`，分得开）。**密码经过的地方**：密码是 `reset` 建库时
  随机生成的（`stack.admin_password`，也写进只有属主可读的 `~/.local/share/sfly/evals/admin-slot<槽位>.txt`，
  给人登录控制台用）；宿主机起驱动时 `docker exec -e SFLY_ADMIN_PASSWORD`，**参数里只有变量名**，值放在这条
  `docker exec` 进程的环境里（和 `aeval/docker.py` 的 `secret_env` 同一个约定），容器里的驱动从环境变量读；
  它**不进命令行参数、不进 `platform.json`、`driver-stdout.log`、`platform-events.jsonl`**，Cookie 同样：驱动把
  写进记录和标准输出的文字里的密码、Cookie 先换成 `******`（`Client.scrub`；认原文、去掉 `sfly_login=` 的值、
  JSON 转义的写法，**只认完整的出现**，不看开头像不像）。**要截断的文字先打码、后截断**（`Client.clip`，
  #583 的规矩）：回应体、异常文字、断开的原因都是；先截断的话凭据跨过截断点时前半截认不出来（审查查到：登录 401
  留下 32 位密码的前 31 位）。测试：假控制面在各种错误回应里回显它们（包括跨过截断点的 7 处），逐个文件和标准输出
  搜密码、Cookie 的任何 8 个字符的片段（`test_a_credential_across_the_cut_is_masked_first_and_cut_after`、
  `test_neither_the_password_nor_the_cookie_reaches_a_file_or_stdout`）。
  镜像站容器是评测自己的，助手的命令够不着它；密码在它的进程环境里，只有评测自己能读。
  登录失败（没给密码、连不上、401、没拿到 Cookie）是环境故障（`login`），不建会话。
- 记录和臂 A 的同样布局，判分、失败分类、`report` 不分臂：
  - `events.jsonl`、`pi-session/`、`pi-stderr.log`、`context.md` 从助手容器里这个会话的目录复制出来，只复制这几样；
    `turn.json` 带着这一轮的环境变量，不复制。
  - `platform-events.jsonl` 是事件流里收到的每个事件，**原样一行一个**（心跳不记）：除了会话的事件，连上事件流时控制面
    补发的一条 `snapshot`（没有序号，重连每次一条：正在输出的文字、在跑的命令、排位）、一轮结束时平台提交工作区的
    `platform`（`kind: commit`，在 `turn_end` 之前）也在里面，不要把它们当成助手的事件数。**现在的题目里不会有
    `commit` 行**：题目的工作区是会话工作目录 `/work` 里嵌套的 git 仓库（`/work/<包>/`，题目自己 `git init`），外层仓库只
    记这个目录的一个指针，模型改里面的文件，外层的树不变，平台就没有东西可提交（`platform` 行里只有 `run`、`scenario_version`
    这样的）。`platform.json` 是开始前的
    检查、会话 ID、结局、断开的次数和原因、评测有没有停下它、记下的问题和每个问题的种类（`problem_kinds`：控制面回错、
    过了时限、停止之后没有结局、评测自己出错、驱动被结束了、管理员登录失败、建会话时环境没准备好）、用时。
  - `driver.json`：模型调用次数当轮数（臂 A 到上限时也记上限的值）、token 是平台的合计；用时是评测这一侧量的
    （从发出题目到看到结局，不含开始前的检查和结束会话；没等到结局时量到不再等为止），平台结局里的用时另记 `platform_duration_seconds`；工具调用次数从 pi 的原始事件里数。
    **平台臂的用时包含一轮结束时平台提交工作区的时间**（`turn_end` 之前提交，最多 30 秒，没有改动时很快；
    臂 A 没有这一步），所以和臂 A 比用时时平台臂会偏高一点；用时不是判定的三条标准之一，报告里写着口径。
  - pi 的内存峰值：评测在助手容器里每秒读一次所有进程名是 `pi` 的进程（pi 启动时改了自己的进程名）的 `VmHWM`，
    取最大值，不为它改产品；每次会话前助手容器重建，里面只有这一次的 pi。一个都没认出来时记成缺（`null`，`report` 写
    「-」），`pi_processes` 记认出了几个。`session.json` 的 `assistant_pi` 是助手镜像里 pi 的版本（和工作台镜像里的分别固定）。
- 上限是平台自己的（每一轮 40 次模型调用、20 分钟），和评测的默认值一样；`--max-turns`、`--max-seconds` 对平台臂不起作用，
  只提醒。
- 模型：`--model` 和助手容器现在的模型不一样时，这次会话之前的 `reset` 把助手容器换成这个模型（假的模型端点要在 up 时起着）。
- **结局的归类**（`aeval/platform.py` 的 `classify_platform`）：每一种情况明确列出归哪一类，不靠兜底。
  - 环境故障（评测环境的问题）：开始前的检查没过（含管理员登录失败）、会话驱动没给出结果、评测自己出错（驱动的异常、
    写不进自己的事件记录）、驱动被结束了、**建会话被 503 拒绝而原因是环境没准备好**（`model_unavailable`：助手服务说
    模型没配置或连不上；`assistant_not_configured`；`assistant_unavailable` 而说明是助手服务的事件流还没连上——
    检查通过之后环境才变坏的那一瞬）、模型端点的故障。作废（`session.json` 的 `platform_fault` 写明原因），`run` 停下，用 `--fill` 重跑。
  - **平台故障**（检查过了之后平台这一侧出的问题）：建会话被拒（上面环境没准备好的几种除外）或回应不对、平台在自己的上限上没给结局要评测来停（先于
    「驱动被结束了」判）、停止之后没有结局、`stop` 或 `end` 回错、结局是 `failed`、`interrupted`、评测没有让它停而结局是
    `stopped`。**算有效的失败**：判分多一条没过的「平台这一侧没有出问题」，计入平台臂的通过率和判定，主类「平台故障」，
    `report` 单独一张表逐次列出（哪道题、哪次会话、原始的问题文字）。
  - **未归类**：结局不是契约里的值，或者驱动记下了认不出种类的问题。作废，主类「未归类」，`report` 单独一张表列出，判定
    那一行写明「有 N 次会话未归类」并带上「只作参考」：既不藏掉，也不算到平台头上。
  - 其余照常判分：平台自己给出的到上限算「超时」。
- `report` 有平台臂时给出臂 A 对平台臂的判定，三条标准和臂 B 的一样（`aeval/decide.py`），结论是「平台臂没有明显变差」或
  「明显变差」，明显变差时写明其中几次是平台故障；两臂的上限不一样时（臂 A 传了别的 `--max-turns`、`--max-seconds`）判定
  那一行带上「只作参考」，开头按臂写出各自的上限（没记上限的会话不算，例如被宿主机超时结束、没写 `driver.json` 的臂 A 会话）。判定下面说明内存、用时、轮数的口径。

### CI 里的平台臂

```sh
./aeval.sh ci --results <目录>     # 要先 up --assistant
```

平台臂、假的模型端点、五道题各一次（四道原有的题和「常驻」），全部通过才算过（`aeval/ci.py`）。最后不论结果如何都扫一遍结果目录里的凭据
（`aeval/leakscan.py`）：按值认评测知道原值的 secret（每次会话的初始管理员密码、控制面和助手服务共用的密钥），
按格式认令牌（`sfly_ses_` 等前缀加一串令牌字符）和登录 Cookie（`sfly_login=` 加值），只认完整的出现，报文件和种类、不报原值。
退出码：0 通过；4 有题没通过（没通过时 `containers/` 下有控制面、助手服务和镜像站的日志）；5 扫到凭据。

CI 的 `package` job 在构建好控制面和助手镜像之后跑它（`.github/workflows/ci.yml`）：正式的一遍是
`up --offline --isolated`，镜像站只用 Actions 缓存里的数据；缓存没有完全命中时先联网跑一遍把缺的录下来
（只有 `dev`、`main` 上的提交写回缓存）。退出码是 0 或 4 时把结果目录作为产物 `assistant-eval` 上传，5 和别的退出码不上传。
缓存的键按决定下载什么的文件算（见工作流里那一步）：改了别处让环境要下载新东西时，正式的一遍会因为缓存里没有而失败，
镜像站的日志里有没找到的路径，把那个文件加进键里。

### 骨架验收（#553）

`acceptance/accept.sh` 在**正式部署形态**里按 #553「一句话之后的十分钟」逐行核对页面，模型是假的模型端点（不花钱），
结论只说明页面和平台怎么显示，不说明模型做得成。用 `deploy/docker-compose.yml --profile assistant`（和
`scripts/release/compose-smoke.sh` 一样），不是上面评测自己的环境。

先构建三个镜像（在仓库根目录；Agent 的包在 macOS 上照上面「从源码构建控制面镜像」在 `pnpm linux` 里打）：

```sh
pnpm bundle:server && docker build -f apps/server/Dockerfile --build-arg NODE_MAJOR="$(cat .node-version)" -t sfly-server:accept out/server
pnpm bundle:assistant && docker build -f apps/assistant/Dockerfile --build-arg NODE_MAJOR="$(cat .node-version)" -t sfly-assistant:accept out/assistant
docker build -t sfly-workbench:accept deploy/workbench
pnpm heavy bash evals/assistant/acceptance/accept.sh [--project <项目>] [--images <标签>] [--out <目录>] [--keep]
```

- 环境：compose 的三个服务加一个 override（PostgreSQL、假的模型端点、被测机 `sut`：普通 Agent `sut-01` 和
  `container/demo_svc.py`）；开着登录，登记工作台；准备一个编辑者账号（两人交替用），照「编排」那道题的初始状态发布
  `svc-probe`、建「demo 巡检」。
- 剧本：`acceptance/accept-*.json`，和 `fake_model.py` 放在同一个目录里给假的模型端点。剧本的一步可以带 `thinking`
  （先流一段「思考」）和 `thinking_delay`；文字里的 `{last_user}` 换成最近一条用户的话（看插话、接着说送到了没有）。
- 浏览器：Playwright 官方镜像（和 e2e 同一个版本）在这套环境的网络里跑 `acceptance/acceptance.spec.ts`。用例要停掉、
  重启容器时在控制目录里写请求，`accept.sh` 在后台照做。
- 结果（默认 `~/.local/share/sfly/evals/<日期>-accept/<时间>/`）：`summary.md`（每行 通过/失败、说明、证据）、
  `results.jsonl`、`shots/`、`samples/`、各个日志。结束前按值搜管理员和编辑者的密码、Agent 凭据、助手的共享密钥，按格式搜会话令牌、
  个人令牌、登录 Cookie；搜到就删掉这次的结果，以退出码 2 结束。全部通过退出码 0，有行没过 1。
- `--project`：项目内的接口（登记工作台、就绪、建会话）都用它；第二个项目要等 #499、#796，现在只在默认项目跑通。
- CI 的 `package` job 在 compose 冒烟之后用同一套 `:smoke` 镜像跑它（`--images smoke`），在上面的平台臂之前。

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

**已知边界**（五道题共用）：判分在开发环境容器里跑，助手在那里是 root，判分不防故意改判分用到的工具（`sfly`、`uv`、`pytest`）或者伪造痕迹的模型。
判分尽量看判分自己跑出来的结果（重新触发的运行、自己跑的测试）；「常驻」的第 1 个目标（替身起着时调试到两个商品）是唯一只看助手留下的记录（`.sfly/runs/`）判的。
真实模型的会话里发现这样做的，这次会话记作废，开 issue。

### 失败分类

没通过的会话按事件流、退出原因和控制面上的运行自动归类（`aeval/classify.py`），取第一个命中的：
平台故障（只有平台臂，见上面「平台臂」）、超时、上下文耗尽、工具调用格式错、编辑替换失败、等待时重复触发运行、读不懂错误、认不出的错误（模型调用以别的错误结束，例如 400，不记到模型头上，要人看）、其他。各类信号的次数也都记下来。

**作废**：会话**因为**模型端点的故障（平台臂还有评测环境的故障，见上面「平台臂」）没能做完才作废（`session.json` 里 `invalid` 为 true）：pi 的自动重试用尽了，或者最后一次模型调用以端点错误结束。端点错误是连不上、连接中途断开、请求超时、401/402/403（鉴权、额度）、408、429、5xx。
作废时 `run` 停下不再跑后面的会话（不会把剩下的计划一次次跑空），`report` 不把它算进结果、但按臂列出作废的次数和原因。中途出过端点错误、pi 重试成功的会话照常算，记下重试了几次。
分类是启发式的，结论里引用前要打开会话记录核对。

## 题目

| id | 类别 | 给助手的话 | 判分 |
|---|---|---|---|
| `write` | 写 | 按一段需求写统计日志级别的节点和单测，`sfly debug` 跑通 | 单测、看不到的断言、判分自己跑 `sfly debug` 的输出 |
| `fix` | 修 | 联调副本最近一次运行失败了，修好节点让它跑通 | 看不到的断言、重新运行联调副本的输出；不许改坏场景、不许降低检查标准 |
| `orchestrate` | 编排 | 在场景里加一步，在另一台 Agent 上读被测机的日志，保持原有说明 | 新节点的类型、输入、执行的 Agent、位置、显示名称，重新运行的输出；原有说明和注释框、文档警告 |
| `cross` | 跨机器 | 写一个经 Agent 能力读另一台机器上日志的节点，加进联调副本跑通 | 单测、看不到的断言、联调副本里的新节点、重新运行的输出 |
| `daemon` | 常驻 | 起库存服务的本地替身，对它 `sfly debug` 两次；写一个自己起替身、用完关掉的集成测试 | 两次调试运行的输入和输出（替身起着才拿得到）；判分把集成测试跑两遍：没有服务起着时通过、结束后替身不在，替身起不来时不通过；不许改节点、替身和原有单测 |

题目内容都是通用的被测服务（HTTP 服务、日志文件），给助手的话在 `tasks/<id>/prompt.md`。

「常驻」量的是平台上「命令结束时它起的进程被结束」的代价（ADR 0019，`remote-tools/README.md` 第 12、13 条）：前四道题都不需要
常驻进程，#539 第 11 题在已有的会话里数到跨两次命令依赖后台进程的是 0 处。一次工具调用里把替身放到后台、下一次调试它，
平台臂上连不上（臂 A 上连得上）；参考答案把起替身和调试写在同一条命令里，平台臂上也能过。判分的检查项由
`aeval/tasks/daemon.py` 的 `checks_from` 从看到的结果算出，参考答案满分、什么都不做零分有单测（`tests/test_daemon.py`）。

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
./aeval.sh rpcprobe                  # 不花钱：第 1–17 题全部跑一遍，写 rpcprobe.md、rpcprobe.json
./aeval.sh rpcprobe --assistant-image sfly-assistant:dev   # 从哪个助手镜像取产品的扩展（不给时用这个槽位的助手容器用的）
./aeval.sh rpcprobe q6 q7            # 只跑这几题
./aeval.sh bgcheck <结果目录>…        # 不调模型：已有的会话记录里，跨两次命令依赖后台进程的有几处
```

`rpcprobe` 用助手服务（#540）那条 pi 启动命令（RPC 模式、`--no-extensions -e` 远程工具扩展、`--no-skills --skill`、
`--no-context-files --append-system-prompt`、`--session-dir --session-id`……），在单独的探针容器
（`sfly-aeval-<槽位>-rpcprobe`，工作台镜像，每次重建）里照问题做实验。**远程工具扩展是产品里的那一份**（#552 起）：
从助手镜像里取 `dist/extension.mjs`（建一个不运行的容器复制出来，不起助手服务），配置照产品的做法，
`SFLY_ASSISTANT_TURN_CONFIG` 指向这一轮的配置文件（工作台的地址、工作区、命令的环境变量、默认超时）；以前用的是评测集
臂 B 的原型扩展。所以要先从源码构建助手镜像（见「平台的助手」）。实验的内容：工具是否都落到能力端口、只加载给的扩展、
系统提示里只有给的东西、会话恢复、kill -9 之后再起、abort 和 steer 的时机、关 stdin 和 SIGTERM 的收场、内存和启动时间、
扩展改系统提示里的工作目录。模型是探针容器里的假的模型端点（照 `container/rpcprobe-*.json` 的剧本，存下每个请求），
工作台上的命令什么时候消失由开发环境容器里的采样量（每 0.2 秒一次）。第 1 题的对照是臂 A：宿主机先在开发环境里用
原版 pi（工具在本地执行）跑同一个工具自检的剧本。**只有后台进程那两步（`bash_background_alive`、`bash_setsid_alive`）
允许和臂 A 不一样**，而且要是写明的样子：不报错、输出里有 `dead`（命令退出之后它起的后台进程被结束，
`remote-tools/README.md`「本地和远程的语义差别」第 12、13 条）；别的每一步，含工具自检里没有预期的另外 5 个后台进程的步骤，
都要和臂 A 逐字相同。
第 9 题另外在助手镜像（Node 的 slim 镜像，只有助手服务、pi 和扩展）上试一次：用镜像里的 pi 和扩展跑一轮。断网的环境里也能跑（`up --offline --isolated`）。
升级 pi 之后重跑它，对照上一次的结论。容器里那一半在 `container/rpcprobe_run.py`，结论在 `aeval/rpcprobe.py` 里算。

判定写的是现在的预期行为，行为变了结论就变：第 5、6、8 题工作台上的命令结束之前在跑、之后不在了才算消失，
一直在是「不成立」，结束之前一次都没采到是「没跑完」（分不清「已经消失」和「没采到」）；第 6 题这一轮要被中止
（`agent_settled` 的 `aborted`、命令结果 `Command aborted`），之后同一个进程再发一轮要照常做完；第 7 题 `steering`
变空、并且随后这句插话作为用户消息出现才算送出（`clear_queue` 之后 `steering` 也会变空）；第 8 题一轮进行中关 stdin、
关 stdin 同时发 SIGTERM、只发 SIGTERM 三种都分出「中止」和「等做完」，预期是中止、10 秒内退出、会话文件最后一行完整；
第 4 题每次起 pi 会话里多一条 role=system 的消息。发给模型的请求没存下来时判「没跑完」，不判「不成立」。
原始采样复制到结果目录的 `rpcprobe-watch.log`。

**量的是哪一份扩展、哪一版 pi**：扩展取自哪个助手镜像由 `--assistant-image` 定；不给时用这个槽位的助手容器用的镜像；
两样都没有就报错，**不退到默认标签**（默认标签可能是几天前构建的旧镜像，量到的是旧扩展，结论照出）。
`rpcprobe.md` 开头和 `rpcprobe.json` 的 `versions` 记下：助手镜像的名字、ID、构建时间，`extension.mjs` 的 sha256
（结果目录里也留着这份文件），助手镜像里 pi 的版本，探针容器里 pi 和 Node 的版本。
探针里各题跑的是**工作台镜像里的 `pi`**（第 9 题 slim 镜像那一半除外），产品跑的是助手镜像 `node_modules` 下的 pi，
两边分别固定，现在都是 1.6.0；版本不一样时报告里有一条「提醒」：结论量的是探针里那一版，不是产品的，
把两边升到同一版之后重跑。

**和产品起 pi 的差别**（现在不影响结论，记在这里）：
- 环境变量：产品给每个 pi 进程一个自己的设置目录（`HOME`、`PI_CODING_AGENT_DIR` 都指它）和一个自己的临时目录（`TMPDIR`），
  探针里 `HOME` 是 `/root`、没有 `TMPDIR`；
- 用户：产品的助手容器里是 `node`，探针容器里是 root；
- 配置里的 `secrets` 在探针里是空的，扩展按值打码的那条路没有走到（那一半由 `apps/assistant` 自己的测试守着）；
- pi 的二进制和 Node 是上面说的两个镜像各自的那一份。

各题共用一个探针容器，不是完全独立的（用原型扩展时，前面的题把工作台上的 AGENTS.md、skill 镜像到了探针容器本地，
单独跑第 10 题时系统提示里没有那几行 `<location>`；产品的扩展不在本地写文件，没有这个问题）。第 10 题只说明系统提示里写的工作目录能改；要去掉助手服务「两边路径相同」的要求，
还得先解决 skill 的位置（`<location>` 仍是本机 `--skill` 的路径，判定把它滤掉了）和工具的工作目录（没测）。第 9 题的内存是用假的模型端点、很短的一轮量的，是下限。
`tests/fixtures/rpcprobe/` 的夹具：第 1、3、9 题是 2026-11-27 在 dev 源码构建的助手镜像上实跑的输出（第 1 题只留了工具结果
和系统提示的工具清单，长输出截短了），其余是之前用原型扩展时的（判法没有变）。

**换成产品扩展之后重跑 17 题（2026-11-25，pi 1.6.0，假的模型端点）**：结论都没变。说法和数字变了的几处：
- 第 1 题：对照换成了臂 A。有预期的 12 步逐字相同；后台进程那两步（`bash_background_alive`、`bash_setsid_alive`）是已知差别。
  系统提示的工具清单现在是全的（原型扩展替换的工具没有带说明，清单里只有 `bash`）。
- 第 3 题：少了「扩展自己加进来的：工作台上的 AGENTS.md、工作台上的 skill」，产品的扩展本来就不做这件事
  （工作区的 AGENTS.md 由模型自己读，skill 用平台自带的）。
- 第 8 题：第一次是「没跑完」，最后一种做法（只发 SIGTERM）0.017 秒退出、这题马上做完，工作台上还没来得及采样；
  做完之后加了 1 秒等待，重跑是「成立」。
- 第 9 题：带产品扩展的 pi，空闲常驻 140.7–140.9 MiB、一轮的峰值 161.9–162.5 MiB（原型扩展时 116.4–117.3 和 135.1–136.3），
  从启动到回应第一条命令 0.19–0.30 秒（原来 0.85–2.0 秒）；助手镜像上能跑，镜像 568 MiB。第 3 题测不出来的一处：设置目录和项目 `.pi/` 里的 `APPEND_SYSTEM.md` 连对照组里也没出现，看起来是被
`--append-system-prompt` 盖掉了；不传这个参数时它们会不会进系统提示，这里没有证据。

**在 dev 源码构建的助手镜像上重跑第 1、3、9 题（2026-11-27，pi 1.6.0，Node v26.13.1，假的模型端点）**：结论没变
（成立、部分成立、成立）。
- 第 1 题：除已知的 2 步外，17 步的工具结果和臂 A 逐字相同（上面「有预期的 12 步」是当时的比法：另外 5 个后台进程的步骤那时只记录、
  不比，现在也比）；已知的 2 步是写明的样子（不报错、输出里有 `dead`）。
- 第 3 题：现在判成预期：产品的扩展不改系统提示，工作台上的 AGENTS.md、skill 的记号出现在系统提示里就是「不成立」
  （设置目录里放 SYSTEM.md 和不放两条路径都看）；这次没有出现，仍是「部分成立」（原因和以前一样：`--append-system-prompt`
  那一条，见上）。
- 第 9 题：空闲常驻 141.4–141.7 MiB，一轮的峰值 161.6–163.4 MiB，从启动到回应第一条命令 0.162–0.167 秒（3 次）；助手镜像上能跑，
  镜像 569 MiB。和 2026-11-25 那次（141 / 162 MiB）一致，根目录 `README.md` 里的容量说明不用改。

### 544-B 先测的七题（第 11 到 17 题）

「可以打断助手」的协议（`packages/schema/src/assistant-protocol.ts` 的文件头）里标了「544-B 先测」的七条，助手服务照协议实现之前
在这里各做一题。和前十题同一个探针容器、同一条 pi 启动命令；假的模型端点为它们多了三样：一段文字分成几段、每段隔一会儿流出来
（`pieces`、`interval`，测输出到一半时中止），报一个接近上限的用量（`prompt_tokens`），回「上下文超长」的 400 并在 pi 请求摘要时
回一段带记号的摘要（剧本 `rpcprobe-compact.json`、`rpcprobe-threshold.json`）。第 16 题多加载一个把以 `AEVAL-HANDLE` 开头的输入
「处理掉」的扩展（`container/rpcprobe-handled.ts`）。`tests/fixtures/rpcprobe/q11.json`–`q17.json` 是 2026-11-24 一次实跑的输出
（pi 1.6.0，长的文字截短了，第 12、13 题的请求只留了用户消息）。

| # | 协议里要先测的 | 结论 |
|---|---|---|
| 11 | 模型输出到一半时 `abort`，之后同一个进程再发一轮照常做（「`abort` 之后进程留着」的前提） | 成立：收到 5 段输出之后 `abort`，十几毫秒回应、`agent_settled`（aborted），这条助手消息以 aborted 结束、留着半截文字；同一个进程再发一轮照常做完，发给模型的请求里没有那条半截的助手消息（两条用户消息连着） |
| 12 | `abort` 紧跟在 `clear_queue` 后面写出时，没有插话漏出去 | 成立：12 遍（一句和两句；命令执行中十遍，两条命令在同一次写里、接连两次写各一半；模型输出到一半时两遍），`clear_queue` 都取回了全部插话、先于 `abort` 回应；之后这一轮没有带着它们请求模型，会话里、同一个进程的下一轮的请求里都没有 |
| 13 | `steer` 的回应还没回来时 `clear_queue` 已经写出：这句话会不会在清空之后才进队列、留到下一轮；「下一轮交 `prompt` 之前再 `clear_queue` 一次」兜不兜得住 | 成立，兜得住：命令执行中，`steer` 和 `clear_queue`、`abort` 在同一次写里或者隔 0–2 毫秒时，这句话在清空之后才进队列，`abort` 收尾时 pi 把它放进了对话（一条用户消息，在 `agent_settled` 之前，没有再请求模型），按「出现用户消息就算送到」记，和会话里一致（下一轮的请求里它是历史的一部分）；模型输出到一半、同一次写时，它留在 pi 的队列里，下一轮之前的 `clear_queue` 取回了它，下一轮的请求里没有；隔 5 毫秒时 `clear_queue` 取回了它。35 遍里没有「漏」 |
| 14 | 一次全送的模式：连着发的几句是不是一次送完 | 成立：`set_steering_mode all` 之后，命令执行中连着发的两句在命令的结果之后的同一次请求里送到。另外看到：这个版本的 pi 默认就是 `all`（`get_state` 报的、对照组的表现都是），协议里「pi 默认是每完成一次助手回复送一句」和这个版本不符；助手服务照样显式设成 `all` |
| 15 | 两句连发是不是各一条用户消息 | 成立：两句不同、两句相同都是事件里各一条 `message_end`（role=user），请求里也是两条 |
| 16 | `handled` 的实际表现 | 成立：被扩展的输入处理器吃掉的一句，`steer` 回应成功、`disposition` 是 `handled`，不进队列（`queue_update` 里没有）、没有用户消息、不送到模型；普通的一句是 `queued`。没有一轮在做时 `steer` 也回 `queued` |
| 17 | 一轮里除了这一轮的 `prompt`，pi 产生的 role=user 的消息都是插话（含压缩上下文） | 成立：没有压缩、中途上下文超长（压缩之后重试）、收尾时到了阈值压缩三种，这一轮的用户消息都只有这一轮的 `prompt` 和那句插话；压缩的摘要不作为用户消息出现 |

和协议的写法不一样、但不影响做法的两处：第 13 题里命令执行中的那种去处（清空之后才进队列的话在 `abort` 收尾时成了这一轮的用户消息，
不是留在队列里），协议的「算送到」那一条把它说成「在 pi 处理 `clear_queue` 之前才送到的」，实际是之后，按顺序认「送到」的记法
照样对；第 14 题 pi 的默认模式。

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
