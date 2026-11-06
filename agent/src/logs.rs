//! 任务日志与进度的转发（docs/ARCHITECTURE.md §5.3）。
//!
//! 执行器的标准输出、标准错误（包括继承了它们的子进程）和 SDK 写入的事件文件 `events.jsonl`
//! 合并成同一条日志流：每行分配任务内递增的序号，批量（约每 100 毫秒一批）以 `LogBatch` 发往控制面。
//!
//! - 标准输出 → 来源 stdout、级别 info；标准错误 → 来源 stderr、级别 error；
//! - 事件文件里的 `{"type":"log"}` → 来源 sdk、级别取 SDK 记录的级别；
//! - `{"type":"progress"}` 只保留最新值，每个任务每秒最多发一次 `Progress`，任务结束前补发最后一次；
//! - `{"type":"metric"}` 按「指标 × 秒」合并（[`crate::metrics`]），每个任务每秒最多发一批 `MetricBatch`，
//!   任务结束前发完。
//!
//! 同一批内按时间排序后再编号，所以不同来源的行大致按发生顺序排列；同一来源内保持写入顺序。
//! 标准输出 / 标准错误的原始内容同时写到工作目录的 `stdout.log` / `stderr.log`（失败消息取标准错误尾部）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use prost::Message as _;

use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::metrics::{Merger, MetricQueue};
use crate::proto::{
    AgentMessage, AssignTask, LogBatch, LogLevel, LogLine, LogSource, MetricBatch, Progress,
    agent_message,
};

/// 读取事件文件、发送一批日志的间隔。
const TICK: Duration = Duration::from_millis(100);
/// 同一任务两次进度上报的最小间隔。
const PROGRESS_INTERVAL: Duration = Duration::from_secs(1);
/// 同一任务两批指标的最小间隔。
const METRIC_INTERVAL: Duration = Duration::from_secs(1);
/// 一秒结束后再等这么多秒才发出它的点：在一秒最后时刻记录、下一秒才读到的事件仍并入那一秒，
/// 不会变成控制面按重复丢弃的同一秒第二个点。
const METRIC_GRACE_SECONDS: i64 = 1;
/// 一行的最大字节数；更长的行被拆成多行。
const MAX_LINE_BYTES: usize = 64 * 1024;
/// 一批最多的行数。
const MAX_BATCH_LINES: usize = 1000;
/// 执行器退出后，等待仍持有标准输出的后台子进程关闭管道的最长时间。
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
        if let Ok(mut queue) = self.metrics.lock() {
            queue.push(batch);
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

/// 一个任务的日志转发；执行器退出后调用 [`Pump::finish`] 发完剩余的日志和最后一次进度。
pub struct Pump {
    exited: oneshot::Sender<()>,
    handle: JoinHandle<()>,
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
    /// 开始转发：读取管道和事件文件（事件文件可以还不存在）。
    pub fn start(
        task: &AssignTask,
        stdout: impl AsyncRead + Unpin + Send + 'static,
        stderr: impl AsyncRead + Unpin + Send + 'static,
        dir: PathBuf,
        telemetry: Telemetry,
    ) -> Pump {
        let (lines_tx, lines_rx) = mpsc::unbounded_channel();
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
            events: EventsFile::new(dir.join("events.jsonl")),
            progress: None,
            progress_sent_at: None,
            metrics: Merger::default(),
            metrics_sent_at: None,
        };
        let handle = tokio::spawn(forwarder.run(lines_rx, exited_rx));
        Pump {
            exited,
            handle,
            stderr_tail,
        }
    }

    /// 执行器已退出：读完管道（最多等 [`DRAIN_TIMEOUT`]）和事件文件，发出剩余日志和最后一次进度。
    /// 返回标准错误最后的 [`STDERR_TAIL_BYTES`] 字节。
    pub async fn finish(self) -> Vec<u8> {
        let _ = self.exited.send(());
        let _ = self.handle.await;
        self.stderr_tail.get()
    }
}

/// 尚未编号的一行。
struct Pending {
    time_unix_ms: i64,
    source: LogSource,
    level: LogLevel,
    text: String,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// 逐行读取一个管道，原始内容同时写到 `copy`（写失败时忽略），并在 `tail` 里保留最后一段。
async fn read_pipe(
    mut pipe: impl AsyncRead + Unpin,
    copy: PathBuf,
    source: LogSource,
    level: LogLevel,
    lines: mpsc::UnboundedSender<Pending>,
    tail: Option<Arc<Tail>>,
) {
    let mut file = match tokio::fs::File::create(&copy).await {
        Ok(file) => Some(file),
        Err(error) => {
            eprintln!("cannot create {}: {error}", copy.display());
            None
        }
    };
    let mut splitter = LineSplitter::default();
    let mut buf = vec![0u8; 16 * 1024];
    let emit = |text: String| {
        let _ = lines.send(Pending {
            time_unix_ms: now_ms(),
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
        if let Some(tail) = &tail {
            tail.push(&buf[..n]);
        }
        if let Some(file) = file.as_mut() {
            let _ = file.write_all(&buf[..n]).await;
        }
        splitter.push(&buf[..n], emit);
    }
    splitter.finish(emit);
    if let Some(mut file) = file {
        let _ = file.flush().await;
    }
}

/// 按换行拆分字节流；去掉行尾的 `\r`，过长的行拆开。
#[derive(Default)]
struct LineSplitter {
    partial: Vec<u8>,
}

impl LineSplitter {
    fn push(&mut self, mut bytes: &[u8], mut emit: impl FnMut(String)) {
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

    fn finish(mut self, mut emit: impl FnMut(String)) {
        if !self.partial.is_empty() {
            self.emit_partial(&mut emit);
        }
    }
}

/// 事件文件中的一行（sfly.context）。
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
    },
}

/// 持续读取事件文件新增的完整行。
struct EventsFile {
    path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
}

impl EventsFile {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            offset: 0,
            partial: Vec::new(),
        }
    }

    /// 读出新增的完整行（最后不完整的一行留到下次）。
    async fn read_new(&mut self) -> Vec<Vec<u8>> {
        let Ok(mut file) = tokio::fs::File::open(&self.path).await else {
            return Vec::new();
        };
        if file
            .seek(std::io::SeekFrom::Start(self.offset))
            .await
            .is_err()
        {
            return Vec::new();
        }
        let mut bytes = Vec::new();
        if file.read_to_end(&mut bytes).await.is_err() {
            return Vec::new();
        }
        self.offset += bytes.len() as u64;
        self.partial.extend_from_slice(&bytes);
        let Some(last) = self.partial.iter().rposition(|&b| b == b'\n') else {
            return Vec::new();
        };
        let rest = self.partial.split_off(last + 1);
        let complete = std::mem::replace(&mut self.partial, rest);
        complete
            .split(|&b| b == b'\n')
            .filter(|line| !line.is_empty())
            .map(<[u8]>::to_vec)
            .collect()
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
    events: EventsFile,
    /// 还没上报的最新进度。
    progress: Option<Progress>,
    progress_sent_at: Option<Instant>,
    /// 还没发出的指标点。
    metrics: Merger,
    metrics_sent_at: Option<Instant>,
}

impl Forwarder {
    async fn run(
        mut self,
        mut lines: mpsc::UnboundedReceiver<Pending>,
        mut exited: oneshot::Receiver<()>,
    ) {
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut pipes_open = true;
        loop {
            tokio::select! {
                line = lines.recv(), if pipes_open => match line {
                    Some(line) => {
                        self.pending.push(line);
                        if self.pending.len() >= MAX_BATCH_LINES {
                            self.flush_lines();
                        }
                    }
                    None => pipes_open = false,
                },
                _ = tick.tick() => self.poll(false).await,
                _ = &mut exited => break,
            }
        }
        // 执行器已退出：等管道关闭（后台子进程可能还持有它们，最多等一会儿）。
        let deadline = Instant::now() + DRAIN_TIMEOUT;
        while pipes_open {
            match tokio::time::timeout_at(deadline, lines.recv()).await {
                Ok(Some(line)) => self.pending.push(line),
                Ok(None) | Err(_) => pipes_open = false,
            }
        }
        self.poll(true).await;
    }

    /// 读事件文件，发出这一批日志；进度到时间（或 `last`）时发出。
    async fn poll(&mut self, last: bool) {
        for line in self.events.read_new().await {
            match serde_json::from_slice::<Event>(&line) {
                Ok(Event::Log { ts, level, message }) => self.pending.push(Pending {
                    time_unix_ms: ts.unwrap_or_else(now_ms),
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
                        time_unix_ms: ts.unwrap_or_else(now_ms),
                    });
                }
                Ok(Event::Metric {
                    ts,
                    name,
                    kind,
                    value,
                }) => self
                    .metrics
                    .add(ts.unwrap_or_else(now_ms), name, &kind, value),
                // 不认识的内容原样记成一行 SDK 日志。
                Err(_) => self.pending.push(Pending {
                    time_unix_ms: now_ms(),
                    source: LogSource::Sdk,
                    level: LogLevel::Info,
                    text: String::from_utf8_lossy(&line).into_owned(),
                }),
            }
        }
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
        let due = self
            .metrics_sent_at
            .is_none_or(|at| at.elapsed() >= METRIC_INTERVAL);
        if due || last {
            // 平时只发结束了至少 METRIC_GRACE_SECONDS 秒的秒（之后还可能读到那一秒的值），任务结束时发出全部。
            let points = self
                .metrics
                .take((!last).then(|| now_ms().div_euclid(1000) - METRIC_GRACE_SECONDS));
            if !points.is_empty() {
                self.metrics_sent_at = Some(Instant::now());
                self.telemetry.send_metrics(MetricBatch {
                    task_id: self.task_id.clone(),
                    attempt: self.attempt,
                    points,
                    dropped_points: 0,
                });
            }
        }
    }

    fn flush_lines(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let mut pending = std::mem::take(&mut self.pending);
        pending.sort_by_key(|p| p.time_unix_ms);
        let lines = pending
            .into_iter()
            .map(|p| {
                self.seq += 1;
                LogLine {
                    seq: self.seq,
                    time_unix_ms: p.time_unix_ms,
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
