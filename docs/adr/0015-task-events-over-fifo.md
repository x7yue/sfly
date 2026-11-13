# 任务事件经 FIFO 交给 Agent，不再写普通文件

节点里的 SDK 把 `ctx.log`、`ctx.progress`、`ctx.metric` 逐行写到环境变量 `SFLY_EVENTS` 给出的路径。这个路径原来是工作目录里的普通文件 `events.jsonl`，Agent 记住偏移量轮询读取新增内容；已读部分从不删除，高频上报指标时每小时增长约 28 MB，压测 72 分钟写满磁盘，`ctx.metric()` 也因写盘失败让节点失败（#69）。现在由 Agent（以及本地调试 `sfly run`）在工作目录里创建命名管道 `events.fifo`，先打开读端并自己持有一个写端，再启动执行器：数据只在内核缓冲区里，读走即释放，不占磁盘，有数据时立即可读。SDK 仍按路径以追加方式打开写入，代码不变，所以旧版本的 SDK 运行时也能用；管道写满时写端阻塞等待（Agent 把容量调到 `/proc/sys/fs/pipe-max-size`），不丢事件。调研见 `docs/research/task-event-channel.md`。

## Considered Options

- **继续用普通文件，对已读区间 `fallocate(PUNCH_HOLE)`**：只改 Agent，但只有部分文件系统支持，`ls -l` 与 `du` 不一致，调研范围内没有成熟系统这样做。
- **继承的匿名管道（`SFLY_EVENTS_FD=3`）**：效果相同，但 SDK 与本地调试都要改，SDK 运行时与 Agent 版本不一致时事件会被悄悄丢弃；将来的 Windows Agent 也要另行设计（Windows 的命名管道同样以路径打开，FIFO 的做法更容易迁移）。
- **SDK 按大小轮换文件**：写者是 SDK，节点 fork 出的子进程也可能在写，轮换要跨进程协调。
- **Agent 截断文件**：读完到截断之间追加的数据会丢。

## Consequences

- 工作目录里没有原始事件文件可供事后查看；日志与进度完整保存在控制面，指标是按「指标 × 秒」合并后的数据。
- Agent 不在时 SDK 写入会得到 `BrokenPipeError`，节点失败；此时任务本来也无法继续（控制面按 `agent_lost` 处理），SDK 不做特殊处理。
- Agent 读得慢时节点写事件会阻塞；节点 fork 出多个进程同时写超过 `PIPE_BUF`（4 KiB）的长行时可能交错。
- 工作目录必须在支持 FIFO 的本地文件系统上。
- `stdout.log` / `stderr.log` 仍由 Agent 在转发管道内容时写一份副本，按大小轮换；执行器失败时错误摘要里的 stderr 末尾取 Agent 内存里保留的部分，不读文件（#70）。
