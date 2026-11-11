//! Agent 能力 `files.watch`：监听一个目录（`files.watch`）。协议见 `proto/sfly/agent/v1/file_watch.proto`。
//!
//! 被监听的一方（[`FileWatch`]，一个监听一个 inotify 实例）：
//!
//! - 先加上目录的 watch，再列出当前的文件作为快照，所以快照之后的变化不会漏掉（可能和快照重复）。
//!   递归时每个子目录一个 watch，监听期间新建（或移进来）的子目录随即加上 watch 并扫描，里面已有的文件作为新建报告。
//! - 一个线程读 inotify、维护「调用方已经知道的文件」（快照加上之后的事件，[`Watcher::index`]），翻译成事件放进队列；
//!   另一个任务（[`pump`]）把队列发给调用方，调用方读得慢时队列变长。队列（[`Queue`]）里还没有发出的连续几次修改
//!   合并成一个事件；超过上限（[`DEFAULT_QUEUE_EVENTS`]）或内核的 inotify 队列溢出（`IN_Q_OVERFLOW`）时丢掉还没发出的事件，
//!   重新扫描，给一份标明「可能有遗漏」的快照。
//! - 没有别的回复时定期发心跳，调用方据此发现连接已经中断。
//!
//! 调用的一方（[`watch`]，节点所在的 Agent）把回复转给 SDK；连另一台 Agent 时，连接中断（出错、对方超过 `timeout`
//! 没有任何回复）后自动重连，重连后的快照标明「可能有遗漏」。重连 `timeout` 秒内没有成功时以「连不通」失败。
//!
//! 只报告发生了什么，不判断文件是否写完。inotify 只在 Linux 的本地文件系统上可靠（网络文件系统上看不到别的机器的修改）。

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::os::fd::AsFd as _;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nix::errno::Errno;
use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify, InotifyEvent, WatchDescriptor};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Notify, mpsc};
use tokio::time::Instant;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::{Stream, StreamExt as _};
use tonic::{Code, Request, Response, Status};

use super::files::{Pattern, absolute, file_info, file_json, io_status};
use super::{Capability, Host, Module};
use crate::calls::{BoxFuture, Call, CallError, Method, Target};
use crate::proto::agent_file_watch_client::AgentFileWatchClient;
use crate::proto::agent_file_watch_server::{AgentFileWatch, AgentFileWatchServer};
use crate::proto::{
    FileEvent, FileEventKind, FileInfo, WatchFilesRequest, WatchFilesResponse, WatchHeartbeat,
    WatchSnapshot, watch_files_response,
};

pub const MODULE: Module = Module {
    capability: Capability {
        name: "files.watch",
        version: 1,
    },
    methods: &[Method {
        name: "files.watch",
        call: watch_call,
    }],
    add_service,
};

fn add_service(routes: &mut tonic::service::RoutesBuilder, _host: &Host) {
    routes.add_service(AgentFileWatchServer::new(FileWatch));
}

/// 队列里最多有多少个还没发出的事件，超过时重新给快照。
pub const DEFAULT_QUEUE_EVENTS: usize = 10_000;

/// 只在测试中使用：覆盖 [`DEFAULT_QUEUE_EVENTS`]，用很小的队列模拟调用方读得太慢。
const QUEUE_EVENTS_ENV: &str = "SFLY_WATCH_QUEUE_EVENTS";

/// 请求里没有指定时的心跳间隔。
const DEFAULT_HEARTBEAT: Duration = Duration::from_secs(10);

/// 心跳间隔的下限。
const MIN_HEARTBEAT: Duration = Duration::from_millis(100);

/// 快照一批最多多少个文件。
const BATCH: usize = 256;

/// 读 inotify 的线程每隔多久看一眼调用方是否已经放弃。
const STOP_CHECK: Duration = Duration::from_millis(200);

/// 改名事件（`IN_MOVED_FROM`）读完一批后再等多久配对的 `IN_MOVED_TO`，等不到就当作移出了监听范围。
const MOVE_PAIRING: Duration = Duration::from_millis(10);

/// 目录 watch 的事件。
fn dir_mask() -> AddWatchFlags {
    AddWatchFlags::IN_CREATE
        | AddWatchFlags::IN_MOVED_FROM
        | AddWatchFlags::IN_MOVED_TO
        | AddWatchFlags::IN_CLOSE_WRITE
        | AddWatchFlags::IN_MODIFY
        | AddWatchFlags::IN_DELETE
        | AddWatchFlags::IN_DELETE_SELF
        | AddWatchFlags::IN_MOVE_SELF
        | AddWatchFlags::IN_ONLYDIR
}

type WatchStream = Pin<Box<dyn Stream<Item = Result<WatchFilesResponse, Status>> + Send>>;

/// `AgentFileWatch` 服务：供其它 Agent 调用，也被自己所在的 Agent 直接调用（[`Target::Local`]）。
pub struct FileWatch;

#[tonic::async_trait]
impl AgentFileWatch for FileWatch {
    type WatchStream = WatchStream;

    async fn watch(
        &self,
        request: Request<WatchFilesRequest>,
    ) -> Result<Response<Self::WatchStream>, Status> {
        let WatchFilesRequest {
            directory,
            pattern,
            recursive,
            heartbeat_ms,
        } = request.into_inner();
        absolute(&directory)?;
        let heartbeat = match heartbeat_ms {
            0 => DEFAULT_HEARTBEAT,
            ms => Duration::from_millis(ms.into()).max(MIN_HEARTBEAT),
        };
        let capacity = std::env::var(QUEUE_EVENTS_ENV)
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_QUEUE_EVENTS)
            .max(1);
        let pattern = Pattern::new(if pattern.is_empty() { "*" } else { &pattern });
        // 目录本身的错误（不存在、不是目录、没有权限）作为调用的错误。
        let mut watcher =
            tokio::task::spawn_blocking(move || Watcher::start(directory, pattern, recursive))
                .await
                .map_err(|error| Status::internal(format!("开始监听失败：{error}")))??;
        let shared = Arc::new(Shared {
            queue: Mutex::new(Queue::new(capacity)),
            notify: Notify::new(),
            stopped: AtomicBool::new(false),
        });
        {
            let shared = shared.clone();
            std::thread::spawn(move || {
                let end = watcher.run(&shared);
                shared.push(Entry::End(end));
            });
        }
        let (tx, rx) = mpsc::channel(16);
        tokio::spawn(pump(shared, tx, heartbeat));
        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }
}

// ---- 队列 ----

/// 队列的一项。
enum Entry {
    /// 一份快照（取代队列里还没发出的一切）。
    Snapshot {
        files: Vec<FileInfo>,
        missed: bool,
    },
    Event(FileEvent),
    /// 监听结束（出错）。
    End(Status),
}

/// 读 inotify 的线程和发给调用方的任务之间的队列。
struct Queue {
    /// (序号, 项)：序号连续递增。
    entries: VecDeque<(u64, Entry)>,
    next_seq: u64,
    /// 队列里的事件数和上限。
    events: usize,
    capacity: usize,
    /// 路径 → 这个路径在队列里的最后一个事件是修改时它的序号：再次修改时合并进它。
    tail_modified: HashMap<String, u64>,
    /// 监听已经结束，不再接受新的项。
    ended: bool,
}

impl Queue {
    fn new(capacity: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            next_seq: 0,
            events: 0,
            capacity,
            tail_modified: HashMap::new(),
            ended: false,
        }
    }

    fn append(&mut self, entry: Entry) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.entries.push_back((seq, entry));
        seq
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.events = 0;
        self.tail_modified.clear();
    }

    /// 放进一个事件；队列已满时清空队列并返回 false（要重新给快照）。
    fn event(&mut self, event: FileEvent) -> bool {
        let path = event
            .file
            .as_ref()
            .map(|f| f.path.clone())
            .unwrap_or_default();
        let modified = event.kind == FileEventKind::Modified as i32;
        if modified && let Some(seq) = self.tail_modified.get(&path).copied() {
            let front = self.entries.front().map_or(seq, |(s, _)| *s);
            if let Some((s, Entry::Event(queued))) = self.entries.get_mut((seq - front) as usize)
                && *s == seq
            {
                queued.file = event.file;
                return true;
            }
        }
        if self.events >= self.capacity {
            self.clear();
            return false;
        }
        self.tail_modified.remove(&path);
        if !event.old_path.is_empty() {
            self.tail_modified.remove(&event.old_path);
        }
        let seq = self.append(Entry::Event(event));
        self.events += 1;
        if modified {
            self.tail_modified.insert(path, seq);
        }
        true
    }

    fn pop(&mut self) -> Option<Entry> {
        let (seq, entry) = self.entries.pop_front()?;
        if let Entry::Event(event) = &entry {
            self.events -= 1;
            if let Some(file) = &event.file
                && self.tail_modified.get(&file.path) == Some(&seq)
            {
                self.tail_modified.remove(&file.path);
            }
        }
        Some(entry)
    }
}

/// 两边共享的状态。
struct Shared {
    queue: Mutex<Queue>,
    notify: Notify,
    /// 调用方已经放弃（或监听已经结束）：读 inotify 的线程随之退出。
    stopped: AtomicBool,
}

impl Shared {
    /// 放进一份快照（取代队列里还没发出的一切）或监听的结束（排在还没发出的事件之后）。
    fn push(&self, entry: Entry) {
        let mut queue = self.queue.lock().unwrap();
        if queue.ended {
            return;
        }
        match entry {
            Entry::End(_) => queue.ended = true,
            _ => queue.clear(),
        }
        queue.append(entry);
        drop(queue);
        self.notify.notify_one();
    }

    /// 放进一个事件；队列已满时返回 false。
    fn event(&self, event: FileEvent) -> bool {
        let accepted = self.queue.lock().unwrap().event(event);
        self.notify.notify_one();
        accepted
    }

    fn stopped(&self) -> bool {
        self.stopped.load(Ordering::Relaxed)
    }
}

/// 把队列发给调用方，没有别的回复时发心跳；调用方放弃时让读 inotify 的线程退出。
async fn pump(
    shared: Arc<Shared>,
    tx: mpsc::Sender<Result<WatchFilesResponse, Status>>,
    heartbeat: Duration,
) {
    let message = |message| -> Result<WatchFilesResponse, Status> {
        Ok(WatchFilesResponse {
            message: Some(message),
        })
    };
    'pump: loop {
        let entry = loop {
            if let Some(entry) = shared.queue.lock().unwrap().pop() {
                break entry;
            }
            tokio::select! {
                () = shared.notify.notified() => {}
                () = tokio::time::sleep(heartbeat) => {
                    let beat = message(watch_files_response::Message::Heartbeat(WatchHeartbeat {}));
                    if tx.send(beat).await.is_err() {
                        break 'pump;
                    }
                }
                () = tx.closed() => break 'pump,
            }
        };
        match entry {
            Entry::Snapshot { files, missed } => {
                let mut batches: Vec<Vec<FileInfo>> = Vec::new();
                let mut files = files.into_iter().peekable();
                // 空快照也发一批。
                loop {
                    batches.push(files.by_ref().take(BATCH).collect());
                    if files.peek().is_none() {
                        break;
                    }
                }
                let count = batches.len();
                for (i, files) in batches.into_iter().enumerate() {
                    let batch = WatchSnapshot {
                        files,
                        first: i == 0,
                        last: i + 1 == count,
                        missed,
                    };
                    if tx
                        .send(message(watch_files_response::Message::Snapshot(batch)))
                        .await
                        .is_err()
                    {
                        break 'pump;
                    }
                }
            }
            Entry::Event(event) => {
                if tx
                    .send(message(watch_files_response::Message::Event(event)))
                    .await
                    .is_err()
                {
                    break 'pump;
                }
            }
            Entry::End(status) => {
                let _ = tx.send(Err(status)).await;
                break 'pump;
            }
        }
    }
    shared.stopped.store(true, Ordering::Relaxed);
}

// ---- 读 inotify ----

/// 一次监听：inotify 实例、各目录的 watch，和调用方已经知道的文件。
struct Watcher {
    inotify: Inotify,
    /// 被监听的目录（请求里的写法）。
    root: String,
    root_wd: WatchDescriptor,
    pattern: Pattern,
    recursive: bool,
    /// watch → 目录的路径。
    dirs: HashMap<WatchDescriptor, String>,
    /// 调用方已经知道的匹配的文件（快照加上之后的事件）：路径 → 最后一次看到的属性。
    index: HashMap<String, FileInfo>,
}

/// 处理一批 inotify 事件之后怎么办。
enum Flow {
    Continue,
    /// 事件队列溢出：重新给快照。
    Resnapshot,
    /// 监听结束。
    End(Status),
}

/// 一个还没配对的 `IN_MOVED_FROM`。
struct MovedFrom {
    cookie: u32,
    path: String,
    is_dir: bool,
}

impl Watcher {
    /// 建 inotify 实例、加上目录的 watch；目录的错误作为调用的错误。
    fn start(root: String, pattern: Pattern, recursive: bool) -> Result<Self, Status> {
        let inotify = Inotify::init(InitFlags::IN_NONBLOCK | InitFlags::IN_CLOEXEC).map_err(
            |errno| match errno {
                Errno::EMFILE | Errno::ENFILE => Status::resource_exhausted(format!(
                    "监听 {root} 失败：inotify 实例数超过了系统上限（{}）：调大这个上限，或减少同时进行的监听",
                    limit("max_user_instances")
                )),
                errno => Status::internal(format!("监听 {root} 失败：{errno}")),
            },
        )?;
        let root_wd = inotify
            .add_watch(Path::new(&root), dir_mask())
            .map_err(|errno| watch_error(errno, &root))?;
        // add_watch 只要求能读目录本身，列出它还要能进入。
        std::fs::read_dir(&root).map_err(|error| io_status(&error, &root))?;
        Ok(Self {
            inotify,
            root_wd,
            dirs: HashMap::from([(root_wd, root.clone())]),
            root,
            pattern,
            recursive,
            index: HashMap::new(),
        })
    }

    /// 先给快照，再一直读 inotify，直到调用方放弃（返回值没有人收）或出错。
    fn run(&mut self, shared: &Shared) -> Status {
        let mut missed = false;
        'snapshot: loop {
            match self.scan() {
                Ok(files) => shared.push(Entry::Snapshot { files, missed }),
                Err(status) => return status,
            }
            missed = true;
            let mut moved: Option<MovedFrom> = None;
            loop {
                if shared.stopped() {
                    return Status::cancelled("调用方已放弃监听");
                }
                let wait = if moved.is_some() {
                    MOVE_PAIRING
                } else {
                    STOP_CHECK
                };
                let events = match self.read(wait) {
                    Ok(events) => events,
                    Err(errno) => {
                        return Status::internal(format!(
                            "读 {} 的 inotify 事件失败：{errno}",
                            self.root
                        ));
                    }
                };
                if events.is_empty() {
                    // 等不到配对的 IN_MOVED_TO：移出了监听范围。
                    if let Some(from) = moved.take() {
                        match self.moved_out(shared, from) {
                            Flow::Continue => {}
                            Flow::Resnapshot => continue 'snapshot,
                            Flow::End(status) => return status,
                        }
                    }
                    continue;
                }
                for event in events {
                    match self.handle(shared, event, &mut moved) {
                        Flow::Continue => {}
                        Flow::Resnapshot => continue 'snapshot,
                        Flow::End(status) => return status,
                    }
                }
            }
        }
    }

    /// 等到有事件（最多 `wait`），读出现有的全部事件。
    fn read(&self, wait: Duration) -> Result<Vec<InotifyEvent>, Errno> {
        let timeout = PollTimeout::try_from(wait).unwrap_or(PollTimeout::MAX);
        let mut fds = [PollFd::new(self.inotify.as_fd(), PollFlags::POLLIN)];
        match poll(&mut fds, timeout) {
            Ok(0) | Err(Errno::EINTR) => return Ok(Vec::new()),
            Ok(_) => {}
            Err(errno) => return Err(errno),
        }
        let mut all = Vec::new();
        loop {
            match self.inotify.read_events() {
                Ok(events) if events.is_empty() => break,
                Ok(events) => all.extend(events),
                Err(Errno::EAGAIN) => break,
                Err(Errno::EINTR) => continue,
                Err(errno) => return Err(errno),
            }
        }
        Ok(all)
    }

    /// 列出当前匹配的文件（递归时顺便给每个子目录加上 watch），作为新的「调用方已经知道的文件」。
    /// 顺序与 `files.list` 相同。
    fn scan(&mut self) -> Result<Vec<FileInfo>, Status> {
        let mut found = Vec::new();
        let mut dirs = HashMap::from([(self.root_wd, self.root.clone())]);
        let top =
            sorted_entries(Path::new(&self.root)).map_err(|error| io_status(&error, &self.root))?;
        let root = self.root.clone();
        self.walk(&root, top, &mut found, &mut dirs)?;
        // 不再存在的目录的 watch 去掉（移出去的目录还在别处，不去掉会继续收到它的事件）。
        for (wd, _) in self.dirs.iter().filter(|(wd, _)| !dirs.contains_key(wd)) {
            let _ = self.inotify.rm_watch(*wd);
        }
        self.dirs = dirs;
        self.index = found.iter().map(|f| (f.path.clone(), f.clone())).collect();
        Ok(found)
    }

    /// 列出一个目录：先是匹配的文件，再按名称依次进入子目录（递归时）。子目录不存在、没有权限时跳过。
    fn walk(
        &self,
        dir: &str,
        entries: Vec<(String, std::fs::DirEntry)>,
        found: &mut Vec<FileInfo>,
        dirs: &mut HashMap<WatchDescriptor, String>,
    ) -> Result<(), Status> {
        let mut subdirs = Vec::new();
        for (name, entry) in entries {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = format!("{}/{name}", dir.trim_end_matches('/'));
            if kind.is_dir() {
                if self.recursive {
                    subdirs.push(path);
                }
                continue;
            }
            if let Some(info) = self.matching(&name, &path) {
                found.push(info);
            }
        }
        for subdir in subdirs {
            // 先加 watch 再列出：列出之后的变化不会漏掉。
            let wd = match self.inotify.add_watch(Path::new(&subdir), dir_mask()) {
                Ok(wd) => wd,
                Err(Errno::ENOSPC) => return Err(watch_error(Errno::ENOSPC, &subdir)),
                Err(_) => continue,
            };
            let Ok(entries) = sorted_entries(Path::new(&subdir)) else {
                continue;
            };
            dirs.insert(wd, subdir.clone());
            self.walk(&subdir, entries, found, dirs)?;
        }
        Ok(())
    }

    /// 名字匹配通配符的普通文件（跟随符号链接判断）的属性；不匹配、不存在、不是普通文件时为 None。
    fn matching(&self, name: &str, path: &str) -> Option<FileInfo> {
        if !self.pattern.matches(name) {
            return None;
        }
        let metadata = std::fs::metadata(path).ok()?;
        metadata
            .is_file()
            .then(|| file_info(path.to_string(), &metadata))
    }

    /// 发出一个事件，记下调用方由此知道的文件。
    fn emit(
        &mut self,
        shared: &Shared,
        kind: FileEventKind,
        file: FileInfo,
        old_path: &str,
    ) -> Flow {
        if !old_path.is_empty() {
            self.index.remove(old_path);
        }
        if kind == FileEventKind::Deleted {
            self.index.remove(&file.path);
        } else {
            self.index.insert(file.path.clone(), file.clone());
        }
        let event = FileEvent {
            kind: kind as i32,
            file: Some(file),
            old_path: old_path.to_string(),
        };
        if shared.event(event) {
            Flow::Continue
        } else {
            Flow::Resnapshot
        }
    }

    /// 一个文件出现在 `path`（新建或移进来）：调用方已经知道同一个文件时不重复报告。
    fn appeared(&mut self, shared: &Shared, name: &str, path: &str) -> Flow {
        let Some(info) = self.matching(name, path) else {
            return Flow::Continue;
        };
        match self.index.get(path) {
            Some(known) if same_file(known, &info) => Flow::Continue,
            Some(known) => {
                // 原来在这个路径上的文件被替换掉了。
                let known = known.clone();
                and_then(self.emit(shared, FileEventKind::Deleted, known, ""), || {
                    self.emit(shared, FileEventKind::Created, info, "")
                })
            }
            None => self.emit(shared, FileEventKind::Created, info, ""),
        }
    }

    /// `path` 上调用方已经知道的文件不在了（删除或移出去）。
    fn gone(&mut self, shared: &Shared, path: &str) -> Flow {
        match self.index.get(path).cloned() {
            Some(known) => self.emit(shared, FileEventKind::Deleted, known, ""),
            None => Flow::Continue,
        }
    }

    /// 一个目录下（含更深的子目录）调用方已经知道的文件，按路径排序。
    fn known_under(&self, dir: &str) -> Vec<String> {
        let prefix = format!("{dir}/");
        let mut paths: Vec<String> = self
            .index
            .keys()
            .filter(|p| p.starts_with(&prefix))
            .cloned()
            .collect();
        paths.sort();
        paths
    }

    /// 递归时新出现一个子目录（新建或移进来）：加上 watch，里面已有的文件作为新建报告。
    fn dir_appeared(&mut self, shared: &Shared, dir: &str) -> Flow {
        let wd = match self.inotify.add_watch(Path::new(dir), dir_mask()) {
            Ok(wd) => wd,
            Err(Errno::ENOSPC) => return Flow::End(watch_error(Errno::ENOSPC, dir)),
            Err(_) => return Flow::Continue,
        };
        let Ok(entries) = sorted_entries(Path::new(dir)) else {
            return Flow::Continue;
        };
        let mut found = Vec::new();
        let mut dirs = HashMap::from([(wd, dir.to_string())]);
        if let Err(status) = self.walk(dir, entries, &mut found, &mut dirs) {
            return Flow::End(status);
        }
        self.dirs.extend(dirs);
        for info in found {
            let name = info.path.rsplit('/').next().unwrap_or_default().to_string();
            let path = info.path.clone();
            match self.appeared(shared, &name, &path) {
                Flow::Continue => {}
                other => return other,
            }
        }
        Flow::Continue
    }

    /// 递归时一个子目录不在了（删除或移出去）：去掉它和下面的 watch，里面调用方已经知道的文件作为删除报告。
    fn dir_gone(&mut self, shared: &Shared, dir: &str) -> Flow {
        let prefix = format!("{dir}/");
        let stale: Vec<WatchDescriptor> = self
            .dirs
            .iter()
            .filter(|(_, path)| *path == dir || path.starts_with(&prefix))
            .map(|(wd, _)| *wd)
            .collect();
        for wd in stale {
            self.dirs.remove(&wd);
            let _ = self.inotify.rm_watch(wd);
        }
        for path in self.known_under(dir) {
            match self.gone(shared, &path) {
                Flow::Continue => {}
                other => return other,
            }
        }
        Flow::Continue
    }

    /// 递归时一个子目录在监听范围内改名：下面的 watch 换成新路径，里面调用方已经知道的文件作为改名报告。
    fn dir_moved(&mut self, shared: &Shared, from: &str, to: &str) -> Flow {
        let prefix = format!("{from}/");
        for path in self.dirs.values_mut() {
            if path == from {
                *path = to.to_string();
            } else if let Some(rest) = path.strip_prefix(&prefix) {
                *path = format!("{to}/{rest}");
            }
        }
        for old in self.known_under(from) {
            let new = format!("{to}/{}", &old[prefix.len()..]);
            let Some(mut info) = self.index.get(&old).cloned() else {
                continue;
            };
            if let Ok(metadata) = std::fs::metadata(&new) {
                info = file_info(new.clone(), &metadata);
            } else {
                info.path = new.clone();
            }
            match self.emit(shared, FileEventKind::Moved, info, &old) {
                Flow::Continue => {}
                other => return other,
            }
        }
        Flow::Continue
    }

    /// 等不到配对的 `IN_MOVED_FROM`：移出了监听范围。
    fn moved_out(&mut self, shared: &Shared, from: MovedFrom) -> Flow {
        if from.is_dir {
            self.dir_gone(shared, &from.path)
        } else {
            self.gone(shared, &from.path)
        }
    }

    /// 处理一个 inotify 事件。
    fn handle(
        &mut self,
        shared: &Shared,
        event: InotifyEvent,
        moved: &mut Option<MovedFrom>,
    ) -> Flow {
        let mask = event.mask;
        if mask.contains(AddWatchFlags::IN_Q_OVERFLOW) {
            moved.take();
            return Flow::Resnapshot;
        }
        // 前面的 IN_MOVED_FROM 后面紧跟的不是配对的 IN_MOVED_TO：移出了监听范围。
        if let Some(from) = moved.take_if(|from| {
            !(mask.contains(AddWatchFlags::IN_MOVED_TO) && event.cookie == from.cookie)
        }) {
            match self.moved_out(shared, from) {
                Flow::Continue => {}
                other => return other,
            }
        }
        if event.wd == self.root_wd
            && mask.intersects(
                AddWatchFlags::IN_DELETE_SELF
                    | AddWatchFlags::IN_MOVE_SELF
                    | AddWatchFlags::IN_IGNORED,
            )
        {
            return Flow::End(Status::not_found(format!(
                "被监听的目录 {} 已被删除或改名，监听结束",
                self.root
            )));
        }
        if mask.contains(AddWatchFlags::IN_UNMOUNT) {
            return Flow::End(Status::failed_precondition(format!(
                "被监听的目录 {} 所在的文件系统已被卸载，监听结束",
                self.root
            )));
        }
        if mask.contains(AddWatchFlags::IN_IGNORED) {
            self.dirs.remove(&event.wd);
            return Flow::Continue;
        }
        let (Some(dir), Some(name)) = (self.dirs.get(&event.wd), event.name.as_ref()) else {
            return Flow::Continue;
        };
        // 名字不是 UTF-8 的跳过（与 files.list 相同）。
        let Some(name) = name.to_str().map(str::to_string) else {
            return Flow::Continue;
        };
        let path = format!("{}/{name}", dir.trim_end_matches('/'));
        let is_dir = mask.contains(AddWatchFlags::IN_ISDIR);
        if is_dir && !self.recursive {
            return Flow::Continue;
        }
        if mask.contains(AddWatchFlags::IN_MOVED_FROM) {
            *moved = Some(MovedFrom {
                cookie: event.cookie,
                path,
                is_dir,
            });
            return Flow::Continue;
        }
        if mask.contains(AddWatchFlags::IN_MOVED_TO) {
            return match moved.take() {
                Some(from) if from.is_dir => self.dir_moved(shared, &from.path, &path),
                Some(from) => self.file_moved(shared, &from.path, &name, &path),
                None if is_dir => self.dir_appeared(shared, &path),
                None => self.appeared(shared, &name, &path),
            };
        }
        if is_dir {
            if mask.contains(AddWatchFlags::IN_CREATE) {
                return self.dir_appeared(shared, &path);
            }
            if mask.contains(AddWatchFlags::IN_DELETE) {
                return self.dir_gone(shared, &path);
            }
            return Flow::Continue;
        }
        if mask.contains(AddWatchFlags::IN_CREATE) {
            return self.appeared(shared, &name, &path);
        }
        if mask.contains(AddWatchFlags::IN_DELETE) {
            return self.gone(shared, &path);
        }
        let kind = if mask.contains(AddWatchFlags::IN_CLOSE_WRITE) {
            FileEventKind::Closed
        } else if mask.contains(AddWatchFlags::IN_MODIFY) {
            FileEventKind::Modified
        } else {
            return Flow::Continue;
        };
        match self.matching(&name, &path) {
            Some(info) => self.emit(shared, kind, info, ""),
            None => Flow::Continue,
        }
    }

    /// 一个文件在监听范围内改名：改名后不再匹配是删除，之前调用方不知道它是新建。
    fn file_moved(&mut self, shared: &Shared, from: &str, name: &str, to: &str) -> Flow {
        let known = self.index.contains_key(from);
        let info = self.matching(name, to);
        match (known, info) {
            (true, Some(info)) => {
                // 改名覆盖了调用方知道的另一个文件。
                let replaced = self
                    .index
                    .get(to)
                    .filter(|other| !same_file(other, &info))
                    .cloned();
                let flow = match replaced {
                    Some(other) => self.emit(shared, FileEventKind::Deleted, other, ""),
                    None => Flow::Continue,
                };
                and_then(flow, || self.emit(shared, FileEventKind::Moved, info, from))
            }
            (true, None) => self.gone(shared, from),
            (false, Some(_)) => self.appeared(shared, name, to),
            (false, None) => Flow::Continue,
        }
    }
}

/// 前一步继续时才做下一步。
fn and_then(flow: Flow, next: impl FnOnce() -> Flow) -> Flow {
    match flow {
        Flow::Continue => next(),
        other => other,
    }
}

fn same_file(a: &FileInfo, b: &FileInfo) -> bool {
    a.device == b.device && a.inode == b.inode
}

/// 加 watch 失败转成 gRPC 状态。
fn watch_error(errno: Errno, path: &str) -> Status {
    match errno {
        Errno::ENOSPC => Status::resource_exhausted(format!(
            "监听 {path} 失败：监听的目录数超过了系统上限（{}）：调大这个上限，或缩小监听范围（不递归，或监听更深的目录）",
            limit("max_user_watches")
        )),
        errno => io_status(&std::io::Error::from(errno), path),
    }
}

/// inotify 的一项系统上限，例如 `/proc/sys/fs/inotify/max_user_watches = 8192`。
fn limit(name: &str) -> String {
    let file = format!("/proc/sys/fs/inotify/{name}");
    match std::fs::read_to_string(&file) {
        Ok(value) => format!("{file} = {}", value.trim()),
        Err(_) => file,
    }
}

/// 目录里的条目，按名称排序；名字不是 UTF-8 的跳过。
fn sorted_entries(dir: &Path) -> std::io::Result<Vec<(String, std::fs::DirEntry)>> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?
        .flatten()
        .filter_map(|entry| Some((entry.file_name().into_string().ok()?, entry)))
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries)
}

// ---- 节点调用（[`crate::calls`]）----

/// 没有 `timeout` 时，对方超过这么久没有任何回复就认为连接已经中断。
const DEFAULT_SILENCE: Duration = Duration::from_secs(30);

/// 没有别的回复时，每隔这么久回复 SDK 一次保活（SDK 等每一帧最多 `timeout` 加 5 秒）。
const ALIVE: Duration = Duration::from_secs(2);

/// 重连的间隔：从这里开始每次加倍，最多 [`MAX_BACKOFF`]。
const FIRST_BACKOFF: Duration = Duration::from_millis(200);
const MAX_BACKOFF: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
struct WatchArgs {
    directory: String,
    #[serde(default)]
    pattern: String,
    #[serde(default)]
    recursive: bool,
}

fn watch_call(call: Call<'_>) -> BoxFuture<'_, Result<Value, CallError>> {
    Box::pin(watch(call))
}

/// 回复 SDK：转发快照和事件，没有别的回复时发保活。
struct Out<'c, 'a> {
    call: &'c mut Call<'a>,
    next_alive: Instant,
}

impl Out<'_, '_> {
    async fn item(&mut self, item: Value) -> Result<(), CallError> {
        self.call.item(item).await?;
        self.next_alive = Instant::now() + ALIVE;
        Ok(())
    }

    /// 等 `future` 的同时按时发保活。
    async fn alive_while<T>(&mut self, future: impl Future<Output = T>) -> Result<T, CallError> {
        tokio::pin!(future);
        loop {
            tokio::select! {
                biased;
                out = &mut future => return Ok(out),
                () = tokio::time::sleep_until(self.next_alive) => {
                    self.item(json!({ "alive": true })).await?;
                }
            }
        }
    }
}

/// 一次连接为什么结束。
enum Lost {
    /// 可以重连（连接中断、对方没有回应）：原因给人看。
    Retry(String),
    /// 不能重连，调用以这个错误结束。
    Fail(CallError),
}

/// `files.watch`：转发快照和事件，直到调用方放弃（或出错）；结果永远不会正常给出。
async fn watch(mut call: Call<'_>) -> Result<Value, CallError> {
    let WatchArgs {
        directory,
        pattern,
        recursive,
    } = call.args()?;
    let limit = call.timeout;
    let silence = limit.unwrap_or(DEFAULT_SILENCE);
    let heartbeat = (silence / 3).max(MIN_HEARTBEAT);
    let request = WatchFilesRequest {
        directory,
        pattern,
        recursive,
        heartbeat_ms: u32::try_from(heartbeat.as_millis()).unwrap_or(u32::MAX),
    };
    let target = call.target;
    let method = call.method;
    let mut out = Out {
        next_alive: Instant::now() + ALIVE,
        call: &mut call,
    };
    // 连上过：之后连接中断时重连（第一次就连不上时和其它方法一样直接失败）。
    let mut connected = false;
    // 已经给过调用方一份完整的快照：重连后的快照标明可能有遗漏。
    let mut delivered = false;
    // 连接从什么时候中断、为什么。
    let mut lost: Option<(Instant, String)> = None;
    let mut backoff = FIRST_BACKOFF;
    loop {
        let remaining = match (&lost, limit) {
            (Some((since, _)), Some(limit)) => Some(limit.saturating_sub(since.elapsed())),
            (_, limit) => limit,
        };
        let ended = match out.alive_while(open(target, &request, remaining)).await? {
            Ok(stream) => {
                connected = true;
                let missed = delivered && lost.is_some();
                forward(&mut out, stream, silence, missed, &mut delivered, &mut lost).await?
            }
            Err(status) if !connected => return Err(first_failure(target, method, limit, status)),
            Err(status) if retryable(&status) => Lost::Retry(status.message().to_string()),
            Err(status) => Lost::Fail(target.error(status)),
        };
        let reason = match ended {
            Lost::Fail(error) => return Err(error),
            Lost::Retry(reason) => reason,
        };
        let Target::Remote(_) = target else {
            return Err(target.error(Status::internal(reason)));
        };
        let since = match &lost {
            Some((since, _)) => *since,
            None => {
                backoff = FIRST_BACKOFF;
                Instant::now()
            }
        };
        if let Some(limit) = limit
            && since.elapsed() >= limit
        {
            return Err(target.error(Status::unavailable(format!(
                "监听的连接中断，{} 秒内没有重新连上：{reason}",
                seconds(limit)
            ))));
        }
        lost = Some((since, reason));
        out.alive_while(tokio::time::sleep(backoff)).await?;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

/// 打开一次监听（最多等 `limit`，超过时是 `DEADLINE_EXCEEDED`）。
async fn open(
    target: &Target,
    request: &WatchFilesRequest,
    limit: Option<Duration>,
) -> Result<WatchStream, Status> {
    let opening = async {
        match target {
            Target::Local { .. } => FileWatch
                .watch(Request::new(request.clone()))
                .await
                .map(Response::into_inner),
            Target::Remote(remote) => AgentFileWatchClient::new(remote.channel())
                .watch(Request::new(request.clone()))
                .await
                .map(|response| Box::pin(response.into_inner()) as WatchStream),
        }
    };
    match limit {
        None => opening.await,
        Some(limit) => tokio::time::timeout(limit, opening)
            .await
            .unwrap_or_else(|_| {
                Err(Status::deadline_exceeded(format!(
                    "超过 {} 秒没有回应",
                    seconds(limit)
                )))
            }),
    }
}

/// 转发一次连接上的回复，直到连接结束。
async fn forward(
    out: &mut Out<'_, '_>,
    mut stream: WatchStream,
    silence: Duration,
    missed: bool,
    delivered: &mut bool,
    lost: &mut Option<(Instant, String)>,
) -> Result<Lost, CallError> {
    let target = out.call.target;
    // 这次连接上的快照是不是重连后的（之前给过调用方完整的快照）：要标明可能有遗漏。
    let mut missed = missed;
    loop {
        let deadline = Instant::now() + silence;
        let next = out
            .alive_while(tokio::time::timeout_at(deadline, stream.next()))
            .await?;
        let message = match next {
            Err(_) => {
                return Ok(Lost::Retry(format!(
                    "超过 {} 秒没有收到任何回复",
                    seconds(silence)
                )));
            }
            Ok(None) => return Ok(Lost::Retry("对方结束了监听".into())),
            Ok(Some(Err(status))) if retryable(&status) => {
                return Ok(Lost::Retry(status.message().to_string()));
            }
            Ok(Some(Err(status))) => return Ok(Lost::Fail(target.error(status))),
            Ok(Some(Ok(response))) => response.message,
        };
        match message {
            Some(watch_files_response::Message::Snapshot(batch)) => {
                let files: Vec<Value> = batch.files.iter().map(file_json).collect();
                out.item(json!({
                    "snapshot": {
                        "files": files,
                        "first": batch.first,
                        "last": batch.last,
                        "missed": batch.missed || missed,
                    }
                }))
                .await?;
                if batch.last {
                    *delivered = true;
                    *lost = None;
                    missed = false;
                }
            }
            Some(watch_files_response::Message::Event(event)) => {
                let Some(file) = event.file else { continue };
                let kind = match FileEventKind::try_from(event.kind) {
                    Ok(FileEventKind::Created) => "created",
                    Ok(FileEventKind::Moved) => "moved",
                    Ok(FileEventKind::Closed) => "closed",
                    Ok(FileEventKind::Modified) => "modified",
                    Ok(FileEventKind::Deleted) => "deleted",
                    // 更新版本的 Agent 加的事件：这个版本不认识，跳过。
                    _ => continue,
                };
                let old_path = (!event.old_path.is_empty()).then_some(event.old_path);
                out.item(json!({
                    "event": { "kind": kind, "file": file_json(&file), "old_path": old_path }
                }))
                .await?;
            }
            Some(watch_files_response::Message::Heartbeat(_)) | None => {}
        }
    }
}

/// 第一次就没有打开监听：和其它方法一样以超时、连不通、目录不存在等失败。
fn first_failure(
    target: &Target,
    method: &str,
    limit: Option<Duration>,
    status: Status,
) -> CallError {
    match limit {
        Some(limit) if status.code() == Code::DeadlineExceeded => CallError::new(
            crate::calls::ErrorKind::Timeout,
            format!(
                "Agent {} 超过 {} 秒没有回应 {method}",
                target.name(),
                seconds(limit)
            ),
        ),
        _ => target.error(status),
    }
}

/// 连接中断、对方没有回应这类可以重连的错误；目录不存在、没有权限这类确定的错误不重连。
fn retryable(status: &Status) -> bool {
    !matches!(
        status.code(),
        Code::NotFound
            | Code::PermissionDenied
            | Code::InvalidArgument
            | Code::FailedPrecondition
            | Code::OutOfRange
            | Code::ResourceExhausted
            | Code::Unimplemented
            | Code::AlreadyExists
            | Code::Unauthenticated
    )
}

/// 秒数（给人看）：整数秒不带小数。
fn seconds(duration: Duration) -> String {
    let seconds = duration.as_secs_f64();
    if seconds.fract() == 0.0 {
        format!("{seconds:.0}")
    } else {
        format!("{seconds}")
    }
}
