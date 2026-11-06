# Agent 自更新：严格跟随控制面版本，排空后原子替换并 execve

Agent、SDK 和控制面共用一个版本号（ADR 0010），所以 Agent 的目标版本永远等于控制面的版本，也允许降级。版本不一致时控制面照常接受连接、续约和接收结果，只是不再派新任务。Agent 先下载新二进制、校验 sha256、试运行 `--version`；等手上的任务结束、结果都被 Ack 后，在同一目录写临时文件并 fsync，用 `rename` 替换自身，再以原来的参数 `execve`。替换前保留 `.prev`，新版本连续失败 3 次（崩溃，或能连上控制面却握手失败）时恢复旧版本，并把该版本记为坏版本、不再自动尝试。systemd 的 `Restart=on-failure` 兜底。调研见 `docs/research/agent-self-update.md`。

## Considered Options

- **退出后由 systemd 拉起**（GitHub Actions runner / Azure Pipelines agent 的做法）：前台运行时没有人拉起，还要包装脚本，比 execve 多不解决任何问题。
- **单独的 updater 进程**（Teleport、Datadog、Tailscale）：能在 Agent 完全起不来时回滚，但多一个要安装和更新的程序；排空后 Agent 已经没有运行时状态，用不着。
- **兼容窗口**（Teleport、Nomad）：升级时不暂停调度，但控制面要同时提供多个版本的 SDK wheel，还要测试版本矩阵。
- **二进制签名**：sha256 与下载地址来自同一个控制面，只防传输损坏；但控制面本来就能下发任意节点包让 Agent 执行，签名带来的额外安全收益很小，需要时再加 minisign。

## Consequences

- 控制面升级后，每个 Agent 要等它最长的任务结束才恢复接任务；Agents 页面显示更新状态，并提供「立即更新」：终止手上的任务，任务以 `agent_lost` 失败并按重试配置重新派发。
- 旧 Agent 要在新控制面上把任务跑完，所以会话协议的消息语义要在相邻版本之间兼容；CI 用上一个发布的 Agent 对接当前控制面验证排空和自更新。
- 二进制不在 `$SFLY_HOME/bin`、目录不可写或指定 `--no-auto-update` 时不自更新，版本不一致时只能连接、不接任务，界面提示需要手动升级。
- 同一个 `SFLY_HOME` 下的多个 Agent 用文件锁避免同时替换。
- 已经部署的、没有自更新能力的旧 Agent 要手动升级一次。
