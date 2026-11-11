//! Agent 能力 files（ADR 0019）：节点经自己所在 Agent 的本地 socket 列出、查看另一台 Agent（或自己）上的文件。
//! 两台真实 Agent 在同一台机器上，「另一台机器上的文件」就是 source 这台 Agent 能访问的临时目录。
#![cfg(unix)]

mod support;

use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
use std::path::Path;

use serde_json::{Value, json};
use support::calls::{AgentPair, call, hold_task, request};

/// 文件属性的期望值（直接读这台机器的文件系统）。
fn expected(path: &Path) -> Value {
    let metadata = std::fs::metadata(path).unwrap();
    json!({
        "path": path.to_str().unwrap(),
        "size": metadata.len(),
        "mtime_ns": metadata.mtime() * 1_000_000_000 + metadata.mtime_nsec(),
        "device": metadata.dev(),
        "inode": metadata.ino(),
    })
}

/// 日志目录：app.log、app.log.1、notes.txt，子目录 old/ 里有 app.log.2 和 old/deeper/app.log.3。
fn log_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("old/deeper")).unwrap();
    for (name, body) in [
        ("app.log", "current\n"),
        ("app.log.1", "rotated once\n"),
        ("notes.txt", "not a log\n"),
        ("old/app.log.2", "rotated twice\n"),
        ("old/deeper/app.log.3", "rotated three times\n"),
    ] {
        std::fs::write(root.join(name), body).unwrap();
    }
    dir
}

#[tokio::test]
async fn lists_matching_files_on_another_agent_with_size_mtime_and_file_id() {
    let pair = AgentPair::start("runner-list", "source-list").await;
    let logs = log_dir();
    let root = logs.path();
    hold_task(
        &pair.runner_cp,
        "task-list",
        vec![pair.source_ref("source-list")],
    )
    .await;

    let flat = call(
        &pair.socket(),
        request(
            "task-list",
            "source-list",
            "files.list",
            json!({ "directory": root, "pattern": "app.log*" }),
        ),
    )
    .await;
    assert_eq!(flat.result(), &Value::Null);
    assert_eq!(
        flat.items,
        vec![
            expected(&root.join("app.log")),
            expected(&root.join("app.log.1"))
        ]
    );

    // 递归：每个目录先列出自己的文件，再按名称依次进入子目录。
    let deep = call(
        &pair.socket(),
        request(
            "task-list",
            "source-list",
            "files.list",
            json!({ "directory": root, "pattern": "app.log*", "recursive": true }),
        ),
    )
    .await;
    assert_eq!(
        deep.items,
        [
            "app.log",
            "app.log.1",
            "old/app.log.2",
            "old/deeper/app.log.3"
        ]
        .iter()
        .map(|name| expected(&root.join(name)))
        .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn the_own_agent_gives_the_same_listing_and_attributes() {
    let pair = AgentPair::start("runner-own", "source-own").await;
    let logs = log_dir();
    let root = logs.path();
    hold_task(
        &pair.runner_cp,
        "task-own",
        vec![pair.source_ref("source-own")],
    )
    .await;
    let list = |agent: &'static str| {
        request(
            "task-own",
            agent,
            "files.list",
            json!({ "directory": root, "recursive": true }),
        )
    };
    let stat = |agent: &'static str| {
        request(
            "task-own",
            agent,
            "files.stat",
            json!({ "path": root.join("app.log") }),
        )
    };

    let remote = call(&pair.socket(), list("source-own")).await;
    // 空串和自己的名称都是自己所在的 Agent。
    for own in ["", "runner-own"] {
        let local = call(&pair.socket(), list(own)).await;
        assert_eq!(local.items, remote.items);
        assert_eq!(local.items.len(), 5);
        assert_eq!(
            call(&pair.socket(), stat(own)).await.result(),
            call(&pair.socket(), stat("source-own")).await.result()
        );
    }
    assert_eq!(
        call(&pair.socket(), stat("source-own")).await.result(),
        &expected(&root.join("app.log"))
    );
}

#[tokio::test]
async fn missing_files_relative_paths_and_non_directories_are_told_apart() {
    let pair = AgentPair::start("runner-errors", "source-errors").await;
    let logs = log_dir();
    let root = logs.path();
    hold_task(
        &pair.runner_cp,
        "task-errors",
        vec![pair.source_ref("source-errors")],
    )
    .await;
    let socket = pair.socket();
    let ask = |method: &str, args: Value| {
        call(
            &socket,
            request("task-errors", "source-errors", method, args),
        )
    };

    let missing = root.join("gone.log");
    let (kind, message) = ask("files.stat", json!({ "path": missing })).await.error();
    assert_eq!(kind, "not_found");
    assert_eq!(
        message,
        format!("Agent source-errors：{} 不存在", missing.display())
    );
    let (kind, _) = ask(
        "files.list",
        json!({ "directory": root.join("no-such-dir") }),
    )
    .await
    .error();
    assert_eq!(kind, "not_found");

    let (kind, message) = ask("files.list", json!({ "directory": root.join("app.log") }))
        .await
        .error();
    assert_eq!(kind, "invalid");
    assert!(message.contains("不是目录"), "{message}");

    let (kind, message) = ask("files.stat", json!({ "path": "relative/app.log" }))
        .await
        .error();
    assert_eq!(kind, "invalid");
    assert!(message.contains("绝对路径"), "{message}");

    let (kind, message) = ask("files.stat", json!({ "file": "/x" })).await.error();
    assert_eq!(kind, "invalid");
    assert!(message.contains("files.stat 的参数不合法"), "{message}");
}

#[tokio::test]
async fn files_the_agent_may_not_read_are_permission_denied() {
    // root 不受文件权限限制。
    if std::fs::metadata("/proc/self").unwrap().uid() == 0 {
        return;
    }
    let pair = AgentPair::start("runner-perm", "source-perm").await;
    let logs = log_dir();
    let locked = logs.path().join("old");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
    hold_task(
        &pair.runner_cp,
        "task-perm",
        vec![pair.source_ref("source-perm")],
    )
    .await;

    let stat = call(
        &pair.socket(),
        request(
            "task-perm",
            "source-perm",
            "files.stat",
            json!({ "path": locked.join("app.log.2") }),
        ),
    )
    .await;
    let list = call(
        &pair.socket(),
        request(
            "task-perm",
            "source-perm",
            "files.list",
            json!({ "directory": locked }),
        ),
    )
    .await;
    // 递归列出时跳过没有权限进入的子目录。
    let around = call(
        &pair.socket(),
        request(
            "task-perm",
            "source-perm",
            "files.list",
            json!({ "directory": logs.path(), "recursive": true }),
        ),
    )
    .await;
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(stat.error().0, "permission_denied");
    let (kind, message) = list.error();
    assert_eq!(kind, "permission_denied");
    assert_eq!(
        message,
        format!("Agent source-perm：没有权限访问 {}", locked.display())
    );
    let names: Vec<&str> = around
        .items
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    assert_eq!(names.len(), 3, "{names:?}");
}
