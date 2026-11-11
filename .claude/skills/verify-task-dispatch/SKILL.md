---
name: verify-task-dispatch
description: 用 TLA+ 模型检查器 TLC 穷举验证 sfly 控制面与 Agent 之间的任务派发协议（派发、TaskStarted、结果与 Ack、心跳续约、租约过期以 agent_lost 重试、断线重连时 Hello/Welcome 的继续或放弃）。改动 apps/server/src/engine/engine.ts 或 leases.ts 里的派发、结果、心跳、租约、重试逻辑，agent/src/lib.rs 里的 Hello/Welcome、serve 循环、run_task，或者 proto/sfly/agent/v1/agent.proto 的这些消息时使用：检查同一个节点的两次尝试会不会在 Agent 上同时执行、槽位会不会被超用、一个节点会不会接受两次成功。
---

# 验证任务派发协议

## 这次检查回答的问题

**承诺：** 控制面重新执行一个节点时（重试一个新尝试），Agent 上这个节点较早的尝试要么已经结束，要么已经被告知停止。

**被打破的危害：** 同一个节点的代码在同一台 Agent 上同时跑两份，副作用做两遍（比如起了两个常驻进程、往被测系统发了两遍请求）。旧的那份还没人管，会一直跑到它自己结束，最长可达节点超时（默认 1 小时）。同时 Agent 实际执行的任务数超过槽位。

一起检查的性质（`model/TaskDispatch.tla` 末尾）：

| 不变式 | 白话 |
|---|---|
| `NoUnstoppedDuplicate` | 较新的尝试已经启动执行器时，较早的尝试要么已结束，要么已被 `cancel_task` 告知停止 |
| `SlotBound` | 没被告知停止的任务（安装中和执行中都算）不超过 Agent 的槽位 |
| `AtMostOneSuccess` | 一个节点最多一次尝试被记为 `success` |
| `SuccessWasRun` | 被记为 `success` 的尝试确实在 Agent 上执行成功了 |

## 运行

```sh
.claude/skills/verify-task-dispatch/scripts/check.sh     # 约 5 秒；退出码 0 = 结果与下面记录的一致
.claude/skills/verify-task-dispatch/scripts/mutants.sh   # 约 6 秒；确认每条性质仍然能失败
```

第一次运行时，脚本会用 mise 装 Temurin 21（`java@temurin-21.0.13+9.0.LTS`），下载 tla2tools 1.8.0 到 `~/.cache/sfly-formal/` 并校验 sha256，都不改动仓库。完整输出和反例写到 `~/.local/state/sfly-formal/<时间>/<配置>.txt`。

`check.sh` 跑三个配置（`model/*.cfg`），范围都一样：一个 Agent、一个包节点、`retries = 2`（3 次尝试）、1 个槽位、每个方向最多 3 条在途消息，断线和重连的次数不限。

| 配置 | 时序假设 | 期望 |
|---|---|---|
| `Safe` | 心跳不迟到，投递及时 | 无违例，约 19.9 万个不同状态 |
| `LateHeartbeats` | 连接正常时租约也可能过期 | `NoUnstoppedDuplicate` 被违反（发现 1） |
| `SlowDelivery` | 消息可能晚于两个心跳周期才被处理 | `NoUnstoppedDuplicate` 被违反（发现 2） |

两个时序假设的具体含义：
- **心跳不迟到**（`LateHeartbeats = FALSE`）：连接正常时，心跳总能在 30 秒租约内被控制面处理，租约只在断线期间过期。
- **投递及时**（`PromptDelivery = TRUE`）：Agent 手上还有没处理的控制面消息、还有没交给 serve 循环的结果、或者上一次心跳控制面还没处理时，不会发下一次心跳。10 秒的心跳间隔远大于投递延迟。

`check.sh` 的输出：
- `ok`：和这里记录的一致。
- `DIFF`：结果变了，按下面「读结果」处理。
- `ERROR`：模型语法错误或工具出错，看对应的输出文件。

## 当前发现（在同步提交上成立）

**发现 1：租约在连接正常时过期，同一个节点会在 Agent 上同时跑两份。** 最短路径，11 步：
1. Agent 连上控制面（Hello），控制面处理 `onOnline`，发出 Welcome，紧接着 `#dispatch` 派发第 1 次尝试，`#prepareAssign` 把租约设成 30 秒之后。
2. Agent 收到 Welcome 后，先执行 `prepare_environment` 和 `ensure_sdk`（安装 uv、`uv venv` 下载 Python、安装 SDK wheel），然后才进入 `serve()`。这期间不读派发消息，也不发心跳。
3. 这段时间超过 30 秒：`expireTasks` 让第 1 次尝试以 `agent_lost` 失败，`#failTask` 在同一个 Agent 上排队第 2 次尝试，`#dispatch` 发现槽位空出来了，立刻派发。连接一直正常，没有任何一方给 Agent 发取消。
4. Agent 进入 `serve()`，依次收到两条 Assign。`Runtime::accept` 不检查槽位，也不知道这是同一个节点（每次尝试的 task_id 都不同），两次尝试都启动执行器。
5. 之后 Agent 的心跳会上报第 1 次尝试，但 `renewHeld` 只看控制面仍在等的任务，第 1 次尝试的行已经是 `failed`，被忽略。直到它自己结束之前都没人停它，结果也会被 `#applyResult` 丢弃。

能触发它的真实情况：
- 新装的 Agent，或者 venv 被删掉的 Agent 首次连接时，已经有任务在排队等它（`queue_timeout` 默认 10 分钟，正是为「Agent 还没上线」准备的），而环境准备超过 30 秒。
- 已在 `serve()` 中的 Agent，如果心跳被别的分支挤占，或者控制面处理心跳慢了 30 秒以上，也会触发。

`retries = 0` 时没有第 2 次尝试，但第 1 次尝试仍会在控制面已经判它失败之后继续执行。

**发现 2：派发消息晚到超过两个心跳周期时，同样会出现两份。** 控制面派发第 1 次尝试，Agent 在收到这条 Assign 之前连发了两次心跳（都不含它），`renewHeld` 按「连续两次没上报」判它 `agent_lost`，再派发第 2 次尝试，之后 Agent 先后收到两条 Assign，两次都执行。代码注释里也说「第一次可能是心跳与派发消息在路上交错」，容忍的正是一次交错。

两个发现的共同根因：控制面放弃一次尝试、重新派发到同一个 Agent 时，只在 Agent **重连**时通过 Welcome 的 ABANDON 告诉它停止旧尝试。连接正常时，Agent 在心跳里上报的、控制面已经放弃的尝试没有人去取消，Agent 本身也不拒绝超出槽位的派发。修复与否由维护者决定，这个 skill 不改产品代码。

## 范围：验证了什么，没验证什么

在上面的范围和时序假设内，`Safe` 穷举了所有消息交错、断线时机、执行结果（成功或失败）和租约到期时机。以下不在模型里，结论不覆盖：

- 多个节点或多个运行共享槽位。只有一个节点时同一时刻最多一个尝试在排队，所以 **`#dispatch` 里按 `slots` 计数这一处没有被验证**，`SlotBound` 守护的是「Hello 要上报安装中的任务」和「放弃的任务要杀掉」。
- 运行取消和强制取消（`cancel`、`#cancelChain`、`#resendCancels`）、停止子流程（§4.1）、定时和 Sleep 节点、立即更新（UpdateNow）和自更新排空、版本不一致时不派发。
- 控制面重启（`extendForRecovery`）、多个控制面连接同一个 Agent、令牌。
- 失败类型的区别：模型里所有失败都按 `retries` 重试；`env_error` 和 `config_error` 不重试，这一点没有建模。
- TaskStarted 走遥测通道，可能晚于结果或丢失，模型里断线时丢失、连接时按顺序送达；心跳里的 `started` 补记保证了结论不依赖它。
- 真实时间。租约多久过期、心跳多快，都用上面两个开关表达。

## 覆盖记录

**同步提交：`388b9004499925835625a0cbf16dc82ade5ce179`**（在这个提交上确认过模型与下列代码一致）。

| 模型里的动作 | 代码 |
|---|---|
| `Dispatch` | `apps/server/src/engine/engine.ts` `#dispatch`、`#prepareAssign`（派发即设租约） |
| `CPRecv` 的 started / result / hb | `engine.ts` `onMessage`、`#started`、`#applyResult`、`#heartbeat`；`apps/server/src/engine/leases.ts` `renewHeld`、`MissedHeartbeats` |
| `FailAll` | `engine.ts` `#failTask` 的重试分支；`apps/server/src/engine/failures.ts` `shouldRetry` |
| `LeaseExpire` | `leases.ts` `expireTasks`、`agentLost` |
| `CPOnline` | `engine.ts` `onOnline`（dispositions、`renewHeld` 不带 suspects、`#heartbeats.reset`） |
| `OnAgent` | `packages/schema/src/http/runs.ts` `ON_AGENT_STATUSES` |
| `AgentConnect` | `agent/src/lib.rs` `run()` 循环、`Runtime::held_collecting`、`held_tasks`、`collect_results` |
| `AgentWelcome` | `lib.rs` `run()` 里处理 `welcome.dispositions` 的 ABANDON，`serve()` 开头重发 unacked |
| `AgentRecv` | `lib.rs` `serve()` 的 Assign（`Runtime::accept`）与 Ack 分支 |
| `AgentStart` | `lib.rs` `Runtime::run_task` → `start_task`；`agent/src/executor.rs` 发 `TaskStarted` |
| `AgentFinish` | `lib.rs` `Runtime::run_task` 末尾持 `cancels` 锁交出结果；`Runtime::cancel_task` |
| `AgentSendResult` / `AgentHeartbeat` | `lib.rs` `serve()` 的 `results.recv` 与 `heartbeat.tick` 分支（`Runtime::held`） |
| 消息定义 | `proto/sfly/agent/v1/agent.proto` 的 Hello、Welcome、TaskAction、AssignTask、TaskResult、Heartbeat、Ack |

判断一次改动要不要重新检查：

```sh
git diff --stat 388b9004499925835625a0cbf16dc82ade5ce179 -- \
  apps/server/src/engine/engine.ts apps/server/src/engine/leases.ts apps/server/src/engine/failures.ts \
  packages/schema/src/http/runs.ts agent/src/lib.rs agent/src/executor.rs proto/sfly/agent/v1/agent.proto
```

有输出时，打开上表里对应的函数读一遍 diff：
- 改动落在表里的函数上，就要重新核对模型。
- 只改了这些文件里的其它部分（日志、指标、安装、UI 字段），可以不动模型，但仍要跑一次 `check.sh`。

## 读结果

模型检查的结果请用户运行 pstack 的 `/statechart` 来读（它只能由用户手动启动）。违例时它把最短反例讲成白话步骤，通过时画出状态之间怎么迁移。自己读原始输出时：TLC 打印 `Error: Invariant X is violated.`，后面是 `State 1 … State N`，每个状态前写着动作名（如 `<Dispatch(1) …>`），对照上面的覆盖表翻译成代码里的步骤。

拿到 `DIFF` 之后，按反例逐步对照代码，判断是哪一种：

- **真问题。** 每一步在代码里都能发生，没有违背时序假设，就是一个新发现。如实写进「当前发现」，附上用代码术语讲的步骤，告诉用户，不要改性质或模型让它通过，也不要擅自改产品代码。
- **建模错误。** 某一步在代码里不可能发生，比如两个动作在代码里在同一个事务里，或者违反了配置的时序假设。修正模型，在动作的注释里写明代码依据，再跑一次 `check.sh` 和 `mutants.sh`。这个 skill 写的时候就遇到过一次：最初的「投递及时」没排除「两次心跳都还没被处理」，反例里控制面积压了 10 秒以上的消息，于是给 `AgentHeartbeat` 加了「上一次心跳已被处理」这个条件。
- **发现被修复了**（`LateHeartbeats` 或 `SlowDelivery` 变成 `pass`）：确认修复的代码已经映射进模型，在 `check.sh` 里把期望改成 `pass`，删掉「当前发现」里对应的一条。

## 有意改动协议时

1. 改代码的同时，修改模型中对应的动作（看覆盖表），动作注释里写上新的代码位置。
2. 新增的行为如果能破坏上面四条承诺，就加一个变异体到 `mutants.sh`：模型里对应检查那一行原文，加上改坏后的样子，再加上期望抓到它的不变式。
3. 跑 `check.sh` 和 `mutants.sh`，两者都要退出码 0（或者把新的发现记进来）。
4. 读完 diff、确认模型描述的就是新提交上的代码之后，才把上面的**同步提交**改成新的提交号，覆盖表也一并更新。只跑通检查、没核对代码，不要移动同步提交。

扩大范围（比如加第二个节点来覆盖 `#dispatch` 的槽位计数，或者加运行取消）时，状态数会大幅增长。改完之后确认 `check.sh` 仍在一分钟以内，否则缩小 `MaxAttempt` 或 `MaxInFlight`，并在「范围」里写清楚。
