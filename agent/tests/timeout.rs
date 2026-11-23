//! 切入点 B（Agent 一侧）：任务超时后 Agent 杀掉整棵进程树，以 timeout 失败（docs/SEMANTICS.md §3.3）。
#![cfg(unix)]

mod support;

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::json;
use sfly_agent::proto::{ErrorKind, TaskStatus};
use support::{AgentOptions, FakeControlPlane, assert_quiet_termination, spawn_agent, stub_task};

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
