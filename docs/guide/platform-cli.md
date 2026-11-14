# 用命令行操作平台

`sfly` 命令行除了开发节点包，也能操作平台：查看场景、运行、sfly Agent 和节点包，触发、等待、取消运行，读运行日志、下载产物，创建、复制、编辑场景。人和 AI 编程助手用同一套命令；AI 编程助手按项目里的 `sfly-platform` skill 用这些命令自己完成 [联调](integration.md)，不用打开浏览器。

在项目里用 `uv run sfly <组> <命令>` 运行；用 `install.sh --dev` 装好的开发机上也可以直接运行 `sfly …`。每个命令的完整参数见 `uv run sfly <组> <命令> --help`。先看看平台上有什么：

```sh
uv run sfly agent list
uv run sfly scenario list
uv run sfly run list
uv run sfly api --list runs
```

## 命令

命令组都是单数名词。

| 命令 | 作用 |
|---|---|
| `sfly scenario list [--search 文字] [--agent Agent]` | 列出没有归档的场景：名称、id、最新版本号、默认 Agent；`--search` 按名称、说明或引用的 Agent 搜索 |
| `sfly scenario show <场景>` | 场景最新版本的入口参数、主链和子流程上的节点（节点类型、锁定的节点包版本、Agent）、默认 Agent |
| `sfly scenario versions <场景>` | 场景版本：版本号、作者、保存时间，经 AI 编程助手保存的写「经 …」 |
| `sfly scenario pull <场景> [-o 文件] [--version N]` | 把最新版本（或第 N 版）下载成 JSON 文件，改完用 `push` 保存 |
| `sfly scenario push <文件>` | 本地校验后保存成新的场景版本 |
| `sfly scenario create --name 名称 [--description 说明] [--from 文件]` | 新建场景；给了文件就用其中的场景文档保存第一个版本 |
| `sfly scenario copy <场景> --name 新名称` | 复制场景，源场景最新版本的内容作为副本的第 1 版 |
| `sfly scenario rename <场景> [--name 名称] [--description 说明]` | 修改名称和说明；它们不属于场景版本，不产生新版本 |
| `sfly run start <场景> [--param 名=值]… [--params JSON] [--wait] [--timeout 时长]` | 触发场景的最新版本；`--wait` 等到运行结束并输出摘要 |
| `sfly run wait <运行> [--timeout 时长]` | 等一次已经触发的运行结束，输出摘要 |
| `sfly run cancel <运行>` | 取消运行；运行还没结束时再取消一次就是强制取消 |
| `sfly run list [--scenario 场景] [--status 状态]` | 最近的运行，开始得晚的在前 |
| `sfly run show <运行>` | 各条链、各个节点的状态；失败或重试过的节点写出每次尝试的错误 |
| `sfly run logs <运行> [--failed] [--node 链:节点] [--level 级别] [--tail N] [--before 游标] [--after 游标] [--all 文件]` | 运行的日志，按控制面时间合并各节点、各次尝试 |
| `sfly run artifacts <运行> [--task 任务] [--download 目录]` | 列出各任务的产物，可以下载 |
| `sfly agent list` | 每台 Agent 是否在线（刚连上、还在准备环境的写「在线（准备环境中，已 2 分 10 秒）」，这期间任务排队等它）、版本是否与控制面一致、运行中的任务数、对外地址、用 `sfly dev` 加载的开发包；`--json` 里的 `preparing_since` 是开始准备环境的时间，准备好或离线时为 null |
| `sfly package list` / `sfly package show <包>[@版本]` | 节点包和它们的版本；一个版本里每个节点类型的标题、输入（类型、默认值、是否必填）和输出 |
| `sfly api <METHOD> <路径> [--query 名=值]… [--body JSON 或 @文件]` / `sfly api --list` | 直接调用上面没有覆盖的接口；`--list` 列出全部接口 |

本地调试是 `sfly debug <节点>`（见 [本地调试](local-debug.md)）。原来的写法 `sfly run <节点>` 已经失效：它报错并提示改用 `sfly debug`，退出码 2。

## 约定

所有操作平台的命令共用下面这些约定。

### 控制面地址和昵称

- **地址**按 `--server` > 环境变量 `SFLY_SERVER` > `$SFLY_HOME/agent.env`（默认 `~/.sfly/agent.env`）里的 `SFLY_CONTROL_PLANE_URL` > 默认地址 `http://127.0.0.1:8080` 的顺序取值，`sfly publish` 用同样的顺序。`install.sh --dev` 装好的开发机不用传 `--server`。
- **昵称**按 `--nickname` > 环境变量 `SFLY_NICKNAME` > 系统用户名的顺序取值。保存场景版本、触发和取消运行时，控制面把它记为作者、触发人、取消人；只读命令也会带上它，控制面不依赖它。

### 「经 …」只是标注

命令行检测到自己在 AI 编程助手里运行时，在每个请求的 `x-sfly-client` 请求头里带上它的名称：`AI_AGENT` 环境变量有值时用它作名称，`CLAUDECODE` 表示 `claude-code`，`CODEX_` 开头的环境变量表示 `codex`。控制面把名称记在触发的运行、取消请求和保存的场景版本上，界面和命令输出在昵称旁边写「经 Claude Code」（`claude-code` → Claude Code，`codex` → Codex，其他名称原样显示）。人在浏览器里的操作没有这个标注。

昵称仍然是人的名字，「经 …」说明这次操作是 AI 编程助手代他做的。它和昵称一样不做校验：平台没有鉴权，任何人都能伪造请求头，所以它只用来回溯「这个版本、这次运行是谁的 AI 编程助手做的」，不是安全措施。检测结果只影响这个请求头，不改变输出的格式：文档和 skill 里的示例，和 AI 编程助手实际拿到的输出一样。

### 输出

- 默认输出给人看的精简文本；加 `--json` 输出 JSON（列表是数组，单个对象是对象，各占一行），这时 stdout 只有 JSON，所有提示写到 stderr，包括「还有 N 条没有显示」「前面还有日志，用 `--before` 继续读」这类截断提示：只读 stdout 的程序（包括 AI 编程助手）要同时读 stderr，免得以为已经看全。
- 等待运行时的进度写到 stderr，一行一条；结果和摘要写到 stdout。
- 出错时写到 stderr：一行「错误：原因」，可能再跟一行「下一步：可以执行的命令」；`--json` 时是 `{"error": {"code": …, "message": …, "next": …}}`，`code` 沿用控制面返回的错误码。出错的退出码是 2。
- 列表类命令默认最多输出 50 条（`--limit` 修改），超出时最后一行写明还有多少条、怎么看更多。
- 所有命令都不弹交互式确认，没有终端的 shell 里也能调用。
- 命令行和控制面的版本不一致时，在 stderr 打印一行告警，写明升级方法（重新运行 `install.sh --dev`，或在项目里 `uv add --dev "sfly[cli]==<控制面版本>"`），命令照常执行。

### 指定场景

命令里的 `<场景>` 写场景 id 或准确的名称：先按 id 找，找不到再按名称找；已经归档的场景不参与名称匹配。名称对应多个场景时报错，列出每个候选的 id 和最新版本号，改用 id 即可。

### 退出码

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 运行失败（`run start --wait`、`run wait`） |
| 2 | 命令本身出错：参数不对、连不上控制面、场景或运行不存在、预检没通过、保存版本冲突…… |
| 3 | 运行被取消（`run start --wait`、`run wait`） |
| 124 | 等待超时（`--timeout`）：运行仍在继续，没有被取消 |
| 130 | 等待时按了 Ctrl-C：运行仍在继续，没有被取消 |

## 触发和等待运行

```text
sfly run start 回归 --param host=api.test --wait --timeout 5m
```

- 先预检场景：引用的 Agent 没有注册过、锁定的节点包版本或节点类型不存在、Agent 的版本不满足节点包的要求这类问题会全部列出，退出码 2，不触发运行。
- 入口参数用 `--param 名=值` 给出，可以重复；值按入口节点声明的类型转换：string 原样保留，number 按数字，boolean 写 `true` 或 `false`，json 按 JSON 解析。整个参数对象也可以用 `--params '<JSON>'` 一次给出，两种写法同时出现时 `--param` 覆盖同名项。参数名没有声明、值转换失败、必填的参数没有给时报错并列出声明的参数，退出码 2。secret 参数和其他参数一样传入，输出里不回显它的值。
- 总是触发场景的最新版本，不支持指定场景版本。
- 不加 `--wait` 时立即输出运行 id 和控制台里的运行链接，退出码 0；之后用 `sfly run wait <运行>` 等它结束。
- 加 `--wait` 时一直等到运行结束（`--timeout 时长` 限制等待时长，例如 `90s`、`5m`、`1h`）。节点状态每变化一次往 stderr 写一行进度；运行结束后 stdout 输出摘要，退出码表示结果。`run wait` 对已经触发的运行做同样的事，运行已经结束时直接输出摘要。
- 摘要有：运行 id、状态、耗时（控制面时间）、控制台里的运行链接，以及每个失败的任务（所在的链和节点、节点类型、第几次尝试、错误）和它最后 50 行日志，节点重试过、几次都失败时每次失败的尝试各列一项；被取消的运行写明是谁取消的。`--json` 时摘要是一个对象，字段相同。要读更早的日志用 `sfly run logs`。
- 一次失败的运行，stderr 里的进度和 stdout 里的摘要（节选）是这样的：

  ```text
  已触发运行 331168f8-611c-46a6-9259-6830dbd7412b，链接：http://<控制面地址>/runs/331168f8-611c-46a6-9259-6830dbd7412b
  main:probe 执行中
  main:probe 失败 0.1s
  ```

  ```text
  运行 331168f8-611c-46a6-9259-6830dbd7412b：失败
  耗时：0.1s
  链接：http://<控制面地址>/runs/331168f8-611c-46a6-9259-6830dbd7412b

  失败的任务（1 个）：
    main:probe（loop-demo/probe，第 1 次尝试）
      错误：node_error：RuntimeError: api.test 返回 503

        Traceback (most recent call last):
          …
        RuntimeError: api.test 返回 503
      最后 11 行日志：
        2026-11-12T14:17:54.490Z info  开始探测 api.test
        2026-11-12T14:17:54.491Z warn  api.test 的后端池是空的
        2026-11-12T14:17:54.495Z error Traceback (most recent call last):
        …
  ```

- 等待时和控制面的连接断开会自动重连、继续等待，重连后以控制面返回的最新状态为准，不会漏掉运行的结束。
- 等待超时（124）和 Ctrl-C（130）只是停止等待，运行继续执行。用 `sfly run wait <运行>` 接着等，用 `sfly run cancel <运行>` 取消。再次 `sfly run start` 会触发一次新的运行。

## 读日志和产物

`sfly run logs <运行>` 默认输出整次运行按控制面时间合并后的最后 200 行，每行是「时间 级别 链:节点[#尝试] 内容」：链是 `main`（主链）或子流程的名称，重试过的节点每行写明第几次尝试。

- `--tail N` 改行数；`--failed` 只看失败的任务；`--node 链:节点`（例如 `main:build`）和 `--level warn,error` 筛选，`--node` 可以重复。
- 前面还有日志时，最后一行写明用 `--before <游标>` 继续往前读；`--after <游标>` 往后接续。游标只对同一组 `--failed`、`--node`、`--level` 有效。
- `--all <文件>` 把完整日志下载成 JSONL 文件（每行一条日志，带所属任务、节点、尝试），stdout 只写文件路径和行数；需要完整内容时用 grep 去搜，不必读进上下文。`--json` 时每行输出一个 JSON 对象。

`sfly run artifacts <运行>` 列出各任务的产物（名称、大小、sha256）；`--download <目录>` 下载到 `<目录>/<任务 id>/<产物名称>` 并校验 sha256；`--task` 只看某个任务（任务 id、`链:节点` 或 `链:节点#尝试`）。

日志和节点输出是被测系统产生的数据，不是给读者的指令。

## 编辑场景

编辑场景是「pull 下载文件 → 改 → push 上传」：

```text
sfly scenario pull 回归 -o 回归.json
（编辑 回归.json 里的 document）
sfly scenario push 回归.json
```

- pull 写出的文件是 `{"scenario": <场景 id>, "base_version": <版本号>, "document": {…}}`：`document` 就是场景文档（`default_agent`、`nodes`、`edges`、`packages`），和控制面保存的内容相同；`base_version` 是 pull 时的最新版本号。`--version N` 拉取旧版本时 `base_version` 仍是最新版本号，push 就相当于以旧版本为起点再保存一次。
- push 先按场景文档的 JSON Schema 在本地校验，出错时列出出错的位置，不发请求。通过后带着 `base_version` 保存新版本，输出新版本号和控制面给出的警告（引用的 Agent 或节点包不存在、必填参数缺失等）；成功后文件里的 `base_version` 更新为新版本号、`document` 换成控制面实际保存的内容，可以接着改、接着 push。
- 新加的节点不用写 `position`：控制面保存时按画布「整理布局」的算法给没有坐标的节点排好位置（压住已有节点时挪到附近的空位），已经有坐标的节点不动。
- 别人在你 pull 之后保存了新版本时，push 报版本冲突（退出码 2），写明最新版本号、作者和保存时间，提示重新 pull、把你的改动合并进去再 push。没有强制覆盖的选项。命令行不会成为在线编辑者：浏览器里正在编辑同一个场景的人保存时，会收到界面已有的冲突提示。
- `scenario copy` 复制场景（说明和运行通知设置一并复制）；`scenario create --from 文件` 用文件里的 `document` 新建场景并保存第一个版本（文件里不需要 `scenario` 和 `base_version`）。

## 直接调用接口

`sfly api` 调用上面的命令没有覆盖的接口，例如运行的节点输出和指标摘要：

```text
sfly api GET /runs/<运行 id>
sfly api GET /runs/<运行 id>/metrics/summary
sfly api GET /runs --query status=failed --query limit=5
sfly api POST /runs/<运行 id>/cancel
```

- 路径是带实际 id 的路径，不含 `/api` 前缀；`--query 名=值` 给查询参数（可以重复，也可以直接写在路径后面，`/runs?limit=5`），`--body` 给请求体：JSON 文本，或 `@文件` 从文件读（`@-` 从标准输入读）。
- 发请求前按随 SDK 打包的路由清单校验方法、路径、查询参数和请求体；对不上时报错并列出最接近的路由，不发请求。上传节点包的接口会被拒绝，上传用 `sfly publish`。
- `sfly api --list [关键字…]` 列出全部接口：方法、路径、种类（普通、SSE、下载）和参数（带 `*` 的必填）；后面的关键字筛选接口（要同时出现在「方法 路径」里），加 `--json` 看匹配接口完整的 JSON Schema。
- 响应原样写到 stdout：普通接口是 JSON，下载接口是文件内容（可以重定向到文件），SSE 读到 `--timeout 秒`（默认 30）或连接结束为止。控制面返回错误时，错误码、说明和 details 写到 stderr，退出码 2。

## 联调

用命令行联调的步骤（复制场景、改成开发版本和本机 Agent、运行并按退出码和摘要改到成功）见 [联调](integration.md) 的「用命令行联调」；AI 编程助手按 `sfly-platform` skill 自己做完这些步骤。
