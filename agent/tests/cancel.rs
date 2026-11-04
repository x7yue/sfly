//! 切入点 B（Agent 一侧）：取消任务（docs/SEMANTICS.md §3.4）——先写取消标记、优雅终止，
//! 宽限期过后杀掉整棵进程树；强制取消立即杀掉；以 TASK_STATUS_CANCELLED 上报。
#![cfg(unix)]

mod support;

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::json;
use sfly_agent::proto::{CancelTask, TaskStatus, server_message};
use support::{AgentOptions, FakeControlPlane, spawn_agent, stub_task};

fn alive(pid: u32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => !stat
            .rsplit_once(')')
            .is_some_and(|(_, rest)| rest.trim_start().starts_with(['Z', 'X'])),
        Err(_) => false,
    }
}

async fn wait_for_file(path: &Path) -> String {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(text) = std::fs::read_to_string(path)
            && !text.is_empty()
        {
            return text;
        }
        assert!(
            Instant::now() < deadline,
            "{} never appeared",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn pids(text: &str) -> Vec<u32> {
    text.split_whitespace()
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

async fn cancel(cp: &FakeControlPlane, task_id: &str, force: bool) {
    cp.send(server_message::Body::Cancel(CancelTask {
        task_id: task_id.into(),
        attempt: 1,
        force,
    }))
    .await;
}

#[tokio::test]
async fn cancelled_task_sees_the_cancel_marker_and_terminates_gracefully() {
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(AgentOptions::new(&cp.url, "agent-cancel"));
    cp.hello(0).await;
    let dir = tempfile::tempdir().unwrap();
    let ready = dir.path().join("ready");
    let report = dir.path().join("report");

    cp.assign(stub_task(
        "task-cancel",
        "wait_cancel",
        json!({ "ready_file": ready, "report_file": report }),
    ))
    .await;
    let pid: u32 = wait_for_file(&ready).await.trim().parse().unwrap();
    let started = Instant::now();
    cancel(&cp, "task-cancel", false).await;

    let (result, _) = cp.result("task-cancel").await;
    // 节点代码响应了优雅终止，不需要等到宽限期（默认 10 秒）结束。
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(result.status(), TaskStatus::Cancelled, "{result:?}");
    assert_eq!(wait_for_file(&report).await, "cancelled");
    assert!(agent.work_dir.path().join("task-cancel/cancel").exists());
    assert_all_gone(&[pid]).await;
}

#[tokio::test]
async fn process_tree_ignoring_sigterm_is_killed_after_the_grace_period() {
    let cp = FakeControlPlane::start().await;
    let mut options = AgentOptions::new(&cp.url, "agent-cancel-stubborn");
    options.args = vec!["--terminate-grace".into(), "1".into()];
    let _agent = spawn_agent(options);
    cp.hello(0).await;
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pids");

    cp.assign(stub_task(
        "task-stubborn",
        "process_tree",
        json!({ "pid_file": pid_file, "ignore_term": true }),
    ))
    .await;
    let pids = pids(&wait_for_file(&pid_file).await);
    let started = Instant::now();
    cancel(&cp, "task-stubborn", false).await;

    let (result, _) = cp.result("task-stubborn").await;
    assert!(started.elapsed() >= Duration::from_secs(1));
    assert_eq!(result.status(), TaskStatus::Cancelled, "{result:?}");
    assert_all_gone(&pids).await;
}

#[tokio::test]
async fn forced_cancel_kills_the_process_tree_immediately() {
    let cp = FakeControlPlane::start().await;
    let mut options = AgentOptions::new(&cp.url, "agent-cancel-force");
    options.args = vec!["--terminate-grace".into(), "60".into()];
    let _agent = spawn_agent(options);
    cp.hello(0).await;
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pids");

    cp.assign(stub_task(
        "task-force",
        "process_tree",
        json!({ "pid_file": pid_file, "ignore_term": true }),
    ))
    .await;
    let pids = pids(&wait_for_file(&pid_file).await);
    let started = Instant::now();
    cancel(&cp, "task-force", true).await;

    let (result, _) = cp.result("task-force").await;
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(result.status(), TaskStatus::Cancelled, "{result:?}");
    assert_all_gone(&pids).await;
}

#[tokio::test]
async fn forced_cancel_during_graceful_termination_kills_immediately() {
    let cp = FakeControlPlane::start().await;
    let mut options = AgentOptions::new(&cp.url, "agent-cancel-escalate");
    options.args = vec!["--terminate-grace".into(), "60".into()];
    let _agent = spawn_agent(options);
    cp.hello(0).await;
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pids");

    cp.assign(stub_task(
        "task-escalate",
        "process_tree",
        json!({ "pid_file": pid_file, "ignore_term": true }),
    ))
    .await;
    let pids = pids(&wait_for_file(&pid_file).await);
    let started = Instant::now();
    cancel(&cp, "task-escalate", false).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(pids.iter().all(|&p| alive(p)), "SIGTERM is ignored");
    cancel(&cp, "task-escalate", true).await;

    let (result, _) = cp.result("task-escalate").await;
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(result.status(), TaskStatus::Cancelled, "{result:?}");
    assert_all_gone(&pids).await;
}

#[tokio::test]
async fn cancel_for_an_unknown_task_is_ignored() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-cancel-unknown"));
    cp.hello(0).await;
    cancel(&cp, "no-such-task", true).await;

    cp.assign(stub_task("task-after", "sleep", json!({ "seconds": 0.1 })))
        .await;
    let (result, _) = cp.result("task-after").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
}
