//! Agent 能力 files.write（ADR 0019）：节点经自己所在 Agent 的本地 socket 往另一台 Agent（或自己）上写入、上传、删除文件。
//! 两台真实 Agent 在同一台机器上，「另一台机器上的文件」就是 source 这台 Agent 能访问的临时目录。
//!
//! 流式写入时调用方在请求之后发 `{"data": N}` + N 个字节的帧，最后发 `{"end": true}`（协议见 `sfly_agent::calls`）。
#![cfg(unix)]

mod support;

use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use sfly_agent::proto::{CancelTask, server_message};
use support::calls::{AgentPair, Reply, call, hold_task, open_call, read_reply, request};
use support::wait_until;
use tokio::io::{AsyncWriteExt as _, BufReader};
use tokio::net::UnixStream;

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

/// 有一定大小、每个字节都可能出现的内容（不是全零，换行、0、0xff 都有）。
fn content(size: usize) -> Vec<u8> {
    (0..size).map(|i| (i * 7 + i / 251) as u8).collect()
}

/// 目录里的全部名字（含隐藏文件），排序后给出。
fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

/// 写入进行中：目标所在目录里有临时文件（`.<文件名>.sfly-<随机>.tmp`）。
fn has_temp_file(dir: &Path) -> bool {
    names(dir)
        .iter()
        .any(|n| n.starts_with('.') && n.ends_with(".tmp"))
}

async fn send_data(stream: &mut BufReader<UnixStream>, bytes: &[u8]) {
    let mut frame = json!({ "data": bytes.len() }).to_string().into_bytes();
    frame.push(b'\n');
    let socket = stream.get_mut();
    socket.write_all(&frame).await.unwrap();
    socket.write_all(bytes).await.unwrap();
}

async fn send_end(stream: &mut BufReader<UnixStream>) {
    stream
        .get_mut()
        .write_all(b"{\"end\":true}\n")
        .await
        .unwrap();
}

/// 流式写入：发出请求，把 `chunks` 逐段发过去，读完回复。
async fn write(socket: &Path, task: &str, agent: &str, path: &Path, chunks: &[&[u8]]) -> Reply {
    let mut stream = open_call(
        socket,
        &request(task, agent, "files.write", json!({ "path": path })),
    )
    .await;
    for chunk in chunks {
        send_data(&mut stream, chunk).await;
    }
    send_end(&mut stream).await;
    read_reply(&mut stream).await
}

#[tokio::test]
async fn streamed_writes_and_uploads_land_on_another_agent_with_the_same_content() {
    let pair = AgentPair::start("runner-write", "source-write").await;
    hold_task(
        &pair.runner_cp,
        "task-write",
        vec![pair.source_ref("source-write")],
    )
    .await;
    let there = tempfile::tempdir().unwrap();
    let here = tempfile::tempdir().unwrap();

    // 流式写入：大小不一的几段（含空段），合起来超过一次传输的分块。
    let body = content(3 * 1024 * 1024 + 17);
    let (a, rest) = body.split_at(1000);
    let (b, c) = rest.split_at(1024 * 1024);
    let target = there.path().join("result.bin");
    let written = write(
        &pair.socket(),
        "task-write",
        "source-write",
        &target,
        &[a, b, &[], c],
    )
    .await;
    assert_eq!(written.result(), &expected(&target));
    assert_eq!(std::fs::read(&target).unwrap(), body);

    // 从本地路径上传：runner 这台机器上的文件，由 runner 直接传给 source。
    let local = here.path().join("upload.bin");
    let uploaded_body = content(5 * 1024 * 1024 + 3);
    std::fs::write(&local, &uploaded_body).unwrap();
    let uploaded_to = there.path().join("uploaded.bin");
    let uploaded = call(
        &pair.socket(),
        request(
            "task-write",
            "source-write",
            "files.upload",
            json!({ "local_path": local, "path": uploaded_to }),
        ),
    )
    .await;
    assert_eq!(uploaded.result(), &expected(&uploaded_to));
    assert_eq!(std::fs::read(&uploaded_to).unwrap(), uploaded_body);

    // 写一个空文件；只留下目标文件，没有临时文件。
    let empty = there.path().join("empty");
    write(&pair.socket(), "task-write", "source-write", &empty, &[])
        .await
        .result();
    assert_eq!(std::fs::read(&empty).unwrap(), b"");
    assert_eq!(names(there.path()), ["empty", "result.bin", "uploaded.bin"]);
}

#[tokio::test]
async fn replacing_an_existing_file_swaps_it_whole_and_keeps_its_permissions() {
    let pair = AgentPair::start("runner-replace", "source-replace").await;
    hold_task(
        &pair.runner_cp,
        "task-replace",
        vec![pair.source_ref("source-replace")],
    )
    .await;
    let there = tempfile::tempdir().unwrap();
    let target = there.path().join("marker");
    std::fs::write(&target, "an old and much longer content\n").unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o640)).unwrap();
    let old_inode = std::fs::metadata(&target).unwrap().ino();

    write(
        &pair.socket(),
        "task-replace",
        "source-replace",
        &target,
        &[b"new\n"],
    )
    .await
    .result();

    let metadata = std::fs::metadata(&target).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), b"new\n");
    assert_eq!(metadata.permissions().mode() & 0o777, 0o640);
    // 是另一个文件改名过来的，不是在原文件上截短重写：读着原文件的人不会读到半截。
    assert_ne!(metadata.ino(), old_inode);
}

#[tokio::test]
async fn the_own_agent_writes_uploads_and_deletes_the_same_way() {
    let pair = AgentPair::start("runner-own-write", "source-own-write").await;
    hold_task(&pair.runner_cp, "task-own-write", Vec::new()).await;
    let dir = tempfile::tempdir().unwrap();
    let socket = pair.socket();

    let target = dir.path().join("own.txt");
    let written = write(&socket, "task-own-write", "", &target, &[b"one ", b"two\n"]).await;
    assert_eq!(written.result(), &expected(&target));
    assert_eq!(std::fs::read(&target).unwrap(), b"one two\n");

    let copy = dir.path().join("copy.txt");
    let uploaded = call(
        &socket,
        request(
            "task-own-write",
            "runner-own-write",
            "files.upload",
            json!({ "local_path": target, "path": copy }),
        ),
    )
    .await;
    assert_eq!(uploaded.result(), &expected(&copy));
    assert_eq!(std::fs::read(&copy).unwrap(), b"one two\n");

    let deleted = call(
        &socket,
        request(
            "task-own-write",
            "",
            "files.delete",
            json!({ "path": target }),
        ),
    )
    .await;
    assert_eq!(deleted.result(), &Value::Null);
    assert_eq!(names(dir.path()), ["copy.txt"]);
}

#[tokio::test]
async fn deleting_removes_the_file_and_a_missing_file_is_not_found() {
    let pair = AgentPair::start("runner-delete", "source-delete").await;
    hold_task(
        &pair.runner_cp,
        "task-delete",
        vec![pair.source_ref("source-delete")],
    )
    .await;
    let there = tempfile::tempdir().unwrap();
    let doomed = there.path().join("app.log.1");
    std::fs::write(&doomed, "rotated\n").unwrap();
    std::fs::create_dir(there.path().join("old")).unwrap();
    let socket = pair.socket();
    let delete = |path: &Path| {
        call(
            &socket,
            request(
                "task-delete",
                "source-delete",
                "files.delete",
                json!({ "path": path }),
            ),
        )
    };

    assert_eq!(delete(&doomed).await.result(), &Value::Null);
    assert!(!doomed.exists());

    let (kind, message) = delete(&doomed).await.error();
    assert_eq!(kind, "not_found");
    assert_eq!(
        message,
        format!("Agent source-delete：{} 不存在", doomed.display())
    );

    // 不删除目录。
    let (kind, message) = delete(&there.path().join("old")).await.error();
    assert_eq!(kind, "invalid");
    assert!(message.contains("是目录"), "{message}");
    assert!(there.path().join("old").is_dir());

    let (kind, message) = delete(Path::new("relative/app.log")).await.error();
    assert_eq!(kind, "invalid");
    assert!(message.contains("绝对路径"), "{message}");
}

#[tokio::test]
async fn a_write_that_breaks_off_leaves_nothing_at_the_target() {
    let pair = AgentPair::start("runner-broken-write", "source-broken-write").await;
    hold_task(
        &pair.runner_cp,
        "task-broken-write",
        vec![pair.source_ref("source-broken-write")],
    )
    .await;
    let there = tempfile::tempdir().unwrap();
    let existing = there.path().join("existing.log");
    std::fs::write(&existing, "keep me\n").unwrap();
    let fresh = there.path().join("fresh.log");

    for target in [&existing, &fresh] {
        // 写到一半调用方断开（节点进程退出）：已经开始写，但没有发 end。
        let mut stream = open_call(
            &pair.socket(),
            &request(
                "task-broken-write",
                "source-broken-write",
                "files.write",
                json!({ "path": target }),
            ),
        )
        .await;
        send_data(&mut stream, &content(256 * 1024)).await;
        wait_until("the write to start on source", || {
            has_temp_file(there.path())
        })
        .await;
        drop(stream);

        wait_until("the half-written file to be gone", || {
            names(there.path()) == ["existing.log"]
        })
        .await;
        assert_eq!(std::fs::read(&existing).unwrap(), b"keep me\n");
    }

    // 上传的本地文件不存在：在 runner 这一侧就失败，source 上什么都没有。
    let missing = there.path().join("no-such-local-file");
    let failed = call(
        &pair.socket(),
        request(
            "task-broken-write",
            "source-broken-write",
            "files.upload",
            json!({ "local_path": missing, "path": fresh }),
        ),
    )
    .await;
    let (kind, message) = failed.error();
    assert_eq!(kind, "not_found");
    assert_eq!(
        message,
        format!("Agent runner-broken-write：{} 不存在", missing.display())
    );
    assert_eq!(names(there.path()), ["existing.log"]);
}

#[tokio::test]
async fn cancelling_the_task_mid_write_leaves_nothing_at_the_target() {
    let pair = AgentPair::start("runner-cancel-write", "source-cancel-write").await;
    hold_task(
        &pair.runner_cp,
        "task-cancel-write",
        vec![pair.source_ref("source-cancel-write")],
    )
    .await;
    let there = tempfile::tempdir().unwrap();
    let target = there.path().join("never.log");
    let mut stream = open_call(
        &pair.socket(),
        &request(
            "task-cancel-write",
            "source-cancel-write",
            "files.write",
            json!({ "path": target }),
        ),
    )
    .await;
    send_data(&mut stream, &content(64 * 1024)).await;
    wait_until("the write to start on source", || {
        has_temp_file(there.path())
    })
    .await;

    pair.runner_cp
        .send(server_message::Body::Cancel(CancelTask {
            task_id: "task-cancel-write".into(),
            attempt: 1,
            force: false,
        }))
        .await;
    let reply = tokio::time::timeout(Duration::from_secs(10), read_reply(&mut stream))
        .await
        .expect("the write did not end when the task was cancelled");
    assert_eq!(reply.error().0, "cancelled");
    wait_until("the half-written file to be gone", || {
        names(there.path()).is_empty()
    })
    .await;
}

#[tokio::test]
async fn writes_into_a_missing_directory_or_onto_a_directory_are_told_apart() {
    let pair = AgentPair::start("runner-write-errors", "source-write-errors").await;
    hold_task(
        &pair.runner_cp,
        "task-write-errors",
        vec![pair.source_ref("source-write-errors")],
    )
    .await;
    let there = tempfile::tempdir().unwrap();
    std::fs::create_dir(there.path().join("sub")).unwrap();
    let socket = pair.socket();
    let attempt = |path: std::path::PathBuf| {
        let socket = socket.clone();
        async move {
            write(
                &socket,
                "task-write-errors",
                "source-write-errors",
                &path,
                &[b"x"],
            )
            .await
            .error()
        }
    };

    let missing_dir = there.path().join("no-such-dir");
    let (kind, message) = attempt(missing_dir.join("out.txt")).await;
    assert_eq!(kind, "not_found");
    assert_eq!(
        message,
        format!(
            "Agent source-write-errors：目录 {} 不存在",
            missing_dir.display()
        )
    );

    let (kind, message) = attempt(there.path().join("sub")).await;
    assert_eq!(kind, "invalid");
    assert!(message.contains("是目录"), "{message}");

    let (kind, message) = attempt("relative/out.txt".into()).await;
    assert_eq!(kind, "invalid");
    assert!(message.contains("绝对路径"), "{message}");
    assert_eq!(names(there.path()), ["sub"]);
}

#[tokio::test]
async fn writing_or_deleting_without_permission_is_permission_denied() {
    // root 不受文件权限限制。
    if std::fs::metadata("/proc/self").unwrap().uid() == 0 {
        return;
    }
    let pair = AgentPair::start("runner-write-perm", "source-write-perm").await;
    hold_task(
        &pair.runner_cp,
        "task-write-perm",
        vec![pair.source_ref("source-write-perm")],
    )
    .await;
    let there = tempfile::tempdir().unwrap();
    let locked = there.path().join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::write(locked.join("app.log"), "keep\n").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();

    let written = write(
        &pair.socket(),
        "task-write-perm",
        "source-write-perm",
        &locked.join("new.txt"),
        &[b"x"],
    )
    .await;
    let deleted = call(
        &pair.socket(),
        request(
            "task-write-perm",
            "source-write-perm",
            "files.delete",
            json!({ "path": locked.join("app.log") }),
        ),
    )
    .await;
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();

    let (kind, message) = written.error();
    assert_eq!(kind, "permission_denied");
    assert_eq!(
        message,
        format!(
            "Agent source-write-perm：没有权限写入 {}",
            locked.join("new.txt").display()
        )
    );
    let (kind, message) = deleted.error();
    assert_eq!(kind, "permission_denied");
    assert_eq!(
        message,
        format!(
            "Agent source-write-perm：没有权限删除 {}",
            locked.join("app.log").display()
        )
    );
    assert_eq!(names(&locked), ["app.log"]);
}
