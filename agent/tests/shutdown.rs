//! 切入点 B（Agent 一侧）：Agent 收到退出信号（SIGTERM / Ctrl-C 的 SIGINT）时终止手上任务的进程树（#113）——
//! 执行器自成进程组，不会随 Agent 一起收到信号；Agent 不终止它们就会留下孤儿执行器。
#![cfg(unix)]

mod support;

use std::path::Path;
use std::time::{Duration, Instant};

use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use serde_json::json;
use support::{AgentOptions, AgentProcess, FakeControlPlane, spawn_agent, stub_task};

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

/// 向 Agent 发信号，等它退出（最多 `within`），返回所用时间。
async fn stop_agent(agent: &mut AgentProcess, signal: Signal, within: Duration) -> Duration {
    let started = Instant::now();
    let pid = Pid::from_raw(agent.child.id().unwrap() as i32);
    kill(pid, signal).unwrap();
    tokio::time::timeout(within, agent.child.wait())
        .await
        .expect("agent did not exit after the signal")
        .unwrap();
    started.elapsed()
}

async fn assert_all_gone(pids: &[u32]) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while pids.iter().any(|&p| alive(p)) {
        assert!(Instant::now() < deadline, "processes still alive: {pids:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Agent 收到 `signal` 后优雅终止正在执行的任务（节点的 finally 照常执行），然后退出，不留执行器。
async fn running_task_is_terminated_on(signal: Signal) {
    let cp = FakeControlPlane::start().await;
    let mut agent = spawn_agent(AgentOptions::new(&cp.url, "agent-shutdown"));
    cp.hello(0).await;
    let dir = tempfile::tempdir().unwrap();
    let ready = dir.path().join("ready");
    let report = dir.path().join("report");
    cp.assign(stub_task(
        "task-running",
        "wait_cancel",
        json!({ "ready_file": ready, "report_file": report }),
    ))
    .await;
    let pid: u32 = wait_for_file(&ready).await.trim().parse().unwrap();

    stop_agent(&mut agent, signal, Duration::from_secs(15)).await;

    assert_all_gone(&[pid]).await;
    // 和取消一样优雅终止：先写取消标记再 SIGTERM，节点里抛出 Cancelled，
    // finally 里的清理代码执行了，并且看得到 ctx.cancelled()。
    assert_eq!(
        std::fs::read_to_string(&report).ok().as_deref(),
        Some("cancelled")
    );
}

#[tokio::test]
async fn sigterm_terminates_running_tasks_before_the_agent_exits() {
    running_task_is_terminated_on(Signal::SIGTERM).await;
}

#[tokio::test]
async fn ctrl_c_terminates_running_tasks_before_the_agent_exits() {
    running_task_is_terminated_on(Signal::SIGINT).await;
}

#[tokio::test]
async fn task_processes_ignoring_sigterm_are_killed_after_the_grace_period() {
    let cp = FakeControlPlane::start().await;
    let mut options = AgentOptions::new(&cp.url, "agent-shutdown-force");
    options.args = vec!["--terminate-grace".into(), "1".into()];
    let mut agent = spawn_agent(options);
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

    let took = stop_agent(&mut agent, Signal::SIGTERM, Duration::from_secs(10)).await;

    assert!(took >= Duration::from_millis(900), "exited after {took:?}");
    assert_all_gone(&pids).await;
}

#[tokio::test]
async fn a_second_signal_during_the_grace_period_kills_task_processes_at_once() {
    let cp = FakeControlPlane::start().await;
    let mut options = AgentOptions::new(&cp.url, "agent-shutdown-twice");
    options.args = vec!["--terminate-grace".into(), "60".into()];
    let mut agent = spawn_agent(options);
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
    let agent_pid = Pid::from_raw(agent.child.id().unwrap() as i32);

    // 第一次：开始等宽限期（执行器忽略 SIGTERM）；第二次：不再等，直接强制杀掉后退出。
    kill(agent_pid, Signal::SIGTERM).unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(
        agent.child.try_wait().unwrap().is_none(),
        "the agent exited before the grace period ended"
    );
    stop_agent(&mut agent, Signal::SIGINT, Duration::from_secs(10)).await;

    assert_all_gone(&pids).await;
}
