---------------------------- MODULE TaskDispatch ----------------------------
(***************************************************************************)
(* 控制面与 Agent 之间的任务派发、心跳续约、租约过期重试、断线重连协议。     *)
(* 一个 Agent、一个包节点（retries = MaxAttempt - 1），每次尝试是一个任务行。 *)
(* 每个动作的注释写明它对应的代码；动作内部的更新在代码里是同一个事务/同一   *)
(* 段持锁代码，所以建模成一步。                                             *)
(*                                                                         *)
(* 时间不建模，用两个开关表达时序假设：                                      *)
(*   LateHeartbeats = FALSE：连接正常时租约不会过期（心跳总能在 30 秒租约内   *)
(*                   被控制面处理）；断线期间租约照常过期。                  *)
(*   PromptDelivery = TRUE：两边都在一个心跳间隔（10 秒）内处理完对方的消息： *)
(*                   Agent 手上还有没处理的控制面消息、还有没交给 serve 循环 *)
(*                   的结果、或上一次心跳控制面还没处理时，不会发下一次心跳。 *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS MaxAttempt, Slots, LateHeartbeats, PromptDelivery, MaxInFlight

Attempts == 1..MaxAttempt
\* packages/schema/src/http/runs.ts ON_AGENT_STATUSES
OnAgent == {"dispatched", "running"}

VARIABLES
    cp,          \* 控制面 tasks 行的 status（按 attempt）
    suspects,    \* leases.ts MissedHeartbeats：上一次心跳没上报的尝试
    conn,        \* "down" | "hello"（Agent 已发 Hello）| "welcome"（控制面已处理 onOnline、发出 Welcome；Agent 在准备环境）| "up"（Agent 进入 serve 循环）
    ready,       \* 控制面这条连接已收到 Welcome 之后的第一次心跳（agent-hub.ts 连接阶段 ready）：只有这时才派发
    toCP,        \* Agent -> 控制面 的 gRPC 流（TaskStarted / TaskResult / Heartbeat）
    toAgent,     \* 控制面 -> Agent 的 gRPC 流（Assign / Cancel / Ack）
    ag,          \* Agent 上每次尝试：none | held（在 cancels 里，安装/准备中）| started（执行器已启动）| done（run_task 已结束）
    stopSig,     \* Agent 已对它调用 cancel_task（被告知停止）的尝试
    chan,        \* results 通道里、还没被 serve 收下的结果 <<attempt, ok>>
    unacked,     \* 已上报、还没收到 Ack 的结果 <<attempt, ok>>
    abandoned,   \* 控制面在 Welcome 中放弃、结果不再上报的尝试
    hello,       \* 最近一次 Hello 的 running_tasks
    welcome,     \* 最近一次 Welcome 里放弃（ABANDON）的尝试
    okFinished   \* 真的在 Agent 上成功执行完的尝试（只用于检查）

vars == <<cp, suspects, conn, ready, toCP, toAgent, ag, stopSig, chan, unacked,
          abandoned, hello, welcome, okFinished>>

AttemptsOf(R) == {r[1] : r \in R}
Holding == {b \in Attempts : ag[b] \in {"held", "started"}}
StartedOnAgent == {b \in Attempts : ag[b] = "started"}

\* engine.ts #failTask：任务 failed；可重试时在同一个 Agent 上排队 attempt + 1。
\* 所有失败（node_error / timeout / agent_lost）都按 retries 重试。
FailAll(f, L) ==
    [b \in Attempts |->
        IF b \in L THEN "failed"
        ELSE IF b > 1 /\ (b - 1) \in L /\ f[b] = "none" THEN "queued"
        ELSE f[b]]

\* engine.ts #started：只把 dispatched 的当前尝试改成 running。
MarkStarted(f, S) ==
    [b \in Attempts |-> IF b \in S /\ f[b] = "dispatched" THEN "running" ELSE f[b]]

RECURSIVE ResultMsgs(_)
ResultMsgs(S) ==
    IF S = {} THEN <<>>
    ELSE LET r == CHOOSE x \in S : TRUE
         IN <<[type |-> "result", a |-> r[1], ok |-> r[2]]>> \o ResultMsgs(S \ {r})

Init ==
    /\ cp = [b \in Attempts |-> IF b = 1 THEN "queued" ELSE "none"]
    /\ suspects = {}
    /\ conn = "down"
    /\ ready = FALSE
    /\ toCP = <<>>
    /\ toAgent = <<>>
    /\ ag = [b \in Attempts |-> "none"]
    /\ stopSig = {}
    /\ chan = {}
    /\ unacked = {}
    /\ abandoned = {}
    /\ hello = [held |-> {}, started |-> {}]
    /\ welcome = {}
    /\ okFinished = {}

CPConnected == conn \in {"welcome", "up"}

(* ------------------------------ 控制面 --------------------------------- *)

\* engine.ts #dispatch + #prepareAssign：Agent 在线并已准备好环境（AgentConnection.ready）、ON_AGENT 数小于 slots 时派发排队任务。
Dispatch(a) ==
    /\ CPConnected
    /\ ready
    /\ cp[a] = "queued"
    /\ Cardinality({b \in Attempts : cp[b] \in OnAgent}) < Slots
    /\ cp' = [cp EXCEPT ![a] = "dispatched"]
    /\ toAgent' = Append(toAgent, [type |-> "assign", a |-> a])
    /\ UNCHANGED <<suspects, conn, ready, toCP, ag, stopSig, chan, unacked, abandoned,
                   hello, welcome, okFinished>>

\* engine.ts onMessage：started -> #started；result -> #applyResult 后回 Ack；
\* heartbeat -> #heartbeat（leases.ts renewHeld 带 suspects，再按 started 补记 running），
\* 并把连接记为已准备好（AgentConnection.heartbeat；第一次时 #step 提交后为这台 Agent 派发，即之后的 Dispatch）。
\* agent_lost 的尝试由 leases.ts agentLost 记下强制取消，#step 在事务提交后、#dispatch 之前发出。
CPRecv ==
    /\ CPConnected
    /\ toCP # <<>>
    /\ LET m == Head(toCP) IN
        /\ toCP' = Tail(toCP)
        /\ CASE m.type = "started" ->
                    /\ cp' = MarkStarted(cp, {m.a})
                    /\ UNCHANGED <<suspects, ready, toAgent>>
             [] m.type = "result" ->
                    \* #applyResult：只接受 attempt 一致、状态在 ON_AGENT、派给这个 Agent 的那次尝试。
                    /\ cp' = IF cp[m.a] \notin OnAgent THEN cp
                             ELSE IF m.ok THEN [cp EXCEPT ![m.a] = "success"]
                             ELSE FailAll(cp, {m.a})
                    /\ toAgent' = Append(toAgent, [type |-> "ack", a |-> m.a])
                    /\ UNCHANGED <<suspects, ready>>
             [] m.type = "hb" ->
                    LET mine    == {b \in Attempts : cp[b] \in OnAgent}
                        missing == mine \ m.held
                        lost    == missing \cap suspects
                    IN /\ suspects' = missing
                       /\ ready' = TRUE
                       /\ cp' = MarkStarted(FailAll(cp, lost), m.started)
                       /\ toAgent' = IF lost = {} THEN toAgent
                                     ELSE Append(toAgent, [type |-> "cancel", as |-> lost])
    /\ UNCHANGED <<conn, ag, stopSig, chan, unacked, abandoned, hello, welcome, okFinished>>

\* leases.ts expireTasks：租约过期的 ON_AGENT 任务以 agent_lost 失败（按 retries 派回同一个 Agent）。
\* 断线期间没有心跳，租约会过期；连接正常时只有心跳迟到才会过期（LateHeartbeats）。
\* agentLost 同时记下强制取消，#step 提交后经 #sendCancel 发出；#sendCancel 只发给已推送 Welcome 的连接
\*（agent-hub.ts connection），没有这样的连接时什么也不发，重连后由 Welcome 的 ABANDON 停掉。
LeaseExpire(a) ==
    /\ cp[a] \in OnAgent
    /\ conn \in {"down", "hello"} \/ LateHeartbeats
    /\ cp' = FailAll(cp, {a})
    /\ toAgent' = IF CPConnected THEN Append(toAgent, [type |-> "cancel", as |-> {a}]) ELSE toAgent
    /\ UNCHANGED <<suspects, conn, ready, toCP, ag, stopSig, chan, unacked, abandoned,
                   hello, welcome, okFinished>>

\* engine.ts onOnline：Hello 里上报的尝试，控制面仍在等的继续、否则放弃；
\* 控制面认为在这个 Agent 上、Hello 里没有的立即 agent_lost；清空 suspects；发 Welcome。
\* 这时连接还没推送 Welcome，agentLost 记下的取消不会发出（Agent 也不持有这些尝试）。
\* 发出 Welcome 后连接在准备环境（AgentConnection.welcome），不派发（ready 仍为 FALSE）。
CPOnline ==
    /\ conn = "hello"
    /\ LET mine == {b \in Attempts : cp[b] \in OnAgent}
           lost == mine \ hello.held
       IN /\ welcome' = {b \in hello.held : cp[b] \notin OnAgent}
          /\ cp' = MarkStarted(FailAll(cp, lost), hello.started)
    /\ suspects' = {}
    /\ conn' = "welcome"
    /\ UNCHANGED <<ready, toCP, toAgent, ag, stopSig, chan, unacked, abandoned, hello, okFinished>>

(* ------------------------------- 网络 ---------------------------------- *)

\* gRPC 流断开：两个方向在途的消息都丢失；Agent 保留 unacked，控制面保留任务行。
\* 「已准备好」跟着连接走，断开就没了（下次连接是新的 AgentConnection）。
Disconnect ==
    /\ conn # "down"
    /\ conn' = "down"
    /\ ready' = FALSE
    /\ toCP' = <<>>
    /\ toAgent' = <<>>
    /\ UNCHANGED <<cp, suspects, ag, stopSig, chan, unacked, abandoned, hello, welcome, okFinished>>

(* ------------------------------- Agent --------------------------------- *)

\* lib.rs run() 循环：held_collecting 持 cancels 锁把通道里的结果收进 unacked（放弃的丢弃），
\* 列出手上任务，作为 Hello 的 running_tasks 连接控制面。
AgentConnect ==
    /\ conn = "down"
    /\ LET kept     == {r \in chan : r[1] \notin abandoned}
           unacked2 == unacked \cup kept
       IN /\ unacked' = unacked2
          /\ abandoned' = abandoned \ AttemptsOf(chan)
          /\ hello' = [held    |-> Holding \cup AttemptsOf(unacked2),
                       started |-> StartedOnAgent \cup AttemptsOf(unacked2)]
    /\ chan' = {}
    /\ conn' = "hello"
    /\ UNCHANGED <<cp, suspects, ready, toCP, toAgent, ag, stopSig, welcome, okFinished>>

\* lib.rs run()：准备好环境后处理 Welcome 的 ABANDON（结果没 Ack 的直接删掉；还在执行的 force 取消并记入
\* abandoned），然后进入 serve()：先重发全部 unacked 结果，再立即发一次心跳（Runtime::held），
\* 不等心跳周期。控制面处理这次心跳后才派发（#219）。
AgentWelcome ==
    /\ conn = "welcome"
    /\ LET dropped == {r \in unacked : r[1] \in welcome}
           kill    == {b \in welcome : b \notin AttemptsOf(unacked) /\ b \in Holding}
           rest    == unacked \ dropped
       IN /\ unacked' = rest
          /\ stopSig' = stopSig \cup kill
          /\ abandoned' = abandoned \cup kill
          /\ toCP' = toCP \o ResultMsgs(rest)
                     \o <<[type    |-> "hb",
                           held    |-> Holding \cup AttemptsOf(rest),
                           started |-> StartedOnAgent \cup AttemptsOf(rest)]>>
    /\ conn' = "up"
    /\ UNCHANGED <<cp, suspects, ready, toAgent, ag, chan, hello, welcome, okFinished>>

\* lib.rs serve()：Assign -> Runtime::accept（进 cancels，不检查槽位）并 spawn run_task；
\* Cancel -> Runtime::cancel_task（不在 cancels 里的忽略；被杀的尝试照常上报结果）；Ack -> 从 unacked 删除。
AgentRecv ==
    /\ conn = "up"
    /\ toAgent # <<>>
    /\ LET m == Head(toAgent) IN
        /\ toAgent' = Tail(toAgent)
        /\ CASE m.type = "assign" ->
                    /\ ag' = [ag EXCEPT ![m.a] = "held"]
                    /\ UNCHANGED <<unacked, stopSig>>
             [] m.type = "cancel" ->
                    /\ stopSig' = stopSig \cup (m.as \cap Holding)
                    /\ UNCHANGED <<ag, unacked>>
             [] m.type = "ack" ->
                    /\ unacked' = {r \in unacked : r[1] # m.a}
                    /\ UNCHANGED <<ag, stopSig>>
    /\ UNCHANGED <<cp, suspects, conn, ready, toCP, chan, abandoned, hello, welcome, okFinished>>

\* lib.rs run_task -> start_task 成功、executor.rs 发出 TaskStarted（断线时丢失，靠心跳的 started 补记）。
AgentStart(a) ==
    /\ ag[a] = "held"
    /\ ag' = [ag EXCEPT ![a] = "started"]
    /\ toCP' = IF conn = "up" THEN Append(toCP, [type |-> "started", a |-> a]) ELSE toCP
    /\ UNCHANGED <<cp, suspects, conn, ready, toAgent, stopSig, chan, unacked, abandoned,
                   hello, welcome, okFinished>>

\* lib.rs run_task 结束：持 cancels 锁把结果送进 results 通道并移出 cancels。
\* 成功只可能来自真正执行了、没有被取消的尝试；安装失败、节点失败、被杀都是失败。
AgentFinish(a, ok) ==
    /\ ag[a] \in {"held", "started"}
    /\ ok => (ag[a] = "started" /\ a \notin stopSig)
    /\ ag' = [ag EXCEPT ![a] = "done"]
    /\ chan' = chan \cup {<<a, ok>>}
    /\ okFinished' = IF ok THEN okFinished \cup {a} ELSE okFinished
    /\ UNCHANGED <<cp, suspects, conn, ready, toCP, toAgent, stopSig, unacked, abandoned, hello, welcome>>

\* lib.rs serve() 的 results.recv 分支：放弃的结果丢弃，否则记入 unacked 并上报。
AgentSendResult ==
    /\ conn = "up"
    /\ \E r \in chan :
        /\ chan' = chan \ {r}
        /\ IF r[1] \in abandoned
              THEN /\ abandoned' = abandoned \ {r[1]}
                   /\ UNCHANGED <<unacked, toCP>>
              ELSE /\ unacked' = unacked \cup {r}
                   /\ toCP' = Append(toCP, [type |-> "result", a |-> r[1], ok |-> r[2]])
                   /\ UNCHANGED abandoned
    /\ UNCHANGED <<cp, suspects, conn, ready, toAgent, ag, stopSig, hello, welcome, okFinished>>

\* lib.rs serve() 的 heartbeat.tick 分支：running_tasks = Runtime::held(unacked)
\* （cancels 里的，加上 unacked；还在 results 通道里的结果不在其中）。进入 serve() 时立即发的那一次在 AgentWelcome 里。
AgentHeartbeat ==
    /\ conn = "up"
    /\ PromptDelivery => /\ toAgent = <<>>
                         /\ chan = {}
                         /\ \A i \in 1..Len(toCP) : toCP[i].type # "hb"
    /\ toCP' = Append(toCP, [type    |-> "hb",
                             held    |-> Holding \cup AttemptsOf(unacked),
                             started |-> StartedOnAgent \cup AttemptsOf(unacked)])
    /\ UNCHANGED <<cp, suspects, conn, ready, toAgent, ag, stopSig, chan, unacked, abandoned,
                   hello, welcome, okFinished>>

Next ==
    \/ \E a \in Attempts : Dispatch(a) \/ LeaseExpire(a) \/ AgentStart(a)
    \/ \E a \in Attempts, ok \in BOOLEAN : AgentFinish(a, ok)
    \/ CPRecv \/ CPOnline \/ Disconnect
    \/ AgentConnect \/ AgentWelcome \/ AgentRecv \/ AgentSendResult \/ AgentHeartbeat

Spec == Init /\ [][Next]_vars

\* 有限的状态空间：每个方向在途的消息数有上限。
InFlight == Len(toCP) <= MaxInFlight /\ Len(toAgent) <= MaxInFlight

(* ------------------------------- 性质 ---------------------------------- *)

TypeOK ==
    /\ cp \in [Attempts -> {"none", "queued", "dispatched", "running", "success", "failed"}]
    /\ ag \in [Attempts -> {"none", "held", "started", "done"}]
    /\ conn \in {"down", "hello", "welcome", "up"}
    /\ ready \in BOOLEAN
    /\ suspects \subseteq Attempts
    /\ stopSig \subseteq Attempts

\* 承诺 1：同一个节点的较新尝试在 Agent 上执行时，较早的尝试要么已经结束，要么已经被告知停止。
NoUnstoppedDuplicate ==
    \A a, b \in Attempts :
        (a < b /\ ag[a] = "started" /\ ag[b] = "started") => a \in stopSig

\* 承诺 2：没被告知停止的任务数不超过 Agent 的槽位。
SlotBound ==
    Cardinality({b \in Attempts : ag[b] \in {"held", "started"} /\ b \notin stopSig}) <= Slots

\* 承诺 3：派发只发给已准备好环境、进入了 serve 循环的 Agent（#219）：任务的租约不会算进 Agent 准备环境的时间。
AssignOnlyWhenReady ==
    \A i \in 1..Len(toAgent) : toAgent[i].type = "assign" => conn = "up"

\* 承诺 4：一个节点最多接受一次成功，而且成功来自真正执行成功的那次尝试。
AtMostOneSuccess == Cardinality({b \in Attempts : cp[b] = "success"}) <= 1
SuccessWasRun == \A b \in Attempts : cp[b] = "success" => b \in okFinished
=============================================================================
