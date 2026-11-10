//! 任务日志与进度的转发（docs/ARCHITECTURE.md §5.3）。
//!
//! 执行器的标准输出、标准错误（包括继承了它们的子进程）和 SDK 写入的事件管道 `events.fifo`（[`EventsPipe`]，ADR 0015）
//! 合并成同一条日志流：每行分配任务内递增的序号，批量（约每 100 毫秒一批）以 `LogBatch` 发往控制面。
//!
//! - 标准输出 → 来源 stdout、级别 info；标准错误 → 来源 stderr、级别 error；
//! - 事件管道里的 `{"type":"log"}` → 来源 sdk、级别取 SDK 记录的级别；
//! - 任务执行中途 Agent 时间跳变（[`crate::time_jump`]）→ Agent 自己写一行提示，来源 agent、级别 warn；
//! - `{"type":"progress"}` 只保留最新值，每个任务每秒最多发一次 `Progress`，任务结束前补发最后一次；
//! - `{"type":"metric"}` 按「序列（指标名 + 标签）× 秒」合并（[`crate::metrics`]），每个任务每秒最多发一批 `MetricBatch`，
//!   任务结束前发完。
//!
//! 每行和每次进度带两个时间（ADR 0018）：Agent 时间（SDK 事件取 SDK 记录的时间，其余取读到的时刻），以及读到它时的
//! 单调时钟读数（[`Stamp`]，每次读取打一次点），控制面据此折算出控制面时间。
//! 同一批内按单调时钟读数排序后再编号，所以不同来源的行大致按读到的先后排列，Agent 时间跳变也不打乱顺序；
//! 同一来源内保持写入顺序。
//! 标准输出 / 标准错误的原始内容同时写到工作目录的 `stdout.log` / `stderr.log`，每个文件 8 MiB，超过后改名为 `.1`
//! 再新建（[`LogCopy`]）；失败消息里的标准错误尾部取自内存（[`Pump::finish`]）。
//!
//! 读出、还没转发的内容有上限（[`LINE_CHUNKS`]、[`EVENT_CHUNKS`]）：转发跟不上时暂停读取，管道写满后节点的写入等待，
//! 不丢日志，Agent 内存不随节点的输出量增长（#75）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use prost::Message as _;

use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::clock;
use crate::metrics::{Labels, Merger, MetricQueue};
use crate::proto::{
    AgentMessage, AssignTask, LogBatch, LogLevel, LogLine, LogSource, MetricBatch, Progress,
    agent_message,
};
use crate::time_jump;

/// 发送一批日志、检查进度与指标的间隔。
const TICK: Duration = Duration::from_millis(100);
/// 同一任务两次进度上报的最小间隔。
const PROGRESS_INTERVAL: Duration = Duration::from_secs(1);
/// 读出、还没处理的事件管道内容最多排这么多块（每块不超过一次读取的 64 KiB 加上跨块的不完整行）。
const EVENT_CHUNKS: usize = 16;
/// 读出、还没处理的标准输出 / 标准错误最多排这么多块（每块是一次读取拆出的行，不超过 16 KiB 加上跨块的不完整行）。
const LINE_CHUNKS: usize = 16;
/// 一行的最大字节数；更长的行被拆成多行。
const MAX_LINE_BYTES: usize = 64 * 1024;
/// 一批最多的行数。
const MAX_BATCH_LINES: usize = 1000;
/// 执行器退出后，等待仍持有标准输出（或事件管道）的后台子进程关闭管道的最长时间。
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// 断开期间默认最多排队的日志字节数。
pub const DEFAULT_TELEMETRY_QUEUE_BYTES: usize = 64 * 1024 * 1024;

/// 发往控制面的任务消息（`TaskStarted` / `LogBatch` / `Progress` / `MetricBatch`）。
/// 连接断开期间在通道里排队，重连后按顺序发送。
///
/// - 日志：排队的字节数有上限，超出时丢弃新的日志批次（控制面按序号看到缺口），其他消息照常排队；
/// - 指标：批次本身放在有界的 [`MetricQueue`] 里（超出时丢弃最早的点），通道里只放一个占位，
///   轮到它时取出最早的指标批次——指标仍按发出顺序排在同一任务的结果之前。
#[derive(Clone)]
pub struct Telemetry {
    tx: mpsc::UnboundedSender<Queued>,
    queued: Arc<AtomicUsize>,
    dropping: Arc<AtomicBool>,
    limit: usize,
    metrics: Arc<Mutex<MetricQueue>>,
}

enum Queued {
    Message(usize, Box<AgentMessage>),
    /// 从 [`MetricQueue`] 取一批。
    Metrics,
}

/// [`Telemetry`] 的接收端（Agent 主循环在连接上逐条发出）。
pub struct TelemetryReceiver {
    rx: mpsc::UnboundedReceiver<Queued>,
    queued: Arc<AtomicUsize>,
    metrics: Arc<Mutex<MetricQueue>>,
}

/// 新建一条任务消息通道；`limit` 是最多排队的日志字节数，`metric_limit` 是最多排队的指标点数。
pub fn telemetry(limit: usize, metric_limit: usize) -> (Telemetry, TelemetryReceiver) {
    let (tx, rx) = mpsc::unbounded_channel();
    let queued = Arc::new(AtomicUsize::new(0));
    let metrics = Arc::new(Mutex::new(MetricQueue::new(metric_limit)));
    (
        Telemetry {
            tx,
            queued: queued.clone(),
            dropping: Arc::new(AtomicBool::new(false)),
            limit,
            metrics: metrics.clone(),
        },
        TelemetryReceiver {
            rx,
            queued,
            metrics,
        },
    )
}

impl Telemetry {
    pub fn send(&self, message: AgentMessage) {
        let size = message.encoded_len();
        let is_logs = matches!(message.body, Some(agent_message::Body::Logs(_)));
        if is_logs && self.queued.load(Ordering::SeqCst) + size > self.limit {
            if !self.dropping.swap(true, Ordering::SeqCst) {
                eprintln!(
                    "log queue is full ({} bytes queued while disconnected): dropping new log lines",
                    self.queued.load(Ordering::SeqCst)
                );
            }
            return;
        }
        self.dropping.store(false, Ordering::SeqCst);
        self.queued.fetch_add(size, Ordering::SeqCst);
        if self
            .tx
            .send(Queued::Message(size, Box::new(message)))
            .is_err()
        {
            self.queued.fetch_sub(size, Ordering::SeqCst);
        }
    }

    /// 排队一批指标（超出上限时丢弃最早的点）。
    pub fn send_metrics(&self, batch: MetricBatch) {
        let limit = match self.metrics.lock() {
            Ok(mut queue) => queue.push(batch).then_some(queue.limit()),
            Err(_) => None,
        };
        if let Some(limit) = limit {
            eprintln!(
                "metric queue is full ({limit} points queued while disconnected): dropping the oldest points"
            );
        }
        let _ = self.tx.send(Queued::Metrics);
    }
}

impl TelemetryReceiver {
    pub async fn recv(&mut self) -> Option<AgentMessage> {
        loop {
            match self.rx.recv().await? {
                Queued::Message(size, message) => {
                    self.queued.fetch_sub(size, Ordering::SeqCst);
                    return Some(*message);
                }
                // 占位对应的批次可能已经因为超出上限被丢弃，或者被合并进了更早的一批。
                Queued::Metrics => {
                    let batch = self.metrics.lock().ok().and_then(|mut q| q.pop());
                    if let Some(batch) = batch {
                        return Some(AgentMessage {
                            body: Some(agent_message::Body::Metrics(batch)),
                        });
                    }
                }
            }
        }
    }
}

/// SDK 写入结构化事件的命名管道（`SFLY_EVENTS`，ADR 0015）：数据只在内核缓冲区里，读走即释放。
///
/// 在启动执行器之前创建：先以非阻塞方式打开读端，再由 Agent 自己持有一个写端——没有任何写者时
/// 读端读到的是 EOF，持有写端保证执行器打开管道之前不会提前结束；执行器退出后关掉它（[`Pump::finish`]），
/// 其余写者也都关闭后读端读到 EOF。容量调到 `/proc/sys/fs/pipe-max-size`（失败时保持默认）。
pub struct EventsPipe {
    reader: Box<dyn AsyncRead + Unpin + Send>,
    /// Agent 自己持有的写端（只为保持管道打开，从不写入）。
    writer: Box<dyn Send>,
}

impl EventsPipe {
    /// 在 `path` 创建命名管道（已存在的同名文件先删除）并打开两端。
    #[cfg(unix)]
    pub fn create(path: &Path) -> std::io::Result<EventsPipe> {
        use nix::sys::stat::Mode;
        use tokio::net::unix::pipe;

        match std::fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        nix::unistd::mkfifo(path, Mode::S_IRUSR | Mode::S_IWUSR).map_err(std::io::Error::from)?;
        let reader = pipe::OpenOptions::new().open_receiver(path)?;
        let writer = pipe::OpenOptions::new().open_sender(path)?;
        #[cfg(target_os = "linux")]
        grow_pipe(&reader);
        Ok(EventsPipe {
            reader: Box::new(reader),
            writer: Box::new(writer),
        })
    }

    #[cfg(not(unix))]
    pub fn create(_path: &Path) -> std::io::Result<EventsPipe> {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "named pipes are only supported on Unix",
        ))
    }
}

/// 把管道容量调到非特权进程允许的最大值；失败时保持默认（64 KiB）。
#[cfg(target_os = "linux")]
fn grow_pipe(fd: &impl std::os::fd::AsFd) {
    use nix::fcntl::{FcntlArg, fcntl};

    let Some(max) = std::fs::read_to_string("/proc/sys/fs/pipe-max-size")
        .ok()
        .and_then(|s| s.trim().parse::<i32>().ok())
    else {
        return;
    };
    let _ = fcntl(fd, FcntlArg::F_SETPIPE_SZ(max));
}

/// 一个任务的日志转发；执行器退出后调用 [`Pump::finish`] 发完剩余的日志和最后一次进度。
pub struct Pump {
    exited: oneshot::Sender<()>,
    handle: JoinHandle<()>,
    /// 事件管道上 Agent 自己的写端，执行器退出时关闭。
    events_writer: Box<dyn Send>,
    /// 标准错误最后的 [`STDERR_TAIL_BYTES`] 字节。
    stderr_tail: Arc<Tail>,
}

/// 失败时附带的标准错误尾部的最大字节数。
pub const STDERR_TAIL_BYTES: usize = 8 * 1024;

/// 内存里保留的一个管道最后几千字节（错误摘要用，不依赖磁盘上的副本，#70）。
#[derive(Default)]
struct Tail(Mutex<Vec<u8>>);

impl Tail {
    fn push(&self, bytes: &[u8]) {
        let Ok(mut tail) = self.0.lock() else { return };
        tail.extend_from_slice(bytes);
        if tail.len() > 2 * STDERR_TAIL_BYTES {
            let excess = tail.len() - STDERR_TAIL_BYTES;
            tail.drain(..excess);
        }
    }

    fn get(&self) -> Vec<u8> {
        let Ok(tail) = self.0.lock() else {
            return Vec::new();
        };
        tail[tail.len().saturating_sub(STDERR_TAIL_BYTES)..].to_vec()
    }
}

impl Pump {
    /// 开始转发：读取标准输出、标准错误和事件管道。`forward_rate` 只在测试中使用：
    /// 转发器每秒最多处理这么多字节的标准输出 / 标准错误（0 = 不限制），模拟转发跟不上节点的输出。
    pub fn start(
        task: &AssignTask,
        stdout: impl AsyncRead + Unpin + Send + 'static,
        stderr: impl AsyncRead + Unpin + Send + 'static,
        events: EventsPipe,
        dir: PathBuf,
        telemetry: Telemetry,
        forward_rate: u64,
    ) -> Pump {
        let EventsPipe {
            reader,
            writer: events_writer,
        } = events;
        let (events_tx, events_rx) = mpsc::channel(EVENT_CHUNKS);
        tokio::spawn(read_events(reader, events_tx));
        let (lines_tx, lines_rx) = mpsc::channel(LINE_CHUNKS);
        tokio::spawn(read_pipe(
            stdout,
            dir.join("stdout.log"),
            LogSource::Stdout,
            LogLevel::Info,
            lines_tx.clone(),
            None,
        ));
        let stderr_tail = Arc::new(Tail::default());
        tokio::spawn(read_pipe(
            stderr,
            dir.join("stderr.log"),
            LogSource::Stderr,
            LogLevel::Error,
            lines_tx,
            Some(stderr_tail.clone()),
        ));
        let (exited, exited_rx) = oneshot::channel();
        let forwarder = Forwarder {
            task_id: task.task_id.clone(),
            attempt: task.attempt,
            telemetry,
            seq: 0,
            pending: Vec::new(),
            progress: None,
            progress_sent_at: None,
            metrics: Merger::default(),
            throttle: Throttle::new(forward_rate),
            time_jumps: time_jump::Watch::start(),
        };
        let handle = tokio::spawn(forwarder.run(lines_rx, events_rx, exited_rx));
        Pump {
            exited,
            handle,
            events_writer,
            stderr_tail,
        }
    }

    /// 执行器已退出：关掉 Agent 自己的事件管道写端，读完各个管道（最多等 [`DRAIN_TIMEOUT`]），
    /// 发出剩余日志和最后一次进度。返回标准错误最后的 [`STDERR_TAIL_BYTES`] 字节。
    pub async fn finish(self) -> Vec<u8> {
        drop(self.events_writer);
        let _ = self.exited.send(());
        let _ = self.handle.await;
        self.stderr_tail.get()
    }
}

/// 尚未编号的一行。
struct Pending {
    /// Agent 时间。
    time_unix_ms: i64,
    /// 读到这一行时的单调时钟读数（[`Stamp`]）。
    monotonic_ms: i64,
    source: LogSource,
    level: LogLevel,
    text: String,
}

/// 现在的 Agent 时间。
fn now_ms() -> i64 {
    clock::agent_time_ms()
}

/// 读到一块内容（标准输出 / 标准错误的一次读取、事件管道的一次读取）时打的点：这一块里的每一行、每个事件
/// （日志、进度、指标）都用它，不逐行读时钟。控制面按 `monotonic_ms` 折算出控制面时间（ADR 0018）。
#[derive(Clone, Copy)]
struct Stamp {
    /// 单调时钟读数（[`clock::monotonic_ms`]）。
    monotonic_ms: i64,
}

impl Stamp {
    fn now() -> Stamp {
        Stamp {
            monotonic_ms: clock::monotonic_ms(),
        }
    }
}

/// 事件管道里读出的一块完整内容（若干行事件）和读到它时打的点。
struct EventChunk {
    bytes: Vec<u8>,
    stamp: Stamp,
}

/// SDK 事件的 Agent 时间：事件带时间戳时用它（SDK 读的是系统时钟，经 [`clock::to_agent_time_ms`] 换算），
/// 没带时取现在。
fn sdk_time_ms(ts: Option<i64>) -> i64 {
    ts.map_or_else(now_ms, clock::to_agent_time_ms)
}

/// 逐行读取一个管道，原始内容同时写到 `copy`（写失败时忽略），并在 `tail` 里保留最后一段；
/// 每次读取拆出的行作为一块交给 `lines`。通道有界：转发跟不上时不再读管道，写满后节点写标准输出 / 标准错误
/// 等待（背压），Agent 内存里不会越积越多，日志也不丢。转发器已经结束（执行器退出后等管道关闭超时）时
/// 照常读完管道、写副本，只是不再转发。
async fn read_pipe(
    mut pipe: impl AsyncRead + Unpin,
    copy: PathBuf,
    source: LogSource,
    level: LogLevel,
    lines: mpsc::Sender<Vec<Pending>>,
    tail: Option<Arc<Tail>>,
) {
    let mut copy = LogCopy::create(copy).await;
    let mut splitter = LineSplitter::default();
    let mut buf = vec![0u8; 16 * 1024];
    let mut chunk = Vec::new();
    // 两个时钟每次读取各读一次，这次读取拆出的行共用（一次读取里的行本来就是同时到的）。
    let emit = |chunk: &mut Vec<Pending>, (time_unix_ms, stamp): (i64, Stamp), text: String| {
        chunk.push(Pending {
            time_unix_ms,
            monotonic_ms: stamp.monotonic_ms,
            source,
            level,
            text,
        });
    };
    loop {
        let n = match pipe.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let at = (now_ms(), Stamp::now());
        if let Some(tail) = &tail {
            tail.push(&buf[..n]);
        }
        copy.write(&buf[..n]).await;
        splitter.push(&buf[..n], |text| emit(&mut chunk, at, text));
        if !chunk.is_empty() {
            let _ = lines.send(std::mem::take(&mut chunk)).await;
        }
    }
    let at = (now_ms(), Stamp::now());
    splitter.finish(|text| emit(&mut chunk, at, text));
    if !chunk.is_empty() {
        let _ = lines.send(chunk).await;
    }
    copy.flush().await;
}

/// 一个流在工作目录里的副本（`stdout.log` / `stderr.log`）：单个文件写到 [`LOG_FILE_MAX_BYTES`]
/// 时改名为 `.1`（覆盖旧的 `.1`）再新建，每个流最多两个文件。写失败时忽略（控制面有完整日志）。
struct LogCopy {
    path: PathBuf,
    file: Option<tokio::fs::File>,
    written: u64,
}

/// `stdout.log` / `stderr.log` 单个文件的上限。
const LOG_FILE_MAX_BYTES: u64 = 8 * 1024 * 1024;

impl LogCopy {
    async fn create(path: PathBuf) -> LogCopy {
        let file = Self::open(&path).await;
        LogCopy {
            path,
            file,
            written: 0,
        }
    }

    async fn open(path: &Path) -> Option<tokio::fs::File> {
        match tokio::fs::File::create(path).await {
            Ok(file) => Some(file),
            Err(error) => {
                eprintln!("cannot create {}: {error}", path.display());
                None
            }
        }
    }

    async fn write(&mut self, bytes: &[u8]) {
        if self.written > 0 && self.written + bytes.len() as u64 > LOG_FILE_MAX_BYTES {
            self.flush().await;
            self.file = None;
            let mut rotated = self.path.clone().into_os_string();
            rotated.push(".1");
            let _ = tokio::fs::rename(&self.path, rotated).await;
            self.file = Self::open(&self.path).await;
            self.written = 0;
        }
        if let Some(file) = self.file.as_mut()
            && file.write_all(bytes).await.is_ok()
        {
            self.written += bytes.len() as u64;
        }
    }

    async fn flush(&mut self) {
        if let Some(file) = self.file.as_mut() {
            let _ = file.flush().await;
        }
    }
}

/// 按换行拆分字节流；去掉行尾的 `\r`，过长的行拆开。公开只是为了基准测试（benches/telemetry.rs）。
#[derive(Default)]
pub struct LineSplitter {
    partial: Vec<u8>,
}

impl LineSplitter {
    /// 追加一段字节，每切出一个完整的行（或过长被拆开的一段）调用一次 `emit`。
    pub fn push(&mut self, mut bytes: &[u8], mut emit: impl FnMut(String)) {
        while !bytes.is_empty() {
            match bytes.iter().position(|&b| b == b'\n') {
                Some(i) => {
                    self.partial.extend_from_slice(&bytes[..i]);
                    bytes = &bytes[i + 1..];
                    self.emit_partial(&mut emit);
                }
                None => {
                    self.partial.extend_from_slice(bytes);
                    bytes = &[];
                }
            }
            while self.partial.len() >= MAX_LINE_BYTES {
                let rest = self.partial.split_off(MAX_LINE_BYTES);
                emit(String::from_utf8_lossy(&self.partial).into_owned());
                self.partial = rest;
            }
        }
    }

    fn emit_partial(&mut self, emit: &mut impl FnMut(String)) {
        if self.partial.last() == Some(&b'\r') {
            self.partial.pop();
        }
        emit(String::from_utf8_lossy(&self.partial).into_owned());
        self.partial.clear();
    }

    /// 流结束：剩下没有换行结尾的内容作为最后一行。
    pub fn finish(mut self, mut emit: impl FnMut(String)) {
        if !self.partial.is_empty() {
            self.emit_partial(&mut emit);
        }
    }
}

/// 事件管道中的一行（sfly.context）。
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Event {
    Log {
        #[serde(default)]
        ts: Option<i64>,
        #[serde(default)]
        level: String,
        #[serde(default)]
        message: String,
    },
    Progress {
        #[serde(default)]
        ts: Option<i64>,
        current: f64,
        #[serde(default)]
        total: Option<f64>,
        #[serde(default)]
        message: String,
    },
    Metric {
        #[serde(default)]
        ts: Option<i64>,
        name: String,
        /// `gauge`（默认）| `counter`。
        #[serde(default)]
        kind: String,
        value: f64,
        /// 标签（键 → 值）；不带标签时没有这个字段。
        #[serde(default)]
        labels: Labels,
    },
}

/// 读取事件管道，把以换行结尾的完整内容按块交给 `chunks`，直到所有写端关闭（最后不完整的一行丢弃）。
/// 每块带上读到它的那一刻打的点（[`Stamp`]）：SDK 不改，事件的单调时钟读数由 Agent 在这里打上。
/// 通道有界：处理跟不上时不再读管道，写满后 SDK 的写入等待（背压），Agent 内存里不会越积越多。
async fn read_events(mut pipe: impl AsyncRead + Unpin, chunks: mpsc::Sender<EventChunk>) {
    let mut partial = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match pipe.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let stamp = Stamp::now();
        partial.extend_from_slice(&buf[..n]);
        let Some(last) = partial.iter().rposition(|&b| b == b'\n') else {
            continue;
        };
        let rest = partial.split_off(last + 1);
        let bytes = std::mem::replace(&mut partial, rest);
        if chunks.send(EventChunk { bytes, stamp }).await.is_err() {
            return;
        }
    }
}

fn sdk_level(level: &str) -> LogLevel {
    match level {
        "debug" => LogLevel::Debug,
        "warn" | "warning" => LogLevel::Warn,
        "error" => LogLevel::Error,
        _ => LogLevel::Info,
    }
}

struct Forwarder {
    task_id: String,
    attempt: u32,
    telemetry: Telemetry,
    seq: u64,
    pending: Vec<Pending>,
    /// 还没上报的最新进度。
    progress: Option<Progress>,
    progress_sent_at: Option<Instant>,
    /// 还没发出的指标点。
    metrics: Merger,
    throttle: Throttle,
    /// Agent 时间跳变的检测。
    time_jumps: time_jump::Watch,
}

/// 测试用的转发限速（[`Pump::start`] 的 `forward_rate`）：按累计处理的字节数等到对应的时刻。
struct Throttle {
    /// 每秒字节数，0 = 不限制。
    rate: u64,
    started: Instant,
    bytes: u64,
}

impl Throttle {
    fn new(rate: u64) -> Throttle {
        Throttle {
            rate,
            started: Instant::now(),
            bytes: 0,
        }
    }

    async fn pace(&mut self, bytes: usize) {
        if self.rate == 0 {
            return;
        }
        self.bytes += bytes as u64;
        let due = self.started + Duration::from_secs_f64(self.bytes as f64 / self.rate as f64);
        if due > Instant::now() {
            tokio::time::sleep_until(due).await;
        }
    }
}

impl Forwarder {
    async fn run(
        mut self,
        mut lines: mpsc::Receiver<Vec<Pending>>,
        mut events: mpsc::Receiver<EventChunk>,
        mut exited: oneshot::Receiver<()>,
    ) {
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut pipes_open = true;
        let mut events_open = true;
        loop {
            tokio::select! {
                chunk = lines.recv(), if pipes_open => match chunk {
                    Some(chunk) => self.lines(chunk).await,
                    None => pipes_open = false,
                },
                chunk = events.recv(), if events_open => match chunk {
                    Some(chunk) => self.events(&chunk),
                    None => events_open = false,
                },
                _ = tick.tick() => {
                    self.note_time_jump();
                    self.poll(false);
                }
                _ = &mut exited => break,
            }
        }
        // 执行器已退出：等管道关闭（后台子进程可能还持有它们，最多等一会儿）。
        let deadline = Instant::now() + DRAIN_TIMEOUT;
        while pipes_open || events_open {
            tokio::select! {
                chunk = lines.recv(), if pipes_open => match chunk {
                    Some(chunk) => self.lines(chunk).await,
                    None => pipes_open = false,
                },
                chunk = events.recv(), if events_open => match chunk {
                    Some(chunk) => self.events(&chunk),
                    None => events_open = false,
                },
                () = tokio::time::sleep_until(deadline) => break,
            }
        }
        self.poll(true);
    }

    fn flush_full_batch(&mut self) {
        if self.pending.len() >= MAX_BATCH_LINES {
            self.flush_lines();
        }
    }

    /// 处理标准输出 / 标准错误的一块行。
    async fn lines(&mut self, chunk: Vec<Pending>) {
        for line in chunk {
            self.throttle.pace(line.text.len()).await;
            self.pending.push(line);
            self.flush_full_batch();
        }
    }

    /// 处理事件管道里的一块完整内容。
    fn events(&mut self, chunk: &EventChunk) {
        for line in chunk
            .bytes
            .split(|&b| b == b'\n')
            .filter(|l| !l.is_empty())
        {
            self.event(line, chunk.stamp);
            self.flush_full_batch();
        }
    }

    /// 处理事件管道里的一行；`stamp` 是读到它所在的那一块时打的点，三种事件都能取到。
    fn event(&mut self, line: &[u8], stamp: Stamp) {
        match serde_json::from_slice::<Event>(line) {
            Ok(Event::Log { ts, level, message }) => self.pending.push(Pending {
                time_unix_ms: sdk_time_ms(ts),
                monotonic_ms: stamp.monotonic_ms,
                source: LogSource::Sdk,
                level: sdk_level(&level),
                text: message,
            }),
            Ok(Event::Progress {
                ts,
                current,
                total,
                message,
            }) => {
                self.progress = Some(Progress {
                    task_id: self.task_id.clone(),
                    attempt: self.attempt,
                    current,
                    total,
                    message,
                    time_unix_ms: sdk_time_ms(ts),
                    monotonic_ms: stamp.monotonic_ms,
                });
            }
            Ok(Event::Metric {
                ts,
                name,
                kind,
                value,
                labels,
            }) => self
                .metrics
                .add(sdk_time_ms(ts), name, labels, &kind, value),
            // 不认识的内容原样记成一行 SDK 日志。
            Err(_) => self.pending.push(Pending {
                time_unix_ms: now_ms(),
                monotonic_ms: stamp.monotonic_ms,
                source: LogSource::Sdk,
                level: LogLevel::Info,
                text: String::from_utf8_lossy(line).into_owned(),
            }),
        }
    }

    /// Agent 时间跳变了（[`time_jump`]）就往日志里写一行提示：排在已经读到的行之后，沿用任务的日志序号。
    /// 只在检查点调用，不在逐行处理的路径上。
    fn note_time_jump(&mut self) {
        let Some(jump) = self.time_jumps.check() else {
            return;
        };
        self.flush_lines();
        self.pending.push(Pending {
            time_unix_ms: jump.after_ms,
            monotonic_ms: Stamp::now().monotonic_ms,
            source: LogSource::Agent,
            level: LogLevel::Warn,
            text: jump.notice(),
        });
    }

    /// 发出这一批日志；进度、指标到时间（或 `last`）时发出。
    fn poll(&mut self, last: bool) {
        self.flush_lines();
        let due = self
            .progress_sent_at
            .is_none_or(|at| at.elapsed() >= PROGRESS_INTERVAL);
        if (due || last)
            && let Some(progress) = self.progress.take()
        {
            self.progress_sent_at = Some(Instant::now());
            self.send(agent_message::Body::Progress(progress));
        }
        // 平时一秒的宽限期一结束（下一个检查点，最多晚 TICK）就发出这一秒，每秒最多一批；任务结束时发出全部。
        let points = if last {
            self.metrics.take(None)
        } else {
            self.metrics.take_due(now_ms())
        };
        if !points.is_empty() {
            self.telemetry.send_metrics(MetricBatch {
                task_id: self.task_id.clone(),
                attempt: self.attempt,
                points,
                dropped_points: 0,
            });
        }
    }

    fn flush_lines(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let mut pending = std::mem::take(&mut self.pending);
        // 按读到的先后（单调时钟）排，不按 Agent 时间：Agent 时间往回跳时，跳变之后的行不会排到之前的行前面。
        pending.sort_by_key(|p| p.monotonic_ms);
        let lines = pending
            .into_iter()
            .map(|p| {
                self.seq += 1;
                LogLine {
                    seq: self.seq,
                    time_unix_ms: p.time_unix_ms,
                    monotonic_ms: p.monotonic_ms,
                    source: p.source.into(),
                    level: p.level.into(),
                    text: p.text,
                }
            })
            .collect();
        self.send(agent_message::Body::Logs(LogBatch {
            task_id: self.task_id.clone(),
            attempt: self.attempt,
            lines,
        }));
    }

    fn send(&self, body: agent_message::Body) {
        self.telemetry.send(AgentMessage { body: Some(body) });
    }
}
