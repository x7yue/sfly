//! Agent 能力 files.read（ADR 0019）：节点经自己所在 Agent 的本地 socket 流式读取另一台 Agent（或自己）上的文件，
//! 或让自己所在的 Agent 把它下载到本地路径。两台真实 Agent 在同一台机器上，「另一台机器上的文件」就是 source 这台
//! Agent 能访问的临时目录。连接中断、下载期间暂停用一个夹在两台 Agent 之间的 TCP 代理（[`Proxy`]）模拟。
#![cfg(unix)]

mod support;

use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use sfly_agent::proto::agent_file_read_server::{AgentFileRead, AgentFileReadServer};
use sfly_agent::proto::agent_peer_server::{AgentPeer, AgentPeerServer};
use sfly_agent::proto::{
    CancelTask, DescribeRequest, DescribeResponse, FileInfo, ReadFileRequest, ReadFileResponse,
    server_message,
};
use support::calls::{AgentPair, hold_task, open_call, referenced, request};
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::{TcpListener, TcpStream, UnixStream};
use tokio::sync::watch;

/// 一次调用的全部回复：`{"data": N}` 帧的字节按顺序拼起来，`{"item": ...}` 的各项，最后一帧。
struct Received {
    data: Vec<u8>,
    /// 收到几个 data 帧。
    chunks: usize,
    items: Vec<Value>,
    end: Value,
}

impl Received {
    fn result(&self) -> &Value {
        self.end
            .get("result")
            .unwrap_or_else(|| panic!("call failed: {}", self.end))
    }

    fn error(&self) -> (String, String) {
        let error = self
            .end
            .get("error")
            .unwrap_or_else(|| panic!("call succeeded: {}", self.end));
        (
            error["kind"].as_str().unwrap().to_string(),
            error["message"].as_str().unwrap().to_string(),
        )
    }
}

/// 读完一个调用的回复，包括 data 帧之后的原始字节。
async fn receive(stream: &mut BufReader<UnixStream>) -> Received {
    let mut received = Received {
        data: Vec::new(),
        chunks: 0,
        items: Vec::new(),
        end: Value::Null,
    };
    loop {
        let mut line = String::new();
        let n = stream.read_line(&mut line).await.unwrap();
        assert!(n > 0, "the agent closed the call without a final frame");
        let frame: Value = serde_json::from_str(&line).unwrap();
        if let Some(size) = frame.get("data") {
            let mut bytes = vec![0; usize::try_from(size.as_u64().unwrap()).unwrap()];
            stream.read_exact(&mut bytes).await.unwrap();
            received.data.extend_from_slice(&bytes);
            received.chunks += 1;
            continue;
        }
        if let Some(item) = frame.get("item") {
            received.items.push(item.clone());
            continue;
        }
        received.end = frame;
        return received;
    }
}

async fn call(socket: &Path, request: Value) -> Received {
    let mut stream = open_call(socket, &request).await;
    receive(&mut stream).await
}

/// `size` 个字节的内容：任意字节（含换行和 0），每个位置都不同，错位、重复一段都看得出来。
fn content(size: usize) -> Vec<u8> {
    let mut state = 0x9e37_79b9_7f4a_7c15_u64;
    (0..size)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state.to_le_bytes()[0]
        })
        .collect()
}

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

/// 目录里的全部条目名（检查下载失败、取消后没有留下临时文件）。
fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

fn read_request(task: &str, agent: &str, args: Value) -> Value {
    request(task, agent, "files.read", args)
}

fn download_request(task: &str, agent: &str, path: &Path, local: &Path) -> Value {
    request(
        task,
        agent,
        "files.download",
        json!({ "path": path, "local_path": local }),
    )
}

#[tokio::test]
async fn reads_a_file_on_another_agent_from_an_offset_up_to_a_length() {
    let pair = AgentPair::start("runner-read", "source-read").await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    // 几段 data 帧的量：调用方按顺序拼起来就是文件内容。
    let body = content(3 * 1024 * 1024 + 17);
    std::fs::write(&path, &body).unwrap();
    hold_task(
        &pair.runner_cp,
        "task-read",
        vec![pair.source_ref("source-read")],
    )
    .await;

    let whole = call(
        &pair.socket(),
        read_request("task-read", "source-read", json!({ "path": path })),
    )
    .await;
    assert_eq!(whole.result(), &Value::Null);
    assert!(whole.chunks > 1, "{} chunks", whole.chunks);
    assert!(whole.data == body, "the content read differs from the file");

    let part = call(
        &pair.socket(),
        read_request(
            "task-read",
            "source-read",
            json!({ "path": path, "offset": 1_000_000, "length": 2_000_000 }),
        ),
    )
    .await;
    assert!(part.data == body[1_000_000..3_000_000]);

    // 只给偏移：读到文件末尾。长度超过剩下的部分：读到文件末尾为止。
    let tail = call(
        &pair.socket(),
        read_request(
            "task-read",
            "source-read",
            json!({ "path": path, "offset": body.len() - 10 }),
        ),
    )
    .await;
    assert_eq!(tail.data, body[body.len() - 10..]);
    let past = call(
        &pair.socket(),
        read_request(
            "task-read",
            "source-read",
            json!({ "path": path, "offset": body.len() - 3, "length": 100 }),
        ),
    )
    .await;
    assert_eq!(past.data, body[body.len() - 3..]);

    // 偏移在文件末尾之后、长度为 0：没有内容，调用照常成功。
    for args in [
        json!({ "path": path, "offset": body.len() + 5 }),
        json!({ "path": path, "length": 0 }),
    ] {
        let empty = call(
            &pair.socket(),
            read_request("task-read", "source-read", args),
        )
        .await;
        assert_eq!(empty.result(), &Value::Null);
        assert!(empty.data.is_empty());
    }

    // 自己所在的 Agent 读到同样的内容。
    let own = call(
        &pair.socket(),
        read_request(
            "task-read",
            "",
            json!({ "path": path, "offset": 5, "length": 1_500_000 }),
        ),
    )
    .await;
    assert!(own.data == body[5..1_500_005]);
}

#[tokio::test]
async fn reading_tells_apart_missing_files_directories_and_relative_paths() {
    let pair = AgentPair::start("runner-read-errors", "source-read-errors").await;
    let dir = tempfile::tempdir().unwrap();
    hold_task(
        &pair.runner_cp,
        "task-read-errors",
        vec![pair.source_ref("source-read-errors")],
    )
    .await;
    let read = |path: Value| {
        read_request(
            "task-read-errors",
            "source-read-errors",
            json!({ "path": path }),
        )
    };

    let missing = dir.path().join("gone.log");
    let (kind, message) = call(&pair.socket(), read(json!(missing))).await.error();
    assert_eq!(kind, "not_found");
    assert_eq!(
        message,
        format!("Agent source-read-errors：{} 不存在", missing.display())
    );

    let (kind, message) = call(&pair.socket(), read(json!(dir.path()))).await.error();
    assert_eq!(kind, "invalid");
    assert!(message.contains("是目录"), "{message}");

    let (kind, message) = call(&pair.socket(), read(json!("app.log"))).await.error();
    assert_eq!(kind, "invalid");
    assert!(message.contains("绝对路径"), "{message}");
}

#[tokio::test]
async fn downloads_a_large_file_from_another_agent_straight_to_a_local_path() {
    let pair = AgentPair::start("runner-download", "source-download").await;
    let source_dir = tempfile::tempdir().unwrap();
    let path = source_dir.path().join("app.log.1");
    let body = content(96 * 1024 * 1024 + 3);
    std::fs::write(&path, &body).unwrap();
    let local_dir = tempfile::tempdir().unwrap();
    // 目标目录不存在时一并创建；目标路径上已有的文件被替换。
    let local = local_dir.path().join("pulled/app.log.1");
    std::fs::create_dir_all(local.parent().unwrap()).unwrap();
    std::fs::write(&local, b"an older copy").unwrap();
    hold_task(
        &pair.runner_cp,
        "task-download",
        vec![pair.source_ref("source-download")],
    )
    .await;

    let reply = call(
        &pair.socket(),
        download_request("task-download", "source-download", &path, &local),
    )
    .await;

    // 结果是源文件的属性（下载完成时的），节点进程收到的只有它和进度，没有文件内容。
    assert_eq!(reply.result(), &expected(&path));
    assert!(reply.data.is_empty());
    for item in &reply.items {
        assert_eq!(item["size"], json!(body.len()), "{item}");
        assert!(item["downloaded"].as_u64().unwrap() <= body.len() as u64);
    }
    assert!(std::fs::read(&local).unwrap() == body);
    assert_eq!(names_in(local.parent().unwrap()), vec!["app.log.1"]);

    // 自己所在的 Agent：本机上的复制，规则相同。
    let copy = local_dir.path().join("new/dir/copy.log");
    let own = call(
        &pair.socket(),
        download_request("task-download", "", &path, &copy),
    )
    .await;
    assert_eq!(own.result(), &expected(&path));
    assert!(std::fs::read(&copy).unwrap() == body);
}

#[tokio::test]
async fn the_local_path_of_a_download_must_be_absolute() {
    let pair = AgentPair::start("runner-download-relative", "source-download-relative").await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.log");
    std::fs::write(&path, b"x").unwrap();
    hold_task(
        &pair.runner_cp,
        "task-download-relative",
        vec![pair.source_ref("source-download-relative")],
    )
    .await;

    let reply = call(
        &pair.socket(),
        download_request(
            "task-download-relative",
            "source-download-relative",
            &path,
            Path::new("copy.log"),
        ),
    )
    .await;
    let (kind, message) = reply.error();
    assert_eq!(kind, "invalid");
    assert!(message.contains("绝对路径"), "{message}");
}

/// 夹在两台 Agent 之间的 TCP 代理：runner 连代理，代理连 source。
/// 记下从 source 流向 runner 的字节数；可以在流过一定字节数之后切断当时的连接（一次），或者暂停转发直到放行，
/// 也可以随时切断当时的全部连接（[`Proxy::cut`]）。
struct Proxy {
    port: u16,
    /// 从 source 流向 runner 的字节数（全部连接合计）。
    downstream: Arc<AtomicU64>,
    /// 接受过几个连接。
    connections: Arc<AtomicUsize>,
    /// 流过这么多字节后切断当时的全部连接（只切一次）。
    cut_at: Option<u64>,
    cut_done: Arc<AtomicBool>,
    /// 流过这么多字节后暂停转发，`release` 之后继续。
    pause_at: Option<u64>,
    release: watch::Sender<bool>,
    /// 已经暂停（达到 `pause_at`）。
    paused: Arc<AtomicBool>,
    /// 切断当时的全部连接。
    cut: tokio::sync::broadcast::Sender<()>,
}

impl Proxy {
    async fn start(to: u16, cut_at: Option<u64>, pause_at: Option<u64>) -> Arc<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (release, _) = watch::channel(false);
        let (cut, _) = tokio::sync::broadcast::channel::<()>(1);
        let proxy = Arc::new(Self {
            port: listener.local_addr().unwrap().port(),
            downstream: Arc::default(),
            connections: Arc::default(),
            cut_at,
            cut_done: Arc::default(),
            pause_at,
            release,
            paused: Arc::default(),
            cut,
        });
        let accepting = proxy.clone();
        tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                accepting.connections.fetch_add(1, Ordering::SeqCst);
                let server = TcpStream::connect(("127.0.0.1", to)).await.unwrap();
                tokio::spawn(accepting.clone().relay(client, server));
            }
        });
        proxy
    }

    async fn relay(self: Arc<Self>, client: TcpStream, server: TcpStream) {
        let (mut client_read, mut client_write) = client.into_split();
        let (mut server_read, mut server_write) = server.into_split();
        let mut cut_rx = self.cut.subscribe();
        let up = async { tokio::io::copy(&mut client_read, &mut server_write).await };
        let down = async {
            let mut buf = vec![0; 64 * 1024];
            loop {
                let n = server_read.read(&mut buf).await?;
                if n == 0 {
                    return Ok::<(), std::io::Error>(());
                }
                let total = self.downstream.fetch_add(n as u64, Ordering::SeqCst) + n as u64;
                if let Some(at) = self.cut_at
                    && total >= at
                    && !self.cut_done.swap(true, Ordering::SeqCst)
                {
                    let _ = self.cut.send(());
                    return Ok(());
                }
                if let Some(at) = self.pause_at
                    && total >= at
                {
                    self.paused.store(true, Ordering::SeqCst);
                    let mut release = self.release.subscribe();
                    while !*release.borrow_and_update() {
                        if release.changed().await.is_err() {
                            return Ok(());
                        }
                    }
                }
                client_write.write_all(&buf[..n]).await?;
            }
        };
        tokio::select! {
            _ = up => {}
            _ = down => {}
            _ = cut_rx.recv() => {}
        }
        // 两个方向一起丢掉：连接被切断。
    }

    fn release(&self) {
        let _ = self.release.send(true);
    }

    /// 切断当时的全部连接（之后的新连接照常转发）。
    fn cut(&self) {
        let _ = self.cut.send(());
    }
}

/// 一对 Agent，runner 经代理连 source；任务 `task` 引用 source。
async fn through_proxy(pair: &AgentPair, task: &str, source: &str, proxy: &Proxy) {
    hold_task(
        &pair.runner_cp,
        task,
        vec![referenced(source, "127.0.0.1", proxy.port)],
    )
    .await;
}

#[tokio::test]
async fn a_download_resumes_where_the_connection_dropped_instead_of_starting_over() {
    let pair = AgentPair::start("runner-resume", "source-resume").await;
    let source_dir = tempfile::tempdir().unwrap();
    let path = source_dir.path().join("app.log.2");
    let size = 48 * 1024 * 1024;
    let body = content(size);
    std::fs::write(&path, &body).unwrap();
    let cut_at: u64 = 16 * 1024 * 1024;
    let proxy = Proxy::start(pair.source_port, Some(cut_at), None).await;
    through_proxy(&pair, "task-resume", "source-resume", &proxy).await;
    let local_dir = tempfile::tempdir().unwrap();
    let local = local_dir.path().join("app.log.2");

    let reply = call(
        &pair.socket(),
        download_request("task-resume", "source-resume", &path, &local),
    )
    .await;

    assert_eq!(reply.result(), &expected(&path));
    assert!(std::fs::read(&local).unwrap() == body);
    assert!(proxy.cut_done.load(Ordering::SeqCst));
    assert!(proxy.connections.load(Ordering::SeqCst) >= 2);
    // 从断点继续：从头再来的话至少要多传切断之前的那 16 MiB。
    let moved = proxy.downstream.load(Ordering::SeqCst);
    assert!(
        moved < size as u64 + cut_at / 2,
        "{moved} bytes went through for a {size}-byte file"
    );
    assert_eq!(names_in(local_dir.path()), vec!["app.log.2"]);
}

/// 下载 `path`，传到一半时暂停，期间执行 `change`，然后放行，返回调用的回复。`reconnect` 时放行之前先切断连接：
/// 两台 Agent 之间的连接中断，runner 重连后从断点续传。
async fn download_while(
    name: &str,
    path: &Path,
    local: &Path,
    reconnect: bool,
    change: impl FnOnce(),
) -> (Received, AgentPair) {
    let runner = format!("runner-{name}");
    let source = format!("source-{name}");
    let task = format!("task-{name}");
    let pair = AgentPair::start(&runner, &source).await;
    let proxy = Proxy::start(pair.source_port, None, Some(1024 * 1024)).await;
    through_proxy(&pair, &task, &source, &proxy).await;
    let mut open = open_call(
        &pair.socket(),
        &download_request(&task, &source, path, local),
    )
    .await;
    let reply = tokio::spawn(async move { receive(&mut open).await });
    support::wait_until("the download to be under way", || {
        proxy.paused.load(Ordering::SeqCst)
    })
    .await;
    change();
    if reconnect {
        proxy.cut();
    }
    proxy.release();
    let reply = tokio::time::timeout(Duration::from_secs(60), reply)
        .await
        .expect("the download did not end")
        .unwrap();
    (reply, pair)
}

/// 一个 32 MiB 的源文件和下载目标（在另一个临时目录里）。
fn source_and_target() -> (tempfile::TempDir, PathBuf, tempfile::TempDir, PathBuf) {
    let source_dir = tempfile::tempdir().unwrap();
    let path = source_dir.path().join("app.log");
    std::fs::write(&path, content(32 * 1024 * 1024)).unwrap();
    let local_dir = tempfile::tempdir().unwrap();
    let local = local_dir.path().join("app.log");
    (source_dir, path, local_dir, local)
}

#[tokio::test]
async fn a_source_deleted_during_the_download_fails_it_without_leaving_a_file() {
    let (_source_dir, path, local_dir, local) = source_and_target();
    let (reply, _pair) = download_while("deleted", &path, &local, false, || {
        std::fs::remove_file(&path).unwrap()
    })
    .await;

    let (kind, message) = reply.error();
    assert_eq!(kind, "not_found");
    assert!(message.contains("下载期间被删除"), "{message}");
    assert!(names_in(local_dir.path()).is_empty());
}

#[tokio::test]
async fn a_source_truncated_during_the_download_fails_it_without_leaving_a_file() {
    let (_source_dir, path, local_dir, local) = source_and_target();
    let (reply, _pair) = download_while("truncated", &path, &local, false, || {
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(1000)
            .unwrap();
    })
    .await;

    let (kind, message) = reply.error();
    assert_eq!(kind, "failed");
    assert!(message.contains("下载期间被截短"), "{message}");
    assert!(names_in(local_dir.path()).is_empty());
}

#[tokio::test]
async fn a_source_still_being_written_during_the_download_fails_it_without_leaving_a_file() {
    // 还在续写的文件：下载完时大小和下载开始时对不上。
    let (_source_dir, path, local_dir, local) = source_and_target();
    let (reply, _pair) = download_while("grown", &path, &local, false, || {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(b"one more line\n").unwrap();
    })
    .await;
    let (kind, message) = reply.error();
    assert_eq!(kind, "failed");
    assert!(message.contains("下载期间变化"), "{message}");
    assert!(names_in(local_dir.path()).is_empty());
}

/// 日志轮转：原来的文件被改名为 `app.log.1`，路径上换成了一个新文件。
fn rotate(path: &Path) {
    std::fs::rename(path, path.with_file_name("app.log.1")).unwrap();
    std::fs::write(path, b"a new log").unwrap();
}

#[tokio::test]
async fn a_source_rotated_during_the_download_is_still_downloaded_in_full() {
    // 内容都从打开的文件读，完成时按它核对：被改名的文件照样下载完，结果里是它现在的路径。
    let (source_dir, path, local_dir, local) = source_and_target();
    let body = std::fs::read(&path).unwrap();
    let rotated = source_dir.path().join("app.log.1");
    let (reply, _pair) = download_while("rotated", &path, &local, false, || rotate(&path)).await;

    assert_eq!(reply.result(), &expected(&rotated));
    assert!(std::fs::read(&local).unwrap() == body);
    assert_eq!(names_in(local_dir.path()), vec!["app.log"]);
}

#[tokio::test]
async fn a_download_resumes_from_the_new_name_when_the_source_was_rotated_while_disconnected() {
    // 连接中断期间日志轮转：续传时在同一目录里找到改了名的文件，从断点接着读。
    let (source_dir, path, local_dir, local) = source_and_target();
    let body = std::fs::read(&path).unwrap();
    let rotated = source_dir.path().join("app.log.1");
    let (reply, _pair) =
        download_while("rotated-resume", &path, &local, true, || rotate(&path)).await;

    assert_eq!(reply.result(), &expected(&rotated));
    assert!(std::fs::read(&local).unwrap() == body);
    assert_eq!(names_in(local_dir.path()), vec!["app.log"]);
}

#[tokio::test]
async fn a_source_moved_elsewhere_while_disconnected_fails_the_download_as_moved() {
    // 连接中断期间原来的文件被移到了别的目录、路径上换成了新文件：续传找不到它，以「移走了」失败，
    // 调用方据此去别处找它。
    let (source_dir, path, local_dir, local) = source_and_target();
    let archive = source_dir.path().join("archive");
    std::fs::create_dir(&archive).unwrap();
    let (reply, _pair) = download_while("moved", &path, &local, true, || {
        std::fs::rename(&path, archive.join("app.log.1")).unwrap();
        std::fs::write(&path, b"a new log").unwrap();
    })
    .await;

    let (kind, message) = reply.error();
    assert_eq!(kind, "moved");
    assert!(message.contains("下载期间被移走"), "{message}");
    assert!(names_in(local_dir.path()).is_empty());
}

#[tokio::test]
async fn cancelling_the_task_stops_a_download_at_once_and_removes_the_partial_file() {
    let pair = AgentPair::start("runner-download-cancel", "source-download-cancel").await;
    let (_source_dir, path, local_dir, local) = source_and_target();
    let proxy = Proxy::start(pair.source_port, None, Some(1024 * 1024)).await;
    through_proxy(
        &pair,
        "task-download-cancel",
        "source-download-cancel",
        &proxy,
    )
    .await;
    let mut ask = download_request(
        "task-download-cancel",
        "source-download-cancel",
        &path,
        &local,
    );
    ask["timeout_ms"] = json!(0);
    let mut open = open_call(&pair.socket(), &ask).await;
    let reply = tokio::spawn(async move { receive(&mut open).await });
    support::wait_until("the download to be under way", || {
        proxy.paused.load(Ordering::SeqCst)
    })
    .await;

    pair.runner_cp
        .send(server_message::Body::Cancel(CancelTask {
            task_id: "task-download-cancel".into(),
            attempt: 1,
            force: false,
        }))
        .await;

    let reply = tokio::time::timeout(Duration::from_secs(10), reply)
        .await
        .expect("the download did not end when the task was cancelled")
        .unwrap();
    assert_eq!(reply.error().0, "cancelled");
    support::wait_until("the partial file to be removed", || {
        names_in(local_dir.path()).is_empty()
    })
    .await;
}

/// 假的另一台 Agent：Describe 照常回答；读文件时先给出文件属性和一段内容，然后回复一个读文件出错的 INTERNAL
/// （真实 Agent 读到坏磁盘时 EIO 就是这样回复的）。记下被读了几次。
struct FailingReads {
    reads: Arc<AtomicUsize>,
}

#[tonic::async_trait]
impl AgentPeer for FailingReads {
    async fn describe(
        &self,
        _request: tonic::Request<DescribeRequest>,
    ) -> Result<tonic::Response<DescribeResponse>, tonic::Status> {
        Ok(tonic::Response::new(DescribeResponse {
            name: "source-eio".into(),
            agent_version: "0.0.0".into(),
            capabilities: sfly_agent::capabilities::reported(),
        }))
    }
}

#[tonic::async_trait]
impl AgentFileRead for FailingReads {
    type ReadStream = sfly_agent::calls::BoxStream<ReadFileResponse>;

    async fn read(
        &self,
        request: tonic::Request<ReadFileRequest>,
    ) -> Result<tonic::Response<Self::ReadStream>, tonic::Status> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let path = request.into_inner().path;
        let replies = vec![
            Ok(ReadFileResponse {
                file: Some(FileInfo {
                    path: path.clone(),
                    size: 1024 * 1024,
                    mtime_unix_ns: 0,
                    device: 1,
                    inode: 2,
                }),
                data: vec![7; 1000],
                ..Default::default()
            }),
            Err(tonic::Status::internal(format!(
                "访问 {path} 失败：Input/output error (os error 5)"
            ))),
        ];
        Ok(tonic::Response::new(Box::pin(tokio_stream::iter(replies))))
    }
}

#[tokio::test]
async fn a_read_error_on_the_other_agent_fails_the_download_without_reconnecting() {
    // 对方回复的错误（例如读文件时的 I/O 错误）重连也一样：不当作连接中断去反复重连。
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let reads = Arc::new(AtomicUsize::new(0));
    let server = tonic::transport::Server::builder()
        .add_service(AgentPeerServer::new(FailingReads {
            reads: reads.clone(),
        }))
        .add_service(AgentFileReadServer::new(FailingReads {
            reads: reads.clone(),
        }))
        .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener));
    tokio::spawn(server);
    let cp = support::FakeControlPlane::start().await;
    let runner = support::spawn_agent(support::AgentOptions::new(&cp.url, "runner-eio"));
    cp.hello(0).await;
    hold_task(
        &cp,
        "task-eio",
        vec![referenced("source-eio", "127.0.0.1", port)],
    )
    .await;
    let local_dir = tempfile::tempdir().unwrap();

    let reply = call(
        &support::calls::socket_of(&runner),
        download_request(
            "task-eio",
            "source-eio",
            Path::new("/var/log/app.log"),
            &local_dir.path().join("app.log"),
        ),
    )
    .await;

    let (kind, message) = reply.error();
    assert_eq!(kind, "failed");
    assert_eq!(
        message,
        "Agent source-eio：访问 /var/log/app.log 失败：Input/output error (os error 5)"
    );
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert!(names_in(local_dir.path()).is_empty());
}
