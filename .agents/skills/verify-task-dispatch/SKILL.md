---
name: verify-task-dispatch
description: 用 TLA+ 模型检查器 TLC 穷举验证 sfly 控制面与 Agent 之间的任务派发协议（派发、TaskStarted、结果与 Ack、心跳续约、租约过期以 agent_lost 重试并强制取消旧尝试、断线重连时 Hello/Welcome 的继续或放弃）。改动 apps/server/src/engine/engine.ts 或 leases.ts 里的派发、结果、心跳、租约、重试逻辑，agent/src/lib.rs 里的 Hello/Welcome、serve 循环、run_task，agent/src/ledger.rs 的任务台账，或者 proto/sfly/agent/v1/agent.proto 的这些消息时使用：检查同一个节点的两次尝试会不会在 Agent 上同时执行、槽位会不会被超用、一个节点会不会接受两次成功。
---

# 验证任务派发协议

## 这次检查回答的问题

**承诺：** 控制面重新执行一个节点时（重试一个新尝试），Agent 上这个节点较早的尝试要么已经结束，要么已经被告知停止。

**被打破的危害：** 同一个节点的代码在同一台 Agent 上同时跑两份，副作用做两遍（比如起了两个常驻进程、往被测系统发了两遍请求）。旧的那份还没人管，会一直跑到它自己结束，最长可达节点超时（默认 1 小时）。同时 Agent 实际执行的任务数超过槽位。

一起检查的性质（`model/TaskDispatch.tla` 末尾）：

| 不变式 | 白话 |
|---|---|
| `NoUnstoppedDuplicate` | 较新的尝试已经启动执行器时，较早的尝试要么已结束，要么已被告知停止（`Ledger::cancel`；Welcome 放弃的是 `Ledger::abandon`） |
| `SlotBound` | 没被告知停止的任务（安装中和执行中都算）不超过 Agent 的槽位 |
| `AssignOnlyWhenReady` | 派发只发给已准备好环境、进入了收发循环的 Agent（#219）：任务的租约不会算进 Agent 准备环境的时间 |
| `AtMostOneSuccess` | 一个节点最多一次尝试被记为 `success` |
| `SuccessWasRun` | 被记为 `success` 的尝试确实在 Agent 上执行成功了 |

## 运行

```sh
.agents/skills/verify-task-dispatch/scripts/check.sh     # 约 1.5 分钟（大部分是 SlowDelivery）；退出码 0 = 结果与下面记录的一致
.agents/skills/verify-task-dispatch/scripts/mutants.sh   # 约 5 秒；确认每条性质仍然能失败
```

第一次运行时，脚本会用 mise 装 Temurin 21（`java@temurin-21.0.13+9.0.LTS`），下载 tla2tools 1.8.0 到 `~/.cache/sfly-formal/` 并校验 sha256，都不改动仓库。完整输出和反例写到 `~/.local/state/sfly-formal/<时间>/<配置>.txt`。

`check.sh` 跑三个配置（`model/*.cfg`），范围都一样：一个 Agent、一个包节点、`retries = 2`（3 次尝试）、1 个槽位、每个方向最多 3 条在途消息，断线和重连的次数不限。

| 配置 | 时序假设 | 期望 |
|---|---|---|
| `Safe` | 心跳不迟到，投递及时 | 无违例，约 56.4 万个不同状态 |
| `LateHeartbeats` | 连接正常时租约也可能过期 | 无违例，约 1019 万个不同状态 |
| `SlowDelivery` | 消息可能晚于两个心跳周期才被处理 | 无违例，约 1207 万个不同状态 |

两个时序假设的具体含义：
- **心跳不迟到**（`LateHeartbeats = FALSE`）：连接正常时，心跳总能在 30 秒租约内被控制面处理，租约只在断线期间过期。Agent 准备环境期间不发心跳，所以这也假设了重连时手上有任务的 Agent 准备环境不超过租约（这时环境早已就绪，只做几项检查；见 #294「不专门处理的边界」）。
- **投递及时**（`PromptDelivery = TRUE`）：Agent 手上还有没处理的控制面消息、或者上一次心跳控制面还没处理时，不会发下一次心跳。10 秒的心跳间隔远大于投递延迟。结果已交出、还没发出的任务也在心跳里（台账里的全部任务都在，`Ledger::held`），不再需要「没有这样的结果才发心跳」这个假设。

`check.sh` 的输出：
- `ok`：和这里记录的一致。
- `DIFF`：结果变了，按下面「读结果」处理。
- `ERROR`：模型语法错误或工具出错，看对应的输出文件。

## 当前发现

无。写这个 skill 时（#214）`LateHeartbeats` 和 `SlowDelivery` 各找到一条反例，#215 已修复：租约在连接正常时过期（当时包括重装的 Agent 首次准备环境超过 30 秒，#219 之后 Agent 准备好环境之前不派发，只剩派发消息晚到这类情况），或派发消息晚到、连续两次心跳都没有上报时，旧尝试以 `agent_lost` 失败并重派到同一个 Agent，但没有人让 Agent 停掉旧尝试，两次尝试都执行。现在 `leases.ts` `agentLost` 同时记下这次尝试的强制取消，`#step` 提交后先于下一次尝试的派发发出。`mutants.sh` 的 `lease-expired-no-cancel`、`heartbeat-lost-no-cancel` 去掉这一步，两条反例重新出现。

## 范围：验证了什么，没验证什么

在上面的范围和时序假设内，三个配置各自穷举了所有消息交错、断线时机、执行结果（成功或失败）和租约到期时机。两个时序假设同时不成立（`LateHeartbeats = TRUE` 且 `PromptDelivery = FALSE`）时没有放进 `check.sh`（#408 时穷举过一次，五条性质都成立）。

**在模型外、结论不覆盖的：**

- 多个节点或多个运行共享槽位。只有一个节点时同一时刻最多一个尝试在排队，所以 **`#dispatch` 里按 `slots` 计数这一处没有被验证**，`SlotBound` 守护的是「Hello 要上报安装中的任务」和「放弃的任务要杀掉」。
- 运行取消（`cancel`、`#cancelChain`、`#resendCancels`）、停止子流程节点（docs/SEMANTICS.md §4.1）、立即更新（UpdateNow，以 `agent_lost` 结束手上的任务）和自更新排空、版本不一致时不派发。`agent_lost` 时的强制取消在模型里，但取消只建模成「被告知停止」，不区分优雅取消和强制取消。
- 控制面重启：`extendForRecovery`，以及启动时 `engine/foreign-agent-tasks.ts` `failForeignAgentTasks` 把登记在别的项目里的 Agent 手上的任务以 `config_error` 失败（不重试、不发取消，Agent 重连时由 Welcome 的 ABANDON 停掉，就是 `CPOnline` 和 `AgentWelcome`）。多个控制面连接同一个 Agent。
- 失败类型的区别：模型里所有失败都按 `retries` 重试；`env_error`（含产物超限，#570）和 `config_error`（含派发内容准备出错、排队超时写得不合格）不重试，这一点没有建模，只会让重试更少。结果写不进数据库时按 `node_error` 失败（#207）也没有建模。
- 认身份（Agent 凭据、共享令牌、停用、登记工作台之后只认 Agent 凭据、连接的项目；`agents/agent-auth.ts`、`agent-hub.ts` `attach`、`gateway/agent-gateway.ts`）只决定「这次 Hello 连不连得上」：拒绝发生在登记进连接表之前（`attach` 在引擎的锁里再确认一遍），不碰任务和租约，在模型里就是一次没有发生的 `AgentConnect`。Agent 被拒绝之后不退出、退避重连（`lib.rs` `Rejections`），台账留在内存里，就是 `Disconnect` 之后的状态。停用或吊销时断开连接是 `Disconnect`，手上的任务等租约过期走 `agent_lost`（`apps/server/test/agent-disable-dispatch.test.ts`）。派发时比较连接的项目和运行的项目是一次只读的比较，比不上以 `config_error` 失败（不重试、没到过 Agent）。
- 任务凭据（`AssignTask.task_token`，`#prepareAssign` 在设租约的同一个事务里签发）：只用于下载和上传产物的 HTTP 请求，有效与否由任务当前的状态得出，不改任务的状态。
- 结果的内容：失败文字、输出、`output.json` 有上界（#728），产物超限报 `env_error`、上传失败报 `node_error`、上传期间到的取消报 cancelled（`agent/src/artifacts.rs` `Uploader::finish`）。这些都只可能把成功变成不成功，不会反过来；模型里 `AgentFinish` 可以得出成功或失败，已经包含它们。
- Agent 自己在超时进入收尾时间时调 `Ledger::cancel`（`lib.rs` `run_task` 的 `wind_down`，#656，让正在进行的能力调用放弃）：不是协议消息，结局仍是超时失败。模型不把它算进 `stopSig`：`stopSig` 更小，`NoUnstoppedDuplicate` 和 `SlotBound` 只会更严。
- 同名的新连接顶掉旧连接时（`attach` 的 `old?.close()`），旧连接上已经读出、在等引擎锁的那一条消息可能在新连接的 `onOnline` 之后才处理（`#heartbeat`、`#applyResult` 按 Agent 的名字处理，不看是哪条连接）。模型的 `Disconnect` 清空在途消息，没有表达这种跨连接的迟到。逐条推过不破坏五条性质：旧心跳只能往 `suspects` 里加东西，要连续两次没报才判丢；它让旧连接变成已准备好也不派发（`#dispatch` 取的是新连接）；旧结果照常处理、Ack 发到关掉的连接上丢掉，Agent 会重发。
- 「结果已交出、还没发出」的任务有没有被漏报（#132）：Hello 或心跳少列了这样一个任务，只会让控制面多一次 `agent_lost`、多重试一次（旧尝试已经结束），不会破坏上面五条性质，所以模型里没有对应的性质。漏报还在安装或执行中的任务不一样：`SlotBound` 会抓到（`mutants.sh` 的 `hello-omits-installing`）。这一条由 `agent/src/ledger.rs` 的单元测试守着（`hello_lists_a_task_that_finished_before_it_was_listed` 等）。
- 动作摘要和明细（`ActionSummary`、`ActionBatch`，#345）、日志：走遥测通道，不回 Ack、不续租约、不改任务状态。
- TaskStarted 走遥测通道，可能晚于结果或丢失，模型里断线时丢失、连接时按顺序送达；心跳里的 `started` 补记保证了结论不依赖它。心跳和 Hello 里的 `started` 按执行器子进程有没有启动过如实报，已经结束的任务也一样（`Finished::started`）。模型里 `HandStarted` 描述了这一点，但没有性质守着它（它只影响 `startedAt` 记得准不准），由 `agent/src/ledger.rs` 的单元测试守着（`a_finished_task_reports_whether_its_executor_ever_started` 等）。
- 真实时间：租约多久过期、心跳多快、重连的退避，都用上面两个开关表达或不建模。

## 覆盖记录

**同步提交：`879c61104a1a2821eee26732081c74031745b610`**（在这个提交上逐个核对过模型与下列代码一致，见下面「核对的历史」）。

| 模型里的动作 | 代码 |
|---|---|
| `Dispatch` | `apps/server/src/engine/engine.ts` `#dispatch`（只派给 `AgentConnection.ready` 的连接；连接能不能接新任务、空闲槽位在 `apps/server/src/agents/dispatch-gate.ts` `connectionBlock`、`freeSlots`，页面上「排队中的任务在等什么」（`queue-wait.ts`）用的是同一段，不改状态转移）、`#prepareAssign`（派发即设租约；派什么由 `#assignContent`、`assign-content.ts` 回答，不在模型里；准备内容出错时这个任务以 `config_error` 失败，不重试） |
| `CPRecv` 的 started / result / hb | `engine.ts` `onMessage`、`#started`、`#applyResult`（经 `#resultTask` 只接受在 Agent 手上、尝试序号一致的任务）、`#heartbeat`；`apps/server/src/engine/leases.ts` `renewHeld`、`MissedHeartbeats`、`agentLost`（hb 判丢的尝试记下强制取消）；hb 还经 `apps/server/src/agents/agent-hub.ts` `AgentConnection.heartbeat` 把连接记为已准备好（`ready`），第一次时 `#step` 提交后为这台 Agent 派发 |
| `FailAll` | `engine.ts` `#failTask` 的重试分支；`apps/server/src/engine/failures.ts` `shouldRetry` |
| `LeaseExpire` | `leases.ts` `expireTasks`、`agentLost`；`engine.ts` `#step`（提交后先跑 `afterCommit`，再发取消、再派发；`apps/server/src/engine/step.ts`）、`#sendCancel`；`agent-hub.ts` `connection`（只返回已推送 Welcome 的连接，即 `CPConnected`） |
| `CPOnline` | `engine.ts` `onOnline`（dispositions、`renewHeld` 不带 suspects、`#heartbeats.reset`；Welcome 里和调度无关的部分来自 `apps/server/src/agents/agent-environment.ts`，不在模型里；这时还没推送 Welcome，`agentLost` 记下的取消不发出；`AgentConnection.welcome` 之后连接在准备环境，不派发） |
| `Disconnect` | `agent-hub.ts` `detach`；断开的来源：Agent 一侧断线；`attach` 顶掉同名的旧连接（`old?.close()`）；停用 Agent、吊销凭据（`setDisabled`、`closeByCredentials`，在引擎的锁里 `AgentConnection.close`）；`apps/server/src/gateway/agent-gateway.ts` 的接收循环看到连接已关就退出，Agent 发来一条超过上限的消息时流以 `resource_exhausted` 结束（超限的那条没有解码，后面的都丢掉）。重连是新的 `AgentConnection`，阶段从头开始（`ready` 清除） |
| `OnAgent` | `packages/schema/src/http/runs.ts` `ON_AGENT_STATUSES` |
| `AgentConnect` | `agent/src/lib.rs` `run()` 循环、`agent/src/ledger.rs` `Ledger::hello`（持一次锁把结果待发的结果收为待 Ack、列出 `State::on_hand`） |
| `AgentWelcome` | `lib.rs` `run()` 里准备环境之后处理 `welcome.dispositions` 的 ABANDON（`Ledger::abandon`），`serve()` 开头重发待 Ack 的结果（`Ledger::unacked`）、立即发一次心跳（`Ledger::held`） |
| `AgentRecv` | `lib.rs` `serve()` 的 Assign（`Ledger::accept`）、Cancel（`Ledger::cancel`；它还有一个不来自协议的调用方：超时进入收尾时间时 `run_task` 的 `wind_down`，不算进 `stopSig`，见「范围」）与 Ack（`Runtime::acked` → `Ledger::ack`）分支 |
| `AgentStart` | `lib.rs` `Runtime::run_task` → `start_task` → `Ledger::started`；`agent/src/executor.rs` 发 `TaskStarted` |
| `AgentFinish` | `lib.rs` `Runtime::run_task`：执行器结束（`running.wait`）之后经 `agent/src/artifacts.rs` `Uploader::finish`、`upload_all` 上传产物并定下最终的结果（只会把成功换成不成功），末尾 `Ledger::finish`（一次持锁把执行中换成结果待发并记下结束时执行器有没有启动过，被放弃的任务的结果在这里丢弃，`Ledger::discarded` 叫醒 `serve`，只影响自更新的排空）；`Ledger::cancel`。被告知停止的尝试也可能报成功（取消在执行器退出之后、或开始上传之前到） |
| `AgentSendResult` / `AgentHeartbeat` | `lib.rs` `serve()` 的 `ledger.next_result`（`Ledger::next_result`）与 `heartbeat.tick` 分支（`Ledger::held`） |
| `AgentReplaceResult` | `lib.rs` `run()` 里 `serve()` 以「消息超过上限」（`resource_exhausted`，不论被拒的是不是结果）结束之后、重连之前调用 `Ledger::replace_results_over`（#723）：结果待发或待 Ack 里整条消息超过控制面一条消息上限的结果换成 `node_error` 失败，没超过的不动。模型里没有大小，断线之后任何一条成功的结果都可能被换成失败；反过来（失败换成成功）是错的，`mutants.sh` 的 `replace-fail-to-success` 守着。台账里的阶段不变，不增减任务 |
| 消息定义 | `proto/sfly/agent/v1/agent.proto` 的 Hello、Welcome、TaskAction、AssignTask、CancelTask、TaskResult、Heartbeat、Ack（之后加的字段都是内容：`package_index_url`、`artifact_limit_bytes`、`task_token`、`TaskError.location`） |

Agent 一侧「手上的任务」只有一个定义：`Ledger::held`（台账里的全部，不论阶段），模型里是 `Hand` 和 `HandStarted`；Hello 和每次心跳都按它列出，每个任务的 `started` 是真实的值：执行中的看执行器现在启动了没有，结果待发和待 Ack 的看结束时启动过没有。

判断一次改动要不要重新检查：

```sh
git diff --stat 879c61104a1a2821eee26732081c74031745b610 -- \
  apps/server/src/engine/engine.ts apps/server/src/engine/leases.ts apps/server/src/engine/failures.ts \
  apps/server/src/engine/step.ts apps/server/src/engine/foreign-agent-tasks.ts \
  apps/server/src/agents/agent-hub.ts apps/server/src/agents/agent-auth.ts apps/server/src/agents/dispatch-gate.ts \
  apps/server/src/gateway/agent-gateway.ts packages/schema/src/http/runs.ts \
  agent/src/lib.rs agent/src/ledger.rs agent/src/executor.rs agent/src/artifacts.rs \
  proto/sfly/agent/v1/agent.proto
```

有输出时，打开上表里对应的函数读一遍 diff：
- 改动落在表里的函数上，就要重新核对模型。
- 只改了这些文件里的其它部分（日志、指标、安装、UI 字段），可以不动模型，但仍要跑一次 `check.sh`。

### 核对的历史

- #214、#215（写这个 skill）：两条反例，已修，见「当前发现」。
- #408（同步提交 `f44b09d8`）：台账独占手上的任务。
- #492、#638、#719（Agent 凭据、停用 Agent、任务凭据、连接的项目、被拒绝之后不退出）：没有改模型，结论并进上面「范围」里认身份、任务凭据两条。
- #723、#728（结果有上界、超限的结果换成失败）：加了 `AgentReplaceResult` 和变异体 `replace-fail-to-success`。
- #738（同步提交移到 `879c6110`）：逐个读了 `f44b09d8` 到 `879c6110` 之间上面清单里的文件。模型只改了一处：`AgentFinish` 不再要求「没有被告知停止」才能报成功（代码里取消在执行器退出之后、开始上传之前到时照样报成功；同步提交时就是这样，#673 只把上传期间到的取消改成了 cancelled）。状态数从 365,921 / 5,602,537 / 6,842,713 变成 564,460 / 10,194,904 / 12,069,478（都无违例），加了变异体 `result-accepts-lost`（九个变异体都被抓到）。覆盖表补上 `artifacts.rs`、`step.ts`、断开连接的新来源，`foreign-agent-tasks.ts`、`ledger.rs` 里两处说错了协议行为的注释改正，`git diff` 的清单补上 `step.ts`、`foreign-agent-tasks.ts`、`dispatch-gate.ts`、`artifacts.rs`；「范围」补上 `failForeignAgentTasks`、`wind_down`、跨连接迟到的消息。
- #449（同一台 Agent 上同一个节点包的另一个版本正在执行时，派发时任务以 `env_error` 失败）：没有改模型，没有移动同步提交。`#prepareAssign` 在核对连接的项目之后多了一次只读的查询（这台 Agent 上准备中、执行中的任务各用哪个版本，`version-conflict.ts`），冲突时任务在同一个事务里失败、不发给 Agent，和已有的「项目不符、派发内容准备不好时失败」是同一种路径：没有新的消息、状态转移和同步点，派发的条件（`AssignOnlyWhenReady`、槽位）没有动。冲突要有两个节点包或两个运行在同一台 Agent 上，在模型的范围之外；`env_error` 不重试也不在模型里（「范围」第 4 条）。`check.sh` 三个配置的状态数和上一条一样（都无违例），九个变异体都被抓到。

## 读结果

模型检查的结果请用户运行 pstack 的 `/statechart` 来读（它只能由用户手动启动）。违例时它把最短反例讲成白话步骤，通过时画出状态之间怎么迁移。自己读原始输出时：TLC 打印 `Error: Invariant X is violated.`，后面是 `State 1 … State N`，每个状态前写着动作名（如 `<Dispatch(1) …>`），对照上面的覆盖表翻译成代码里的步骤。

拿到 `DIFF` 之后，按反例逐步对照代码，判断是哪一种：

- **真问题。** 每一步在代码里都能发生，没有违背时序假设，就是一个新发现。如实写进「当前发现」，附上用代码术语讲的步骤，告诉用户，不要改性质或模型让它通过，也不要擅自改产品代码。
- **建模错误。** 某一步在代码里不可能发生，比如两个动作在代码里在同一个事务里，或者违反了配置的时序假设。修正模型，在动作的注释里写明代码依据，再跑一次 `check.sh` 和 `mutants.sh`。这个 skill 写的时候就遇到过一次：最初的「投递及时」没排除「两次心跳都还没被处理」，反例里控制面积压了 10 秒以上的消息，于是给 `AgentHeartbeat` 加了「上一次心跳已被处理」这个条件。
- **发现被修复了**（期望违例的配置变成 `pass`）：确认修复的代码已经映射进模型，在 `check.sh` 里把期望改成 `pass`，删掉「当前发现」里对应的一条。

## 有意改动协议时

1. 改代码的同时，修改模型中对应的动作（看覆盖表），动作注释里写上新的代码位置。
2. 新增的行为如果能破坏上面的承诺，就加一个变异体到 `mutants.sh`：模型里对应检查那一行原文，加上改坏后的样子，再加上期望抓到它的不变式。
3. 跑 `check.sh` 和 `mutants.sh`，两者都要退出码 0（或者把新的发现记进来）。
4. 读完 diff、确认模型描述的就是新提交上的代码之后，才把上面的**同步提交**改成新的提交号，覆盖表也一并更新。只跑通检查、没核对代码，不要移动同步提交。

扩大范围（比如加第二个节点来覆盖 `#dispatch` 的槽位计数，或者加运行取消）时，状态数会大幅增长。改完之后确认 `check.sh` 没有明显超过现在的一分半钟，否则缩小 `MaxAttempt` 或 `MaxInFlight`，并在「范围」里写清楚。
