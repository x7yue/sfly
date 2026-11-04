//! 切入点 B（Agent 一侧）：任务超时后 Agent 杀掉整棵进程树，以 timeout 失败（docs/SEMANTICS.md §3.3）。
#![cfg(unix)]

mod support;

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::json;
use sfly_agent::proto::{ErrorKind, TaskStatus};
use support::{AgentOptions, FakeControlPlane, spawn_agent, stub_task};

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
