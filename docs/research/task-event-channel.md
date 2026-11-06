# 任务事件通道与本地日志文件清理调研

调研日期：2026 年 11 月。源码链接固定到调研时各仓库 HEAD 的提交。背景是 issue #69（`events.jsonl` 已读部分不删、任务目录不删，压测 72 分钟写满磁盘）和 #70（错误摘要取 `stderr.log` 尾部，磁盘满时为空）。

现状（`origin/main` 51753d5）：

- SDK 的 `_EventWriter`（`sdk/python/src/sfly/context.py`）以 `O_WRONLY|O_APPEND|O_CREAT` 打开 `SFLY_EVENTS`，持进程内锁写整行；
- Agent 的 `EventsFile`（`agent/src/logs.rs`）每 100 ms 打开文件、`seek(offset)`、读到末尾，只保留不完整的尾行；`Merger` 按「指标 × 秒」合并；
- `read_pipe` 读 stdout/stderr 管道，转发的同时原样写 `stdout.log` / `stderr.log`（写失败被忽略）；
- `stderr_tail`（`agent/src/executor.rs`）从 `stderr.log` 读最后 8 KiB；
- `prepare_dir` 只在同一任务 ID 再次准备时删除目录；
- 本地运行 `sfly.local` 也按偏移量读 `events.jsonl`（`sdk/python/src/sfly/local.py` 的 `_read_events`）。

压测数据：每行约 103 字节（34 MB / 33 万行），每秒约 75 行，约 7.7 KB/s。

## 1. 摘要与对 sfly 的建议

### 1.1 events.jsonl 通道：建议改为继承的匿名管道（候选 B）

**成熟系统最常见的做法**：被监管进程和监管进程同机、同生命周期时，结构化事件走**流式 IPC**（管道或 Unix 域套接字），监管进程在内存里读取、聚合后转发，不落盘。例如：

- Airflow 3 Task SDK：supervisor 为任务进程建 4 对 `socketpair`，其中一对专门传 JSON 日志，在 `posix_spawn` 时 `dup2` 到子进程的 fd 3；
- journald：原生协议是 `AF_UNIX/SOCK_DGRAM`，stdout 流是 `SOCK_STREAM`；
- StatsD / DogStatsD：UDP 或 Unix 域套接字，客户端或 agent 侧聚合；
- OpenTelemetry：SDK 用 OTLP 发给本机 Collector；
- Buildkite Job API：每个作业一个 Unix socket + token；
- Docker、containerd、Nomad：容器的 stdout/stderr 经 FIFO 交给监管进程。

用「文件 + tail」的系统都有特定理由，而且文件都只活一个任务，从不在运行中截断：

- Jenkins durable-task：进程要在 Jenkins 控制器或 agent 连接断开后继续运行，下次重连时从 `last-location.txt` 续读；
- Dagster Pipes：编排进程和外部进程之间可能没有别的共享通道。默认用临时文件，会话结束删掉整个临时目录；
- GitHub Actions 的环境文件：只在 step 结束时读一次，内容很小。

sfly 不需要上面这些理由：

- 执行器的 stdout/stderr 本来就是 Agent 持有的管道。Agent 一死，执行器写 stdout 就会 `EPIPE`。任务本来就不能在 Agent 重启后存活（Hello 只是重连控制面），文件带来的「持久化」没有用处；
- Agent 和执行器始终同机，SDK 与 Agent 同版本，本地协议可以改。

管道有三个好处：

- 已读的数据由内核丢弃，磁盘占用为零，从根本上消除 #69 的第一项；
- 不需要 100 ms 轮询和每次 `open + seek`，Agent 在数据可读时读取；
- 磁盘满不会让 `ctx.metric()` 抛 `OSError`。这次压测里，节点因为写 `events.jsonl` 失败而失败。

**做法要点**：

1. Agent 用 `std::io::pipe()` 或 `tokio::net::unix::pipe` 创建管道。Rust std 创建的 fd 都带 `O_CLOEXEC`（[`pipe2(.., O_CLOEXEC)`][rs-pipe]），要在 `CommandExt::pre_exec` 里 `dup2(write_fd, 3)`。`dup2` 得到的新 fd 不带 CLOEXEC，而且 `dup2` 是 async-signal-safe 的。然后设置 `SFLY_EVENTS_FD=3`。`spawn` 之后 **Agent 必须立即关闭自己手里的写端**，否则永远读不到 EOF。
2. SDK 读 `SFLY_EVENTS_FD`，用 `os.write` 写整行，保留现有的进程内锁。Python 的 `subprocess` 默认 `close_fds=True`，用户代码再起的子进程不会继承 fd 3；`os.fork`（包括 `multiprocessing` 的 fork 方式）会继承，行为与现在的 stdout 相同。
3. Agent 的读取方式和 stdout 一样：按行拆分，执行器退出后最多等 `DRAIN_TIMEOUT`（后台子进程可能还持有写端），然后结束。`Merger`、进度节流、日志排队上限都不变。
4. 背压：用阻塞写，与 Docker 默认的 `mode=blocking` 一致，不丢数据。Agent 只要持续读就不会阻塞写端。默认容量 64 KiB，按压测速率能缓冲约 8 秒；Agent 可以用 `fcntl(F_SETPIPE_SZ)` 调到 `/proc/sys/fs/pipe-max-size`，默认 1 MiB，约 2 分钟。
5. `sfly.local` 改为 `os.pipe()` + `subprocess.Popen(pass_fds=…)`。`Context(events_path=…)` 可以保留为测试用的文件模式。

**其他候选的取舍**：

| 候选 | 评价 |
|---|---|
| A. 对已读区间 `fallocate(PUNCH_HOLE)` | 改动最小（只改 Agent），偏移量保持不变，与 `O_APPEND` 写端没有竞态。但支持的文件系统有限：手册列出 XFS、ext4（≥3.0）、Btrfs（≥3.7）、tmpfs（≥3.5）、gfs2，其他文件系统返回错误，需要回退到「无上限」。`st_size` 继续增长，只是块被释放，`ls -l` 与 `du` 不一致，容易误导排查。只对整块生效。Windows Agent（路线图 P4）上没有对应做法。调研范围内**没有看到成熟系统这样用**。适合当作发布前的临时修补，不适合作为最终协议。 |
| C. SDK 按大小轮换 | Docker、Nomad、kubelet 的轮换都在**单一写者**一侧进行（kubelet 改名后让运行时 `ReopenContainerLog`）。sfly 的写者是 SDK，而且可能有多个进程（fork 后的子进程各自持有 fd），轮换要跨进程协调；读端还要处理「旧文件读完才能删」（Ray 的 log_monitor 靠 inode 变化 + 尺寸回退来识别轮换）。复杂度比 B 高，收益相同。 |
| 截断（`ftruncate` 到 0） | 有经典竞态：读完到截断之间追加的数据会丢（logrotate 的 `copytruncate` 手册明说「some logging data might be lost」）。不建议。 |
| Unix 域 `SOCK_SEQPACKET` socketpair | 保留消息边界，多进程写也不会交错，有 EOF。但 tokio 没有 seqpacket 类型（要用 `AsyncFd` 或第三方 crate），单条消息受 `SO_SNDBUF` 限制，长日志要截断。现阶段 JSONL + 管道够用；以后如果需要双向（例如 SDK 向 Agent 发请求），可以像 Airflow 那样再加一对 socketpair。 |

### 1.2 stdout.log / stderr.log：内存尾部 + 写端按大小轮换（或干脆不写）

**成熟系统最常见的做法**：

- 本地日志由**写它的监管进程**按「单个文件大小 × 文件个数」轮换，在写入时检查，是硬上限。例如 Docker `local` 驱动默认 20 MB × 5，kubelet `containerLogMaxSize` 10Mi × `containerLogMaxFiles` 5，Nomad `max_file_size` 10 MB × `max_files` 10；
- CI agent 把本地副本当作临时文件。Buildkite 的 `enable-job-log-tmpfile` 默认关闭，开启时也是 best-effort 写入（「a tmpfile error (disk full, …) would abort the copy that feeds the Buildkite job log」，所以写失败不影响主日志），作业结束删除；GitHub runner 把 step 日志写成 8 MB 一页，上传成功后删除。

建议：

1. **#70：错误摘要改用内存尾部。** Buildkite 的 `outputTail` 就是这样：在内存里保留最近 4 KiB 输出，供 captured error 使用，与日志文件无关。`read_pipe` 已经拿到每块字节，在 stderr 读取任务里维护一个 8 KiB 环形缓冲即可，执行器退出时交给 `wait()`。
2. **副本文件**：控制面已经保存全部任务日志，本地副本只用于 Agent 侧排查（例如断线期间被丢弃的日志）。有两种选择：
   - 保留：由 Agent（唯一写者）在写入前检查大小，超过上限时 `rename` 成 `.1` 再新建，例如每个流 8 MiB × 2 个文件，任务内上限 32 MiB。这和 Docker `LogFile.WriteLogEntry`、Nomad `FileRotator.Write` 一样，没有跨进程协调问题。写失败继续忽略（现状已经是 `let _ =`）；
   - 不写：GitHub、Buildkite 默认都不在本地长期保留。
   建议先保留并加上轮换，成本很低；排查价值是否值得保留，可以以后再评估。

### 1.3 任务目录：结果 Ack、产物上传后删除；可选保留窗口有上限

**成熟系统的两类做法**：

- **CI agent：作业结束立即删除**。GitHub runner 在作业开始和结束时都清空 `_temp`，每个 step 的命令文件在下一个 step 初始化时删除；Buildkite 在作业结束时删除 env 文件、日志临时文件；Jenkins durable-task 在读到退出码、取完输出后 `deleteRecursive` 控制目录；Dagster 在会话关闭时删除临时目录。
- **集群调度器：终态目录保留，按数量和磁盘阈值回收**。Nomad 客户端 `gc_max_allocs`（50）、`gc_disk_usage_threshold`（80%）、`gc_inode_usage_threshold`（70%）、`gc_interval`（1m）；kubelet 的容器日志在容器被删除时（`Clean`）连同轮换文件一起删除。反例是 Ray：worker 的 `.out/.err` 不轮换，进程结束后只是移到 `logs/old/`，session 目录不自动清理。

sfly 是 CI 式的「一次性任务」：结果、日志、产物都已经交给控制面。建议：

1. 删除时机：`TaskResult` 收到 Ack，**且**产物上传完成（`artifacts/` 在目录里）。还没 Ack 的任务会出现在 Hello 里，目录要保留到 Ack。
2. 删除方式：直接 `remove_dir_all`。如果想留排查窗口，只保留**有上限**的小文件（`task.json`、`output.json`、轮换后的 `*.log`），按「最近 N 个终态任务」或「总字节数」回收，Nomad 式的磁盘阈值作为兜底。
3. Agent 启动时清扫一次：删除工作目录下不属于运行中任务、也不是 `.dev`、`agent.sock` 等保留项的任务目录。上次崩溃或被杀时留下的目录才能回收。

## 2. 各系统做法对比表

| 系统 | 子进程 → 监管进程的通道 | 是否落盘 | 背压 / 满时 | 大小上限 / 轮换 | 清理时机 | 选择理由（来源中可见的） |
|---|---|---|---|---|---|---|
| Dagster Pipes | 默认 `PipesTempFileMessageReader`：临时文件，每条消息 `open(path,"a")` 追加一行 JSON，读端 10 ms 轮询 `readline`；另有 `stdio`（k8s 的 `PipesK8sPodLogsMessageReader` 用 stderr）、`buffered_stdio`、blob 存储分块（默认 10 s） | 是（默认） | 无；文件随运行增长 | 无 | 会话关闭时删文件（`cleanup_file=True`），并删除 `TemporaryDirectory` | 外部进程可能在别的环境里；reader/writer 成对可插拔；blob 分块是为了不每条消息调一次云服务 |
| GitHub Actions runner | workflow commands：stdout 上的 `::cmd::`；输出、状态、环境变量改为每个 step 一组环境文件（`$GITHUB_OUTPUT`、`$GITHUB_ENV`、`$GITHUB_STATE`、`$GITHUB_PATH`、`$GITHUB_STEP_SUMMARY`） | 是 | 不涉及（step 结束时一次性读） | step summary 上限 1 MiB；日志页 8 MB 一个文件 | 命令文件在下一个 step 初始化时删除；`_temp` 在作业开始和结束时清空；日志页上传成功后删除 | 2020 年 CVE-2020-15228：把不可信数据打到 stdout 就能注入 `set-env` / `add-path`；2022 年 `set-output` / `save-state` 也因「untrusted logged data」改为文件 |
| Buildkite agent | Job API：每个作业一个 Unix socket（目录 0700）+ 32 字节 token，经环境变量 `BUILDKITE_AGENT_JOB_API_SOCKET/TOKEN` 下发，HTTP JSON（env、redaction、captured error 等）；`meta-data set`、`annotate` **不经过本机 agent**，CLI 用作业的 `BUILDKITE_AGENT_ACCESS_TOKEN` 直连 Agent API | 否 | HTTP 请求-响应 | 日志按 chunk 上传；可选日志临时文件无上限 | 作业结束：关闭 socket；删除 env 文件、日志临时文件 | 注释：socket 只有运行 agent 的用户可访问，作业结束后 token 失效；临时文件写失败不能影响主日志 |
| Jenkins durable-task | 包装脚本把输出重定向到 `jenkins-log.txt`，退出码写 `jenkins-result.txt`（先写 `.tmp` 再 `mv`）；后台循环每 3 s `touch` 日志文件作为心跳 | 是 | 无 | 无 | 读到退出码并取完输出后，`deleteRecursive` 控制目录 | 进程要在 Jenkins 外运行并被监控（README），控制器或连接断开后能续读（`last-location.txt`） |
| kubelet + CRI（containerd） | 容器 stdout/stderr → FIFO → containerd CRI 写日志文件 | 是 | 由运行时决定 | `containerLogMaxSize` 10Mi × `containerLogMaxFiles` 5；kubelet 每 10 s 检查，改名后调用 `ReopenContainerLog`，旧文件 gzip 压缩 | 容器删除时 `Clean` 删除全部轮换文件 | 节点磁盘有上限；轮换由写者（运行时）重开文件完成 |
| Docker json-file / local | 容器 stdout → FIFO → dockerd 的 copier → 日志驱动 | 是 | 默认 `blocking`；`non-blocking` 时用环形缓冲（默认 1 MB），满了丢新消息 | json-file 默认**不轮换**（`max-size=-1`、`max-file=1`）；`local` 默认 20 MB × 5 并压缩；写入时检查大小、超限立即轮换 | 容器删除 | 文档提醒 json-file 默认不轮换可能导致磁盘耗尽，推荐 `local` |
| Nomad logmon | 执行器 → FIFO → 独立的 logmon 进程 → `FileRotator` | 是 | FIFO 阻塞 | `max_files` 10 × `max_file_size` 10 MB；写入时检查，超出个数删最旧的 | 终态分配目录按 `gc_max_allocs`、磁盘 / inode 阈值、`gc_interval` 回收 | 日志写入「ephemeral disk」，有配额 |
| Ray | worker 的 stdout/stderr 重定向到 `worker-*.out/.err`；`log_monitor` 轮询 tail（文件名每 0.5 s 更新一次，循环约 0.1 s），按 inode 变化和尺寸回退识别轮换或截断 | 是 | 无 | `RAY_ROTATION_MAX_BYTES` 512 MB × `RAY_ROTATION_BACKUP_COUNT` 5；但文档写明 **Raylet、Python、Java worker 日志不轮换** | 进程结束后移到 `logs/old/`；session 目录不自动删 | — |
| systemd-journald | 原生协议：`/run/systemd/journal/socket`（`SOCK_DGRAM`）；过大时把数据写进封印的 memfd，用 `SCM_RIGHTS` 传 fd；stdout：`SOCK_STREAM`（`sd_journal_stream_fd`） | 由 journald 统一写 | 流式套接字自然有背压；按服务限速（默认 30 s 内 10000 条） | `SystemMaxUse` 默认文件系统的 10%、`SystemKeepFree` 15%，上限 4G | 按上述阈值滚动删除 | 数据报一条消息一条记录；大消息走 memfd |
| OpenTelemetry | SDK 用 OTLP 发给本机 Collector（默认 `localhost:4317/4318`）；批处理器队列 2048，满了丢弃；指标在 SDK 内聚合，默认每 60 s 导出 | 默认否；Collector 可选持久化队列（`file_storage`） | SDK 丢弃；Collector `sending_queue` 默认 1000，默认拒绝，可 `block_on_overflow` | 持久化队列按批数限制 | — | 遥测不能阻塞业务 |
| StatsD / DogStatsD | UDP（或 TCP）；DogStatsD 支持 Unix 域数据报套接字；StatsD 默认每 10 s 聚合后刷出；datadog-go 客户端侧聚合，默认 2 s 窗口 | 否 | UDP 发送不等待，丢包；客户端聚合是为了「reducing … packet drops」 | — | — | 先在客户端或 agent 侧聚合，降低条数 |
| Airflow 3 Task SDK | 4 对 socketpair：stdin/requests、stdout、stderr、**JSON 日志（fd 3）**；supervisor 用 `selectors` 读取 | supervisor 写任务日志文件，可上传到远程 | 流式套接字背压 | — | `delete_local_logs` 默认 False（上传后可删除本地日志） | 结构化日志与 stdout 分开，「JSON logs sent this way will be handled nicely」 |
| Temporal activity heartbeat | SDK → Worker（进程内）→ 服务端 | 否 | Worker 节流：只保留最新一次，按 `min(heartbeatTimeout×0.8 或默认 30 s, 最大 60 s)` 发送 | — | — | 与 sfly 的「进度只保留最新值、每秒一次」同构 |
| Bazel BEP | 同一份事件流可以写成文件（`--build_event_binary_file`，每条消息前面加 varint 长度；或 JSON / 文本），也可以经 gRPC 发给 `--bes_backend` | 文件方式是 | — | — | 由使用者负责 | 文件方式给本地工具，gRPC 方式给服务端 |

## 3. 关键技术点

**管道容量与原子性**（[pipe(7)][pipe7]）：

- Linux 2.6.11 起默认容量 16 页（65,536 字节），可用 `F_GETPIPE_SZ` / `F_SETPIPE_SZ` 调整；非特权进程最大可设到 `/proc/sys/fs/pipe-max-size`。超过 `pipe-user-pages-soft` 后，新管道的默认容量会变小。
- 不超过 `PIPE_BUF`（Linux 4096）的写是原子的。阻塞模式下，没有空间时 `write` 阻塞；超过 `PIPE_BUF` 的写可能与其他写者交错。
- 对 sfly 的影响：同一进程内有锁，不会交错。只有「fork 出的多个进程同时写超过 4 KiB 的行」时才可能交错，读端会把它当成一行无法解析的文本，记成一行 SDK 日志（现有的回退逻辑）。可以接受，也可以让 SDK 把单行限制在 `PIPE_BUF` 以内。
- Rust `std::io::pipe` 的文档也提醒，可移植程序不能假设大于 1 字节的消息是原子的。

**写端阻塞与断开**：

- 读端全部关闭后再写，进程收到 `SIGPIPE` 或 `EPIPE`。Python 启动时忽略 `SIGPIPE`，表现为 `BrokenPipeError`。
- 只要还有任意一个进程持有写端，读端就读不到 EOF。所以 Agent 必须关掉自己的写端；后台子进程持有写端时，靠 `DRAIN_TIMEOUT` 兜底（现有 stdout 逻辑）。

**fd 继承**：

- Rust std 的 fd 默认带 CLOEXEC，`Command` 只为 0/1/2 做重定向；要传额外 fd，需要在 `unsafe pre_exec` 里 `dup2`（[CommandExt][rs-cmdext]，闭包必须 async-signal-safe）。tokio 的 `Command` 也有 `pre_exec`。
- Python 3.4 起自己创建的 fd 默认不可继承；`subprocess` 用 `pass_fds` 显式传递（并强制 `close_fds=True`）。
- Airflow 用 `os.posix_spawn` 的 `POSIX_SPAWN_DUP2` 把 socket 放到固定的 fd 0–3，与这里的方案相同。

**FIFO**（[fifo(7)][fifo7]）：

- 命名管道两端都打开后才能传数据，默认 `open` 会阻塞到另一端打开。
- Docker、containerd、Nomad 用 FIFO，是因为写端（shim / 执行器）和读端（dockerd / logmon）是独立启动、可能重启的进程，需要按路径重新打开。sfly 的执行器由 Agent 直接 fork，匿名管道就够了。

**Unix 域套接字**（[unix(7)][unix7]）：

- `SOCK_STREAM` 没有消息边界；`SOCK_DGRAM` 保留边界，在 Unix 域上可靠、不乱序；`SOCK_SEQPACKET` 面向连接、保留边界、按序到达。
- 可以用 `SCM_RIGHTS` 传 fd，用 `SO_PEERCRED` 取对端凭据。
- 命名 socket 的路径不能超过 `sun_path` 的 108 字节（Buildkite 会检查这个长度），`socketpair` 没有这个问题。

**fallocate PUNCH_HOLE**（[fallocate(2)][falloc]）：

- Linux 2.6.38 起提供，必须与 `FALLOC_FL_KEEP_SIZE` 一起用，所以文件大小不变；部分块清零，整块释放；之后读这段区间返回 0。
- 手册列出的支持文件系统：XFS、ext4、Btrfs、tmpfs、gfs2；其他文件系统返回错误。
- 可以和 `O_APPEND` 写端并发，因为不改变文件大小和偏移量。

**O_APPEND 与截断**（[open(2)][open2]）：

- `O_APPEND` 的「定位到末尾 + 写」是一个原子步骤；在 NFS 上多进程追加可能损坏文件。
- 读者在读完和截断之间，写者追加的数据会丢失（logrotate `copytruncate`）。

**inotify 与轮询**（[inotify(7)][inotify7]）：

- inotify 不报告网络文件系统上的远程修改（「Applications must fall back to polling」），也不报告 mmap 写入；队列溢出时产生 `IN_Q_OVERFLOW`，丢弃事件。
- 被调研的 tail 实现都用轮询：Dagster 10 ms，Jenkins 100 ms，Ray 约 100 ms；sfly 现在也是 100 ms。改为管道后不需要这两种机制。

## 4. 风险与开放问题

1. **背压会阻塞用户节点。** Agent 卡住（例如 tokio 运行时被阻塞）时，写满管道的 `ctx.metric()` 会阻塞。这是「不丢数据」的代价，Docker 默认也是这样。另一种选择是 SDK 用 `O_NONBLOCK` 写，遇到 `EAGAIN` 时丢掉指标并计数（OTel、DogStatsD 的做法），但日志也会被丢。待定：指标和日志是否区别对待。
2. **Agent 不在时的 SDK 行为。** `EPIPE` 时应吞掉错误，还是让节点失败？现在文件写失败（磁盘满）会让节点失败。建议遥测写失败只告警一次、不抛异常（Buildkite 的 `bestEffortWriter` 思路）。
3. **Windows Agent（P4）。** 匿名管道句柄继承需要 `STARTUPINFO` 句柄列表或可继承句柄。Rust std 没有现成的 `pass_fds` 等价物。到时候可能改用命名管道路径（`\\.\pipe\…`）。协议上让 SDK 同时支持 `SFLY_EVENTS_FD`，以及以后的路径型通道，留出余地。
4. **多进程写交错**（见 §3）。用户用 `multiprocessing`（fork 方式）并发写长日志时可能交错。是否给单行设 `PIPE_BUF` 上限、超出时截断或分块？
5. **排查窗口的取舍。** 立即删除目录最简单；保留窗口要定「最近 N 个」还是「总字节」，以及是否只保留轮换后的日志。依赖 #69 的讨论结论。
6. **改名与兼容。** `SFLY_EVENTS` 是 ARCHITECTURE.md §5.4 里的公开环境变量。SDK 与 Agent 强制同版本（ADR 0010），可以直接替换。需要同步改 §5.4、`sfly.local` 和相关测试。
7. **PUNCH_HOLE 作为临时修补时**，在不支持的文件系统上要检测 `EOPNOTSUPP` 并告警，否则会静默回到无上限。

## 5. 参考来源

**sfly（本仓库，51753d5）**：`agent/src/logs.rs`（`read_pipe`、`EventsFile`、`Forwarder::poll`）、`agent/src/executor.rs`（`prepare_dir`、`spawn_process`、`stderr_tail`）、`sdk/python/src/sfly/context.py`（`_EventWriter`）、`sdk/python/src/sfly/local.py`（`_read_events`）、`docs/ARCHITECTURE.md` §5.4、ADR 0002、ADR 0010。

**Dagster**（`61a846f1`）

- [`PipesDefaultMessageWriter`](https://github.com/dagster-io/dagster/blob/61a846f1906564a6a100d086291cbc70750a1206/python_modules/dagster-pipes/dagster_pipes/__init__.py#L916-L980)、[`PipesFileMessageWriterChannel` / `PipesStreamMessageWriterChannel`](https://github.com/dagster-io/dagster/blob/61a846f1906564a6a100d086291cbc70750a1206/python_modules/dagster-pipes/dagster_pipes/__init__.py#L982-L1000)
- [`PipesFileMessageReader`（结束时删除文件）](https://github.com/dagster-io/dagster/blob/61a846f1906564a6a100d086291cbc70750a1206/python_modules/dagster/dagster/_core/pipes/utils.py#L136-L208)、[`PipesTempFileMessageReader`](https://github.com/dagster-io/dagster/blob/61a846f1906564a6a100d086291cbc70750a1206/python_modules/dagster/dagster/_core/pipes/utils.py#L211-L243)、[`tail_file`（10 ms 轮询）](https://github.com/dagster-io/dagster/blob/61a846f1906564a6a100d086291cbc70750a1206/python_modules/dagster/dagster/_utils/__init__.py#L702-L711)
- [`PipesSubprocessClient` 的默认值](https://github.com/dagster-io/dagster/blob/61a846f1906564a6a100d086291cbc70750a1206/python_modules/dagster/dagster/_core/pipes/subprocess.py#L62-L76)、[`PipesK8sPodLogsMessageReader` 用 stderr](https://github.com/dagster-io/dagster/blob/61a846f1906564a6a100d086291cbc70750a1206/python_modules/libraries/dagster-k8s/dagster_k8s/pipes.py#L80-L90)
- [Pipes 细节文档（默认 reader，blob 分块的理由）](https://github.com/dagster-io/dagster/blob/61a846f1906564a6a100d086291cbc70750a1206/docs/docs/integrations/external-pipelines/dagster-pipes-details-and-customization.md#L52-L65)

**GitHub Actions runner**（`cf65f3ec`）

- [`FileCommandManager.InitializeFiles` / `ProcessFiles`](https://github.com/actions/runner/blob/cf65f3ec8100ee0046d735ac5d647e00f4b8e817/src/Runner.Worker/FileCommandManager.cs#L42-L90)、[step summary 上限 1 MiB](https://github.com/actions/runner/blob/cf65f3ec8100ee0046d735ac5d647e00f4b8e817/src/Runner.Worker/FileCommandManager.cs#L221-L245)、[ActionRunner 在 step 前后调用](https://github.com/actions/runner/blob/cf65f3ec8100ee0046d735ac5d647e00f4b8e817/src/Runner.Worker/ActionRunner.cs#L172)（另见 L282）
- [`set-output` 弃用告警](https://github.com/actions/runner/blob/cf65f3ec8100ee0046d735ac5d647e00f4b8e817/src/Runner.Worker/ActionCommandManager.cs#L310-L335)
- [`PagingLogger` 8 MB 分页](https://github.com/actions/runner/blob/cf65f3ec8100ee0046d735ac5d647e00f4b8e817/src/Runner.Common/Logging.cs#L21-L22)（[换页并排队上传](https://github.com/actions/runner/blob/cf65f3ec8100ee0046d735ac5d647e00f4b8e817/src/Runner.Common/Logging.cs#L105-L144)）、[上传成功后删除](https://github.com/actions/runner/blob/cf65f3ec8100ee0046d735ac5d647e00f4b8e817/src/Runner.Common/JobServerQueue.cs#L920-L930)、[`_temp` 在作业开始和结束时清空](https://github.com/actions/runner/blob/cf65f3ec8100ee0046d735ac5d647e00f4b8e817/src/Runner.Worker/TempDirectoryManager.cs#L27-L59)
- [Changelog 2020-10-01：弃用 set-env / add-path](https://github.blog/changelog/2020-10-01-github-actions-deprecating-set-env-and-add-path-commands/)、[GHSA-mfwh-5m23-j46w / CVE-2020-15228](https://github.com/advisories/GHSA-mfwh-5m23-j46w)、[Changelog 2022-10-11：弃用 save-state / set-output](https://github.blog/changelog/2022-10-11-github-actions-deprecating-save-state-and-set-output-commands/)、[Workflow commands 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands)

**Buildkite agent**（`1bd67ad7`）

- [`startJobAPI`（socket、token、环境变量）](https://github.com/buildkite/agent/blob/1bd67ad74fd931e032098d34bb380853b0507f7a/internal/job/api.go#L18-L104)、[socket 路径](https://github.com/buildkite/agent/blob/1bd67ad74fd931e032098d34bb380853b0507f7a/jobapi/socket.go#L10-L14)、[生成 token](https://github.com/buildkite/agent/blob/1bd67ad74fd931e032098d34bb380853b0507f7a/jobapi/server.go#L92-L117)、[路由](https://github.com/buildkite/agent/blob/1bd67ad74fd931e032098d34bb380853b0507f7a/jobapi/routes.go#L12-L42)、[0700 目录 + `net.Listen("unix")`](https://github.com/buildkite/agent/blob/1bd67ad74fd931e032098d34bb380853b0507f7a/internal/socket/server.go#L22-L60)
- [`meta-data set` 直连 Agent API](https://github.com/buildkite/agent/blob/1bd67ad74fd931e032098d34bb380853b0507f7a/clicommand/meta_data_set.go#L99-L114)、[`annotate` 直连 Agent API](https://github.com/buildkite/agent/blob/1bd67ad74fd931e032098d34bb380853b0507f7a/clicommand/annotate.go#L162-L181)
- [日志临时文件（best-effort）](https://github.com/buildkite/agent/blob/1bd67ad74fd931e032098d34bb380853b0507f7a/agent/job_runner.go#L276-L311)、[删除](https://github.com/buildkite/agent/blob/1bd67ad74fd931e032098d34bb380853b0507f7a/agent/job_runner.go#L381-L417)、[作业结束时清理](https://github.com/buildkite/agent/blob/1bd67ad74fd931e032098d34bb380853b0507f7a/agent/run_job.go#L533-L550)、[`outputTail`（内存尾部 4 KiB）](https://github.com/buildkite/agent/blob/1bd67ad74fd931e032098d34bb380853b0507f7a/internal/job/output_tail.go#L12-L39)
- 文档：[agent 配置 `enable-job-log-tmpfile`](https://buildkite.com/docs/agent/self-hosted/configure)、[`meta-data` CLI](https://buildkite.com/docs/agent/cli/reference/meta-data)

**Jenkins durable-task**（`2e75dc58`）

- [README](https://github.com/jenkinsci/durable-task-plugin/blob/2e75dc58b7fe7ed30ef9a3edbb164e67ba9ad0bd/README.md#L1-L5)、[心跳参数](https://github.com/jenkinsci/durable-task-plugin/blob/2e75dc58b7fe7ed30ef9a3edbb164e67ba9ad0bd/src/main/java/org/jenkinsci/plugins/durabletask/BourneShellScript.java#L89-L102)、[包装脚本（touch 心跳、结果文件 `.tmp` + `mv`）](https://github.com/jenkinsci/durable-task-plugin/blob/2e75dc58b7fe7ed30ef9a3edbb164e67ba9ad0bd/src/main/java/org/jenkinsci/plugins/durabletask/BourneShellScript.java#L234-L262)、[心跳检查](https://github.com/jenkinsci/durable-task-plugin/blob/2e75dc58b7fe7ed30ef9a3edbb164e67ba9ad0bd/src/main/java/org/jenkinsci/plugins/durabletask/BourneShellScript.java#L316-L345)
- [`cleanup` 删除控制目录](https://github.com/jenkinsci/durable-task-plugin/blob/2e75dc58b7fe7ed30ef9a3edbb164e67ba9ad0bd/src/main/java/org/jenkinsci/plugins/durabletask/FileMonitoringTask.java#L491-L496)、[文件名](https://github.com/jenkinsci/durable-task-plugin/blob/2e75dc58b7fe7ed30ef9a3edbb164e67ba9ad0bd/src/main/java/org/jenkinsci/plugins/durabletask/FileMonitoringTask.java#L520-L536)、[Watcher：续读、退出后清理、100 ms 轮询](https://github.com/jenkinsci/durable-task-plugin/blob/2e75dc58b7fe7ed30ef9a3edbb164e67ba9ad0bd/src/main/java/org/jenkinsci/plugins/durabletask/FileMonitoringTask.java#L607-L657)

**Kubernetes / containerd**（`66e16583` / `b54a638a`）

- [kubelet 默认值 10Mi / 5 / 10 s](https://github.com/kubernetes/kubernetes/blob/66e165834ff76655c6f43f946c3df907820f1931/pkg/kubelet/apis/config/v1beta1/defaults.go#L256-L267)、[字段说明](https://github.com/kubernetes/kubernetes/blob/66e165834ff76655c6f43f946c3df907820f1931/staging/src/k8s.io/kubelet/config/v1beta1/types.go#L728-L737)
- [`Clean`](https://github.com/kubernetes/kubernetes/blob/66e165834ff76655c6f43f946c3df907820f1931/pkg/kubelet/logs/container_log_manager.go#L162-L186)、[`processContainer`](https://github.com/kubernetes/kubernetes/blob/66e165834ff76655c6f43f946c3df907820f1931/pkg/kubelet/logs/container_log_manager.go#L240-L262)、[`rotateLog`](https://github.com/kubernetes/kubernetes/blob/66e165834ff76655c6f43f946c3df907820f1931/pkg/kubelet/logs/container_log_manager.go#L275-L308)、[`rotateLatestLog`（改名 + `ReopenContainerLog`）](https://github.com/kubernetes/kubernetes/blob/66e165834ff76655c6f43f946c3df907820f1931/pkg/kubelet/logs/container_log_manager.go#L423-L445)
- [文档：Log rotation](https://kubernetes.io/docs/concepts/cluster-administration/logging/#log-rotation)
- containerd [CRI 的 FIFO](https://github.com/containerd/containerd/blob/b54a638a1795a7f4d286db3cb47dc5225d61887b/internal/cri/io/helpers.go#L78-L92)、[`redirectLogs`](https://github.com/containerd/containerd/blob/b54a638a1795a7f4d286db3cb47dc5225d61887b/internal/cri/io/logger.go#L114-L132)

**Docker（moby `402d0a16`）**

- [json-file 选项解析（默认 `-1` / `1`）](https://github.com/moby/moby/blob/402d0a16f131d93ee89f1b06cb5fc8c98e766dfc/daemon/logger/jsonfilelog/jsonfilelog.go#L39-L71)、[`local` 默认 20 MB × 5 + 压缩](https://github.com/moby/moby/blob/402d0a16f131d93ee89f1b06cb5fc8c98e766dfc/daemon/logger/local/local.go#L28-L30)
- [`WriteLogEntry` 写入时轮换](https://github.com/moby/moby/blob/402d0a16f131d93ee89f1b06cb5fc8c98e766dfc/daemon/logger/loggerutils/logfile.go#L155-L175)、[`rotate`](https://github.com/moby/moby/blob/402d0a16f131d93ee89f1b06cb5fc8c98e766dfc/daemon/logger/loggerutils/logfile.go#L270-L295)、[non-blocking 环形缓冲 1 MB](https://github.com/moby/moby/blob/402d0a16f131d93ee89f1b06cb5fc8c98e766dfc/daemon/logger/ring.go#L11)（[满了丢新消息](https://github.com/moby/moby/blob/402d0a16f131d93ee89f1b06cb5fc8c98e766dfc/daemon/logger/ring.go#L163-L166)）
- [文档：配置日志驱动（默认不轮换、blocking / non-blocking）](https://docs.docker.com/engine/logging/configure/)、[json-file](https://docs.docker.com/engine/logging/drivers/json-file/)

**Nomad**（`e77c361f`）

- [logmon 打开 FIFO](https://github.com/hashicorp/nomad/blob/e77c361fd055c12659a194ed62eae477b6e45f40/client/logmon/logmon.go#L197-L215)、[`FileRotator.Write`](https://github.com/hashicorp/nomad/blob/e77c361fd055c12659a194ed62eae477b6e45f40/client/logmon/logging/rotator.go#L113-L184)、[`nextFile` / `purgeOldFiles`](https://github.com/hashicorp/nomad/blob/e77c361fd055c12659a194ed62eae477b6e45f40/client/logmon/logging/rotator.go#L186-L350)、[默认 10 × 10 MB](https://github.com/hashicorp/nomad/blob/e77c361fd055c12659a194ed62eae477b6e45f40/nomad/structs/structs.go#L7875-L7881)
- 文档：[`logs` 块](https://developer.hashicorp.com/nomad/docs/job-specification/logs)、[客户端 GC 参数](https://developer.hashicorp.com/nomad/docs/configuration/client)

**Ray**（`0a27c582`）

- [默认 512 MB × 5](https://github.com/ray-project/ray/blob/0a27c582967fe317d7decf7924287ef6cef61aa2/python/ray/_common/ray_constants.py#L4-L5)、[环境变量覆盖](https://github.com/ray-project/ray/blob/0a27c582967fe317d7decf7924287ef6cef61aa2/python/ray/_private/node.py#L197-L203)
- [log_monitor：识别轮换 / 截断](https://github.com/ray-project/ray/blob/0a27c582967fe317d7decf7924287ef6cef61aa2/python/ray/_private/log_monitor.py#L85-L116)、[死进程日志移到 `old/`](https://github.com/ray-project/ray/blob/0a27c582967fe317d7decf7924287ef6cef61aa2/python/ray/_private/log_monitor.py#L220-L247)、[主循环轮询](https://github.com/ray-project/ray/blob/0a27c582967fe317d7decf7924287ef6cef61aa2/python/ray/_private/log_monitor.py#L504-L524)
- [文档：日志目录与轮换（worker 日志不轮换）](https://github.com/ray-project/ray/blob/0a27c582967fe317d7decf7924287ef6cef61aa2/doc/source/ray-observability/user-guides/configure-logging.md#L628-L640)

**systemd**（`2b3a83ff`）

- [JOURNAL_NATIVE_PROTOCOL](https://github.com/systemd/systemd/blob/2b3a83ffae156aa94546e74b08c2e6b6a76dfe6e/docs/JOURNAL_NATIVE_PROTOCOL.md#L28-L53)、[`sd_journal_sendv` 数据报 + memfd 回退](https://github.com/systemd/systemd/blob/2b3a83ffae156aa94546e74b08c2e6b6a76dfe6e/src/libsystemd/sd-journal/journal-send.c#L287-L324)、[`sd_journal_stream_fd`（SOCK_STREAM）](https://github.com/systemd/systemd/blob/2b3a83ffae156aa94546e74b08c2e6b6a76dfe6e/src/libsystemd/sd-journal/journal-send.c#L375-L448)
- [journald.conf：限速默认值](https://github.com/systemd/systemd/blob/2b3a83ffae156aa94546e74b08c2e6b6a76dfe6e/man/journald.conf.xml#L170-L182)、[`SystemMaxUse` / `SystemKeepFree` 默认值](https://github.com/systemd/systemd/blob/2b3a83ffae156aa94546e74b08c2e6b6a76dfe6e/man/journald.conf.xml#L243-L289)

**OpenTelemetry**（规范 `a847b4ea`，Collector `08618bc5`）

- [Logs SDK 批处理器（2048 / 1000 ms / 512，满了丢弃）](https://github.com/open-telemetry/opentelemetry-specification/blob/a847b4eadd3392bd48a32500629736191f82c823/specification/logs/sdk.md#L540-L559)、[Metrics 周期导出 60 s](https://github.com/open-telemetry/opentelemetry-specification/blob/a847b4eadd3392bd48a32500629736191f82c823/specification/metrics/sdk.md#L1592-L1593)、[OTLP exporter 默认地址](https://github.com/open-telemetry/opentelemetry-specification/blob/a847b4eadd3392bd48a32500629736191f82c823/specification/protocol/exporter.md#L26-L33)
- [exporterhelper 的 `sending_queue` / 持久化队列](https://github.com/open-telemetry/opentelemetry-collector/blob/08618bc5fa1c9a295435c0f47154e2f50bc7b6ba/exporter/exporterhelper/README.md#L25-L35)（另见 [L95-L104](https://github.com/open-telemetry/opentelemetry-collector/blob/08618bc5fa1c9a295435c0f47154e2f50bc7b6ba/exporter/exporterhelper/README.md#L95-L104)）

**StatsD / DogStatsD**

- statsd（`f7157b88`）[README：UDP / TCP、10 s 刷出](https://github.com/statsd/statsd/blob/f7157b880631152569b04d626f631b60eec366f8/README.md#L1-L24)
- datadog-go（`e164b9d2`）[客户端聚合](https://github.com/DataDog/datadog-go/blob/e164b9d273a547e9e2507282f7bc4a059c6c0adb/README.md#L141-L153)、[UDS 客户端](https://github.com/DataDog/datadog-go/blob/e164b9d273a547e9e2507282f7bc4a059c6c0adb/README.md#L111-L113)、[UDS 队列内核参数](https://github.com/DataDog/datadog-go/blob/e164b9d273a547e9e2507282f7bc4a059c6c0adb/README.md#L220-L223)

**Airflow**（`82b33126`）

- [JSON 日志通道](https://github.com/apache/airflow/blob/82b33126d3abf31f3e400cdeede4aba37b7616bc/task-sdk/src/airflow/sdk/execution_time/supervisor.py#L393-L401)、[spawn 后 fd 3 是日志 socket](https://github.com/apache/airflow/blob/82b33126d3abf31f3e400cdeede4aba37b7616bc/task-sdk/src/airflow/sdk/execution_time/supervisor.py#L700-L725)、[创建 socketpair 与 `POSIX_SPAWN_DUP2`](https://github.com/apache/airflow/blob/82b33126d3abf31f3e400cdeede4aba37b7616bc/task-sdk/src/airflow/sdk/execution_time/supervisor.py#L935-L968)、[selector 注册](https://github.com/apache/airflow/blob/82b33126d3abf31f3e400cdeede4aba37b7616bc/task-sdk/src/airflow/sdk/execution_time/supervisor.py#L1068-L1094)
- [`delete_local_logs`](https://github.com/apache/airflow/blob/82b33126d3abf31f3e400cdeede4aba37b7616bc/airflow-core/src/airflow/config_templates/config.yml#L834-L841)

**Temporal / Bazel**

- [Temporal：Heartbeat throttling](https://docs.temporal.io/encyclopedia/detecting-activity-failures)
- [Bazel：Build Event Protocol（文件与 BES gRPC）](https://bazel.build/remote/bep)

**Linux / 语言运行时**

- [pipe(7)][pipe7]、[fifo(7)][fifo7]、[unix(7)][unix7]、[fallocate(2)][falloc]、[open(2)][open2]、[fcntl(2)](https://man7.org/linux/man-pages/man2/fcntl.2.html)、[inotify(7)][inotify7]、[logrotate(8)（copytruncate）](https://man7.org/linux/man-pages/man8/logrotate.8.html)
- Rust：[`std::io::pipe`（1.87 稳定）](https://doc.rust-lang.org/std/io/fn.pipe.html)、[pipe 用 `O_CLOEXEC`][rs-pipe]、[`CommandExt::pre_exec`][rs-cmdext]、[`tokio::net::unix::pipe`](https://docs.rs/tokio/latest/tokio/net/unix/pipe/index.html)
- Python：[`subprocess` `pass_fds` / `close_fds`](https://docs.python.org/3/library/subprocess.html#subprocess.Popen)、[fd 继承](https://docs.python.org/3/library/os.html#fd-inheritance)

[pipe7]: https://man7.org/linux/man-pages/man7/pipe.7.html
[fifo7]: https://man7.org/linux/man-pages/man7/fifo.7.html
[unix7]: https://man7.org/linux/man-pages/man7/unix.7.html
[falloc]: https://man7.org/linux/man-pages/man2/fallocate.2.html
[open2]: https://man7.org/linux/man-pages/man2/open.2.html
[inotify7]: https://man7.org/linux/man-pages/man7/inotify.7.html
[rs-pipe]: https://github.com/rust-lang/rust/blob/249c1e4e31111b54ad2483cfd4cea06c7020c653/library/std/src/sys/pipe/unix.rs#L12-L36
[rs-cmdext]: https://doc.rust-lang.org/std/os/unix/process/trait.CommandExt.html#tymethod.pre_exec
