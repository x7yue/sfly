//! 切入点 B（Agent 一侧）：断线恢复（#15）——重连时在 Hello 中上报手上的任务，
//! 按 Welcome 的处置继续或放弃，按 Welcome 给的间隔发送心跳。
#![cfg(unix)]

mod support;

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::json;
use sfly_agent::proto::{RunningTask, agent_message};
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

fn held(task_id: &str) -> RunningTask {
    RunningTask {
        task_id: task_id.into(),
        attempt: 1,
        // 两个任务的执行器都已启动（一个还在运行，一个已结束、结果没收到 Ack）。
        started: true,
    }
}

fn sorted(mut tasks: Vec<RunningTask>) -> Vec<RunningTask> {
    tasks.sort_by(|a, b| a.task_id.cmp(&b.task_id));
    tasks
}

#[tokio::test]
async fn hello_after_reconnecting_lists_running_tasks_and_tasks_with_unacked_results() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-held"));
    assert!(cp.hello(0).await.running_tasks.is_empty());
    cp.stop_acking();
    let dir = tempfile::tempdir().unwrap();
    let ready = dir.path().join("ready");

    cp.assign(stub_task(
        "task-running",
        "wait_cancel",
        json!({ "ready_file": ready, "report_file": dir.path().join("report") }),
    ))
    .await;
    cp.assign(stub_task("task-done", "echo", json!({ "text": "x" })))
        .await;
    wait_for_file(&ready).await;
    cp.result("task-done").await;
    cp.end_session();

    let hello = cp.hello(1).await;
    assert_eq!(
        sorted(hello.running_tasks),
        vec![held("task-done"), held("task-running")]
    );
}

#[tokio::test]
async fn abandoned_tasks_are_killed_and_their_results_dropped() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-abandon"));
    cp.hello(0).await;
    cp.stop_acking();
    let dir = tempfile::tempdir().unwrap();
    let ready = dir.path().join("ready");

    cp.assign(stub_task(
        "task-running",
        "wait_cancel",
        json!({ "ready_file": ready, "report_file": dir.path().join("report") }),
    ))
    .await;
    cp.assign(stub_task("task-done", "echo", json!({ "text": "x" })))
        .await;
    let pid: u32 = wait_for_file(&ready).await.trim().parse().unwrap();
    cp.result("task-done").await;
    cp.abandon("task-running");
    cp.abandon("task-done");
    cp.end_session();
    cp.hello(1).await;

    // 放弃的任务立即被杀掉（不等宽限期）。
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid) {
        assert!(Instant::now() < deadline, "abandoned task still running");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // 两个任务的结果都不再上报。
    tokio::time::sleep(Duration::from_millis(500)).await;
    let resent: Vec<_> = cp
        .received_with_session()
        .into_iter()
        .filter(|r| {
            r.session >= 1 && matches!(r.message.body, Some(agent_message::Body::Result(_)))
        })
        .collect();
    assert!(resent.is_empty(), "unexpected results: {resent:#?}");
    // 之后再重连，Hello 里也不再有它们。
    cp.end_session();
    assert!(cp.hello(2).await.running_tasks.is_empty());
}

#[tokio::test]
async fn sends_heartbeats_at_the_interval_given_in_welcome() {
    let cp = FakeControlPlane::start().await;
    cp.set_heartbeat_interval(Duration::from_millis(100));
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-heartbeat"));
    cp.hello(0).await;
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let beats = cp.heartbeats();
    assert!(
        (5..=15).contains(&beats.len()),
        "{} heartbeats in 1s",
        beats.len()
    );
}

#[tokio::test]
async fn heartbeats_list_the_tasks_the_agent_holds() {
    let cp = FakeControlPlane::start().await;
    cp.set_heartbeat_interval(Duration::from_millis(100));
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-held-beats"));
    cp.hello(0).await;
    cp.stop_acking();
    let dir = tempfile::tempdir().unwrap();
    let ready = dir.path().join("ready");
    cp.assign(stub_task(
        "task-running",
        "wait_cancel",
        json!({ "ready_file": ready, "report_file": dir.path().join("report") }),
    ))
    .await;
    cp.assign(stub_task("task-done", "echo", json!({ "text": "x" })))
        .await;
    wait_for_file(&ready).await;
    cp.result("task-done").await;

    // 心跳带上正在执行的任务和结果还没收到 Ack 的任务（控制面只为它们续约）。
    let beat = cp
        .wait_for("heartbeat listing both tasks", |all| {
            all.iter().rev().find_map(|r| match &r.message.body {
                Some(agent_message::Body::Heartbeat(h)) if h.running_tasks.len() == 2 => {
                    Some(h.clone())
                }
                _ => None,
            })
        })
        .await;
    assert_eq!(
        sorted(beat.running_tasks),
        vec![held("task-done"), held("task-running")]
    );
}
