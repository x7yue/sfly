//! 进程树终止（`sfly_agent::process_tree`）：超时、取消共用的抽象。Linux 下用进程组实现。
#![cfg(unix)]

use std::path::Path;
use std::time::{Duration, Instant};

use sfly_agent::process_tree::ProcessTree;

/// 进程是否还活着（僵尸进程算已经结束）。
pub fn alive(pid: u32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        // 第三个字段是状态；命令名在括号里，可能有空格，从最后一个 ')' 之后取。
        Ok(stat) => !stat
            .rsplit_once(')')
            .is_some_and(|(_, rest)| rest.trim_start().starts_with(['Z', 'X'])),
        Err(_) => false,
    }
}

/// 等到 pid 文件写好，读出其中的 PID。
async fn read_pids(path: &Path) -> Vec<u32> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(text) = std::fs::read_to_string(path)
            && !text.trim().is_empty()
        {
            return text
                .split_whitespace()
                .map(|p| p.parse().unwrap())
                .collect();
        }
        assert!(
            Instant::now() < deadline,
            "pid file {} not written",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn assert_all_gone(pids: &[u32]) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while pids.iter().any(|&p| alive(p)) {
        assert!(Instant::now() < deadline, "processes still alive: {pids:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// `sh -c script`，script 里用 `$PIDS` 指向 pid 文件。
fn shell(script: &str, pid_file: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("sh");
    command.arg("-c").arg(script).env("PIDS", pid_file);
    command
}

#[tokio::test]
async fn wait_returns_the_exit_status_without_killing_anything() {
    let mut tree = ProcessTree::spawn(&mut tokio::process::Command::new("true")).unwrap();
    assert!(tree.wait().await.unwrap().success());
}

#[tokio::test]
async fn terminate_kills_the_leader_and_all_descendants() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pids");
    let mut tree = ProcessTree::spawn(&mut shell(
        "sleep 30 & echo $$ $! > \"$PIDS\"; wait",
        &pid_file,
    ))
    .unwrap();
    let pids = read_pids(&pid_file).await;
    assert_eq!(pids.len(), 2);

    let started = Instant::now();
    let status = tree.terminate(Duration::from_secs(10)).await.unwrap();
    assert!(!status.success());
    // 进程响应 SIGTERM，不需要等满宽限期。
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_all_gone(&pids).await;
}

#[tokio::test]
async fn processes_ignoring_sigterm_are_killed_after_the_grace_period() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pids");
    let mut tree = ProcessTree::spawn(&mut shell(
        "trap '' TERM; sleep 30 & echo $$ $! > \"$PIDS\"; wait",
        &pid_file,
    ))
    .unwrap();
    let pids = read_pids(&pid_file).await;

    let started = Instant::now();
    tree.terminate(Duration::from_millis(500)).await.unwrap();
    assert!(started.elapsed() >= Duration::from_millis(500));
    assert_all_gone(&pids).await;
}

#[tokio::test]
async fn descendants_are_killed_even_when_the_leader_exits_on_sigterm_first() {
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("pids");
    // 后代忽略 SIGTERM，组长不忽略：组长退出后，剩下的后代在宽限期后仍要被强制杀掉。
    let mut tree = ProcessTree::spawn(&mut shell(
        "(trap '' TERM; exec sleep 30) & echo $$ $! > \"$PIDS\"; wait",
        &pid_file,
    ))
    .unwrap();
    let pids = read_pids(&pid_file).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let started = Instant::now();
    tree.terminate(Duration::from_millis(500)).await.unwrap();
    assert!(started.elapsed() >= Duration::from_millis(500));
    assert_all_gone(&pids).await;
}
