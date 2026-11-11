//! Agent 能力 files.watch（ADR 0019）：节点经自己所在 Agent 的本地 socket 监听另一台 Agent（或自己）上的目录。
//! 两台真实 Agent 在同一台机器上，「另一台机器上的目录」就是 source 这台 Agent 能访问的临时目录。
//!
//! 回复（见 `agent/src/capabilities/file_watch.rs`）：`{"snapshot": {files, first, last, missed}}` 的若干批组成一份快照，
//! `{"event": {kind, file, old_path}}` 是一个事件，`{"alive": true}` 是没有别的回复时的保活（这里跳过）。
#![cfg(unix)]

mod support;

use std::os::unix::fs::MetadataExt as _;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use sfly_agent::proto::{CancelTask, server_message};
use support::calls::{AgentPair, hold_task, open_call, referenced, request, socket_of};
use support::{AgentOptions, FakeControlPlane, WAIT, spawn_agent, wait_until};
use tokio::io::{AsyncBufReadExt as _, BufReader};
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

fn path_of(value: &Value) -> &str {
    value["path"].as_str().unwrap()
}

/// 一次进行中的监听：按顺序读回复。
struct Watching {
    stream: BufReader<UnixStream>,
}

impl Watching {
    async fn open(socket: &Path, task: &str, agent: &str, args: Value) -> Self {
        Self {
            stream: open_call(socket, &request(task, agent, "files.watch", args)).await,
        }
    }

    /// 下一帧（跳过保活）：`{"item": ...}` 的内容，或者最后一帧 `{"error": ...}` / `{"result": ...}`。
    async fn next(&mut self) -> Value {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            let mut line = String::new();
            let n = tokio::time::timeout_at(deadline, self.stream.read_line(&mut line))
                .await
                .expect("timed out waiting for the next reply")
                .unwrap();
            assert!(n > 0, "the agent closed the watch without a final frame");
            let frame: Value = serde_json::from_str(&line).unwrap();
            match frame.get("item") {
                Some(item) if item.get("alive").is_some() => continue,
                Some(item) => return item.clone(),
                None => return frame,
            }
        }
    }

    /// 读一份完整的快照：(文件, 是否可能有遗漏)。
    async fn snapshot(&mut self) -> (Vec<Value>, bool) {
        let first = self.next().await;
        let batch = first
            .get("snapshot")
            .unwrap_or_else(|| panic!("expected a snapshot, got {first}"));
        assert_eq!(batch["first"], true, "{first}");
        let missed = batch["missed"].as_bool().unwrap();
        let mut files: Vec<Value> = batch["files"].as_array().unwrap().clone();
        let mut last = batch["last"].as_bool().unwrap();
        while !last {
            let next = self.next().await;
            let batch = &next["snapshot"];
            assert_eq!(batch["first"], false, "{next}");
            files.extend(batch["files"].as_array().unwrap().iter().cloned());
            last = batch["last"].as_bool().unwrap();
        }
        (files, missed)
    }

    /// 下一个事件。
    async fn event(&mut self) -> Value {
        let next = self.next().await;
        next.get("event")
            .unwrap_or_else(|| panic!("expected an event, got {next}"))
            .clone()
    }

    /// 读事件直到 `done` 成立，返回读到的全部事件（含最后一个）。
    async fn events_until(&mut self, done: impl Fn(&Value) -> bool) -> Vec<Value> {
        let mut events = Vec::new();
        loop {
            let event = self.event().await;
            let stop = done(&event);
            events.push(event);
            if stop {
                return events;
            }
        }
    }
}

/// (kind, 路径, 原路径) 的简写，便于比较事件序列。
fn brief(event: &Value) -> (String, String, Option<String>) {
    (
        event["kind"].as_str().unwrap().to_string(),
        path_of(&event["file"]).to_string(),
        event["old_path"].as_str().map(str::to_string),
    )
}

#[tokio::test]
async fn a_watch_starts_with_a_snapshot_and_then_reports_a_log_rotation() {
    let pair = AgentPair::start("runner-watch", "source-watch").await;
    let logs = tempfile::tempdir().unwrap();
    let root = logs.path();
    std::fs::write(root.join("app.log"), "current\n").unwrap();
    std::fs::write(root.join("app.log.1"), "rotated once\n").unwrap();
    std::fs::write(root.join("notes.txt"), "not a log\n").unwrap();
    hold_task(
        &pair.runner_cp,
        "task-watch",
        vec![pair.source_ref("source-watch")],
    )
    .await;

    let mut watch = Watching::open(
        &pair.socket(),
        "task-watch",
        "source-watch",
        json!({ "directory": root, "pattern": "app.log*" }),
    )
    .await;
    let (files, missed) = watch.snapshot().await;
    assert!(!missed);
    assert_eq!(
        files,
        vec![
            expected(&root.join("app.log")),
            expected(&root.join("app.log.1"))
        ]
    );
    let current = files[0]["inode"].clone();

    // 轮转：app.log.1 → app.log.2，app.log → app.log.1，再新建 app.log 写一行后关闭。
    std::fs::rename(root.join("app.log.1"), root.join("app.log.2")).unwrap();
    std::fs::rename(root.join("app.log"), root.join("app.log.1")).unwrap();
    std::fs::write(root.join("app.log"), "fresh\n").unwrap();
    std::fs::write(root.join("notes.txt"), "still not a log\n").unwrap();

    let events = watch
        .events_until(|e| e["kind"] == "closed" && path_of(&e["file"]).ends_with("/app.log"))
        .await;
    let p = |name: &str| root.join(name).to_str().unwrap().to_string();
    assert_eq!(
        events.iter().map(brief).collect::<Vec<_>>(),
        vec![
            ("moved".into(), p("app.log.2"), Some(p("app.log.1"))),
            ("moved".into(), p("app.log.1"), Some(p("app.log"))),
            ("created".into(), p("app.log"), None),
            ("modified".into(), p("app.log"), None),
            ("closed".into(), p("app.log"), None),
        ]
    );
    // 改名后文件标识不变；事件带上事件之后的文件属性。
    assert_eq!(events[1]["file"]["inode"], current);
    assert_eq!(events[4]["file"], expected(&root.join("app.log")));
}

#[tokio::test]
async fn a_recursive_watch_follows_new_subdirectories_and_reports_deletions_with_the_file_id() {
    let pair = AgentPair::start("runner-watch-deep", "source-watch-deep").await;
    let logs = tempfile::tempdir().unwrap();
    let root = logs.path();
    std::fs::create_dir(root.join("old")).unwrap();
    std::fs::write(root.join("app.log"), "current\n").unwrap();
    std::fs::write(root.join("old/app.log.1"), "rotated\n").unwrap();
    hold_task(
        &pair.runner_cp,
        "task-deep",
        vec![pair.source_ref("source-watch-deep")],
    )
    .await;

    let mut watch = Watching::open(
        &pair.socket(),
        "task-deep",
        "source-watch-deep",
        json!({ "directory": root, "pattern": "app.log*", "recursive": true }),
    )
    .await;
    let (files, _) = watch.snapshot().await;
    assert_eq!(
        files,
        vec![
            expected(&root.join("app.log")),
            expected(&root.join("old/app.log.1"))
        ]
    );

    // 新建的子目录（连同马上写进去的文件）也在监听范围内。
    std::fs::create_dir_all(root.join("2026/11")).unwrap();
    std::fs::write(root.join("2026/11/app.log.2"), "new day\n").unwrap();
    let deep = root.join("2026/11/app.log.2");
    let events = watch
        .events_until(|e| e["kind"] == "created" && path_of(&e["file"]) == deep.to_str().unwrap())
        .await;
    assert_eq!(
        events.last().unwrap()["file"]["inode"],
        expected(&deep)["inode"]
    );
    std::fs::write(root.join("2026/11/app.log.3"), "later\n").unwrap();
    let later = root.join("2026/11/app.log.3");
    watch
        .events_until(|e| e["kind"] == "closed" && path_of(&e["file"]) == later.to_str().unwrap())
        .await;

    // 删除的事件带最后一次看到的属性（文件标识）。
    let rotated = expected(&root.join("old/app.log.1"));
    std::fs::remove_file(root.join("old/app.log.1")).unwrap();
    let deleted = watch.event().await;
    assert_eq!(
        deleted,
        json!({ "kind": "deleted", "file": rotated, "old_path": null })
    );

    // 改名后不再匹配通配符：作为删除报告。
    let current = expected(&root.join("app.log"));
    std::fs::rename(root.join("app.log"), root.join("archived.gz")).unwrap();
    let renamed = watch.event().await;
    assert_eq!(
        renamed,
        json!({ "kind": "deleted", "file": current, "old_path": null })
    );
}

#[tokio::test]
async fn the_own_agent_can_be_watched_and_a_missing_directory_is_a_clear_error() {
    let pair = AgentPair::start("runner-watch-own", "source-watch-own").await;
    let logs = tempfile::tempdir().unwrap();
    let root = logs.path();
    hold_task(
        &pair.runner_cp,
        "task-own",
        vec![pair.source_ref("source-watch-own")],
    )
    .await;

    let mut own =
        Watching::open(&pair.socket(), "task-own", "", json!({ "directory": root })).await;
    assert_eq!(own.snapshot().await, (vec![], false));
    std::fs::write(root.join("a.txt"), "x").unwrap();
    let created = own.event().await;
    assert_eq!(brief(&created).0, "created");
    assert_eq!(
        path_of(&created["file"]),
        root.join("a.txt").to_str().unwrap()
    );
    own.events_until(|e| e["kind"] == "closed").await;

    let gone = root.join("gone");
    for agent in ["", "source-watch-own"] {
        let mut missing = Watching::open(
            &pair.socket(),
            "task-own",
            agent,
            json!({ "directory": gone }),
        )
        .await;
        let end = missing.next().await;
        assert_eq!(end["error"]["kind"], "not_found", "{end}");
        let message = end["error"]["message"].as_str().unwrap();
        assert!(
            message.ends_with(&format!("{} 不存在", gone.display())),
            "{message}"
        );
    }

    // 被监听的目录被删除时监听结束：先报告里面的文件被删除，再以 not_found 结束。
    std::fs::remove_dir_all(root).unwrap();
    let deleted = own.event().await;
    assert_eq!(brief(&deleted).0, "deleted");
    let end = own.next().await;
    assert_eq!(end["error"]["kind"], "not_found", "{end}");
    assert!(
        end["error"]["message"]
            .as_str()
            .unwrap()
            .contains("已被删除或改名"),
        "{end}"
    );
}

/// runner 和 source 之间的 TCP 代理：可以切断现有的连接、暂时拒绝新连接，模拟两台 Agent 之间的网络中断。
struct Proxy {
    port: u16,
    up: Arc<AtomicBool>,
    /// 中断期间拒绝了多少次连接（runner 在重连）。
    refused: Arc<AtomicUsize>,
    connections: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
    accept: tokio::task::JoinHandle<()>,
}

impl Proxy {
    async fn start(target: u16) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let up = Arc::new(AtomicBool::new(true));
        let refused = Arc::new(AtomicUsize::new(0));
        let connections: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>> = Arc::default();
        let accept = {
            let (up, refused, connections) = (up.clone(), refused.clone(), connections.clone());
            tokio::spawn(async move {
                while let Ok((mut inbound, _)) = listener.accept().await {
                    if !up.load(Ordering::SeqCst) {
                        refused.fetch_add(1, Ordering::SeqCst);
                        drop(inbound);
                        continue;
                    }
                    connections.lock().unwrap().push(tokio::spawn(async move {
                        if let Ok(mut outbound) =
                            tokio::net::TcpStream::connect(("127.0.0.1", target)).await
                        {
                            let _ =
                                tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                        }
                    }));
                }
            })
        };
        Self {
            port,
            up,
            refused,
            connections,
            accept,
        }
    }

    /// 切断现有的连接，之后拒绝新连接，直到 [`Proxy::restore`]。
    fn sever(&self) {
        self.up.store(false, Ordering::SeqCst);
        for connection in self.connections.lock().unwrap().drain(..) {
            connection.abort();
        }
    }

    fn restore(&self) {
        self.up.store(true, Ordering::SeqCst);
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.accept.abort();
        self.sever();
    }
}

#[tokio::test]
async fn after_the_connection_between_the_agents_drops_and_recovers_a_new_snapshot_marks_possible_gaps()
 {
    let pair = AgentPair::start("runner-reconnect", "source-reconnect").await;
    let proxy = Proxy::start(pair.source_port).await;
    let logs = tempfile::tempdir().unwrap();
    let root = logs.path();
    std::fs::write(root.join("app.log"), "current\n").unwrap();
    hold_task(
        &pair.runner_cp,
        "task-reconnect",
        vec![referenced("source-reconnect", "127.0.0.1", proxy.port)],
    )
    .await;

    let mut watch = Watching::open(
        &pair.socket(),
        "task-reconnect",
        "source-reconnect",
        json!({ "directory": root }),
    )
    .await;
    assert_eq!(
        watch.snapshot().await,
        (vec![expected(&root.join("app.log"))], false)
    );

    proxy.sever();
    // runner 发现连接中断并开始重连；中断期间的变化不会作为事件送到。
    wait_until("the runner to try to reconnect", || {
        proxy.refused.load(Ordering::SeqCst) > 0
    })
    .await;
    std::fs::rename(root.join("app.log"), root.join("app.log.1")).unwrap();
    std::fs::write(root.join("app.log"), "after the gap\n").unwrap();
    proxy.restore();

    let (files, missed) = watch.snapshot().await;
    assert!(
        missed,
        "the snapshot after reconnecting must mark possible gaps"
    );
    assert_eq!(
        files,
        vec![
            expected(&root.join("app.log")),
            expected(&root.join("app.log.1"))
        ]
    );
    // 之后照常收到事件。
    std::fs::write(root.join("app.log.2"), "x").unwrap();
    let created = watch.event().await;
    assert_eq!(brief(&created).0, "created");
    assert_eq!(
        path_of(&created["file"]),
        root.join("app.log.2").to_str().unwrap()
    );
}

#[tokio::test]
async fn a_watch_that_cannot_reconnect_within_the_timeout_fails_as_unreachable() {
    let pair = AgentPair::start("runner-giveup", "source-giveup").await;
    let proxy = Proxy::start(pair.source_port).await;
    let logs = tempfile::tempdir().unwrap();
    hold_task(
        &pair.runner_cp,
        "task-giveup",
        vec![referenced("source-giveup", "127.0.0.1", proxy.port)],
    )
    .await;
    let mut ask = request(
        "task-giveup",
        "source-giveup",
        "files.watch",
        json!({ "directory": logs.path() }),
    );
    ask["timeout_ms"] = json!(1000);
    let mut watch = Watching {
        stream: open_call(&pair.socket(), &ask).await,
    };
    watch.snapshot().await;

    proxy.sever();
    let end = watch.next().await;
    assert_eq!(end["error"]["kind"], "unreachable", "{end}");
    let message = end["error"]["message"].as_str().unwrap();
    assert!(
        message.starts_with(&format!(
            "从 Agent runner-giveup 连不上 Agent source-giveup（地址 127.0.0.1，端口 {}）：监听的连接中断，1 秒内没有重新连上",
            proxy.port
        )),
        "{message}"
    );
}

#[tokio::test]
async fn when_the_event_queue_overflows_a_new_snapshot_marks_possible_gaps() {
    let (runner_cp, source_cp) = (
        FakeControlPlane::start().await,
        FakeControlPlane::start().await,
    );
    let runner = spawn_agent(AgentOptions::new(&runner_cp.url, "runner-overflow"));
    let mut options = AgentOptions::new(&source_cp.url, "source-overflow");
    // 很小的事件队列：读得慢的调用方很快就让它溢出。
    options.args = vec!["--watch-queue-events".into(), "4".into()];
    let _source = spawn_agent(options);
    let peer = source_cp.hello(0).await.peer.expect("Hello.peer");
    runner_cp.hello(0).await;
    let socket = socket_of(&runner);
    wait_until("the runner's local socket", || socket.exists()).await;
    let port = u16::try_from(peer.port).unwrap();
    hold_task(
        &runner_cp,
        "task-overflow",
        vec![referenced("source-overflow", "127.0.0.1", port)],
    )
    .await;
    let logs = tempfile::tempdir().unwrap();
    let root = logs.path();

    let mut watch = Watching::open(
        &socket,
        "task-overflow",
        "source-overflow",
        json!({ "directory": root }),
    )
    .await;
    assert_eq!(watch.snapshot().await, (vec![], false));

    // 不读回复，同时产生远多于沿途缓冲能容纳的事件。
    let count = 3000;
    for i in 0..count {
        std::fs::write(root.join(format!("f{i:05}.log")), "x").unwrap();
    }
    std::fs::write(root.join("done.log"), "x").unwrap();

    // 读下去：先是溢出前已经发出的事件，然后是标明可能有遗漏的快照，快照加上之后的事件就是全部文件。
    let mut known: std::collections::BTreeSet<String> = Default::default();
    let mut missed_snapshots = 0;
    let done = root.join("done.log").to_str().unwrap().to_string();
    while missed_snapshots == 0 || !known.contains(&done) {
        let next = watch.next().await;
        if next.get("snapshot").is_some() {
            assert_eq!(next["snapshot"]["first"], true, "{next}");
            let missed = next["snapshot"]["missed"].as_bool().unwrap();
            let mut batch = next;
            known.clear();
            loop {
                let snapshot = &batch["snapshot"];
                assert_eq!(snapshot["missed"].as_bool(), Some(missed));
                known.extend(
                    snapshot["files"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|f| path_of(f).to_string()),
                );
                if snapshot["last"] == true {
                    break;
                }
                batch = watch.next().await;
            }
            assert!(missed, "only the first snapshot is complete");
            missed_snapshots += 1;
        } else if let Some(event) = next.get("event") {
            if event["kind"] == "created" {
                known.insert(path_of(&event["file"]).to_string());
            }
        } else {
            panic!("the watch ended: {next}");
        }
    }
    assert_eq!(known.len(), count + 1);
}

#[tokio::test]
async fn cancelling_the_task_ends_its_watch_at_once() {
    let pair = AgentPair::start("runner-watch-cancel", "source-watch-cancel").await;
    let logs = tempfile::tempdir().unwrap();
    hold_task(
        &pair.runner_cp,
        "task-watch-cancel",
        vec![pair.source_ref("source-watch-cancel")],
    )
    .await;
    let mut ask = request(
        "task-watch-cancel",
        "source-watch-cancel",
        "files.watch",
        json!({ "directory": logs.path() }),
    );
    ask["timeout_ms"] = json!(0);
    let mut watch = Watching {
        stream: open_call(&pair.socket(), &ask).await,
    };
    watch.snapshot().await;

    pair.runner_cp
        .send(server_message::Body::Cancel(CancelTask {
            task_id: "task-watch-cancel".into(),
            attempt: 1,
            force: false,
        }))
        .await;
    let end = tokio::time::timeout(Duration::from_secs(10), watch.next())
        .await
        .expect("the watch did not end when the task was cancelled");
    assert_eq!(end["error"]["kind"], "cancelled", "{end}");
}
