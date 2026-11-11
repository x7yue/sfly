---
name: verify-sfly
description: 像用户一样驱动真实的 sfly 来证明改动有效。启动一套独立环境：独立 PostgreSQL 库、从源码运行并托管刚构建前端的控制面、一个真实 Rust Agent，再用 agent-browser 操作 Web 控制台（场景编排画布、运行抽屉、运行记录、Agent 管理、节点包管理、开发文档），用 sfly CLI 发布节点包。改了前端、控制面、Agent 或 SDK，需要在真实应用里拿到证据而不是只跑测试时使用。
---

# 验证 sfly

sfly 的主界面是浏览器里的 Web 控制台，由控制面在同一个 HTTP 端口上托管：页面在 `/`，API 和 SSE 在 `/api/*`。节点包用 CLI `sfly publish` 发布。节点在真实 Agent 上执行，Agent 用 gRPC 连到控制面。其它入口：`sfly` CLI（`build`、`publish`、`init`、`dev`）和 Agent 自己的命令行。

e2e 测试（`apps/web/e2e`）用的是假 Agent 和手动时钟。这个 skill 走全真路径：全部是真实进程，用真实时间，节点包也真实安装。

脚本在 `.claude/skills/verify-sfly/scripts/`，下文写成 `$V`：

```sh
V=.claude/skills/verify-sfly/scripts   # 在仓库根目录
```

## 启动

```sh
$V/up.sh            # 先重新构建前端、SDK wheel 和 debug 版 Agent（增量构建，几秒到一分钟）
$V/up.sh --no-build # 确定构建产物已是当前代码时才用
```

`up.sh` 做这些事：
1. 在 `DATABASE_URL` 指向的服务器上建一个空库 `sfly_verify_<随机>`（本机默认用 docker 容器 `sfly-pg`，`postgres://sfly:sfly@127.0.0.1:5432/sfly`）。
2. 用 `pnpm --filter @sfly/server start` 从源码启动控制面，只监听 127.0.0.1，HTTP 和 gRPC 都用随机空闲端口，数据目录是独立的。启动时自动执行迁移。
3. 启动 `target/debug/sfly-agent`，名字 `verify-agent`，4 个槽位，`SFLY_HOME`、venv、工作目录都是独立的，用 PATH 上的 `uv`。它从空 venv 开始，从控制面下载同版本的 SDK 运行时。

就绪的标准是这三条都满足：控制面日志打出 `sfly control plane <版本>: http <地址>`；`/api/health` 返回 `"database":"ok"`；Agent 的标准输出出现 `{"event":"welcome"}`。成功时最后一行打印 `RUN=<运行目录>`，`$SFLY_VERIFY_ROOT/current`（默认 `~/.local/state/sfly-verify/current`）指向这个目录。后面的命令都从这里读环境信息：

```sh
source ~/.local/state/sfly-verify/current/state.env   # HTTP_URL GRPC_URL DB AGENT_NAME BROWSER_SESSION RUN …
```

可以同时开好几套，互不干扰：库名、端口、目录和浏览器会话各自独立。不要去操作开发者自己的实例（8080 / 50051 / 3000 端口），也不要操作 `~/.sfly`。

种子数据：发布桩节点包 `sfly-stub@0.1.0`（`testdata/stub-package`，节点有回显 `echo`、失败 `fail`、等待 `sleep`、多路日志 `chatter`、产物 `artifacts` 等）。用的是用户的发布路径，也就是 CLI：

```sh
$V/publish-stub.sh                       # 输出写到 evidence/publish-stub-package.txt
$V/publish-stub.sh "" testdata/short-package
```

## 体检

不确定环境是否可用时先跑，只读：

```sh
$V/doctor.sh [运行目录]
```

它检查：两个进程组都还活着；HTTP 端口确实是这套环境的控制面在监听；健康检查通过；`verify-agent` 在线，并且 Agent 版本和控制面版本都等于工作区 `apps/server/package.json` 的版本。版本不一致的 Agent 不会被派任务。有一项失败就不要继续操作，先 `down.sh` 再重新 `up.sh`。

## 驱动

浏览器用 agent-browser，每套环境用自己的会话：

```sh
S="--session $BROWSER_SESSION"
agent-browser $S set viewport 1440 900
agent-browser $S open "$HTTP_URL/orchestrations"
agent-browser $S snapshot -i -c                        # 可交互元素和 @ref
agent-browser $S find role button click --name "新建场景"
agent-browser $S fill @e42 "验证回显"                   # @ref 来自最近一次 snapshot
agent-browser $S select @e70 "verify-agent"
agent-browser $S screenshot "$RUN/evidence/<序号>-<步骤>.png"
```

- 定位元素优先用可访问名称（中文 ARIA 名称和按钮文字）。这些名称和 e2e 用例共用，比较稳定。每条用户路径的具体选择器见 `features/`。
- 首次打开页面会弹「欢迎使用 sfly」，让你填昵称：`open` 返回时对话框可能还没渲染出来，要先 `snapshot -i -c` 看到 `textbox "昵称"` 再填，然后点 `开始使用`。对话框关闭有动画，`sleep 1` 之后再点别的，否则会报 covered。
- `find` 只支持 `click`、`fill`、`check`、`hover`、`text` 这几个动作。下拉框要先 `snapshot` 取 `@ref`，再用 `agent-browser $S select @eN "<选项文字>"`。
- `@ref` 只在页面变化之前有效，变化后要重新 `snapshot`。
- 有些状态只出现在抽屉或弹出层里，`snapshot -c` 的文字里不一定有。等运行结束时轮询 API，再截图作为界面证据：

```sh
curl -s "$HTTP_URL/api/runs" | python3 -c 'import json,sys; print([(r["id"],r["status"]) for r in json.load(sys.stdin)["runs"]])'
curl -s "$HTTP_URL/api/runs/<运行ID>"   # 各链、各节点的 status 和 outputs
curl -s "$HTTP_URL/api/agents"          # 在线状态、agent_version、installed_packages
```

浏览器只走 `/api/*`。Agent 和 CLI 用根路径上的同一套 API，比如 `sfly publish` 调的是 `POST /packages`。

## 证据

证据都放在 `$RUN/evidence/`，清理后保留：
- `logs/server.log`：控制面日志；`logs/agent.jsonl`：Agent 事件流；`logs/agent.stderr.log`：Agent 日志。
- 截图：每个关键操作截一张，按 `<序号>-<步骤>.png` 命名，操作之前和操作之后的状态都要拍。
- 副作用的只读第二视角，比如 `curl … > $RUN/evidence/run.json`、`agents.json`。

证明的标准：
- 走真实的用户路径：在页面上点按钮，发布节点包用 `sfly publish`。不要直接调 API 写数据来代替用户操作。API 只用来读取，作为第二视角。
- 同时证明操作本身和操作后的状态。例如「触发运行」要拍到抽屉里的「成功」，还要用 `/api/runs/<id>` 看到节点的 `outputs`。
- 证明副作用：Agent 的 `installed_packages` 里出现了节点包；任务日志和产物出现在运行详情里；场景的版本号增加了。
- 不 mock：控制面、Agent 和数据库都是真实的。节点包依赖走 uv 的真实来源，没有网络时会以 `env_error` 失败，这本身就是如实的结果。

## 清理

```sh
$V/down.sh [运行目录]
```

它只杀 `state.env` 里记录的两个进程组，不按进程名杀；同时关闭这套环境的浏览器会话，删除 `sfly_verify_*` 库、数据目录和 Agent 目录（venv、任务工作目录），保留 `evidence/` 和 `state.env`。重复运行也安全。每次失败的尝试之后也要运行它，免得留下占着端口的进程。旧的证据目录在 `~/.local/state/sfly-verify/` 下，需要时手动删除。

## 辅助脚本

| 命令 | 作用 |
|---|---|
| `$V/up.sh [--no-build]` | 构建并启动一套独立环境，打印 `RUN=` |
| `$V/doctor.sh [运行目录]` | 只读体检，退出码 0 表示可以驱动 |
| `$V/publish-stub.sh [运行目录] [项目目录]` | 用 `sfly publish` 发布节点包（默认 `testdata/stub-package`） |
| `$V/down.sh [运行目录]` | 清理，保留证据 |

本机注意：`/tmp` 是 3.6G 的 tmpfs，脚本把 `TMPDIR` 设为 `~/.t`。

## 功能地图

`features/README.md` 是索引，每个功能一个文件，写的是用户路径和判定通过的标准。一个功能有多个入口时，证明只走其中一个不算完整。
