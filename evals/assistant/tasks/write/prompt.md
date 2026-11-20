在这个节点包里加一个节点 `level_counts`，标题「统计日志级别」：读本机上的一个日志文件（输入 `path`，绝对路径），按行统计各级别的行数。

日志每行是「时间 级别 消息」，用空格分开，级别是第二个字段，一般是 INFO、WARN、ERROR，也可能有别的级别（比如 DEBUG）或者不合这个格式的行（比如异常堆栈）。

输出三项：
- `total`：总行数，空行不算；
- `counts`：INFO、WARN、ERROR 三个键，各自的行数，没有的写 0；
- `error_ratio`：ERROR 的行数除以 `total`，保留 4 位小数，`total` 是 0 时为 0。

读文件这一步用 `ctx.action` 记成一个动作。文件不存在时节点失败，错误信息里写出路径。

写好单测，再用 `sfly debug` 对 /fixtures/app.log 跑通。
