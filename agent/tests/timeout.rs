//! 切入点 B（Agent 一侧）：任务超时后 Agent 杀掉整棵进程树，以 timeout 失败（docs/SEMANTICS.md §3.3）。
#![cfg(unix)]

mod support;

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::json;
use sfly_agent::proto::{CancelTask, ErrorKind, TaskStatus, server_message};
use support::calls::{open_call, read_reply, referenced, request, silent_peer, socket_of};
use support::{
    AgentOptions, FakeControlPlane, assert_quiet_termination, capture_stderr, spawn_agent,
    stub_task, wait_until,
};

fn alive(pid: u32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => !stat
            .rsplit_once(')')
            .is_some_and(|(_, rest)| rest.trim_start().starts_with(['Z', 'X'])),
        Err(_) => false,
    }
}

fn pids(path: &Path) -> Vec<u32> {
    std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
        .split_whitespace()
        .map(|p| p.parse().unwrap())
        .collect()
}

async fn assert_all_gone(pids: &[u32]) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while pids.iter().any(|&p| alive(p)) {
        assert!(Instant::now() < deadline, "processes still alive: {pids:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn timed_out_task_has_its_process_tree_killed_and_fails_with_timeout() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-timeout"));
    cp.hello(0).await;
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pids");

    let mut task = stub_task(
        "task-timeout",
        "process_tree",
        json!({ "pid_file": pid_file, "seconds": 60 }),
    );
    task.timeout_seconds = 1;
    let started = Instant::now();
    cp.assign(task).await;

    let (result, _) = cp.result("task-timeout").await;
    assert!(started.elapsed() >= Duration::from_secs(1));
    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.expect("error");
    assert_eq!(error.kind(), ErrorKind::Timeout, "{error:?}");
    assert!(error.message.contains("1 秒"), "{}", error.message);
    let pids = pids(&pid_file);
    assert_eq!(pids.len(), 2);
    assert_all_gone(&pids).await;
    // 超时是 Agent 发 SIGTERM 终止的，节点里收到 Cancelled：日志里没有 ERROR 级的堆栈，
    // 只有一行 INFO 写明被终止。
    assert_quiet_termination(&cp.task_logs("task-timeout"));
}

#[tokio::test]
async fn timed_out_task_sees_the_cancel_marker_while_it_cleans_up_and_still_fails_with_timeout() {
    // #593：超时进入收尾时间时和取消一样先写取消标记，节点里 `ctx.cancelled()` 是真的；
    // 任务的结局不受影响，仍然是超时失败，不是取消。
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(AgentOptions::new(&cp.url, "agent-timeout-marker"));
    cp.hello(0).await;
    let dir = tempfile::tempdir().unwrap();
    let ready = dir.path().join("ready");
    let report = dir.path().join("report");

    let mut task = stub_task(
        "task-timeout-marker",
        "wait_cancel",
        json!({ "ready_file": ready, "report_file": report }),
    );
    // 给节点留够启动的时间：SIGTERM 来得太早的话 `finally` 还没有进入。
    task.timeout_seconds = 2;
    cp.assign(task).await;

    let (result, _) = cp.result("task-timeout-marker").await;
    assert_eq!(result.status(), TaskStatus::Failed, "{result:?}");
    assert_eq!(result.error.expect("error").kind(), ErrorKind::Timeout);
    assert_eq!(wait_for_report(&report).await, "cancelled");
    assert!(
        agent
            .work_dir
            .path()
            .join("task-timeout-marker/cancel")
            .exists()
    );
}

#[tokio::test]
async fn cleaning_up_two_services_that_ignore_sigterm_finishes_within_the_grace_period_after_a_timeout()
 {
    // #593：节点在 `finally` 里依次停两个不理会 SIGTERM 的服务（和 sfly-std 的
    // `stop_background_process` 同样的做法）：任务已经被「取消」（`ctx.cancelled()` 为真）时宽限期压短。
    // 超时时 Agent 以前不写标记，宽限期压不短：第一个服务用满 3 秒，第二个刚发出 SIGTERM，
    // 平台的收尾时间（这里 4 秒）就到了，第二个服务留在机器上。
    let cp = FakeControlPlane::start().await;
    let mut options = AgentOptions::new(&cp.url, "agent-timeout-services");
    options.args = vec!["--terminate-grace".into(), "4".into()];
    let _agent = spawn_agent(options);
    cp.hello(0).await;
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pids");

    let mut task = stub_task(
        "task-timeout-services",
        "stubborn_services",
        json!({ "pid_file": pid_file, "count": 2, "grace": 3, "cancelled_grace": 1 }),
    );
    // 给节点留够启动的时间：SIGTERM 来得太早的话 `finally` 还没有进入。
    task.timeout_seconds = 2;
    cp.assign(task).await;

    let (result, _) = cp.result("task-timeout-services").await;
    assert_eq!(result.status(), TaskStatus::Failed, "{result:?}");
    assert_eq!(result.error.expect("error").kind(), ErrorKind::Timeout);
    let pids = pids(&pid_file);
    assert_eq!(pids.len(), 2);
    assert_all_gone(&pids).await;
}

#[tokio::test]
async fn a_cancel_marker_that_cannot_be_written_does_not_stop_the_timeout_from_terminating_the_process_tree()
 {
    // 写取消标记失败（路径上已经有一个叫 `cancel` 的目录，EISDIR）：Agent 只在标准错误里写一行，
    // 照常终止进程树，任务仍然以超时失败；不 panic，也不因为标记写不出来就不终止。
    let cp = FakeControlPlane::start().await;
    let mut options = AgentOptions::new(&cp.url, "agent-timeout-marker-fails");
    options.pipe_stderr = true;
    let mut agent = spawn_agent(options);
    let stderr = capture_stderr(&mut agent);
    cp.hello(0).await;
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pids");

    let mut task = stub_task(
        "task-marker-fails",
        "process_tree",
        json!({ "pid_file": pid_file, "seconds": 60, "block_cancel_marker": true }),
    );
    // 给节点留够建目录、写 PID 的时间：超时来得太早的话标记写得进去，下面「写失败」那一行就没有，测试会红。
    task.timeout_seconds = 3;
    let started = Instant::now();
    cp.assign(task).await;

    let (result, _) = cp.result("task-marker-fails").await;
    assert_eq!(result.status(), TaskStatus::Failed, "{result:?}");
    assert_eq!(result.error.expect("error").kind(), ErrorKind::Timeout);
    // 进程树在宽限期（默认 10 秒）之内被终止：节点收到 SIGTERM 就退出，不需要等到强制杀掉。
    assert!(started.elapsed() < Duration::from_secs(9));
    assert_all_gone(&pids(&pid_file)).await;
    assert!(
        agent
            .work_dir
            .path()
            .join("task-marker-fails/cancel")
            .is_dir()
    );

    wait_until("the failed marker write to be logged", || {
        let lines = stderr.lock().unwrap();
        lines
            .iter()
            .any(|l| l.contains("cannot write cancel marker"))
    })
    .await;
    let lines = stderr.lock().unwrap().clone();
    let failed: Vec<_> = lines
        .iter()
        .filter(|l| l.contains("cannot write cancel marker"))
        .collect();
    assert_eq!(failed.len(), 1, "{lines:?}");
    assert!(failed[0].contains("task-marker-fails/cancel"), "{failed:?}");
    assert!(lines.iter().all(|l| !l.contains("panicked")), "{lines:?}");
}

/// 等节点在 `finally` 里写出报告（超时的任务结果和节点收尾的先后不保证）。
async fn wait_for_report(path: &Path) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(text) = std::fs::read_to_string(path)
            && !text.is_empty()
        {
            return text;
        }
        assert!(Instant::now() < deadline, "没有等到 {}", path.display());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn processes_ignoring_sigterm_are_killed_after_the_grace_period() {
    let cp = FakeControlPlane::start().await;
    let mut options = AgentOptions::new(&cp.url, "agent-stubborn");
    options.args = vec!["--terminate-grace".into(), "1".into()];
    let _agent = spawn_agent(options);
    cp.hello(0).await;
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pids");

    let mut task = stub_task(
        "task-stubborn",
        "process_tree",
        json!({ "pid_file": pid_file, "seconds": 60, "ignore_term": true }),
    );
    task.timeout_seconds = 1;
    let started = Instant::now();
    cp.assign(task).await;

    let (result, _) = cp.result("task-stubborn").await;
    assert!(started.elapsed() >= Duration::from_secs(2));
    assert_eq!(result.error.expect("error").kind(), ErrorKind::Timeout);
    assert_all_gone(&pids(&pid_file)).await;
}

#[tokio::test]
async fn task_finishing_within_its_timeout_succeeds() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-in-time"));
    cp.hello(0).await;

    let mut task = stub_task("task-in-time", "sleep", json!({ "seconds": 0.2 }));
    task.timeout_seconds = 5;
    cp.assign(task).await;

    let (result, _) = cp.result("task-in-time").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
}

async fn cancel(cp: &FakeControlPlane, task_id: &str, force: bool) {
    cp.send(server_message::Body::Cancel(CancelTask {
        task_id: task_id.into(),
        attempt: 1,
        force,
    }))
    .await;
}

#[tokio::test]
async fn a_forced_cancel_during_the_grace_period_after_a_timeout_kills_the_process_tree_at_once() {
    // #617：超时进入收尾时间（已经向进程树发了 SIGTERM）之后又收到强制取消：立即杀掉进程树，不等收尾时间用完。
    // 结局仍然是超时：它由先发生的原因决定，控制面按运行是否已经取消记任务的状态。
    let cp = FakeControlPlane::start().await;
    let mut options = AgentOptions::new(&cp.url, "agent-timeout-force");
    options.args = vec!["--terminate-grace".into(), "60".into()];
    let agent = spawn_agent(options);
    cp.hello(0).await;
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pids");

    let mut task = stub_task(
        "task-timeout-force",
        "process_tree",
        json!({ "pid_file": pid_file, "ignore_term": true }),
    );
    task.timeout_seconds = 2;
    cp.assign(task).await;
    wait_for_report(&pid_file).await;
    let pids = pids(&pid_file);
    // 取消标记出现了：超时已经进入收尾时间，进程树理会不了 SIGTERM，还活着。
    let marker = agent.work_dir.path().join("task-timeout-force/cancel");
    wait_until("the cancel marker", || marker.exists()).await;
    assert!(pids.iter().all(|&p| alive(p)), "SIGTERM is ignored");

    let forced = Instant::now();
    cancel(&cp, "task-timeout-force", true).await;
    let (result, _) = cp.result("task-timeout-force").await;
    assert!(
        forced.elapsed() < Duration::from_secs(2),
        "{:?}",
        forced.elapsed()
    );
    assert_eq!(result.status(), TaskStatus::Failed, "{result:?}");
    let error = result.error.expect("error");
    assert_eq!(error.kind(), ErrorKind::Timeout, "{error:?}");
    assert!(error.message.contains("2 秒"), "{}", error.message);
    assert!(
        error.message.contains("收到强制取消，已强制杀掉进程树"),
        "{}",
        error.message
    );
    assert_all_gone(&pids).await;
}

#[tokio::test]
async fn a_graceful_cancel_during_the_grace_period_after_a_timeout_does_not_cut_it_short() {
    // #617：优雅取消不用做什么（进程树已经在终止），收尾时间照常用满，结局仍然是超时。
    let cp = FakeControlPlane::start().await;
    let mut options = AgentOptions::new(&cp.url, "agent-timeout-graceful");
    options.args = vec!["--terminate-grace".into(), "3".into()];
    let agent = spawn_agent(options);
    cp.hello(0).await;
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pids");

    let mut task = stub_task(
        "task-timeout-graceful",
        "process_tree",
        json!({ "pid_file": pid_file, "ignore_term": true }),
    );
    task.timeout_seconds = 2;
    cp.assign(task).await;
    wait_for_report(&pid_file).await;
    let pids = pids(&pid_file);
    let marker = agent.work_dir.path().join("task-timeout-graceful/cancel");
    wait_until("the cancel marker", || marker.exists()).await;

    let cancelled = Instant::now();
    cancel(&cp, "task-timeout-graceful", false).await;
    let (result, _) = cp.result("task-timeout-graceful").await;
    assert!(
        cancelled.elapsed() >= Duration::from_secs(2),
        "the grace period was cut short: {:?}",
        cancelled.elapsed()
    );
    assert_eq!(result.status(), TaskStatus::Failed, "{result:?}");
    let error = result.error.expect("error");
    assert_eq!(error.kind(), ErrorKind::Timeout, "{error:?}");
    assert!(!error.message.contains("强制取消"), "{}", error.message);
    assert_all_gone(&pids).await;
}

#[tokio::test]
async fn an_agent_call_in_flight_ends_when_the_task_times_out_while_the_node_is_still_cleaning_up()
{
    // #617：超时进入收尾时间时，这个任务正在进行的 Agent 能力调用和取消一样立即结束（以 cancelled 回复，SDK 抛
    // `Cancelled`），不等进程退出；任务的结局仍然是超时。后台线程里的调用走的是同一条路。
    let cp = FakeControlPlane::start().await;
    let mut options = AgentOptions::new(&cp.url, "agent-timeout-call");
    options.args = vec!["--terminate-grace".into(), "60".into()];
    let agent = spawn_agent(options);
    cp.hello(0).await;
    let (port, _peer) = silent_peer().await;
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pids");

    let mut task = stub_task(
        "task-timeout-call",
        "process_tree",
        json!({ "pid_file": pid_file, "ignore_term": true }),
    );
    task.referenced_agents = vec![referenced("silent", "127.0.0.1", port)];
    task.timeout_seconds = 3;
    cp.assign(task).await;
    wait_for_report(&pid_file).await;
    let pids = pids(&pid_file);

    // 不限调用的超时：只有任务进入收尾时间能结束它。
    let mut ask = request(
        "task-timeout-call",
        "silent",
        "files.stat",
        json!({ "path": "/" }),
    );
    ask["timeout_ms"] = json!(0);
    let mut open = open_call(&socket_of(&agent), &ask).await;
    let reply = tokio::spawn(async move { read_reply(&mut open).await });
    let reply = tokio::time::timeout(Duration::from_secs(10), reply)
        .await
        .expect("the call did not end when the task timed out")
        .unwrap();
    assert_eq!(reply.error().0, "cancelled");
    // 调用是在进程还活着的时候结束的：节点理会不了 SIGTERM，收尾时间有 60 秒。
    assert!(
        pids.iter().all(|&p| alive(p)),
        "the call waited for the process to exit"
    );

    cancel(&cp, "task-timeout-call", true).await;
    let (result, _) = cp.result("task-timeout-call").await;
    assert_eq!(result.status(), TaskStatus::Failed, "{result:?}");
    assert_eq!(result.error.expect("error").kind(), ErrorKind::Timeout);
    assert_all_gone(&pids).await;
}
