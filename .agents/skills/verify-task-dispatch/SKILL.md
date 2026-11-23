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
.agents/skills/verify-task-dispatch/scripts/check.sh     # 约 2 分钟（大部分是 SlowDelivery）；退出码 0 = 结果与下面记录的一致
.agents/skills/verify-task-dispatch/scripts/mutants.sh   # 约 5 秒；确认每条性质仍然能失败
```

第一次运行时，脚本会用 mise 装 Temurin 21（`java@temurin-21.0.13+9.0.LTS`），下载 tla2tools 1.8.0 到 `~/.cache/sfly-formal/` 并校验 sha256，都不改动仓库。完整输出和反例写到 `~/.local/state/sfly-formal/<时间>/<配置>.txt`。

`check.sh` 跑三个配置（`model/*.cfg`），范围都一样：一个 Agent、一个包节点、`retries = 2`（3 次尝试）、1 个槽位、每个方向最多 3 条在途消息，断线和重连的次数不限。

| 配置 | 时序假设 | 期望 |
|---|---|---|
| `Safe` | 心跳不迟到，投递及时 | 无违例，约 32.8 万个不同状态 |
| `LateHeartbeats` | 连接正常时租约也可能过期 | 无违例，约 541 万个不同状态 |
| `SlowDelivery` | 消息可能晚于两个心跳周期才被处理 | 无违例，约 660 万个不同状态 |

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

在上面的范围和时序假设内，三个配置各自穷举了所有消息交错、断线时机、执行结果（成功或失败）和租约到期时机。两个时序假设同时不成立（`LateHeartbeats = TRUE` 且 `PromptDelivery = FALSE`）时也在同步提交上穷举过一次，五条性质都成立（约 1320 万个不同状态，约 1 分钟），没有放进 `check.sh`。以下不在模型里，结论不覆盖：

- 多个节点或多个运行共享槽位。只有一个节点时同一时刻最多一个尝试在排队，所以 **`#dispatch` 里按 `slots` 计数这一处没有被验证**，`SlotBound` 守护的是「Hello 要上报安装中的任务」和「放弃的任务要杀掉」。
- 运行取消（`cancel`、`#cancelChain`、`#resendCancels`）、停止子流程节点（docs/SEMANTICS.md §4.1）、立即更新（UpdateNow）和自更新排空、版本不一致时不派发。`agent_lost` 时的强制取消在模型里，但取消只建模成「被告知停止」，不区分优雅取消和强制取消。
- 控制面重启（`extendForRecovery`）、多个控制面连接同一个 Agent、令牌本身（谁能连、项目从哪来）。认身份的结果只通过「连不连得上」影响协议，见下面「#492 的核对」。
- 失败类型的区别：模型里所有失败都按 `retries` 重试；`env_error` 和 `config_error` 不重试，这一点没有建模。结果写不进数据库时按 `node_error` 失败（#207）也没有建模，模型里成功的结果总被记为成功。
- 「结果已交出、还没发出」的任务有没有被漏报（#132）：Hello 或心跳少列了这样一个任务，只会让控制面多一次 `agent_lost`、多重试一次（旧尝试已经结束），不会破坏上面五条性质，所以模型里没有对应的性质。漏报还在安装或执行中的任务不一样：`SlotBound` 会抓到（`mutants.sh` 的 `hello-omits-installing`）。这一条由 `agent/src/ledger.rs` 的单元测试守着（`hello_lists_a_task_that_finished_before_it_was_listed` 等）。
- 动作摘要和明细（`ActionSummary`、`ActionBatch`，#345）：和日志一样走遥测通道，由 `apps/server/src/actions/task-actions.ts` 处理（`engine.ts` `onMessage` 不碰），不回 Ack、不续租约、不改任务状态，对派发协议没有影响。
- TaskStarted 走遥测通道，可能晚于结果或丢失，模型里断线时丢失、连接时按顺序送达；心跳里的 `started` 补记保证了结论不依赖它。
  心跳和 Hello 里的 `started` 按执行器子进程有没有启动过如实报，已经结束的任务也一样（`Finished::started`）：没启动就结束的任务（安装失败等）不会被补记成 running、写上开始时间。模型里 `HandStarted` 描述了这一点，但没有性质守着它（它只影响 `startedAt` 记得准不准，不影响上面五条），由 `agent/src/ledger.rs` 的单元测试守着（`a_finished_task_reports_whether_its_executor_ever_started` 等）。
- 真实时间。租约多久过期、心跳多快，都用上面两个开关表达。

## 覆盖记录

**同步提交：`f44b09d802296f4f2b14954671995eb7828bf54a`**（在这个提交上确认过模型与下列代码一致）。

| 模型里的动作 | 代码 |
|---|---|
| `Dispatch` | `apps/server/src/engine/engine.ts` `#dispatch`（只派给 `AgentConnection.ready` 的连接，即 `ready`；能不能接新任务的判断在 `apps/server/src/agents/dispatch-gate.ts`，页面上「排队中的任务在等什么」（`queue-wait.ts`）用的是同一段，不改状态转移）、`#prepareAssign`（派发即设租约；派什么由 `assign-content.ts` 回答，不在模型里） |
| `CPRecv` 的 started / result / hb | `engine.ts` `onMessage`、`#started`、`#applyResult`、`#heartbeat`；`apps/server/src/engine/leases.ts` `renewHeld`、`MissedHeartbeats`、`agentLost`（hb 判丢的尝试记下强制取消）；hb 还经 `apps/server/src/agents/agent-hub.ts` `AgentConnection.heartbeat` 把连接记为已准备好（`ready`），第一次时 `#step` 提交后为这台 Agent 派发 |
| `FailAll` | `engine.ts` `#failTask` 的重试分支；`apps/server/src/engine/failures.ts` `shouldRetry` |
| `LeaseExpire` | `leases.ts` `expireTasks`、`agentLost`；`engine.ts` `#step`（提交后先发取消、再派发）、`#sendCancel`；`apps/server/src/agents/agent-hub.ts` `connection`（只返回已推送 Welcome 的连接，即 `CPConnected`） |
| `CPOnline` | `engine.ts` `onOnline`（dispositions、`renewHeld` 不带 suspects、`#heartbeats.reset`；Welcome 里和调度无关的部分来自 `apps/server/src/agents/agent-environment.ts`，不在模型里；这时还没推送 Welcome，`agentLost` 记下的取消不发出；`AgentConnection.welcome` 之后连接在准备环境，不派发） |
| `Disconnect` | `agent-hub.ts` `detach`；重连是新的 `AgentConnection`，阶段从头开始（`ready` 清除） |
| `OnAgent` | `packages/schema/src/http/runs.ts` `ON_AGENT_STATUSES` |
| `AgentConnect` | `agent/src/lib.rs` `run()` 循环、`agent/src/ledger.rs` `Ledger::hello`（持一次锁把结果待发的结果收为待 Ack、列出 `State::on_hand`） |
| `AgentWelcome` | `lib.rs` `run()` 里准备环境之后处理 `welcome.dispositions` 的 ABANDON（`Ledger::abandon`），`serve()` 开头重发待 Ack 的结果（`Ledger::unacked`）、立即发一次心跳（`Ledger::held`） |
| `AgentRecv` | `lib.rs` `serve()` 的 Assign（`Ledger::accept`）、Cancel（`Ledger::cancel`）与 Ack（`Runtime::acked` → `Ledger::ack`）分支 |
| `AgentStart` | `lib.rs` `Runtime::run_task` → `start_task` → `Ledger::started`；`agent/src/executor.rs` 发 `TaskStarted` |
| `AgentFinish` | `lib.rs` `Runtime::run_task` 末尾 `Ledger::finish`（一次持锁把执行中换成结果待发并记下结束时执行器有没有启动过，被放弃的任务的结果在这里丢弃，`Ledger::discarded` 叫醒 `serve`，只影响自更新的排空）；`Ledger::cancel` |
| `AgentSendResult` / `AgentHeartbeat` | `lib.rs` `serve()` 的 `ledger.next_result`（`Ledger::next_result`）与 `heartbeat.tick` 分支（`Ledger::held`） |
| 消息定义 | `proto/sfly/agent/v1/agent.proto` 的 Hello、Welcome、TaskAction、AssignTask、CancelTask、TaskResult、Heartbeat、Ack |

Agent 一侧「手上的任务」只有一个定义：`Ledger::held`（台账里的全部，不论阶段），模型里是 `Hand` 和 `HandStarted`；Hello 和每次心跳都按它列出，每个任务的 `started` 是真实的值：执行中的看执行器现在启动了没有，结果待发和待 Ack 的看结束时启动过没有。

判断一次改动要不要重新检查：

```sh
git diff --stat f44b09d802296f4f2b14954671995eb7828bf54a -- \
  apps/server/src/engine/engine.ts apps/server/src/engine/leases.ts apps/server/src/engine/failures.ts \
  apps/server/src/agents/agent-hub.ts apps/server/src/agents/agent-auth.ts apps/server/src/gateway/agent-gateway.ts packages/schema/src/http/runs.ts agent/src/lib.rs agent/src/ledger.rs agent/src/executor.rs \
  proto/sfly/agent/v1/agent.proto
```

有输出时，打开上表里对应的函数读一遍 diff：
- 改动落在表里的函数上，就要重新核对模型。
- 只改了这些文件里的其它部分（日志、指标、安装、UI 字段），可以不动模型，但仍要跑一次 `check.sh`。

## #492 的核对（Agent 凭据、停用 Agent、任务凭据）

改了 Hello 的处理、`AssignTask` 加字段、停用 Agent 让任务按 `agent_lost` 处理。逐项对照模型，**没有改模型，也没有移动上面的同步提交**（同步提交之后别的改动还没有逐个核对）。`check.sh` 三个配置的结果和上面一致（Safe 327,997、LateHeartbeats 5,410,113、SlowDelivery 6,596,137 个不同状态，都无违例），`mutants.sh` 七个变异体都被抓到。核对的结论：

- **Hello 被拒绝**（凭据无效、吊销、名字和凭据不一致、所属用户或这台 Agent 被停用、登记工作台之后只认 Agent 凭据、同名顶掉规则不允许：`agents/agent-auth.ts` `AgentAuthenticator`、`agents/agent-hub.ts` `attach`、`gateway/agent-gateway.ts`）：没有连接登记进连接表，没有 Welcome，Agent 一侧是连接失败后重连。模型里 `Disconnect` 之后 Agent 离线多久都可以（重连次数不限），被拒绝的 Hello 就是一次没有发生的 `AgentConnect`，不引入新的状态。拒绝发生在 `attach` 登记之前，没有碰任务和租约。
- **认身份和登记之间的空档**：`attach` 在引擎的锁里先再确认一遍（`verify`：凭据没吊销、所属用户没停用、Agent 没停用、登记工作台之后不是以旧方式连接），吊销、用户停用、停用 Agent 断开连接也在同一把锁里（`closeByCredentials`、`setDisabled`），不会有已经没有资格的连接留在连接表里。这个锁就是引擎的锁，和 `CPOnline`、`Disconnect` 共用，不会让连接的登记和已有的状态迁移交错。
- **停用或吊销时断开连接**（`AgentConnection.close`）：就是模型的 `Disconnect`。它手上的任务没有新的处理：控制面照旧等租约过期，走 `LeaseExpire` → `agentLost` 的强制取消和 `retries` 重试；停用期间 Agent 连不上，所以第 2 次尝试留在队列里，恢复后重连才派发。同一条路径有测试：`apps/server/test/agent-disable-dispatch.test.ts`。重连被拒绝所以 Welcome 里的放弃不会发生，旧尝试只由租约过期结束。
- **`AssignTask.task_token`**：`engine.ts` `#prepareAssign` 在「记为 dispatched 并设租约」的同一个事务里签发任务凭据（`agents/task-credentials.ts`），加在消息里；没有新的状态转移，派发的条件（`AssignOnlyWhenReady`、槽位）没有动。任务凭据是否有效由任务当前的状态得出（还在 Agent 手上），不另有吊销动作，所以不会有哪条路径漏掉。

### #638 审查之后的再核对（连接的项目、旧方式只认凭据、任务凭据随 Agent 状态）

审查之后又改了三处，逐项对照模型，**没有改模型，也没有移动同步提交**：

- **连接的项目**（`AgentConnection.project`，`attach` 在引擎的锁里核对「已登记的项目等于连接的项目」，`#prepareAssign` 比较连接的项目和运行的项目）：派发前多了一次**只读的比较**，比较的两边（连接的项目、运行的项目）在连接建立、运行创建之后都不再变；比不上时任务以 `config_error` 失败，这条路径在 #629 之前就有（比较的对象从登记记录的项目换成连接的项目），**没有新的状态转移，没有新的同步点，没有动派发的先后条件**（`AssignOnlyWhenReady`、槽位）。`attach` 多了一次读库和一次拒绝，都在登记之前、引擎的锁里，和上面「认身份和登记之间的空档」同一把锁；被拒绝的 Hello 仍然是一次没有发生的 `AgentConnect`。
- **名字有没被吊销的 Agent 凭据就只认凭据**、Hello 三种情况同一句话、先比项目后看停用：都只改「这次 Hello 连不连得上」，同上，不碰任务和租约。
- **停用、吊销之后任务凭据立刻不认**（`taskIsActive` 多看这台 Agent 的停用和凭据）：任务凭据只用于下载产物的 HTTP 请求，不在派发、结果、心跳、租约的任何一步里；它不改变任务的状态，所以和模型无关（任务照旧等租约过期走 `agent_lost`）。

`check.sh`、`mutants.sh` 重新跑过，结果和上面一致。

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

扩大范围（比如加第二个节点来覆盖 `#dispatch` 的槽位计数，或者加运行取消）时，状态数会大幅增长。改完之后确认 `check.sh` 没有明显超过现在的两分钟，否则缩小 `MaxAttempt` 或 `MaxInFlight`，并在「范围」里写清楚。
