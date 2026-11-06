# Agent 自更新调研

调研日期：2026 年（源码链接固定到调研时各仓库 HEAD 的提交）。背景是 ADR 0010（Agent、SDK、控制面共用版本号 X.Y.Z 且必须一致）和待讨论的方案：握手时版本不一致，Welcome 携带二进制 URL 和 sha256，Agent 进入「待更新」，停止接新任务，等运行中的任务结束（不设超时），然后下载、校验、原子替换自身并 `execve()` 自己；`--no-auto-update` 时只告警。

## 1. 摘要与对 sfly 的建议

**结论：「严格版本相等 + 排空 + 原子替换 + execve」可行，有直接先例**（Elastic Agent 在 Unix 上就是 `unix.Exec` 重新执行自己；GitHub Actions runner 和 Azure Pipelines agent 也是「先下载，再等当前作业结束，再替换并重启」）。但以下几点需要补上，否则方案在边界情况下会出问题：

1. **「严格相等」只能用于调度，不能用于连接。** 控制面升级后，旧 Agent 要在新控制面上把正在跑的任务跑完：发心跳续约、上报日志和结果、收 Ack。所以控制面必须**接受**版本不一致的 Agent，只是不给它派新任务（GitHub/Azure 都是这么做的：更新进行中时作业消息不删除，留在队列给别的 runner，见 §2）。这要求会话维持用到的那部分协议（Hello/Heartbeat/LogBatch/TaskResult/Ack）在相邻版本之间线上兼容。`buf breaking` 已经保护了字段编号，但还应在 CI 里加一条「上一个已发布 Agent ↔ 当前控制面」的排空测试。
2. **排空的条件是「任务进程结束且结果都已 Ack」，不只是「没有子进程」。** Hello.running_tasks 里有「已经结束、结果还没收到 Ack 的」任务，这部分状态在内存里，execve 之后就没了。排空要等到结果都被 Ack，或者先把未确认的结果落盘，新进程启动后再读回来。缓冲区里的日志也一样。
3. **先下载、校验、试运行，再排空。** GitHub runner 先 `DownloadLatestRunner`，再 `jobDispatcher.WaitAsync`。下载失败能尽早报告；排空结束到恢复服务的空窗只剩替换和 exec 的时间。试运行指执行一次 `新二进制 --version`（Teleport 的「verify that the downloaded binaries are valid executables on the host」），能挡住架构不对、文件截断、musl 链接问题。
4. **execve 为主，systemd 兜底；不建议单独做 updater 进程。** execve 在三种运行方式下（前台、systemd 系统单元、`--user` 单元）行为相同：PID 不变，systemd 看到的 MainPID 不变，前台终端也不会丢掉进程。「退出码 + 由 systemd 拉起」在前台模式下不成立，还要额外维护包装脚本（GitHub runner 的 `run-helper.sh` 要处理退出码 3/4 和 `update.finished` 标记文件）。单独的 updater（Teleport `teleport-update`、Datadog installer、OpAMP Supervisor）适合「Agent 本身要保持在线、需要金丝雀和回滚编排」的大规模产品。sfly 已经通过排空把运行时状态清零，用不着这套复杂度。
5. **回滚：保留上一个二进制和标记文件，失败时不要来回循环。** 替换前把当前文件硬链接或复制成 `sfly-agent.prev`；写入 `update-state.json`（目标版本、旧版本、尝试次数）。新进程在 N 次启动内没完成握手，就由新进程自己恢复成 `.prev`。systemd 的 `Restart=on-failure` 让崩溃的新版本有机会被重启到做这个判断。回滚后版本照样不一致，所以要把这个目标版本**记为坏版本**（OpenTelemetry OpAMP Supervisor 规范的做法），之后不再自动尝试，转为「版本不一致、只告警、不可调度」，并上报控制面。
6. **sha256 足够，签名列为后续可选项。** sha256 和 URL 来自同一个控制面，只能防传输损坏，防不了控制面被攻破（OpAMP 规范明确建议签名密钥不要和服务端放在一起）。但 sfly 的控制面本来就能通过 AssignTask 让 Agent 执行任意节点包代码，SDK wheel 也只校验同源 sha256，所以对二进制加签名带来的额外安全收益很有限。保持与 `sdk_wheel_sha256` 一致即可。如果以后要防镜像被篡改，可以用 minisign（Ed25519，Rust 有零依赖的 `minisign-verify`），公钥编译进 Agent。
7. **允许降级，目标就是控制面的版本。** 控制面回滚是最常见的「降级」场景。Azure agent 默认就允许服务端驱动的降级，用来做自动回滚。前提是 Agent 的本地状态（共享 venv、缓存目录布局）对相邻版本向前、向后都兼容。
8. **不可写或由包管理器安装时不自更新。** 二进制不在 `~/.sfly/bin`、所在目录不可写（rename 需要对目录有写权限），或者以后有了 deb/rpm 安装方式，都按 `--no-auto-update` 处理并上报原因。Elastic Agent 对 DEB/RPM 安装不支持 Fleet 升级；Tailscale 检测到包管理器安装时改用包管理器升级。

**备选方案的取舍：**

| 方案 | 优点 | 代价 |
|---|---|---|
| A. 严格相等 + 排空 + execve（建议） | 实现最小；三种运行方式行为一致；与 ADR 0010 的 SDK 匹配规则一致 | 控制面升级后，整个集群暂停调度，直到最长的那个任务结束；排空期间旧 Agent 与新控制面的会话协议必须兼容 |
| B. 退出码 + systemd 拉起（GitHub/Azure 风格） | 新进程完全干净，没有 execve 继承状态的问题 | 前台模式不可用；要包装脚本或 `RestartForceExitStatus=`；与 A 相比不解决任何额外问题 |
| C. 单独的 updater 进程（Teleport/Datadog/Tailscale 风格） | 能在 Agent 完全起不来时回滚；能做金丝雀 | 多一个要安装、要更新的程序；systemd 下要用 `systemd-run` 等方式让它不随 Agent 单元一起被杀 |
| D. 兼容窗口（Teleport：落后一个大版本；Nomad：落后两个小版本） | 升级不阻塞调度，可以滚动升级 | 控制面要同时提供多个 SDK wheel，要测试版本矩阵，与 ADR 0010「镜像只带同版本 SDK」冲突 |

A 的主要缺点是「整体暂停调度，直到最长任务结束」。对 sfly 现在的规模可以接受，但要在界面上把「待更新 / 排空中」显示出来，并提供人工「立即更新」入口（放弃剩余任务、按 agent_lost 重试）。以后如果暂停调度变得难以接受，再考虑 D，或者让任务进程脱离 Agent 存活（Nomad 客户端重启时「Running allocations will continue running uninterrupted」，需要执行器与 Agent 解耦，改动很大）。

## 2. 各产品做法对比表

| 产品 | 谁来替换二进制 | 触发方式 | 排空 | 校验 | 生效方式 | 回滚 | 版本偏差策略 | 包管理器安装 / 禁用 |
|---|---|---|---|---|---|---|---|---|
| GitHub Actions runner | Listener 下载、解包到 `bin.<ver>`；生成的 `_update.sh` 等旧进程退出后切换符号链接 | 服务端下发 `AgentRefreshMessage` / `RunnerRefreshMessage` | 先下载，再 `jobDispatcher.WaitAsync` 等作业结束；更新期间不删作业消息，留给别的 runner | 服务端给的 sha256 | Listener 以退出码 3（RunnerUpdating）退出，`run-helper.sh` 等 `update.finished` 后重新拉起 | 保留 `bin.<旧版本>` 目录，不自动回滚 | 默认自动更新；`--disableupdate` 时必须在新版本发布后 30 天内手动更新 | `--disableupdate` |
| Azure Pipelines agent | 同上（两者同源） | 流水线或任务需要更高版本时，服务端下发 `AgentRefreshMessage` | 同上 | sha256 | 退出码 + 包装脚本 | 允许降级，用于服务端驱动的自动回滚；`DisableAgentDowngrade` 可以关掉 | 小版本自动更新，大版本手动 | 环境变量 `agent.disableupdate` |
| Tailscale | `tailscale update` CLI；tailscaled 通过 `systemd-run` 在单独的临时单元里运行它 | 控制面（c2n）或本地离线自动更新 | 由客户端按节点活动安排时机 | distsign：离线根密钥签名签名密钥，签名密钥签名文件（Ed25519） | 写 `.new` 后 rename，再 `systemctl restart tailscaled` | 无 | 不强制 | 检测到 apt/dnf 等时改用包管理器；无包管理器时用 tarball |
| Teleport（agent managed updates v2） | 单独的 `teleport-update`，systemd 定时器每 10 分钟运行 | 轮询 `/v1/webapi/find`，按更新组和时间窗 | 不涉及（Agent 重启） | tarball 的 `.sha256` | 解包到 `versions/<ver>`，切换符号链接，重启单元 | 监控 PID 是否稳定、诊断接口是否就绪；失败就切回旧链接并恢复 sqlite 备份；只保留当前和上一个可用版本 | 服务端支持落后一个大版本的客户端；不能跨两个大版本 | 有包管理器安装的「system」版本，由更新器接管链接 |
| GitLab Runner | 无自更新，用包管理器 | — | `SIGQUIT`：停止接新作业，作业结束后退出；建议配 `KillSignal=SIGQUIT`、`TimeoutStopSec=infinity` | 包管理器 | 包管理器 + 服务重启 | — | 建议 major.minor 与 GitLab 同步；小版本间保证向后兼容 | — |
| Buildkite agent | 无自更新，用包管理器或重跑安装脚本 | — | `SIGTERM`：完成当前作业后断开 | — | — | — | 每个小版本线支持一年，过期不阻断连接 | — |
| Grafana Alloy / Fleet Management | Fleet Management 只管远程配置管道（Alloy Remote Config / OpAMP），文档里没有二进制升级 | — | — | — | — | — | — | 安装文档只有包管理器、Helm、Ansible 等方式 |
| OpenTelemetry OpAMP（规范 + Supervisor） | Supervisor 进程（规范允许 Agent 自己实现） | 服务端下发 `PackagesAvailable` | — | `DownloadableFile.content_hash` + 可选的独立签名；规范建议签名密钥不放在服务端 | Supervisor 停止 Collector，覆盖可执行文件，再启动 | 覆盖前保存旧文件；启动后不健康就恢复，并把该版本标为「坏」，不再尝试 | — | 默认关闭（`accepts_packages`） |
| HashiCorp Nomad / Consul | 无自更新，运维替换二进制后重启 | — | Nomad 客户端重启时运行中的分配不中断（执行器独立于客户端进程）；降级客户端要先 drain | — | 重启服务 | 不支持降级 | Nomad 至少兼容两个小版本（1.7.x 与 1.5.x）；先升级服务端 | — |
| Elastic Agent / Fleet | Agent 进程自己下载、解包到版本目录、切换符号链接，然后 **`unix.Exec` 重新执行自己**；另起 `watcher` 进程 | Fleet 下发升级动作 | — | SHA 哈希 + PGP 签名（`.asc`） | execve | watcher 在宽限期（默认 11 分钟）内看到崩溃或 FAILED 状态，就切回旧版本；手动回滚在约 7 天内可用 | Agent 的小版本不能高于 Fleet Server | 只有用 `install` 子命令安装、且在系统服务管理器下运行的才可升级；DEB/RPM 不支持 Fleet 升级 |
| Datadog Agent（Fleet Automation） | 单独的 Datadog Installer 守护进程 | 远程配置；主机上要开启 `remote_updates: true` | — | OCI 包 | 磁盘上有 `stable` 和 `experiment` 两个符号链接；先装 experiment，成功后 promote | 失败自动回到上一个版本；为此预留双份磁盘空间 | — | 建议只用一种升级来源（Fleet 或配置管理工具） |

## 3. 关键技术点

### 3.1 在 Linux 上替换正在运行的可执行文件

- 以写方式打开正在执行的映像会返回 `ETXTBSY`（open(2)），所以**不能原地覆盖**，必须写到临时文件再 `rename(2)` 覆盖。`rename` 覆盖已存在的目标是原子的（「no point at which another process … will find it missing」）；跨文件系统时返回 `EXDEV`，所以临时文件必须和目标放在**同一目录**。正在运行的进程继续持有旧 inode，不受影响。
- `self-replace` crate 在 Unix 上就是这么做的：在同一目录下创建 `.<name>.__temp__*`，复制内容，复制权限，再 rename；如果当前路径是符号链接，先解析一层。它**没有 fsync**。sfly 自己实现也就二三十行，可以加上 `File::sync_all()` 和对目录 fd 的 fsync，防止掉电后留下空文件。`self_update` crate 面向 GitHub/S3 等发布后端，它的 `signatures` 特性用 zipsign，`checksums` 特性校验 SHA-256/512。sfly 的 URL 和 sha256 由控制面直接给出，用不上它的后端抽象。
- 另一种 `ETXTBSY`：`execve` 的目标文件还被任何进程以写方式打开时会失败（execve(2)）。多线程程序里，A 线程正在写新二进制，B 线程 fork 出子进程，子进程在 exec 之前会继承写 fd（rust-lang/rust#114554、golang/go#22315）。排空之后不会再派生任务进程，但还是要在 exec 之前确认写 fd 已经关闭，并且排空期间不要并发运行 uv 安装等会派生子进程的操作。
- `std::env::current_exe()` 在 Linux 上读 `/proc/self/exe`。文件被替换（旧 inode 被 unlink）之后，可能返回带 `" (deleted)"` 后缀的路径。所以要**在启动时解析并保存**可执行文件路径，之后替换和 exec 都用这个路径。

### 3.2 execve 与「退出后由 systemd 拉起」

- execve 不创建新进程，PID 不变（execve(2)）。所以 systemd 的 MainPID、前台终端的作业控制、父进程看到的子进程都不变。默认情况下 fd 会跨 exec 保留，只有设置了 CLOEXEC 的才关闭（Rust std 和 tokio 创建的 fd 默认带 CLOEXEC）。除调用线程外的所有线程都会被销毁。被捕获的信号恢复默认处理，被忽略的信号和信号掩码保留。重新执行时传原来的 `args_os()` 和环境，可以再加一个 `SFLY_UPDATED_FROM=<旧版本>`，方便新进程写日志、读标记文件。
- 子进程不会因为 execve 被杀。sfly 排空后已经没有子进程，但排空如果只等「结果 Ack」而有残留后代（任务自己 `setsid` 出去的进程，process_tree.rs 里已有说明），它们会变成新进程的子进程，而新进程不认识它们。
- Elastic Agent 的先例：`reexec()` 先同步日志，再执行 `unix.Exec(executable, args, os.Environ())`；并且只在「运行于系统服务管理器之下」时才允许 re-exec 和升级，理由是没有监管者时，re-exec 失败就没有人能把它拉起来。sfly 的前台模式没有监管者，所以 execve 失败时要恢复 `.prev`，然后以非零码退出（或者继续以旧版本运行，保持「待更新」状态）。
- 如果选「退出后由 systemd 拉起」：`Restart=always` 不管退出码都会重启；`on-failure` 只在非零退出码、被信号终止等情况下重启；`RestartForceExitStatus=` 可以指定某个退出码强制重启。重启受 `StartLimitIntervalSec=` / `StartLimitBurst=` 限速，systemd 文档推荐长期运行的服务用 `on-failure`。
- `KillMode=control-group`（默认）在单元停止或重启时会杀掉 cgroup 里的所有进程。这就是 Tailscale 要用 `systemd-run` 在单独的临时单元里运行 `tailscale update` 的原因：在 tailscaled 单元里起的更新进程，会在重启 tailscaled 时被一起杀掉。sfly 如果选 execve，不涉及这个问题；如果以后做单独的 updater，就必须处理。

### 3.3 回滚

- 常见做法分三种：**保留上一个版本**（GitHub 的 `bin.<ver>` 目录、Teleport「只保留当前和上一个可用版本」），**启动后健康检查**（Teleport 每 2 秒轮询一次，PID 连续 6 次不变算稳定，崩溃 2 次算失败，1 分钟超时，然后检查诊断接口是否就绪；Elastic watcher 的宽限期是 11 分钟），**A/B 符号链接**（Datadog `stable`/`experiment`，Elastic 的版本目录加顶层符号链接）。
- sfly 单文件场景下的最小做法：`sfly-agent` 和 `sfly-agent.prev` 两个文件，加上 `update-state.json`。「健康」就定义为「新版本完成 Hello/Welcome 握手」。连续 N 次启动（例如 3 次）都没握手成功，就恢复 `.prev` 并把目标版本记为坏版本（参考 OpAMP Supervisor）。要区分「控制面不可达」和「新版本坏了」：只有在新进程能连上控制面却握手失败，或者进程本身崩溃时，才计入失败次数。
- 新二进制根本起不来（入口就崩溃）时，只有外部进程能回滚。替换前的 `--version` 试运行能挡住大部分这类情况。剩下的风险是「能打印版本，但启动后才崩」。如果不做单独的 watcher，就只能靠 systemd 重启加启动早期检查标记文件，前台模式下只能人工处理。

### 3.4 签名与校验

- 现状：GitHub/Azure 用服务端下发的 sha256，Teleport v2 用 tarball 的 `.sha256`，都是同源校验。Tailscale 的 distsign 是两级 Ed25519：离线根密钥编译进客户端，用它签名可轮换的签名密钥，再用签名密钥签名每个发布文件。Elastic 用 PGP。OpAMP 规范建议对可执行包签名，并且「CA 和私钥不要和 OpAMP 服务端放在一起，以免被攻破的服务端签出恶意代码」。
- sfly 的威胁模型：控制面本来就能下发任意节点包，让 Agent 执行。所以控制面被攻破时，二进制签名挡不住攻击，sha256 与 SDK wheel 的做法保持一致即可。签名能防的只有「镜像或 HTTP 下载路径被篡改、但控制面本身没被攻破」，以及以后节点包也走签名的情况。如果要加：minisign（`minisign-verify` crate 零依赖）比 cosign 简单得多。cosign 的 keyless 签名需要 Sigstore 证书链和透明日志，对一个静态 musl Agent 来说依赖太重。

### 3.5 排空

- GitHub runner 和 Azure agent：收到更新消息后先下载，再无限期等当前作业结束（`WaitAsync(token)` 只能被关机取消）；期间收到的作业消息不删除，服务端会派给别的 runner。GitLab Runner：`SIGQUIT` 停止接新作业，作业结束后退出，官方建议的 systemd 配置是 `TimeoutStopSec=infinity`。Buildkite：`SIGTERM` 完成当前作业后断开。行业里「排空不设超时」很常见，但都允许人工强制操作。
- sfly 需要的协议能力：控制面要知道 Agent 处于「待更新」状态，不再派任务。这个状态可以由控制面根据版本不一致自行判断，也可以由 Agent 在 Heartbeat 里上报更新状态（下载中、等待任务、替换中、失败原因），后者便于在界面上展示。断线重连后，Agent 再发 Hello，控制面再回 Welcome，Agent 继续排空，这个过程要幂等。

### 3.6 版本偏差与降级

- 严格相等：GitHub（功能依赖时强制更新，`--disableupdate` 后 30 天内必须更新）和 Azure（任务需要时更新）实际上都是「服务端说了算」，没有兼容窗口。
- 兼容窗口：Teleport（服务端支持落后一个大版本的客户端，客户端不能比 Auth 新）、Nomad（至少兼容两个小版本，不支持降级）、GitLab（建议 major.minor 同步，小版本间保证向后兼容）、Elastic（Agent 的小版本不高于 Fleet Server）、Buildkite（每个小版本线支持一年）。
- 降级：Azure 默认允许服务端驱动的降级，用于自动回滚；Nomad 不支持降级；Tailscale apt 安装时带 `--allow-downgrades`。sfly 选择「目标就是控制面的版本」，天然支持控制面回滚，前提是本地状态在相邻版本间双向兼容。

### 3.7 二进制不可写或由包管理器安装

- Elastic：只有用 `install` 子命令安装、且在服务管理器下运行的才可升级；DEB/RPM 必须用包管理器升级。Tailscale：检测到 apt/dnf/apk 安装就调用包管理器，否则下载 tarball；替换二进制需要 root。Teleport v2 不用包管理器，包管理器安装的版本只作为「system」链接，由更新器接管。Datadog：建议只用一种升级来源，否则配置管理工具会把版本改回去。
- sfly：启动时检查「路径在 `~/.sfly/bin` 下，或带有安装脚本写的标记文件」以及「父目录可写」，任何一项不满足就按 `--no-auto-update` 处理，并上报「需要手动升级」。

## 4. 风险与开放问题

1. **集群级暂停调度**：控制面升级后，所有 Agent 同时排空，新任务要排队到最长任务结束。需要界面提示和「强制更新」入口，并确定强制更新时如何处理剩余任务（取消后按 agent_lost 重试，还是直接失败）。
2. **跨版本会话兼容**：旧 Agent 在新控制面上排空，依赖消息语义（不只是字段编号）在相邻版本间保持兼容。要不要把「N-1 Agent 排空」加进 `pnpm test:bundle`？
3. **未 Ack 结果和日志的持久化**：是等待 Ack 再 exec，还是落盘？前者实现简单，但会话一直断开时会卡住。
4. **`sfly dev` 加载的开发包**：Hello.dev_packages 是进程内状态。exec 之后要么重新加载，要么要求开发模式下禁用自更新。
5. **同一台机器上多个 Agent 共用 `~/.sfly/bin`**：两个进程可能同时替换同一个文件。需要文件锁（Teleport 用锁文件防重入）；第二个进程发现文件已经是目标 sha256 时，跳过下载直接 exec。
6. **`--no-auto-update` 的语义**：严格相等下，这个模式的 Agent 版本不一致时只能连接、不可调度。需要在文档里写清楚，否则用户会以为它还能干活。
7. **坏版本标记的清除**：控制面发布修复版本 X.Y.(Z+1) 后，目标变了，自然会重试；同一版本重新打包（sha256 变了）是否允许重试？
8. **前台模式下 execve 失败或新版本崩溃**：没有监管者，只能恢复 `.prev` 并退出。可以接受，但要在日志里给出明确的手动处理步骤。
9. **磁盘空间**：musl 静态二进制不大，仍应在下载前检查（Teleport 用 `Statfs` 加 `HEAD` 拿到的 content-length），并在 `.prev` 之外清理旧的临时文件。
10. **安装脚本与控制面同源**：`curl <cp>/install.sh | sh` 的信任边界和自更新相同（都信任控制面）。如果以后引入签名，安装脚本也要能校验。

## 5. 参考来源

**GitHub Actions runner**（actions/runner@cf65f3e）
- 自更新流程：先下载（L73），再等作业（L79），再生成并执行更新脚本（L92）：https://github.com/actions/runner/blob/cf65f3ec8100ee0046d735ac5d647e00f4b8e817/src/Runner.Listener/SelfUpdater.cs#L53-L134
- sha256 校验：同文件 L382-L398
- 更新完成后以 RunnerUpdating 退出：https://github.com/actions/runner/blob/cf65f3ec8100ee0046d735ac5d647e00f4b8e817/src/Runner.Listener/Runner.cs#L549-L577
- 更新期间不删除作业消息：同文件 L681-L684
- 退出码定义：https://github.com/actions/runner/blob/cf65f3ec8100ee0046d735ac5d647e00f4b8e817/src/Runner.Common/Constants.cs#L150-L162
- 包装脚本按退出码 3/4 等待 `update.finished`：https://github.com/actions/runner/blob/cf65f3ec8100ee0046d735ac5d647e00f4b8e817/src/Misc/layoutroot/run-helper.sh.template#L35-L74
- 更新脚本等待旧 PID 退出、切换 `bin` 符号链接：https://github.com/actions/runner/blob/cf65f3ec8100ee0046d735ac5d647e00f4b8e817/src/Misc/layoutbin/update.sh.template#L28-L121
- `--disableupdate` 与 30 天要求、自动更新时机：https://docs.github.com/en/actions/reference/runners/self-hosted-runners （源文件 https://github.com/github/docs/blob/main/content/actions/reference/runners/self-hosted-runners.md 约 L125-L135、L173）

**Azure Pipelines agent**（microsoft/azure-pipelines-agent@3cdc668）
- 下载（L82）与等待作业（L88）：https://github.com/microsoft/azure-pipelines-agent/blob/3cdc6680ec5a54dd9bb85ff9dc69b3c65025ca16/src/Agent.Listener/SelfUpdater.cs#L66-L120
- 降级与自动回滚、`DisableAgentDowngrade`：同文件 L122-L171
- `agent.disableupdate`、更新期间跳过作业消息：https://github.com/microsoft/azure-pipelines-agent/blob/3cdc6680ec5a54dd9bb85ff9dc69b3c65025ca16/src/Agent.Listener/Agent.cs#L471 与 L565-L597
- 文档「Agent version and upgrades」：https://learn.microsoft.com/en-us/azure/devops/pipelines/agents/agents?view=azure-devops

**Tailscale**（tailscale/tailscale@e906e69）
- 按安装方式选择更新方式：https://github.com/tailscale/tailscale/blob/e906e6934d25da71c4bbf3c30af679fb2f72b423/clientupdate/clientupdate.go#L198-L268 ；apt 未安装时回落到 tarball：同文件 L473-L480
- tarball 更新、写 `.new` 后 rename、重启 systemd 单元：同文件 L948-L1003、L1096-L1115
- 下载走 distsign 校验：https://github.com/tailscale/tailscale/blob/e906e6934d25da71c4bbf3c30af679fb2f72b423/clientupdate/clientupdate_downloads.go#L14-L20
- distsign 两级 Ed25519 设计：https://github.com/tailscale/tailscale/blob/e906e6934d25da71c4bbf3c30af679fb2f72b423/clientupdate/distsign/distsign.go#L4-L36
- 用 `systemd-run` 让更新进程不随 tailscaled 一起被杀：https://github.com/tailscale/tailscale/blob/e906e6934d25da71c4bbf3c30af679fb2f72b423/feature/clientupdate/clientupdate.go#L376-L421 ；CLI 与守护进程版本必须一致：同文件 L451-L459
- 文档：https://tailscale.com/kb/1067/update

**Teleport**（gravitational/teleport@1283425）
- RFD 0184 Agent 自动更新：https://github.com/gravitational/teleport/blob/1283425b60ec5f60d509ba4c791183d452923ff7/rfd/0184-agent-auto-updates.md （单独的 updater 和分阶段计划 L20、L55-L64；运行时步骤 L1709-L1767；失败处理 L1782-L1790）
- 重启后的健康监控常量：https://github.com/gravitational/teleport/blob/1283425b60ec5f60d509ba4c791183d452923ff7/lib/autoupdate/agent/process.go#L42-L51
- 版本兼容规则：https://github.com/gravitational/teleport/blob/1283425b60ec5f60d509ba4c791183d452923ff7/docs/pages/includes/compatibility.mdx#L5-L16

**GitLab Runner**
- 版本同步建议：https://gitlab.com/gitlab-org/gitlab-runner/-/blob/main/docs/_index.md （约 L96-L103）
- 信号与优雅退出、systemd `KillSignal=SIGQUIT`：https://gitlab.com/gitlab-org/gitlab-runner/-/blob/main/docs/commands/_index.md （约 L120-L123、L634-L643）
- 用包管理器升级：https://gitlab.com/gitlab-org/gitlab-runner/-/blob/main/docs/install/linux-repository.md （约 L189）

**Buildkite agent**
- 版本支持策略：https://github.com/buildkite/docs/blob/main/pages/agent/version_support_policy.md
- 信号（SIGTERM 完成当前作业后断开）：https://github.com/buildkite/docs/blob/main/pages/agent/lifecycle.md （约 L26）
- 升级方式：https://github.com/buildkite/docs/blob/main/pages/agent/self_hosted/install.md （约 L32-L39）

**Grafana Alloy / Fleet Management / OpAMP**
- Fleet Management 介绍（远程配置、两种协议）：https://grafana.com/docs/grafana-cloud/send-data/fleet-management/introduction/
- Alloy 安装方式：https://github.com/grafana/alloy/tree/main/docs/sources/set-up/install
- OpAMP 规范（Supervisor、Packages、代码签名）：https://github.com/open-telemetry/opamp-spec/blob/main/specification.md （「Code Signing」一节）
- OpAMP Supervisor 可执行文件更新设计（保存旧文件、恢复、标记坏版本）：https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/cmd/opampsupervisor/specification/README.md （「Collector Executable Updates」一节）；实现状态：https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/cmd/opampsupervisor/README.md

**HashiCorp**
- Nomad 升级（兼容两个小版本、不支持降级、运行中的分配不中断）：https://developer.hashicorp.com/nomad/docs/upgrade
- Consul 升级：https://developer.hashicorp.com/consul/docs/upgrade

**Elastic Agent**（elastic/elastic-agent@5a6a595）
- `unix.Exec` 重新执行：https://github.com/elastic/elastic-agent/blob/5a6a595b949cc1f4c6578dfb82ec8a28f2c2c042/internal/pkg/agent/application/reexec/reexec.go#L18-L26
- 只在服务管理器下、用 install 安装时才允许升级：https://github.com/elastic/elastic-agent/blob/5a6a595b949cc1f4c6578dfb82ec8a28f2c2c042/internal/pkg/agent/application/reexec/manager.go#L28-L50 ，https://github.com/elastic/elastic-agent/blob/5a6a595b949cc1f4c6578dfb82ec8a28f2c2c042/internal/pkg/agent/application/upgrade/upgrade.go#L136-L141
- watcher 默认宽限期：https://github.com/elastic/elastic-agent/blob/5a6a595b949cc1f4c6578dfb82ec8a28f2c2c042/internal/pkg/agent/configuration/upgrade.go#L14
- 文档（版本限制、DEB/RPM、回滚）：https://www.elastic.co/docs/reference/fleet/upgrade-elastic-agent ；独立模式与签名校验：https://www.elastic.co/docs/reference/fleet/upgrade-standalone

**Datadog Agent**（DataDog/datadog-agent@7f5d6d4）
- stable/experiment 仓库布局：https://github.com/DataDog/datadog-agent/blob/7f5d6d4237f9a0cb8aac50a708355d925ac4f991/pkg/fleet/installer/repository/repository.go#L41-L55
- InstallExperiment / RemoveExperiment / PromoteExperiment：https://github.com/DataDog/datadog-agent/blob/7f5d6d4237f9a0cb8aac50a708355d925ac4f991/pkg/fleet/installer/installer.go#L380 、L449、L498
- 文档（前提条件、双份磁盘空间、失败自动回退）：https://docs.datadoghq.com/agent/fleet_automation/upgrade_agents/ ；远程管理：https://docs.datadoghq.com/agent/fleet_automation/remote_management/

**Rust 与 Linux**
- self-replace 的 Unix 实现：https://github.com/mitsuhiko/self-replace/blob/f74d7bd1ab1c29b1bfe71a59f4bcae545ebdd34e/src/unix.rs#L13-L48
- self_update（后端、`signatures`/zipsign、`checksums`）：https://github.com/jaemk/self_update/blob/master/README.md
- `std::env::current_exe` 关于「(deleted)」的说明：https://doc.rust-lang.org/std/env/fn.current_exe.html
- spawn 新写入文件时的 ETXTBSY 竞态：https://github.com/rust-lang/rust/issues/114554 ，https://github.com/golang/go/issues/22315
- open(2)（ETXTBSY）：https://man7.org/linux/man-pages/man2/open.2.html
- rename(2)（原子替换、EXDEV）：https://man7.org/linux/man-pages/man2/rename.2.html
- execve(2)（PID 不变、fd 与信号的保留规则、ETXTBSY）：https://man7.org/linux/man-pages/man2/execve.2.html
- systemd.service（`Restart=`、`RestartForceExitStatus=`、限速）：https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html
- systemd.kill（`KillMode=`）：https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html
- minisign：https://jedisct1.github.io/minisign/ ；minisign-verify：https://github.com/jedisct1/rust-minisign-verify
- cosign 对文件签名：https://github.com/sigstore/docs/blob/main/content/en/cosign/signing/signing_with_blobs.md
