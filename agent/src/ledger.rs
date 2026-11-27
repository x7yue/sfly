//! 任务台账：Agent 手上的每个（任务, 尝试）走到了派发协议的哪一步，由这里独占。
//!
//! 一个（任务, 尝试）在台账里只有一个阶段，只往前走，最后离开台账：
//!
//! ```text
//! 执行中（收下、已启动） ──结束并交出结果──▶ 结果待发 ──发出──▶ 待 Ack ──Ack──▶ 离开台账
//! ```
//!
//! **手上的任务就是台账里的全部任务**（[`Ledger::held`]）：Hello、心跳、自更新排空、保留期扫描、Ack 之后判断任务和运行
//! 是否结束，问的都是同一份。结果交出之前任务在「执行中」，交出之后在「结果待发」；换阶段是在一次持锁里完成的，
//! 所以从任何时刻看台账，任务都恰好在一个阶段里，不会两边都看不到（Hello 漏报，#132），也不会两边都看到
//! （Ack 来得太快，任务还当成在执行，漏写结束标记，#117）。
//!
//! 控制面在 Welcome 里放弃的任务：还在执行的被强制取消，结束时结果直接丢弃，不再上报；结果还没 Ack 的直接删掉。
//! 被放弃的任务结束时没有结果要发，手上却少了一个任务：[`Ledger::discarded`] 叫醒主循环，让它重新判断自更新的排空。
//!
//! 台账的操作和 `.agents/skills/verify-task-dispatch/model/TaskDispatch.tla` 里 Agent 一侧的动作一一对应：
//! [`Ledger::accept`] 是 `AgentRecv` 的 assign，[`Ledger::started`] 是 `AgentStart`，[`Ledger::finish`] 是 `AgentFinish`，
//! [`Ledger::next_result`] 是 `AgentSendResult`，[`Ledger::ack`] 是 `AgentRecv` 的 ack，
//! [`Ledger::hello`] 是 `AgentConnect`，[`Ledger::abandon`] 是 `AgentWelcome` 里的 ABANDON，
//! [`Ledger::cancel`] 是 `AgentRecv` 的 cancel（超时进入收尾时间时 `run_task` 也调用它，给这个任务的取消信号发一次
//! 优雅取消、让正在进行的能力调用放弃：这个调用方不是协议消息，模型里没有它，也不把它算进 `stopSig`），
//! [`Ledger::held`] 是 `AgentHeartbeat` 和 `AgentWelcome` 里的心跳。

use std::collections::btree_map::Entry;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Mutex;

use tokio::sync::{Notify, watch};

use crate::proto::{AssignTask, ErrorKind, ReferencedAgent, RunningTask, TaskResult, TaskStatus};
use crate::{calls, executor, result_message_size};

/// 任务 ID 和尝试。
type Key = (String, u32);

/// 台账。可以在几个线程和任务之间共享（[`crate::Runtime`] 持有它）。
#[derive(Default)]
pub(crate) struct Ledger {
    state: Mutex<State>,
    /// 有结果交出时叫醒 [`Ledger::next_result`]。
    handed: Notify,
    /// 任务不交出结果就离开台账时（被放弃的任务结束）叫醒 [`Ledger::discarded`]。
    discarded: Notify,
}

#[derive(Default)]
struct State {
    /// 手上的任务各在哪个阶段；按（任务 ID, 尝试）排序。
    attempts: BTreeMap<Key, Stage>,
    /// 任务属于哪次运行（任务 ID → 运行 ID）：收下任务时登记，保留期扫描时去掉已经不在手上的。
    /// 任务不在手上之后还要查得到它的运行：结果被 Ack 时据此判断运行是否结束（[`Ledger::ack`]）。
    runs: HashMap<String, String>,
    /// 下一个交出的结果的序号：结果按交出的先后发出。
    next_order: u64,
}

enum Stage {
    /// 执行中：收下之后（含安装节点包的时间）、结束并交出结果之前。
    Running(Running),
    /// 结果已交出，还没发出。
    Handed { order: u64, finished: Finished },
    /// 结果已发出（或新连接开始时收下、等着重发），还没收到 Ack。
    Unacked(Finished),
}

struct Running {
    cancel: watch::Sender<Option<bool>>,
    /// 执行器子进程已经启动（已发出 TaskStarted）。
    started: bool,
    /// 控制面放弃了它：已被强制取消，结束时结果直接丢弃。
    abandoned: bool,
    /// 任务通过「Agent」类型的输入引用的 Agent：节点只能调用它们和自己的能力（[`calls`]）。
    referenced_agents: Vec<ReferencedAgent>,
}

/// 已经结束的任务：要上报的结果，和它结束之前执行器子进程有没有启动过。
#[derive(Default)]
struct Finished {
    result: TaskResult,
    /// 结束时 [`Running::started`] 的值，之后不再变。没启动就结束的（安装失败、开发版本没有加载等）是 false。
    started: bool,
}

impl Running {
    /// 发出取消请求。优雅取消之后再收到强制取消会升级为立即杀掉。
    fn signal(&self, force: bool) {
        self.cancel.send_if_modified(|current| {
            let next = Some(current.unwrap_or(false) || force);
            let changed = *current != next;
            *current = next;
            changed
        });
    }
}

impl Stage {
    /// 执行器子进程启动过没有：执行中的看现在，已经结束的看结束时。
    fn started(&self) -> bool {
        match self {
            Stage::Running(running) => running.started,
            Stage::Handed { finished, .. } | Stage::Unacked(finished) => finished.started,
        }
    }

    /// 结果待发 → 待 Ack；其它阶段不动。
    fn mark_sent(&mut self) {
        if let Stage::Handed { finished, .. } = self {
            *self = Stage::Unacked(std::mem::take(finished));
        }
    }
}

impl State {
    /// 手上的任务（任务 ID、尝试、执行器子进程启动过没有）：台账里的每个阶段都算，已经交出结果的也算；
    /// 启动过没有按真实的值报，没启动就结束的任务（安装失败等）到结果被 Ack 之前都报没启动过。
    /// 这是「手上」唯一的定义，其余都从它来。
    fn on_hand(&self) -> impl Iterator<Item = (&Key, bool)> {
        self.attempts
            .iter()
            .map(|(key, stage)| (key, stage.started()))
    }

    fn held(&self) -> Vec<RunningTask> {
        self.on_hand()
            .map(|((task_id, attempt), started)| RunningTask {
                task_id: task_id.clone(),
                attempt: *attempt,
                started,
            })
            .collect()
    }

    fn holds_task(&self, task_id: &str) -> bool {
        self.on_hand().any(|((id, _), _)| id == task_id)
    }

    /// 交出最早的、还没发出的结果，记为待 Ack。
    fn send_next(&mut self) -> Option<TaskResult> {
        let key = self
            .attempts
            .iter()
            .filter_map(|(key, stage)| match stage {
                Stage::Handed { order, .. } => Some((*order, key)),
                _ => None,
            })
            .min()
            .map(|(_, key)| key.clone())?;
        let stage = self.attempts.get_mut(&key)?;
        stage.mark_sent();
        match stage {
            Stage::Unacked(finished) => Some(finished.result.clone()),
            _ => None,
        }
    }
}

/// 任务落定（[`Ledger::ack`]）：这个任务 ID 下最后一个还在手上的（任务, 尝试）的结果被 Ack 了。
pub(crate) struct Settled {
    /// 它所属的运行里没有别的任务还在手上时，这次运行的 ID：运行在这台 Agent 上结束了。
    pub(crate) run_ended: Option<String>,
}

/// 换掉超过控制面一条消息上限的结果（[`Ledger::replace_results_over`]）：失败，类型 `node_error`（和控制面自己把超过
/// 输出上限的结果换成失败一致，会照 `retries` 重跑）；写明原来是成功还是失败、整条消息多大、上限多大、怎么办。
/// 原来是失败的，出错的位置带着，原来的文字留开头一段（只是帮着认出是哪里出的错，不是原文）。时钟读数保留：结束的时刻没变。
fn too_big(old: &TaskResult, size: usize, limit: usize) -> TaskResult {
    /// 原来的失败文字留下的开头。
    const KEPT_HEAD_BYTES: usize = 2 * 1024;
    let advice =
        "办法：让节点的输出或失败文字小一些；这个上限是部署控制面的人设的，需要的话请他调大。";
    let (was, head, location) = match &old.error {
        Some(error) if old.status() != TaskStatus::Success => {
            let head = executor::truncate_at_boundary(error.message.clone(), KEPT_HEAD_BYTES);
            let omitted = error.message.len() - head.len();
            let head = if omitted == 0 {
                format!("原来的失败文字（全文）：\n{head}")
            } else {
                format!(
                    "原来的失败文字，只留开头 {} 字节（共 {} 字节）：\n{head}",
                    head.len(),
                    error.message.len()
                )
            };
            ("任务失败了，失败的结果", Some(head), error.location.clone())
        }
        _ => ("任务成功了，结果", None, String::new()),
    };
    let mut message = format!(
        "{was}有 {size} 字节（整条消息），超过控制面接收一条消息的上限 {limit} 字节，没有送到：\
         结果已丢弃，任务按失败处理（类型 node_error，按重试配置重跑）。{advice}"
    );
    if let Some(head) = head {
        message.push_str("\n\n");
        message.push_str(&head);
    }
    let mut result = executor::failure_at(
        &AssignTask {
            task_id: old.task_id.clone(),
            attempt: old.attempt,
            ..Default::default()
        },
        ErrorKind::NodeError,
        message,
        location,
    );
    result.agent_time_unix_ms = old.agent_time_unix_ms;
    result.monotonic_ms = old.monotonic_ms;
    result
}

impl Ledger {
    /// 收下派发的任务（在收到 AssignTask 时同步调用：之后的心跳一定带上它），返回它的取消信号。
    /// 这个（任务, 尝试）已经在手上时不再收下，返回 None。
    pub(crate) fn accept(&self, task: &AssignTask) -> Option<executor::CancelSignal> {
        let mut state = self.state.lock().unwrap();
        let Entry::Vacant(slot) = state.attempts.entry((task.task_id.clone(), task.attempt)) else {
            return None;
        };
        let (cancel_tx, cancel) = watch::channel(None);
        slot.insert(Stage::Running(Running {
            cancel: cancel_tx,
            started: false,
            abandoned: false,
            referenced_agents: task.referenced_agents.clone(),
        }));
        state.runs.insert(task.task_id.clone(), task.run_id.clone());
        Some(cancel)
    }

    /// 执行器子进程已经启动。
    pub(crate) fn started(&self, task_id: &str, attempt: u32) {
        let mut state = self.state.lock().unwrap();
        if let Some(Stage::Running(running)) =
            state.attempts.get_mut(&(task_id.to_string(), attempt))
        {
            running.started = true;
        }
    }

    /// 任务结束：在一次持锁里把「执行中」换成「结果待发」，带着结束时执行器有没有启动过（心跳和 Hello 据此报
    /// `started`）。被放弃的任务的结果丢弃，任务也不再在手上：没有结果要发，叫醒 [`Ledger::discarded`]。
    pub(crate) fn finish(&self, result: TaskResult) {
        let key = (result.task_id.clone(), result.attempt);
        let wake = {
            let mut state = self.state.lock().unwrap();
            let previous = state.attempts.remove(&key);
            debug_assert!(
                matches!(previous, Some(Stage::Running(_))),
                "finished a task that was not running: {key:?}"
            );
            let (abandoned, started) = match previous {
                Some(Stage::Running(running)) => (running.abandoned, running.started),
                _ => (false, false),
            };
            if abandoned {
                &self.discarded
            } else {
                let order = state.next_order;
                state.next_order += 1;
                let finished = Finished { result, started };
                state
                    .attempts
                    .insert(key, Stage::Handed { order, finished });
                &self.handed
            }
        };
        wake.notify_one();
    }

    /// 等到有任务不交出结果就离开了台账（被放弃的任务结束）：手上的任务少了一个，调用方要重新判断依赖「手上还有
    /// 几个」的事（自更新的排空，[`crate::update::Updater::poll`]）。[`Ledger::next_result`] 不会因此返回，
    /// 所以主循环的 `select!` 需要这一个分支。叫醒不会丢：没人在等时留到下一次调用。可以放进 `select!`。
    pub(crate) async fn discarded(&self) {
        self.discarded.notified().await;
    }

    /// 等到下一个要发出的结果（先交出的先发），记为待 Ack 并返回；连接断开时发不出去的留在待 Ack 里，
    /// 下一次连接重发（[`Ledger::unacked`]）。可以放进 `select!`：被取消时不会丢结果。
    pub(crate) async fn next_result(&self) -> TaskResult {
        loop {
            let next = self.state.lock().unwrap().send_next();
            if let Some(result) = next {
                return result;
            }
            self.handed.notified().await;
        }
    }

    /// 结果被 Ack。结果已发出（待 Ack）的才算；这个任务 ID 下没有别的（任务, 尝试）还在手上时任务落定，
    /// 并给出运行有没有结束（[`Settled`]）。控制面给每次重试一个新的任务 ID（`apps/server/src/engine/ids.ts`
    /// 的 `taskId` 把尝试算进去），协议上一个任务 ID 只有一个尝试，到不了「同一个任务 ID 有两个尝试在手上」；
    /// 这里仍按任务 ID 判断，是防着这种到不了的情况：任务目录按任务 ID 命名，别的尝试还在用它时不能写结束标记。
    pub(crate) fn ack(&self, task_id: &str, attempt: u32) -> Option<Settled> {
        let mut state = self.state.lock().unwrap();
        let key = (task_id.to_string(), attempt);
        if !matches!(state.attempts.get(&key), Some(Stage::Unacked(_))) {
            return None;
        }
        state.attempts.remove(&key);
        if state.holds_task(task_id) {
            return None;
        }
        let run_ended = state
            .runs
            .get(task_id)
            .filter(|run_id| {
                !state
                    .runs
                    .iter()
                    .any(|(other, run)| run == *run_id && state.holds_task(other))
            })
            .cloned();
        Some(Settled { run_ended })
    }

    /// 新连接开始时清点手上的任务（Hello 的 running_tasks）：断线期间（或连接之间）交出的结果当作待 Ack，
    /// 随后重发；清点和换阶段在同一次持锁里，任务要么还在执行，要么结果已交出，不会漏报（#132）。
    /// 每个任务的 `started` 是真实的值，已经结束的也一样。
    pub(crate) fn hello(&self) -> Vec<RunningTask> {
        let mut state = self.state.lock().unwrap();
        for stage in state.attempts.values_mut() {
            stage.mark_sent();
        }
        state.held()
    }

    /// 手上的任务（心跳的 running_tasks）：正在执行（含安装中）的，加上已经结束、结果还没收到 Ack 的，
    /// 包括结果已交出、还没发出的。每个任务的 `started` 是真实的值：没启动就结束的任务报 false。
    /// 按（任务 ID, 尝试）排序。
    pub(crate) fn held(&self) -> Vec<RunningTask> {
        self.state.lock().unwrap().held()
    }

    /// 还没收到 Ack 的结果，按（任务 ID, 尝试）排序：新连接开始时先于心跳重发。
    pub(crate) fn unacked(&self) -> Vec<TaskResult> {
        let state = self.state.lock().unwrap();
        state
            .attempts
            .values()
            .filter_map(|stage| match stage {
                Stage::Unacked(finished) => Some(finished.result.clone()),
                _ => None,
            })
            .collect()
    }

    /// 控制面用「消息超过上限」拒绝了这条连接（上限 `limit` 字节，#674）：还没收到 Ack 的结果里，作为一条消息发出时
    /// 超过上限的换成失败（`node_error`，写明原来是成功还是失败、多大、上限多大、怎么办），不再原样重发——原样重发每次
    /// 都被拒，Agent 一直重连，任务一直 running，排在后面的结果和心跳也过不去（#723）。
    ///
    /// 比的是整条 `AgentMessage` 的大小（[`result_message_size`]），和控制面比的是同一个数：只比结果自己的编码，
    /// 差在上限边上的几个字节（字段标签和长度前缀）的那一条会被拒、不被换，永远发不出去。
    /// 没超过上限的不动：被拒的是别的消息（遥测）时，不能把成功的结果换成失败。取消的结果也不换：文字是固定的短句，
    /// 上限小到装不下它时连握手都过不去，到不了这里。返回换掉了几个。
    pub(crate) fn replace_results_over(&self, limit: usize) -> usize {
        let mut state = self.state.lock().unwrap();
        let mut replaced = 0;
        for stage in state.attempts.values_mut() {
            let finished = match stage {
                Stage::Handed { finished, .. } | Stage::Unacked(finished) => finished,
                Stage::Running(_) => continue,
            };
            let size = result_message_size(&finished.result);
            if size <= limit || finished.result.status() == TaskStatus::Cancelled {
                continue;
            }
            finished.result = too_big(&finished.result, size, limit);
            replaced += 1;
        }
        replaced
    }

    /// 控制面在 Welcome 里放弃了这个任务：结果还没 Ack 的直接删掉；还在执行的立即强制取消，结果不再上报；
    /// 结果已交出、还没发出的照常发出（控制面不再接受它）。
    pub(crate) fn abandon(&self, task_id: &str, attempt: u32) {
        let mut state = self.state.lock().unwrap();
        let key = (task_id.to_string(), attempt);
        match state.attempts.get_mut(&key) {
            Some(Stage::Running(running)) => {
                running.abandoned = true;
                running.signal(true);
            }
            Some(Stage::Unacked(_)) => {
                state.attempts.remove(&key);
            }
            Some(Stage::Handed { .. }) | None => {}
        }
    }

    /// 取消一个任务。任务不在执行（不在手上，或已经结束）时返回 false，什么也不做。
    pub(crate) fn cancel(&self, task_id: &str, attempt: u32, force: bool) -> bool {
        let state = self.state.lock().unwrap();
        match state.attempts.get(&(task_id.to_string(), attempt)) {
            Some(Stage::Running(running)) => {
                running.signal(force);
                true
            }
            _ => false,
        }
    }

    /// 取消所有正在执行（含安装中）的任务，返回个数。
    pub(crate) fn cancel_all(&self, force: bool) -> usize {
        let state = self.state.lock().unwrap();
        let mut count = 0;
        for stage in state.attempts.values() {
            if let Stage::Running(running) = stage {
                running.signal(force);
                count += 1;
            }
        }
        count
    }

    /// 节点调用 Agent 能力时对任务的约束（[`calls::serve`]）：任务不在执行时为 None。
    pub(crate) fn calls_of(&self, task_id: &str, attempt: u32) -> Option<calls::TaskCalls> {
        let state = self.state.lock().unwrap();
        match state.attempts.get(&(task_id.to_string(), attempt)) {
            Some(Stage::Running(running)) => Some(calls::TaskCalls {
                referenced: running.referenced_agents.clone(),
                cancel: running.cancel.subscribe(),
            }),
            _ => None,
        }
    }

    /// 这个任务 ID 现在有没有（任务, 尝试）在手上。
    pub(crate) fn holds_task(&self, task_id: &str) -> bool {
        self.state.lock().unwrap().holds_task(task_id)
    }

    /// 属于这次运行的任务（不论还在不在手上，直到保留期扫描忘掉它们）。
    pub(crate) fn tasks_of_run(&self, run_id: &str) -> Vec<String> {
        let state = self.state.lock().unwrap();
        state
            .runs
            .iter()
            .filter(|(_, run)| run.as_str() == run_id)
            .map(|(task_id, _)| task_id.clone())
            .collect()
    }

    /// 保留期扫描：忘掉不在 `held` 里的任务属于哪次运行，返回它们（从现在开始算保留期）。
    pub(crate) fn forget_runs_except(&self, held: &HashSet<String>) -> Vec<String> {
        let mut forgotten = Vec::new();
        self.state.lock().unwrap().runs.retain(|task_id, _| {
            let on_hand = held.contains(task_id);
            if !on_hand {
                forgotten.push(task_id.clone());
            }
            on_hand
        });
        forgotten
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::Duration;

    use prost::Message as _;

    use super::*;

    fn assign(task_id: &str, attempt: u32, run_id: &str) -> AssignTask {
        AssignTask {
            task_id: task_id.into(),
            attempt,
            run_id: run_id.into(),
            ..Default::default()
        }
    }

    fn result(task_id: &str, attempt: u32) -> TaskResult {
        TaskResult {
            task_id: task_id.into(),
            attempt,
            ..Default::default()
        }
    }

    /// 清点出的任务，写成 (任务 ID, 尝试, 执行器是否已启动)。
    fn listed(tasks: Vec<RunningTask>) -> Vec<(String, u32, bool)> {
        tasks
            .into_iter()
            .map(|t| (t.task_id, t.attempt, t.started))
            .collect()
    }

    /// 手上的任务（[`Ledger::held`]）。
    fn held(ledger: &Ledger) -> Vec<(String, u32, bool)> {
        listed(ledger.held())
    }

    fn entry(task_id: &str, attempt: u32, started: bool) -> (String, u32, bool) {
        (task_id.to_string(), attempt, started)
    }

    /// 收下并启动。
    fn start(ledger: &Ledger, task_id: &str, attempt: u32, run_id: &str) {
        ledger.accept(&assign(task_id, attempt, run_id)).unwrap();
        ledger.started(task_id, attempt);
    }

    /// 下一个发出的结果是哪个（任务 ID, 尝试）；没有可发的结果时测试失败，不会卡住。
    async fn sent(ledger: &Ledger) -> (String, u32) {
        let result = tokio::time::timeout(Duration::from_secs(5), ledger.next_result())
            .await
            .expect("no result to send");
        (result.task_id, result.attempt)
    }

    #[test]
    fn an_accepted_task_is_held_until_its_executor_starts() {
        let ledger = Ledger::default();
        ledger.accept(&assign("a", 1, "run")).unwrap();
        assert_eq!(held(&ledger), [entry("a", 1, false)]);
        ledger.started("a", 1);
        assert_eq!(held(&ledger), [entry("a", 1, true)]);
    }

    #[test]
    fn an_attempt_that_is_already_held_is_not_accepted_again() {
        let ledger = Ledger::default();
        start(&ledger, "a", 1, "run");
        assert!(ledger.accept(&assign("a", 1, "run")).is_none());
        assert_eq!(held(&ledger), [entry("a", 1, true)]);
    }

    /// #132：重连时清点已安装的包很慢，任务恰好在 Hello 清点之前结束，Hello 不能漏报它
    /// （控制面会立即以 agent_lost 判它失败）。
    #[test]
    fn hello_lists_a_task_that_finished_before_it_was_listed() {
        let ledger = Ledger::default();
        start(&ledger, "done", 1, "run");
        ledger.accept(&assign("installing", 1, "run")).unwrap();
        ledger.finish(result("done", 1));
        assert_eq!(
            listed(ledger.hello()),
            [entry("done", 1, true), entry("installing", 1, false)]
        );
    }

    /// 没启动就结束的任务在 Hello 里也报没启动过：断线期间交出的结果当作待 Ack，`started` 不因此变成 true。
    #[test]
    fn hello_reports_a_task_that_finished_without_starting_as_not_started() {
        let ledger = Ledger::default();
        ledger.accept(&assign("never-started", 1, "run")).unwrap();
        ledger.finish(result("never-started", 1));
        assert_eq!(listed(ledger.hello()), [entry("never-started", 1, false)]);
        assert_eq!(
            held(&ledger),
            [entry("never-started", 1, false)],
            "now waiting for its ack"
        );
    }

    /// 心跳也列出结果已交出、还没发出的任务：控制面不会因为它们恰好在这一刻交出结果而少续一次约。
    #[test]
    fn a_task_whose_result_is_handed_over_but_not_sent_is_still_held() {
        let ledger = Ledger::default();
        start(&ledger, "a", 1, "run");
        ledger.finish(result("a", 1));
        assert_eq!(held(&ledger), [entry("a", 1, true)]);
    }

    /// 执行器没启动就结束的任务（安装失败、开发版本没有加载等）：结果待发、待 Ack 两个阶段都报没启动过。
    /// 控制面把心跳里 `started` 的任务从派发阶段改成 running、写上开始时间，没启动过的任务不能这样记。
    /// 启动过的任务两个阶段都报启动过。
    #[tokio::test]
    async fn a_finished_task_reports_whether_its_executor_ever_started() {
        let ledger = Ledger::default();
        ledger.accept(&assign("never-started", 1, "run")).unwrap();
        start(&ledger, "started", 1, "run");
        let expected = [entry("never-started", 1, false), entry("started", 1, true)];

        ledger.finish(result("never-started", 1));
        ledger.finish(result("started", 1));
        assert_eq!(held(&ledger), expected, "results handed over, not sent");

        assert_eq!(sent(&ledger).await, ("never-started".into(), 1));
        assert_eq!(held(&ledger), expected, "first result sent, not acked");

        assert_eq!(sent(&ledger).await, ("started".into(), 1));
        assert_eq!(held(&ledger), expected, "both results sent, not acked");
    }

    /// #117：结果的 Ack 来得再快，任务也不会还当成在手上而漏写结束标记。
    #[tokio::test]
    async fn an_ack_right_after_the_result_is_sent_settles_the_task_and_its_run() {
        let ledger = Ledger::default();
        start(&ledger, "a", 1, "run");
        ledger.finish(result("a", 1));
        assert_eq!(sent(&ledger).await, ("a".into(), 1));
        let settled = ledger.ack("a", 1).expect("the task should settle");
        assert_eq!(settled.run_ended.as_deref(), Some("run"));
        assert!(ledger.held().is_empty());
    }

    /// #117：任务一边在别的线程结束，一边被立即 Ack，每个任务都恰好落定一次。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn every_task_acked_as_soon_as_it_finishes_settles() {
        const TASKS: usize = 500;
        let ledger = Arc::new(Ledger::default());
        for i in 0..TASKS {
            start(&ledger, &format!("task-{i}"), 1, &format!("run-{i}"));
        }
        for i in 0..TASKS {
            let ledger = ledger.clone();
            tokio::spawn(async move { ledger.finish(result(&format!("task-{i}"), 1)) });
        }
        let mut settled = 0;
        for _ in 0..TASKS {
            let (task_id, attempt) = sent(&ledger).await;
            if ledger.ack(&task_id, attempt).is_some() {
                settled += 1;
            }
        }
        assert_eq!(settled, TASKS);
        assert!(ledger.held().is_empty());
    }

    /// 结果交出时任务换阶段是一次持锁完成的：另一个线程在任何时刻清点，已经收下的任务一个也不少。
    /// 换阶段拆成「先移出、再放进结果待发」两步时，这里会偶尔清点到少了一个。
    #[test]
    fn a_task_is_never_missing_from_the_ledger_while_it_finishes() {
        const TASKS: usize = 4000;
        let ledger = Ledger::default();
        let accepted = AtomicUsize::new(0);
        let done = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                for i in 0..TASKS {
                    let task_id = format!("task-{i}");
                    ledger.accept(&assign(&task_id, 1, "run")).unwrap();
                    accepted.store(i + 1, Ordering::SeqCst);
                    ledger.started(&task_id, 1);
                    ledger.finish(result(&task_id, 1));
                }
                done.store(true, Ordering::SeqCst);
            });
            while !done.load(Ordering::SeqCst) {
                let accepted_before = accepted.load(Ordering::SeqCst);
                let listed = ledger.held().len();
                assert!(
                    listed >= accepted_before,
                    "{accepted_before} tasks were accepted, but only {listed} are held"
                );
                std::thread::yield_now();
            }
        });
        assert_eq!(ledger.held().len(), TASKS);
    }

    #[tokio::test]
    async fn the_result_of_an_abandoned_task_is_dropped() {
        let ledger = Ledger::default();
        let mut cancel = ledger.accept(&assign("abandoned", 1, "run")).unwrap();
        ledger.started("abandoned", 1);
        start(&ledger, "other", 1, "run");

        ledger.abandon("abandoned", 1);
        assert_eq!(*cancel.borrow_and_update(), Some(true), "killed at once");
        assert_eq!(
            held(&ledger),
            [entry("abandoned", 1, true), entry("other", 1, true)],
            "still held until it ends"
        );

        ledger.finish(result("abandoned", 1));
        ledger.finish(result("other", 1));
        assert_eq!(held(&ledger), [entry("other", 1, true)]);
        // 被放弃的结果没有排进待发：先发出的是后一个任务的结果。
        assert_eq!(sent(&ledger).await, ("other".into(), 1));
        assert_eq!(ledger.unacked().len(), 1);
    }

    #[tokio::test]
    async fn an_abandoned_result_that_is_waiting_for_its_ack_is_deleted() {
        let ledger = Ledger::default();
        start(&ledger, "a", 1, "run");
        ledger.finish(result("a", 1));
        sent(&ledger).await;
        ledger.abandon("a", 1);
        assert!(ledger.held().is_empty());
        assert!(ledger.unacked().is_empty());
    }

    /// 结果已交出、还没发出时才放弃：照常发出，由控制面不接受它（和 Agent 一直以来的做法一样）。
    #[tokio::test]
    async fn an_abandoned_result_that_is_not_sent_yet_is_still_sent() {
        let ledger = Ledger::default();
        start(&ledger, "a", 1, "run");
        ledger.finish(result("a", 1));
        ledger.abandon("a", 1);
        assert_eq!(sent(&ledger).await, ("a".into(), 1));
    }

    /// 被放弃的任务结束时没有结果要发，但手上少了一个任务：叫醒等着的主循环，让它重新判断自更新的排空
    /// （没有这个叫醒，要等到下一次心跳或别的消息才看得到手上已经没有任务）。
    #[tokio::test]
    async fn an_abandoned_task_that_ends_wakes_the_waiter() {
        let ledger = Arc::new(Ledger::default());
        start(&ledger, "a", 1, "run");
        ledger.abandon("a", 1);
        let waiting = tokio::spawn({
            let ledger = ledger.clone();
            async move { ledger.discarded().await }
        });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished(), "the task is still running");

        ledger.finish(result("a", 1));
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("nobody was woken")
            .unwrap();
        assert!(ledger.held().is_empty());
    }

    /// 被放弃的任务结束时主循环正忙着别的（没人在等）：叫醒留到下一次，不会丢。
    #[tokio::test]
    async fn the_wake_for_an_abandoned_task_is_kept_until_someone_waits() {
        let ledger = Ledger::default();
        start(&ledger, "a", 1, "run");
        ledger.abandon("a", 1);
        ledger.finish(result("a", 1));
        tokio::time::timeout(Duration::from_secs(5), ledger.discarded())
            .await
            .expect("the wake was lost");
    }

    #[test]
    fn abandoning_a_task_that_is_not_held_does_nothing() {
        let ledger = Ledger::default();
        ledger.abandon("a", 1);
        assert!(ledger.held().is_empty());
    }

    /// 协议上一个任务 ID 只有一个尝试（重试是新任务，有新的任务 ID），到不了「同一个任务 ID 有两个尝试在手上」；
    /// 台账不依赖这一点：两个尝试各占一格，一个的结果被 Ack 时另一个还在手上，任务没有落定，不写结束标记。
    #[tokio::test]
    async fn attempts_that_share_a_task_id_are_held_apart() {
        let ledger = Ledger::default();
        start(&ledger, "t", 2, "run");
        ledger.accept(&assign("t", 1, "run")).unwrap();
        assert_eq!(
            held(&ledger),
            [entry("t", 1, false), entry("t", 2, true)],
            "listed by task and attempt"
        );

        // 第一个尝试的结果被 Ack 时，同一个任务 ID 的第二个还在手上：没有落定，不写结束标记。
        ledger.started("t", 1);
        ledger.finish(result("t", 1));
        assert_eq!(sent(&ledger).await, ("t".into(), 1));
        assert!(ledger.ack("t", 1).is_none());
        assert_eq!(held(&ledger), [entry("t", 2, true)]);

        ledger.finish(result("t", 2));
        assert_eq!(sent(&ledger).await, ("t".into(), 2));
        assert!(ledger.ack("t", 2).is_some());
        assert!(ledger.held().is_empty());
    }

    /// 同一个任务 ID 的另一个尝试的结果已交出、还没发出，也算还在手上（同样是协议到不了的情况）。
    #[tokio::test]
    async fn an_unsent_result_keeps_its_task_id_unsettled() {
        let ledger = Ledger::default();
        start(&ledger, "t", 1, "run");
        start(&ledger, "t", 2, "run");
        ledger.finish(result("t", 1));
        assert_eq!(sent(&ledger).await, ("t".into(), 1));
        ledger.finish(result("t", 2));
        assert!(ledger.ack("t", 1).is_none());
        assert_eq!(sent(&ledger).await, ("t".into(), 2));
        assert!(ledger.ack("t", 2).is_some());
    }

    #[tokio::test]
    async fn a_run_ends_when_its_last_task_is_acked() {
        let ledger = Ledger::default();
        start(&ledger, "a", 1, "run");
        start(&ledger, "b", 1, "run");
        start(&ledger, "other", 1, "other-run");
        ledger.finish(result("a", 1));
        ledger.finish(result("b", 1));
        sent(&ledger).await;
        sent(&ledger).await;

        assert_eq!(ledger.ack("a", 1).unwrap().run_ended, None);
        assert_eq!(
            ledger.ack("b", 1).unwrap().run_ended.as_deref(),
            Some("run")
        );
    }

    /// 同一次运行里别的任务的结果已交出、还没发出，运行也还没结束。
    #[tokio::test]
    async fn a_run_does_not_end_while_another_task_of_it_has_an_unsent_result() {
        let ledger = Ledger::default();
        start(&ledger, "a", 1, "run");
        start(&ledger, "b", 1, "run");
        ledger.finish(result("a", 1));
        sent(&ledger).await;
        ledger.finish(result("b", 1));

        assert_eq!(ledger.ack("a", 1).unwrap().run_ended, None);
        assert_eq!(sent(&ledger).await, ("b".into(), 1));
        assert_eq!(
            ledger.ack("b", 1).unwrap().run_ended.as_deref(),
            Some("run")
        );
    }

    #[tokio::test]
    async fn only_a_result_that_was_sent_can_be_acked() {
        let ledger = Ledger::default();
        start(&ledger, "a", 1, "run");
        assert!(ledger.ack("a", 1).is_none(), "still running");
        ledger.finish(result("a", 1));
        assert!(ledger.ack("a", 1).is_none(), "not sent yet");
        assert_eq!(held(&ledger), [entry("a", 1, true)]);
        sent(&ledger).await;
        assert!(ledger.ack("a", 1).is_some());
        assert!(ledger.ack("a", 1).is_none(), "acked twice");
    }

    #[tokio::test]
    async fn results_are_sent_in_the_order_they_were_handed_over() {
        let ledger = Ledger::default();
        for task_id in ["c", "a", "b"] {
            start(&ledger, task_id, 1, "run");
        }
        for task_id in ["b", "c", "a"] {
            ledger.finish(result(task_id, 1));
        }
        for task_id in ["b", "c", "a"] {
            assert_eq!(sent(&ledger).await, (task_id.into(), 1));
        }
    }

    #[tokio::test]
    async fn next_result_waits_for_a_result_to_be_handed_over() {
        let ledger = Arc::new(Ledger::default());
        start(&ledger, "a", 1, "run");
        let waiting = tokio::spawn({
            let ledger = ledger.clone();
            async move { sent(&ledger).await }
        });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        ledger.finish(result("a", 1));
        assert_eq!(waiting.await.unwrap(), ("a".into(), 1));
    }

    /// 断线期间交出的结果，重连时当作待 Ack 重发，按任务和尝试排序，先于之后交出的结果。
    #[tokio::test]
    async fn results_handed_over_while_disconnected_are_resent_in_order() {
        let ledger = Ledger::default();
        for task_id in ["a", "b", "c"] {
            start(&ledger, task_id, 1, "run");
        }
        ledger.finish(result("b", 1));
        ledger.finish(result("a", 1));
        assert!(
            ledger.unacked().is_empty(),
            "not sent on any connection yet"
        );

        let listed = ledger.hello();
        assert_eq!(listed.len(), 3);
        let resent: Vec<_> = ledger.unacked().into_iter().map(|r| r.task_id).collect();
        assert_eq!(resent, ["a", "b"]);

        ledger.finish(result("c", 1));
        assert_eq!(sent(&ledger).await, ("c".into(), 1));
    }

    #[test]
    fn cancel_reaches_a_running_task_and_a_forced_cancel_escalates() {
        let ledger = Ledger::default();
        let mut cancel = ledger.accept(&assign("a", 1, "run")).unwrap();
        assert_eq!(*cancel.borrow_and_update(), None);
        assert!(ledger.cancel("a", 1, false));
        assert_eq!(*cancel.borrow_and_update(), Some(false));
        assert!(ledger.cancel("a", 1, true));
        assert_eq!(*cancel.borrow_and_update(), Some(true));
        assert!(ledger.cancel("a", 1, false));
        assert_eq!(*cancel.borrow(), Some(true), "never downgraded");
    }

    #[test]
    fn only_a_running_task_can_be_cancelled() {
        let ledger = Ledger::default();
        assert!(!ledger.cancel("a", 1, false), "unknown");
        start(&ledger, "a", 1, "run");
        ledger.finish(result("a", 1));
        assert!(!ledger.cancel("a", 1, false), "already finished");
    }

    #[test]
    fn cancel_all_reaches_the_running_tasks_only() {
        let ledger = Ledger::default();
        let mut running = ledger.accept(&assign("running", 1, "run")).unwrap();
        start(&ledger, "finished", 1, "run");
        ledger.finish(result("finished", 1));
        assert_eq!(ledger.cancel_all(false), 1);
        assert_eq!(*running.borrow_and_update(), Some(false));
    }

    #[test]
    fn calls_are_only_available_to_a_running_task() {
        let ledger = Ledger::default();
        let task = AssignTask {
            referenced_agents: vec![ReferencedAgent {
                name: "peer".into(),
                ..Default::default()
            }],
            ..assign("a", 1, "run")
        };
        let cancel = ledger.accept(&task).unwrap();
        let calls = ledger.calls_of("a", 1).expect("running");
        assert_eq!(calls.referenced.len(), 1);
        assert_eq!(calls.referenced[0].name, "peer");
        ledger.cancel("a", 1, false);
        assert!(calls.cancel.has_changed().unwrap());
        assert!(cancel.has_changed().unwrap());
        ledger.finish(result("a", 1));
        assert!(ledger.calls_of("a", 1).is_none());
        assert!(ledger.calls_of("unknown", 1).is_none());
    }

    fn success_of(task_id: &str, text: usize) -> TaskResult {
        TaskResult {
            status: TaskStatus::Success.into(),
            outputs_json: "x".repeat(text),
            agent_time_unix_ms: 111,
            monotonic_ms: 222,
            ..result(task_id, 1)
        }
    }

    fn failed_of(task_id: &str, message: &str, location: &str) -> TaskResult {
        TaskResult {
            status: TaskStatus::Failed.into(),
            error: Some(Box::new(crate::proto::TaskError {
                kind: ErrorKind::EnvError.into(),
                message: message.into(),
                location: location.into(),
            })),
            agent_time_unix_ms: 111,
            monotonic_ms: 222,
            ..result(task_id, 1)
        }
    }

    /// 一个台账里只有一个已经发出、没 Ack 的结果。
    async fn unacked_with(finished: TaskResult) -> Ledger {
        let ledger = Ledger::default();
        start(&ledger, &finished.task_id, 1, "run");
        ledger.finish(finished);
        ledger.next_result().await;
        ledger
    }

    /// 控制面用「消息超过上限」拒绝之后：整条消息超过上限的结果（待发的、待 Ack 的）换成失败，别的不动（#723）。
    #[tokio::test]
    async fn results_over_the_message_limit_are_replaced_by_a_failure_and_the_rest_are_kept() {
        let ledger = Ledger::default();
        for id in ["big-sent", "big-unsent", "small", "running"] {
            start(&ledger, id, 1, "run");
        }
        ledger.finish(success_of("big-sent", 10_000));
        ledger.finish(success_of("small", 10));
        // big-sent 已经发出（待 Ack），big-unsent 还没发出
        assert_eq!(ledger.next_result().await.task_id, "big-sent");
        ledger.finish(success_of("big-unsent", 10_000));

        assert_eq!(ledger.replace_results_over(5_000), 2);
        // 发出的顺序不变：先是没超过的 small（原样），再是换过的 big-unsent（还没发出的也换）
        let next = ledger.next_result().await;
        assert_eq!(
            next,
            success_of("small", 10),
            "没超过的不动（成功的结果不能因为被拒的是别的消息就变成失败）"
        );
        let next = ledger.next_result().await;
        assert_eq!(next.task_id, "big-unsent");
        assert_eq!(next.status(), TaskStatus::Failed);

        let unacked: HashMap<String, TaskResult> = ledger
            .unacked()
            .into_iter()
            .map(|r| (r.task_id.clone(), r))
            .collect();
        let replaced = &unacked["big-sent"];
        assert_eq!(replaced.status(), TaskStatus::Failed);
        assert_eq!(replaced.outputs_json, "");
        assert_eq!(
            (replaced.agent_time_unix_ms, replaced.monotonic_ms),
            (111, 222)
        );
        let error = replaced.error.as_ref().expect("失败带着原因");
        assert_eq!(error.kind(), ErrorKind::NodeError);
        assert!(
            error
                .message
                .contains("超过控制面接收一条消息的上限 5000 字节"),
            "{}",
            error.message
        );
        // 写的是整条消息的大小，和控制面日志里的 `message size N` 同一个数
        assert!(
            error.message.contains(&format!(
                "有 {} 字节",
                result_message_size(&success_of("big-sent", 10_000))
            )),
            "{}",
            error.message
        );
        assert!(replaced.encoded_len() < 5_000);
        // 执行中的任务也不动
        assert_eq!(held(&ledger).len(), 4);
        // 已经够小的再换一遍：没有要换的
        assert_eq!(ledger.replace_results_over(5_000), 0);
    }

    /// 边界：整条消息正好等于上限的不换，多 1 个字节的换（控制面也是这样量的）。成功变失败是最坏的方向：上限以下的
    /// 成功结果不论多大（离上限只差 1 个字节、一半、很远）都原样留着。
    #[tokio::test]
    async fn a_result_is_replaced_exactly_when_the_whole_message_is_over_the_limit() {
        let size = result_message_size(&success_of("edge", 10_000));
        // 结果自己的编码比整条消息小：按它比的话上限正好卡在这几个字节里的那一条就换不掉
        assert!(success_of("edge", 10_000).encoded_len() < size);
        for limit in [size, size + 1, size + size / 2, size * 2, size * 1000] {
            let ledger = unacked_with(success_of("edge", 10_000)).await;
            assert_eq!(ledger.replace_results_over(limit), 0, "上限 {limit}");
            assert_eq!(ledger.unacked(), [success_of("edge", 10_000)]);
        }
        // 上限是消息的一半、一半多一点、少 1 个字节：换（它们都比这条消息小）
        for limit in [size - 1, size - 4, size - 5, size - 6, size / 2] {
            let ledger = unacked_with(success_of("edge", 10_000)).await;
            assert_eq!(ledger.replace_results_over(limit), 1, "上限 {limit}");
            assert_eq!(ledger.unacked()[0].status(), TaskStatus::Failed);
        }
    }

    /// 换掉之后写明原来的状态：成功的写成功，失败的写失败、带着出错的位置和原来文字的开头（不是全文）；类型 node_error。
    #[tokio::test]
    async fn the_replacement_says_what_the_result_was_and_what_to_do() {
        let ledger = unacked_with(success_of("was-ok", 10_000)).await;
        ledger.replace_results_over(1_000);
        let error = ledger.unacked()[0].error.clone().unwrap();
        assert_eq!(error.kind(), ErrorKind::NodeError);
        assert!(
            error.message.starts_with("任务成功了，结果有 "),
            "{}",
            error.message
        );
        assert!(error.message.contains("按重试配置重跑"));
        assert!(error.message.contains("办法："));
        assert!(!error.message.contains("原来的失败文字"));
        assert_eq!(error.location, "");

        // 原来的失败：1 万个「中」（3 万字节）加开头；换掉之后只留 2 KiB 左右的开头，截在字符边界上
        let text = format!("开头：{}", "中".repeat(10_000));
        let ledger = unacked_with(failed_of("was-failed", &text, "mod.fn 第 7 行")).await;
        ledger.replace_results_over(10_000);
        let replaced = ledger.unacked()[0].clone();
        assert_eq!(replaced.status(), TaskStatus::Failed);
        let error = replaced.error.clone().unwrap();
        assert_eq!(
            error.kind(),
            ErrorKind::NodeError,
            "原来的类型不带过来，一律 node_error"
        );
        assert!(
            error.message.starts_with("任务失败了，失败的结果有 "),
            "{}",
            error.message
        );
        assert!(error.message.contains("原来的失败文字，只留开头 "));
        assert!(
            error
                .message
                .contains(&format!("（共 {} 字节）", text.len()))
        );
        assert!(error.message.contains("开头：中中中"));
        assert_eq!(error.location, "mod.fn 第 7 行", "出错的位置带着");
        assert!(replaced.encoded_len() < 4_000, "{}", replaced.encoded_len());
        assert_eq!(
            (replaced.agent_time_unix_ms, replaced.monotonic_ms),
            (111, 222)
        );

        // 失败文字本来就很短：全文带上
        let ledger = unacked_with(failed_of("short", "boom", "")).await;
        ledger.replace_results_over(10);
        let error = ledger.unacked()[0].error.clone().unwrap();
        assert!(
            error.message.contains("原来的失败文字（全文）：\nboom"),
            "{}",
            error.message
        );
    }

    /// 取消的结果文字是固定的短句：不换（换成失败会让取消的任务被当成失败去重试）。
    #[tokio::test]
    async fn a_cancelled_result_is_never_replaced() {
        let cancelled = TaskResult {
            status: TaskStatus::Cancelled.into(),
            ..failed_of("cancelled", "任务已取消，已终止进程树", "")
        };
        let ledger = unacked_with(cancelled.clone()).await;
        assert_eq!(ledger.replace_results_over(1), 0);
        assert_eq!(ledger.unacked(), [cancelled]);
    }

    /// 保留期扫描：不再在手上的任务忘掉它属于哪次运行，在手上的（含结果已交出的）保留。
    #[tokio::test]
    async fn a_sweep_forgets_the_runs_of_tasks_that_are_no_longer_held() {
        let ledger = Ledger::default();
        start(&ledger, "gone", 1, "run");
        start(&ledger, "unsent", 1, "run");
        start(&ledger, "running", 1, "other-run");
        ledger.abandon("gone", 1);
        ledger.finish(result("gone", 1));
        ledger.finish(result("unsent", 1));

        let held: HashSet<String> = ledger.held().into_iter().map(|t| t.task_id).collect();
        assert_eq!(held.len(), 2);
        assert!(ledger.holds_task("unsent") && ledger.holds_task("running"));
        assert!(!ledger.holds_task("gone"));
        assert_eq!(ledger.forget_runs_except(&held), ["gone"]);
        let mut tasks = ledger.tasks_of_run("run");
        tasks.sort();
        assert_eq!(tasks, ["unsent"]);
        assert_eq!(ledger.tasks_of_run("other-run"), ["running"]);
    }
}
