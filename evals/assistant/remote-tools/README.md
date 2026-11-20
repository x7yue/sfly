# 远程工具扩展（对照实验的臂 B）

#442 里「pi 的循环跑在哪」由 #443 的对照实验决定。臂 A 是原版 pi 在开发环境里、工具在本地执行；
臂 B 是 pi 进程和开发环境分开，读、写、编辑、命令四个内置工具经这个扩展落到开发环境里 Agent 的能力端口
（`AgentExec`、`AgentFileRead`、`AgentFileWrite`、`AgentFiles`，见 `proto/sfly/agent/v1/`）。
选了「单独的助手容器加远程工具」的话，这个扩展就是适配层的原型。

- `agent.ts`：能力端口的客户端（connect-node 的 gRPC 传输，HTTP/2，连 tonic 的服务）；
- `extension.ts`：pi 扩展，用 pi 的 `create*Tool(cwd, { operations })` 换掉四个工具的执行；
- `Dockerfile`：把扩展和依赖打成一个 `extension.mjs`，放进工作台镜像，得到 `sfly-aeval-pi-remote:<pi 版本>`。
  `./aeval.sh` 第一次跑臂 B 时自动构建，构建上下文是这个目录加 `packages/proto/src/gen/sfly/agent/v1/`。

臂 B 的 pi 跑在 `sfly-aeval-<槽位>-pi` 容器里，什么都不挂载，本地只有一个和开发环境里工作目录同名的空目录：
工作目录的路径两边一样，不用换算，系统提示里写的工作目录也对。

`./aeval.sh toolcheck` 用假的模型端点照剧本（`container/toolcheck.json`）把四个工具各调一遍，两臂逐步对比，
不花模型的钱；对比表写在结果目录的 `toolcheck.md`。

## 本地和远程的语义差别

### 做了适配的

| # | 差别 | 适配 | 还剩的差别 |
|---|---|---|---|
| 1 | 写文件要求父目录已经存在，能力端口没有建目录的接口 | `mkdir` 经 `AgentExec` 执行 `mkdir -p` | 多一次往返 |
| 2 | 能力端口的命令必须有超时；本地 pi 的命令没给超时就一直等（pi 没有给本地命令设默认超时的配置） | 模型没给超时时用默认值 `AEVAL_DEFAULT_TIMEOUT`，评测里设成会话的时间上限（默认 1200 秒），每次记一条 `default_timeout` | 两臂在会话的时间上限处一起结束，臂 B 不会把卡住的命令提前救回来；实现不同，判定的输出里列为「对臂 B 有利的已知差别」 |
| 3 | 超时时能力端口返回 `DEADLINE_EXCEEDED` | 抛 pi 约定的 `timeout:<秒>`，bash 工具照样写「Command timed out after N seconds」，进程树由 Agent 结束 | 无 |
| 4 | 输出超过上限时 pi 把全文写到**自己本地**的临时文件（`/tmp/pi-bash-*.log`，路径写进结果告诉模型），没有可换的钩子 | 命令结束后把这个文件原样传到开发环境的同一路径，模型用 `read` 读得到 | 只在命令结束（成功、失败、超时）时传；全文传两次 |
| 5 | argv 不经 shell | 包 `bash -lc`：登录 shell 读 `~/.profile`，PATH 和人在开发环境里用的一样 | 本地 pi 的命令继承启动 pi 的那个 shell 的环境 |
| 6 | 命令继承的是 Agent 进程的环境，不是 pi 的 | 评测要的 `SFLY_NICKNAME`、`AI_AGENT` 经 `AEVAL_REMOTE_ENV` 补上 | pi 设给子进程的变量（`PI_*`）没有 |
| 7 | skill 只在 pi 本地发现 | 启动时把开发环境里 `<工作目录>/.agents/skills/` 下的文件复制到本地同一路径，经 `resources_discover` 交给 pi；系统提示里的位置是开发环境里的路径，模型 `read` 的也是那份。臂 B 不加 `--approve`（本地没有项目资源要信任） | 会话中途改了 skill 不会重新复制 |
| 8 | `AGENTS.md` 等上下文文件只在 pi 本地找 | 启动时从开发环境读工作目录和各级上级目录的 `AGENTS.md`（没有时 `CLAUDE.md`），在 `before_agent_start` 里加进去 | 同上，只在启动时读 |
| 9 | 能力端口的错误是 gRPC 状态码 | 换成和本地文件系统一样的说法（`ENOENT: no such file or directory, access '…'`、`EACCES`、`EISDIR`），模型看到的和本地一样 | 其他错误写「失败：原因」 |
| 10 | 判断是不是图片要读文件头 | 读前 16 个字节按魔数认 png、jpeg、gif、webp | 无 |
| 11 | pi 的命令行入口要求工作目录存在 | pi 容器里建一个同名的空目录 | 无 |

### 适配不了的

| # | 差别 | 影响 |
|---|---|---|
| 12 | 命令退出之后，它起的子进程（整个进程组）被 Agent 结束：能力端口「不用来启动常驻进程」（ADR 0019） | 模型在一次工具调用里起服务、下一次去测它，看到的是「连接被拒绝」（自检的 `bash_background_alive`：本地 200，远程连不上） |
| 13 | `setsid` 离开进程组能逃过第 12 条，但只有在 shell 退出之前已经完成才行：shell 一退出 Agent 就给进程组发 SIGTERM，还没来得及 `setsid` 的子进程一起被结束 | `setsid … &` 后面紧跟着退出就会被结束；`setsid … & sleep 1` 才留得住（自检的 `bash_setsid_*`） |
| 14 | 命令以 Agent 的系统用户执行 | 分开部署时就是工作台 Agent 的用户 |
| 15 | 每次工具调用都是一次网络往返；`read` 用流式读取（只留要显示的行），但从文件头读到要的位置为止的内容都要传过来 | 文件大、往返多时更慢 |
| 16 | `grep`、`find`、`ls` 工具（默认不启用）和交互模式的 `!` 命令没有接过去 | 启用它们会看到本地的空目录 |

### 实测

自检两臂逐步对比的结果，以及评测会话里观察到的差别，写在 #443 的评论里。
