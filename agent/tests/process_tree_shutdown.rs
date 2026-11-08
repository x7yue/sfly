//! Agent 退出时的进程树终止（`sfly_agent::process_tree::terminate_all`，#113）。
//!
//! `terminate_all` 作用于进程内全部进程树并且之后不再允许启动新的，所以单独放在这个测试程序里，
//! 只有一个用例，不影响 `process_tree.rs` 里并行运行的用例。
#![cfg(unix)]

use std::time::Duration;

use sfly_agent::process_tree::{ProcessTree, terminate_all};

#[tokio::test]
async fn no_process_tree_starts_once_terminate_all_has_begun() {
    let mut tree = ProcessTree::spawn(tokio::process::Command::new("sleep").arg("30")).unwrap();

    // 组长由 wait 回收（Agent 里是各自任务的 wait），否则僵尸组长让进程组一直“活着”。
    let (_, status) = tokio::join!(
        terminate_all(Duration::from_secs(10), std::future::pending()),
        tree.wait()
    );
    assert!(!status.unwrap().success());

    // 快照之后才启动的进程树（例如装包阶段刚结束的任务）不会再被终止，所以根本不让它启动：
    // 否则 Agent 退出后它会成为孤儿。
    assert!(
        ProcessTree::spawn(&mut tokio::process::Command::new("true")).is_err(),
        "a process tree started after terminate_all"
    );
}
