//! 任务日志与进度的转发（docs/ARCHITECTURE.md §5.4）。
//!
//! 执行器的标准输出、标准错误（包括继承了它们的子进程）和 SDK 写入的事件管道 `events.fifo`（[`EventsPipe`]，ADR 0015）
//! 合并成同一条日志流：每行分配任务内递增的序号，批量（约每 100 毫秒一批，一批最多 [`MAX_BATCH_LINES`] 行、[`MAX_BATCH_BYTES`] 字节）
//! 以 `LogBatch` 发往控制面。
//!
//! - 标准输出 → 来源 stdout、级别 info；标准错误 → 来源 stderr、级别 error；
//! - 事件管道里的 `{"type":"log"}` → 来源 sdk、级别取 SDK 记录的级别；
//! - 任务执行中途 Agent 时间跳变（[`crate::time_jump`]）→ Agent 自己写一行提示，来源 agent、级别 warn；
//! - `{"type":"progress"}` 只保留最新值，每个任务每秒最多发一次 `Progress`，任务结束前补发最后一次；
//! - `{"type":"metric"}` 按「序列（指标名 + 标签）× 单调时钟秒」合并（[`crate::metrics`]），每个任务每秒最多发一批 `MetricBatch`，
//!   任务结束前发完；
//! - `{"type":"notify"}`（`ctx.notify`，ADR 0020）先发出已经读到的日志，再把这一行原文放进 `Notification` 转给控制面，
//!   Agent 不解析消息内容；
//! - `{"type":"action_summary"}`（`ctx.action`、`ctx.mark` 的摘要，规格 #345，格式见 sdk/python/src/sfly/context.py）：
//!   和进度一样只保留最新一份，每个任务每秒最多发一次 `ActionSummary`（这一行原文，Agent 不解析内容），
//!   任务结束前补发最后一份；断线期间每个任务只排队最新的一份（[`Telemetry::send_action_summary`]）。
//!   事件管道的一行不限长度（[`read_events`] 读到换行为止），摘要再长也整行转发；
//! - `{"type":"action_start"}`、`{"type":"action_end"}`、`{"type":"mark"}`（动作和标记的明细，规格 #345）：解析成
//!   `ActionEvent`，和日志一样约每 100 毫秒一批（一批最多 [`MAX_BATCH_ACTIONS`] 个、[`MAX_BATCH_BYTES`] 字节）以 `ActionBatch` 转发，
//!   任务结束前发完；
//!   同一批内按事件管道里的先后排列，不按单调时钟重排（补发的 `action_start` 时间早，但紧挨着它的 `action_end`），
//!   `fields` 保持 SDK 写的先后（[`Fields`]）；缺必需字段、`result` 不认识的行和别的不认识的内容一样记成一行 SDK 日志。
//!   断线期间排队的批次和日志一样有字节数上限（[`Telemetry::send`]）。
//!
//! 每行和每次进度带两个时间（ADR 0018）：Agent 时间（SDK 事件取 SDK 记录的时间，其余取读到的时刻），以及读到它时的
//! 单调时钟读数（每次读取读一次时钟），控制面据此折算出控制面时间；动作明细的单调时钟读数优先取 SDK 写的 `mono`
//! （[`detail`]）。
//! 同一批内按单调时钟读数排序后再编号，所以不同来源的行大致按读到的先后排列，Agent 时间跳变也不打乱顺序；
//! 同一来源内保持写入顺序。
//! 标准输出 / 标准错误的原始内容同时写到工作目录的 `stdout.log` / `stderr.log`，每个文件 8 MiB，超过后改名为 `.1`
//! 再新建（[`LogCopy`]）；失败消息里的标准错误尾部取自内存（[`Pump::finish`]）。
//!
//! 读出、还没转发的内容有上限（[`LINE_CHUNKS`]、[`EVENT_CHUNKS`]）：转发跟不上时暂停读取，管道写满后节点的写入等待，
//! 不丢日志，Agent 内存不随节点的输出量增长（#75）。

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use prost::Message as _;

use serde::Deserialize;
use serde::de::{Deserializer, MapAccess, Visitor};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::clock;
use crate::metrics::{Labels, Merger, MetricQueue};
use crate::proto::{
    self, ActionBatch, ActionEvent, ActionField, ActionResult, ActionSummary, AgentMessage,
    AssignTask, LogBatch, LogLevel, LogLine, LogSource, MetricBatch, Notification, Progress,
    action_event, agent_message,
};
use crate::time_jump;

/// 发送一批日志、检查进度与指标的间隔。
const TICK: Duration = Duration::from_millis(100);
/// 同一任务两次进度上报（动作摘要也一样）的最小间隔。
const LATEST_INTERVAL: Duration = Duration::from_secs(1);
/// 读出、还没处理的事件管道内容最多排这么多块（每块不超过一次读取的 64 KiB 加上跨块的不完整行）。
const EVENT_CHUNKS: usize = 16;
/// 读出、还没处理的标准输出 / 标准错误最多排这么多块（每块是一次读取拆出的行，不超过 16 KiB 加上跨块的不完整行）。
const LINE_CHUNKS: usize = 16;
/// 标准输出 / 标准错误一行的最大字节数；更长的行被拆成多行。事件管道的一行不受它限制。
const MAX_LINE_BYTES: usize = 64 * 1024;
/// 一行被拆开时，每一段带的上下文（前一段的结尾、后一段的开头，只用来打码，见 `LogLine.before` / `after`）最多这么多字节。
/// 每种写法的长度都不超过它的 secret 值，跨在拆分处也认得出。
pub const SPLIT_CONTEXT_BYTES: usize = 16 * 1024;
/// 一批最多的行数。
const MAX_BATCH_LINES: usize = 1000;
/// 一批最多的动作明细事件数。
const MAX_BATCH_ACTIONS: usize = 1000;
/// 一批日志（或一批动作明细）攒到这么多字节就发出，不等条数、也不等下一个 [`TICK`]。只按条数限批的话，每个事件都在上限以内，
/// 一批也能比 Agent 自己的排队上限（[`DEFAULT_TELEMETRY_QUEUE_BYTES`]）还大，连接正常、队列是空的时候也被整批丢掉
/// （[`Telemetry::send`]）。这个数是队列上限的 1/32：一批的大小最多是它加上最后一条（标准输出 / 标准错误的一行不超过
/// [`MAX_LINE_BYTES`] 加两段上下文，输出不是合法的 UTF-8 时有损转换最坏是 3 倍，约 300 KiB；动作明细一条最多约 128 KiB，
/// 全是 4 字节的字符时约 172 KiB），远在队列上限以内，队列是空的时候没有一批因为大小被丢掉，
/// 断线时队列里也能排下几十批；也让控制面一次处理的一批、网关一次收的一条消息有个上界（几 MiB），不随节点写得多快而变大。
/// 再小的话批太碎（一个节点每秒写几百 MiB 时每秒上百批），再大就接近队列上限。
///
/// 例外：SDK 通过事件管道写的日志（一行不限长，也不拆，原来就是这样，#674）一条就可以比这个数大；
/// 那样的一条自己成一批，比队列上限还大时仍会被丢掉。
const MAX_BATCH_BYTES: usize = 2 * 1024 * 1024;
/// 一行日志编码之后除了文字之外大约占的字节数（序号、两个时间、来源、级别和各字段的标签）：估算一批的大小用。
const LOG_LINE_OVERHEAD: usize = 64;
/// 执行器退出后，等待仍持有标准输出（或事件管道）的后台子进程关闭管道的最长时间。
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// 日志、通知和动作明细排队的字节数的默认上限：连接断开时它们排着等重连，连接正常时是发出之前的缓冲，同一个上限。
pub const DEFAULT_TELEMETRY_QUEUE_BYTES: usize = 64 * 1024 * 1024;

/// 发往控制面的任务消息（`TaskStarted` / `LogBatch` / `Progress` / `MetricBatch` / `Notification` / `ActionSummary` /
/// `ActionBatch`）。连接断开期间在通道里排队，重连后按顺序发送。
///
/// - 日志、通知（`Notification`）和动作明细（`ActionBatch`）：排队的字节数合计有上限，超出时丢弃新的日志批次
///   （控制面按序号看到缺口）、新的动作明细批次和通知，其他消息照常排队；
/// - 指标：批次本身放在有界的 [`MetricQueue`] 里（超出时丢弃最早的点），通道里只放一个占位，
///   轮到它时取出最早的指标批次——指标仍按发出顺序排在同一任务的结果之前；
/// - 动作摘要：每个任务最多排着一份（[`Telemetry::send_action_summary`]），通道里放一个占位，轮到它时取出这个任务
///   最新的一份。一份摘要可以有几百 KiB，断线久了也不会越积越多。
#[derive(Clone)]
pub struct Telemetry {
    tx: mpsc::UnboundedSender<Queued>,
    queued: Arc<AtomicUsize>,
    dropping: Arc<AtomicBool>,
    limit: usize,
    metrics: Arc<Mutex<MetricQueue>>,
    summaries: Summaries,
}

/// 还没发出的动作摘要：任务 ID → 最新的一份。
type Summaries = Arc<Mutex<HashMap<String, ActionSummary>>>;

enum Queued {
    Message(usize, Box<AgentMessage>),
    /// 从 [`MetricQueue`] 取一批。
    Metrics,
    /// 取这个任务最新的一份动作摘要。
    ActionSummary(String),
}

/// [`Telemetry`] 的接收端（Agent 主循环在连接上逐条发出）。
pub struct TelemetryReceiver {
    rx: mpsc::UnboundedReceiver<Queued>,
    queued: Arc<AtomicUsize>,
    metrics: Arc<Mutex<MetricQueue>>,
    summaries: Summaries,
}

/// 新建一条任务消息通道；`limit` 是最多排队的日志字节数，`metric_limit` 是最多排队的指标点数。
pub fn telemetry(limit: usize, metric_limit: usize) -> (Telemetry, TelemetryReceiver) {
    let (tx, rx) = mpsc::unbounded_channel();
    let queued = Arc::new(AtomicUsize::new(0));
    let metrics = Arc::new(Mutex::new(MetricQueue::new(metric_limit)));
    let summaries = Summaries::default();
    (
        Telemetry {
            tx,
            queued: queued.clone(),
            dropping: Arc::new(AtomicBool::new(false)),
            limit,
            metrics: metrics.clone(),
            summaries: summaries.clone(),
        },
        TelemetryReceiver {
            rx,
            queued,
            metrics,
            summaries,
        },
    )
}

impl Telemetry {
    pub fn send(&self, message: AgentMessage) {
        let size = message.encoded_len();
        let limited = matches!(
            message.body,
            Some(
                agent_message::Body::Logs(_)
                    | agent_message::Body::Notification(_)
                    | agent_message::Body::Actions(_)
            )
        );
        if limited && self.queued.load(Ordering::SeqCst) + size > self.limit {
            if !self.dropping.swap(true, Ordering::SeqCst) {
                // 不说「断线」：连接正常时也会走到这里（转发比发送快、或者一条消息比剩下的空间大），说的是队列满了。
                eprintln!(
                    "telemetry queue is full ({} of {} bytes queued, next message {} bytes): dropping new log lines, action details and notifications until it has room",
                    self.queued.load(Ordering::SeqCst),
                    self.limit,
                    size
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

    /// 排队一份动作摘要。这个任务已经有一份在排队（还没发出）时换成这一份，不再多排：
    /// 先排的那个占位取走的就是最新的一份，所以它仍排在同一任务的结果之前（断线期间结束的任务除外：
    /// 重连后先重发没被 Ack 的结果，排队的消息随后发出）。
    pub fn send_action_summary(&self, summary: ActionSummary) {
        let task_id = summary.task_id.clone();
        let Ok(mut pending) = self.summaries.lock() else {
            return;
        };
        if pending.insert(task_id.clone(), summary).is_none() {
            let _ = self.tx.send(Queued::ActionSummary(task_id));
        }
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
                Queued::ActionSummary(task_id) => {
                    let summary = self
                        .summaries
                        .lock()
                        .ok()
                        .and_then(|mut pending| pending.remove(&task_id));
                    if let Some(summary) = summary {
                        return Some(AgentMessage {
                            body: Some(agent_message::Body::ActionSummary(summary)),
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
    /// 转发器每秒最多处理这么多字节的标准输出 / 标准错误 / 事件管道内容（0 = 不限制），模拟转发跟不上节点的输出。
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
            pending_bytes: 0,
            progress: Latest::default(),
            action_summary: Latest::default(),
            actions: Vec::new(),
            actions_bytes: 0,
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
    /// 上下文（`LogLine.before` / `after`）：只有被拆开的超长行的每一段才有，其余是空串。
    before: String,
    after: String,
    /// Agent 时间。
    time_unix_ms: i64,
    /// 读到这一行（所在的那一块）时的单调时钟读数；控制面按它折算出控制面时间（ADR 0018）。
    monotonic_ms: i64,
    source: LogSource,
    level: LogLevel,
    text: String,
}

impl Pending {
    /// 编码成 `LogLine` 之后大约的字节数（文字、两段上下文加固定的开销）。
    fn size(&self) -> usize {
        self.text.len() + self.before.len() + self.after.len() + LOG_LINE_OVERHEAD
    }
}

/// 事件管道里读出的一块完整内容（若干行事件）。
struct EventChunk {
    bytes: Vec<u8>,
    /// 读到这一块时的单调时钟读数：这一块里的每个事件（日志、进度、指标）都用它，不逐行读时钟。
    /// 事件的 Agent 时间是 SDK 记的（[`sdk_time_ms`]），这里不读。
    monotonic_ms: i64,
}

/// SDK 事件的 Agent 时间：事件带时间戳时用它（SDK 读的是系统时钟，经 [`clock::to_agent_time_ms`] 换算），
/// 没带时取现在。
fn sdk_time_ms(ts: Option<i64>) -> i64 {
    ts.map_or_else(clock::agent_time_ms, clock::to_agent_time_ms)
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
    let emit = |chunk: &mut Vec<Pending>, at: clock::Reading, line: Line| {
        chunk.push(Pending {
            before: line.before,
            after: line.after,
            time_unix_ms: at.agent_time_ms,
            monotonic_ms: at.monotonic_ms,
            source,
            level,
            text: line.text,
        });
    };
    loop {
        let n = match pipe.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let at = clock::Reading::now();
        if let Some(tail) = &tail {
            tail.push(&buf[..n]);
        }
        copy.write(&buf[..n]).await;
        splitter.push(&buf[..n], |line| emit(&mut chunk, at, line));
        if !chunk.is_empty() {
            let _ = lines.send(std::mem::take(&mut chunk)).await;
        }
    }
    let at = clock::Reading::now();
    splitter.finish(|line| emit(&mut chunk, at, line));
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

/// [`LineSplitter`] 切出的一行（或超长行的一段）。
pub struct Line {
    /// 这一行（这一段）的文字，不含换行符。原始字节不超过 [`MAX_LINE_BYTES`]；不是合法的 UTF-8 时有损转换（每个坏字节换成
    /// 3 字节的替换字符），转换之后的字节数可以到 [`MAX_LINE_BYTES`] 的 3 倍，上下文（[`Line::before`]、[`Line::after`]）也一样。
    pub text: String,
    /// 超长行被拆开时：同一行里前一段结尾的最多 [`SPLIT_CONTEXT_BYTES`] 字节（第一段和没有拆开的行是空串）。
    pub before: String,
    /// 超长行被拆开时：同一行里后一段开头的最多 [`SPLIT_CONTEXT_BYTES`] 字节（最后一段和没有拆开的行是空串）。
    pub after: String,
}

/// 按换行拆分字节流；去掉行尾的 `\r`，过长（超过 [`MAX_LINE_BYTES`] 字节）的行拆开。公开只是为了基准测试（benches/telemetry.rs）。
///
/// 拆开的位置落在字符（UTF-8）边界上，每一段多带两小段只用来打码的上下文（[`Line::before`]、[`Line::after`]），所以一个 secret 值
/// 正好跨在拆分处时（每种写法的长度不超过 [`SPLIT_CONTEXT_BYTES`]），控制面看任何一段都认得出它。为了带上后一段的开头，一段要等到这一行又读到 [`SPLIT_CONTEXT_BYTES`]
/// 字节（或这一行结束）才交出去；拆在哪里只取决于这一行的内容，和每次读到多少字节无关。
#[derive(Default)]
pub struct LineSplitter {
    /// 当前这一行还没有交出去的字节（包括向后看的那一段）。
    partial: Vec<u8>,
    /// 当前这一行前一段结尾的最多 [`SPLIT_CONTEXT_BYTES`] 字节（落在字符边界上）；这一行还没有拆开时为空。
    before: Vec<u8>,
}

/// `bytes[pos]` 是不是 UTF-8 的后续字节（不是一个字符的开头）。
fn is_continuation(byte: u8) -> bool {
    byte & 0xC0 == 0x80
}

/// 不大于 `pos` 的最近的字符边界（`pos` 超出 `bytes` 时是末尾）；最多往回退 3 字节（一个字符最多 4 字节），
/// 连续的后续字节不是合法的 UTF-8 时不再退（有损转换时每个坏字节各自换成替换字符），免得退到头。
fn boundary_at_or_before(bytes: &[u8], pos: usize) -> usize {
    if pos >= bytes.len() {
        return bytes.len();
    }
    let mut pos = pos;
    for _ in 0..3 {
        if pos > 0 && is_continuation(bytes[pos]) {
            pos -= 1;
        }
    }
    pos
}

/// 不小于 `pos` 的最近的字符边界；最多往前进 3 字节。
fn boundary_at_or_after(bytes: &[u8], pos: usize) -> usize {
    let mut pos = pos;
    for _ in 0..3 {
        if pos < bytes.len() && is_continuation(bytes[pos]) {
            pos += 1;
        }
    }
    pos
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

impl LineSplitter {
    /// 追加一段字节，每切出一个完整的行（或过长被拆开的一段）调用一次 `emit`。
    pub fn push(&mut self, mut bytes: &[u8], mut emit: impl FnMut(Line)) {
        while !bytes.is_empty() {
            match bytes.iter().position(|&b| b == b'\n') {
                Some(i) => {
                    self.partial.extend_from_slice(&bytes[..i]);
                    bytes = &bytes[i + 1..];
                    self.end_line(&mut emit);
                }
                None => {
                    self.partial.extend_from_slice(bytes);
                    bytes = &[];
                    // 这一行已经比一段加上后面的上下文还长：前面的一段可以交出去了。要**比**它长，不能等于：正好等于时，
                    // 向后看的那一段的终点是读到的末尾，下一个字节还没有到（可能是半个字符的后续字节，或者行尾的 `\r`），
                    // 这时落在字符边界上的判断和整行一次给时不一样，拆在哪里就和每次读到多少字节有关了。
                    while self.partial.len() > MAX_LINE_BYTES + SPLIT_CONTEXT_BYTES {
                        self.emit_piece(&mut emit);
                    }
                }
            }
        }
    }

    /// 交出当前这一行的第一段（`partial` 比一段长）：文字不超过 [`MAX_LINE_BYTES`] 字节、落在字符边界上，
    /// 带上前一段的结尾和后面的开头。
    fn emit_piece(&mut self, emit: &mut impl FnMut(Line)) {
        let cut = boundary_at_or_before(&self.partial, MAX_LINE_BYTES);
        let after_end = boundary_at_or_before(&self.partial, cut + SPLIT_CONTEXT_BYTES);
        emit(Line {
            text: lossy(&self.partial[..cut]),
            before: lossy(&self.before),
            after: lossy(&self.partial[cut..after_end]),
        });
        let tail_start = boundary_at_or_after(
            &self.partial[..cut],
            cut.saturating_sub(SPLIT_CONTEXT_BYTES),
        );
        self.before = self.partial[tail_start..cut].to_vec();
        self.partial.drain(..cut);
    }

    /// 一行结束（读到换行，或流结束）：去掉行尾的 `\r`，把剩下的交出去；还比一段长就先一段一段拆。
    fn end_line(&mut self, emit: &mut impl FnMut(Line)) {
        if self.partial.last() == Some(&b'\r') {
            self.partial.pop();
        }
        while self.partial.len() > MAX_LINE_BYTES {
            self.emit_piece(emit);
        }
        emit(Line {
            text: lossy(&self.partial),
            before: lossy(&self.before),
            after: String::new(),
        });
        self.partial.clear();
        self.before.clear();
    }

    /// 流结束：剩下没有换行结尾的内容作为最后一行。
    pub fn finish(mut self, mut emit: impl FnMut(Line)) {
        if !self.partial.is_empty() {
            self.end_line(&mut emit);
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
    /// 内容由 SDK 和控制面约定，原文转发。
    Notify {},
    /// 动作摘要：内容由 SDK 和控制面约定，原文转发。
    #[serde(rename = "action_summary")]
    ActionSummary {},
    /// 一个动作开始。
    #[serde(rename = "action_start")]
    ActionStart {
        #[serde(default)]
        ts: Option<i64>,
        #[serde(default)]
        mono: Option<i64>,
        id: u64,
        #[serde(default)]
        parent: Option<u64>,
        depth: u32,
        name: String,
        #[serde(default)]
        fields: Fields,
        /// 补发的（超过每种名称的上限、因为失败才补上明细）。
        #[serde(default)]
        late: bool,
    },
    /// 一个动作结束。
    #[serde(rename = "action_end")]
    ActionEnd {
        #[serde(default)]
        ts: Option<i64>,
        #[serde(default)]
        mono: Option<i64>,
        id: u64,
        result: EndResult,
        #[serde(default)]
        reason: Option<String>,
        /// `note()` 补充的字段。
        #[serde(default)]
        fields: Fields,
    },
    /// 一个标记。
    Mark {
        #[serde(default)]
        ts: Option<i64>,
        #[serde(default)]
        mono: Option<i64>,
        id: u64,
        #[serde(default)]
        parent: Option<u64>,
        depth: u32,
        name: String,
        #[serde(default)]
        fields: Fields,
    },
}

/// `action_end` 的 `result`。
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum EndResult {
    Success,
    Failed,
    Unfinished,
}

impl From<EndResult> for ActionResult {
    fn from(result: EndResult) -> Self {
        match result {
            EndResult::Success => ActionResult::Success,
            EndResult::Failed => ActionResult::Failed,
            EndResult::Unfinished => ActionResult::Unfinished,
        }
    }
}

/// 事件里的 `fields` 对象（键 → 字符串值），保持键在 JSON 里出现的先后：proto 用 `repeated ActionField` 就是为了保序。
/// 不用 [`Labels`]：它按键排序。
#[derive(Default)]
struct Fields(Vec<ActionField>);

impl<'de> Deserialize<'de> for Fields {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FieldsVisitor;

        impl<'de> Visitor<'de> for FieldsVisitor {
            type Value = Fields;

            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an object with string values")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Fields, A::Error> {
                let mut fields = Vec::with_capacity(map.size_hint().unwrap_or(0));
                while let Some((key, value)) = map.next_entry()? {
                    fields.push(ActionField { key, value });
                }
                Ok(Fields(fields))
            }
        }

        deserializer.deserialize_map(FieldsVisitor)
    }
}

/// 一个动作明细事件。Agent 时间取 SDK 写的 `ts`；单调时钟读数优先取 SDK 写的 `mono`（大于 0），
/// 没有时取读到这一块时的读数 `read_at`（和日志一样）。
fn detail(
    ts: Option<i64>,
    mono: Option<i64>,
    read_at: i64,
    kind: action_event::Kind,
) -> ActionEvent {
    ActionEvent {
        time_unix_ms: sdk_time_ms(ts),
        monotonic_ms: mono.filter(|&mono| mono > 0).unwrap_or(read_at),
        kind: Some(kind),
    }
}

/// 读取事件管道，把以换行结尾的完整内容按块交给 `chunks`，直到所有写端关闭（最后不完整的一行丢弃）。
/// 每块带上读到它的那一刻的单调时钟读数：SDK 不改，事件的单调时钟读数由 Agent 在这里打上。
/// 通道有界：处理跟不上时不再读管道，写满后 SDK 的写入等待（背压），Agent 内存里不会越积越多。
async fn read_events(mut pipe: impl AsyncRead + Unpin, chunks: mpsc::Sender<EventChunk>) {
    let mut partial = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match pipe.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let monotonic_ms = clock::monotonic_ms();
        partial.extend_from_slice(&buf[..n]);
        let Some(last) = partial.iter().rposition(|&b| b == b'\n') else {
            continue;
        };
        let rest = partial.split_off(last + 1);
        let bytes = std::mem::replace(&mut partial, rest);
        if chunks
            .send(EventChunk {
                bytes,
                monotonic_ms,
            })
            .await
            .is_err()
        {
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
    /// `pending` 编码之后大约的字节数（[`Pending::size`] 之和），到 [`MAX_BATCH_BYTES`] 就发出。
    pending_bytes: usize,
    progress: Latest<Progress>,
    /// 动作摘要那一行的原文。
    action_summary: Latest<String>,
    /// 还没发出的动作明细，按事件管道里的先后。
    actions: Vec<ActionEvent>,
    /// `actions` 编码之后的字节数，到 [`MAX_BATCH_BYTES`] 就发出。
    actions_bytes: usize,
    /// 还没发出的指标点。
    metrics: Merger,
    throttle: Throttle,
    /// Agent 时间跳变的检测。
    time_jumps: time_jump::Watch,
}

/// 只保留最新值、每秒最多发一次的上报（进度、动作摘要）。
struct Latest<T> {
    /// 还没发出的最新值。
    value: Option<T>,
    sent_at: Option<Instant>,
}

impl<T> Default for Latest<T> {
    fn default() -> Self {
        Latest {
            value: None,
            sent_at: None,
        }
    }
}

impl<T> Latest<T> {
    fn set(&mut self, value: T) {
        self.value = Some(value);
    }

    /// 距上一次发出满 [`LATEST_INTERVAL`]（或 `last`：任务结束）时取出最新值。
    fn take_due(&mut self, last: bool) -> Option<T> {
        let due = last
            || self
                .sent_at
                .is_none_or(|at| at.elapsed() >= LATEST_INTERVAL);
        let value = if due { self.value.take() } else { None };
        if value.is_some() {
            self.sent_at = Some(Instant::now());
        }
        value
    }
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
                    Some(chunk) => self.events(&chunk).await,
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
                    Some(chunk) => self.events(&chunk).await,
                    None => events_open = false,
                },
                () = tokio::time::sleep_until(deadline) => break,
            }
        }
        self.poll(true);
    }

    fn push_pending(&mut self, line: Pending) {
        self.pending_bytes += line.size();
        self.pending.push(line);
    }

    fn push_action(&mut self, event: ActionEvent) {
        self.actions_bytes += event.encoded_len();
        self.actions.push(event);
    }

    /// 一批攒满了（条数或字节数）就发出，不等下一个 [`TICK`]。
    fn flush_full_batch(&mut self) {
        if self.pending.len() >= MAX_BATCH_LINES || self.pending_bytes >= MAX_BATCH_BYTES {
            self.flush_lines();
        }
        if self.actions.len() >= MAX_BATCH_ACTIONS || self.actions_bytes >= MAX_BATCH_BYTES {
            self.flush_actions();
        }
    }

    /// 处理标准输出 / 标准错误的一块行。
    async fn lines(&mut self, chunk: Vec<Pending>) {
        for line in chunk {
            self.throttle
                .pace(line.text.len() + line.before.len() + line.after.len())
                .await;
            self.push_pending(line);
            self.flush_full_batch();
        }
    }

    /// 处理事件管道里的一块完整内容。
    async fn events(&mut self, chunk: &EventChunk) {
        self.throttle.pace(chunk.bytes.len()).await;
        for line in chunk.bytes.split(|&b| b == b'\n').filter(|l| !l.is_empty()) {
            self.event(line, chunk.monotonic_ms);
            self.flush_full_batch();
        }
    }

    /// 处理事件管道里的一行；`monotonic_ms` 是读到它所在的那一块时的单调时钟读数，日志、进度和指标都用它。
    fn event(&mut self, line: &[u8], monotonic_ms: i64) {
        match serde_json::from_slice::<Event>(line) {
            Ok(Event::Log { ts, level, message }) => self.push_pending(Pending {
                before: String::new(),
                after: String::new(),
                time_unix_ms: sdk_time_ms(ts),
                monotonic_ms,
                source: LogSource::Sdk,
                level: sdk_level(&level),
                text: message,
            }),
            Ok(Event::Progress {
                ts,
                current,
                total,
                message,
            }) => self.progress.set(Progress {
                task_id: self.task_id.clone(),
                attempt: self.attempt,
                current,
                total,
                message,
                time_unix_ms: sdk_time_ms(ts),
                monotonic_ms,
            }),
            Ok(Event::Metric {
                ts,
                name,
                kind,
                value,
                labels,
            }) => self
                .metrics
                .add(monotonic_ms, sdk_time_ms(ts), name, labels, &kind, value),
            // 通知排在节点在它之前写的日志后面。
            Ok(Event::Notify {}) => {
                self.flush_lines();
                self.send(agent_message::Body::Notification(Notification {
                    task_id: self.task_id.clone(),
                    attempt: self.attempt,
                    event_json: String::from_utf8_lossy(line).into_owned(),
                }));
            }
            Ok(Event::ActionSummary {}) => self
                .action_summary
                .set(String::from_utf8_lossy(line).into_owned()),
            Ok(Event::ActionStart {
                ts,
                mono,
                id,
                parent,
                depth,
                name,
                fields,
                late,
            }) => self.push_action(detail(
                ts,
                mono,
                monotonic_ms,
                action_event::Kind::Start(proto::ActionStart {
                    id,
                    parent,
                    depth,
                    name,
                    fields: fields.0,
                    late,
                }),
            )),
            Ok(Event::ActionEnd {
                ts,
                mono,
                id,
                result,
                reason,
                fields,
            }) => self.push_action(detail(
                ts,
                mono,
                monotonic_ms,
                action_event::Kind::End(proto::ActionEnd {
                    id,
                    result: ActionResult::from(result).into(),
                    reason,
                    fields: fields.0,
                }),
            )),
            Ok(Event::Mark {
                ts,
                mono,
                id,
                parent,
                depth,
                name,
                fields,
            }) => self.push_action(detail(
                ts,
                mono,
                monotonic_ms,
                action_event::Kind::Mark(proto::ActionMark {
                    id,
                    parent,
                    depth,
                    name,
                    fields: fields.0,
                }),
            )),
            // 不认识的内容原样记成一行 SDK 日志。
            Err(_) => self.push_pending(Pending {
                before: String::new(),
                after: String::new(),
                time_unix_ms: clock::agent_time_ms(),
                monotonic_ms,
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
        self.push_pending(Pending {
            before: String::new(),
            after: String::new(),
            time_unix_ms: jump.after_ms,
            monotonic_ms: clock::monotonic_ms(),
            source: LogSource::Agent,
            level: LogLevel::Warn,
            text: jump.notice(),
        });
    }

    /// 发出这一批日志和动作明细；进度、动作摘要、指标到时间（或 `last`）时发出。
    fn poll(&mut self, last: bool) {
        self.flush_lines();
        self.flush_actions();
        if let Some(progress) = self.progress.take_due(last) {
            self.send(agent_message::Body::Progress(progress));
        }
        if let Some(event_json) = self.action_summary.take_due(last) {
            self.telemetry.send_action_summary(ActionSummary {
                task_id: self.task_id.clone(),
                attempt: self.attempt,
                event_json,
            });
        }
        // 平时一秒（按单调时钟）的宽限期一结束（下一个检查点，最多晚 TICK）就发出这一秒，每秒最多一批；任务结束时发出全部。
        let points = if last {
            self.metrics.take(None)
        } else {
            self.metrics.take_due(clock::monotonic_ms())
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
        self.pending_bytes = 0;
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
                    before: p.before,
                    after: p.after,
                }
            })
            .collect();
        self.send(agent_message::Body::Logs(LogBatch {
            task_id: self.task_id.clone(),
            attempt: self.attempt,
            lines,
        }));
    }

    fn flush_actions(&mut self) {
        if self.actions.is_empty() {
            return;
        }
        let events = std::mem::take(&mut self.actions);
        self.actions_bytes = 0;
        self.send(agent_message::Body::Actions(ActionBatch {
            task_id: self.task_id.clone(),
            attempt: self.attempt,
            events,
        }));
    }

    fn send(&self, body: agent_message::Body) {
        self.telemetry.send(AgentMessage { body: Some(body) });
    }
}

#[cfg(test)]
#[path = "local_protocol_tests.rs"]
mod local_protocol_tests;

/// 超长行的拆分（[`LineSplitter`]）：拆开的位置、每一段带的上下文。
#[cfg(test)]
mod splitter_tests {
    use super::*;

    fn split_with(input: &[u8], chunk: usize) -> Vec<(String, String, String)> {
        let mut lines = Vec::new();
        let mut splitter = LineSplitter::default();
        for piece in input.chunks(chunk) {
            splitter.push(piece, |line| {
                lines.push((line.text, line.before, line.after))
            });
        }
        splitter.finish(|line| lines.push((line.text, line.before, line.after)));
        lines
    }

    fn split(input: &[u8]) -> Vec<(String, String, String)> {
        split_with(input, input.len().max(1))
    }

    /// 一行被拆成几段之后的不变量：每段不超过一段的最大字节数；文字接起来就是原来的行；前后的上下文和相邻的段对得上；
    /// 两端都落在字符边界上（原来的行是合法的 UTF-8 时，每一段、每个上下文也是，没有替换字符）。
    fn check_pieces(original: &str, pieces: &[(String, String, String)]) {
        assert!(pieces.len() >= 2, "没有拆开");
        let joined: String = pieces.iter().map(|(t, _, _)| t.as_str()).collect();
        assert_eq!(joined, original);
        let mut seen = String::new();
        for (i, (text, before, after)) in pieces.iter().enumerate() {
            assert!(
                text.len() <= MAX_LINE_BYTES,
                "第 {i} 段 {} 字节",
                text.len()
            );
            assert!(
                !text.contains('\u{FFFD}')
                    && !before.contains('\u{FFFD}')
                    && !after.contains('\u{FFFD}')
            );
            assert!(before.len() <= SPLIT_CONTEXT_BYTES && after.len() <= SPLIT_CONTEXT_BYTES);
            // before：前面所有段接起来的结尾，最多 SPLIT_CONTEXT_BYTES 字节，从字符边界开始
            let mut start = seen.len().saturating_sub(SPLIT_CONTEXT_BYTES);
            while !seen.is_char_boundary(start) {
                start += 1;
            }
            assert_eq!(before, &seen[start..], "第 {i} 段的 before");
            seen.push_str(text);
            // after：后面所有段接起来的开头，最多 SPLIT_CONTEXT_BYTES 字节，到字符边界结束
            let rest = &original[seen.len()..];
            let mut end = rest.len().min(SPLIT_CONTEXT_BYTES);
            while !rest.is_char_boundary(end) {
                end -= 1;
            }
            assert_eq!(after, &rest[..end], "第 {i} 段的 after");
        }
        assert_eq!(pieces[0].1, "");
        assert_eq!(pieces[pieces.len() - 1].2, "");
    }

    #[test]
    fn short_lines_carry_no_context_and_empty_lines_are_lines() {
        let lines = split(b"a\nbb\r\n\nlast");
        let texts: Vec<_> = lines.iter().map(|(t, _, _)| t.as_str()).collect();
        assert_eq!(texts, ["a", "bb", "", "last"]);
        assert!(lines.iter().all(|(_, b, a)| b.is_empty() && a.is_empty()));
    }

    #[test]
    fn a_line_of_exactly_the_maximum_is_one_piece_and_one_byte_more_is_two() {
        let exact = "x".repeat(MAX_LINE_BYTES);
        assert_eq!(
            split(format!("{exact}\n").as_bytes()),
            [(exact.clone(), String::new(), String::new())]
        );
        let over = format!("{exact}y");
        let pieces = split(format!("{over}\n").as_bytes());
        check_pieces(&over, &pieces);
        assert_eq!(pieces.len(), 2);
        assert_eq!(pieces[1].0, "y");
        assert_eq!(pieces[0].2, "y");
    }

    #[test]
    fn long_ascii_lines_split_with_context_that_matches_the_neighbours() {
        for len in [
            MAX_LINE_BYTES + 1,
            MAX_LINE_BYTES + SPLIT_CONTEXT_BYTES - 1,
            MAX_LINE_BYTES + SPLIT_CONTEXT_BYTES,
            MAX_LINE_BYTES + SPLIT_CONTEXT_BYTES + 1,
            2 * MAX_LINE_BYTES,
            2 * MAX_LINE_BYTES + 5,
            5 * MAX_LINE_BYTES + 12345,
        ] {
            let original: String = (0..len)
                .map(|i| char::from(b'a' + (i % 26) as u8))
                .collect();
            check_pieces(&original, &split(format!("{original}\n").as_bytes()));
        }
    }

    #[test]
    fn nothing_carries_over_from_one_line_to_the_next() {
        // 两条超长行挨着：第二条的第一段没有 before（不带上一条的结尾），第一条的最后一段没有 after
        let first: String = (0..2 * MAX_LINE_BYTES)
            .map(|i| char::from(b'a' + (i % 26) as u8))
            .collect();
        let second: String = (0..2 * MAX_LINE_BYTES)
            .map(|i| char::from(b'A' + (i % 26) as u8))
            .collect();
        let input = format!("{first}\n{second}\nshort\n");
        let lines = split(input.as_bytes());
        let split_at = lines
            .iter()
            .position(|(t, _, _)| t.starts_with('A'))
            .unwrap();
        check_pieces(&first, &lines[..split_at]);
        check_pieces(&second, &lines[split_at..lines.len() - 1]);
        assert_eq!(
            lines.last().unwrap(),
            &("short".to_string(), String::new(), String::new())
        );
    }

    #[test]
    fn where_a_line_is_split_does_not_depend_on_how_much_is_read_at_a_time() {
        let original: String = (0..3 * MAX_LINE_BYTES + 777)
            .map(|i| char::from(b'a' + (i % 26) as u8))
            .collect();
        let input = format!("short\n{original}\ntail\r\n{original}");
        let whole = split(input.as_bytes());
        for chunk in [
            1,
            7,
            4096,
            16 * 1024,
            MAX_LINE_BYTES,
            MAX_LINE_BYTES + SPLIT_CONTEXT_BYTES,
        ] {
            assert_eq!(
                split_with(input.as_bytes(), chunk),
                whole,
                "每次读 {chunk} 字节"
            );
        }
    }

    /// 分块读取：每次读到的字节数不影响拆在哪里、上下文是什么，也不影响上下文的两端：多字节的字符、行尾的 `\r` 正好落在
    /// 一段加上下文的结尾时，和整行一次给的结果相同，没有半个字符（替换字符），也没有 `\r`。
    #[test]
    fn chunked_reading_gives_the_same_pieces_for_multi_byte_characters_and_a_trailing_carriage_return()
     {
        let cjk: String = std::iter::once('z')
            .chain(std::iter::repeat_n('中', 60_000))
            .collect();
        let emoji: String = std::iter::repeat_n('😀', 50_000).collect();
        // 行尾的 `\r\n` 正好在一段加上下文的最后一个字节上
        let carriage = "q".repeat(MAX_LINE_BYTES + SPLIT_CONTEXT_BYTES - 1);
        let ascii = "x".repeat(3 * MAX_LINE_BYTES + 5);
        for (name, line, ending) in [
            ("cjk", &cjk, "\n"),
            ("emoji", &emoji, "\n"),
            ("carriage return", &carriage, "\r\n"),
            ("ascii", &ascii, "\n"),
        ] {
            let input = format!("{line}{ending}");
            let whole = split(input.as_bytes());
            for piece in &whole {
                assert!(
                    ![&piece.0, &piece.1, &piece.2]
                        .iter()
                        .any(|t| t.contains('\u{FFFD}') || t.contains('\r')),
                    "{name}: 一次给整行时就有半个字符或 \\r"
                );
            }
            for chunk in [
                1,
                7,
                4096,
                16 * 1024,
                MAX_LINE_BYTES,
                MAX_LINE_BYTES + SPLIT_CONTEXT_BYTES,
            ] {
                assert_eq!(
                    split_with(input.as_bytes(), chunk),
                    whole,
                    "{name}：每次读 {chunk} 字节"
                );
            }
        }
    }

    #[test]
    fn multi_byte_characters_are_never_cut_in_the_middle() {
        // 3 字节的字符，65536 不是 3 的倍数；4 字节的字符；混着 1、2、3、4 字节的
        let sets: [&[char]; 3] = [&['中'], &['😀'], &['a', 'é', '中', '😀']];
        for chars in sets {
            let original: String = (0..(2 * MAX_LINE_BYTES) / 2)
                .map(|i| chars[i % chars.len()])
                .collect();
            for offset in 0..5 {
                let line = format!("{}{original}", "z".repeat(offset));
                check_pieces(&line, &split(format!("{line}\n").as_bytes()));
            }
        }
    }

    #[test]
    fn carriage_return_at_the_end_of_a_long_line_is_dropped_and_not_part_of_the_context() {
        let original = "q".repeat(MAX_LINE_BYTES + 100);
        let pieces = split(format!("{original}\r\n").as_bytes());
        check_pieces(&original, &pieces);
        let last = pieces.last().unwrap();
        assert!(!last.0.ends_with('\r') && !last.1.contains('\r'));
    }

    #[test]
    fn a_long_line_without_a_final_newline_is_still_split_at_the_end_of_the_stream() {
        let original = "w".repeat(MAX_LINE_BYTES * 2 + 3);
        check_pieces(&original, &split(original.as_bytes()));
    }

    #[test]
    fn invalid_utf8_does_not_loop_and_every_piece_is_within_the_maximum() {
        // 连续的后续字节（不是合法的 UTF-8）：不能因为往回找字符边界而退到头
        let bytes = vec![0x80u8; 3 * MAX_LINE_BYTES];
        let pieces = split(&bytes);
        assert!(pieces.len() >= 3);
        assert!(
            pieces
                .iter()
                .all(|(t, _, _)| t.chars().count() <= MAX_LINE_BYTES)
        );
        // 有损转换：每个坏字节一个替换字符，总数不变
        let total: usize = pieces.iter().map(|(t, _, _)| t.chars().count()).sum();
        assert_eq!(total, bytes.len());
    }

    /// 旧版本的控制面不认识 before / after：它们是 protobuf 的新字段，旧的消息定义解码时忽略，其余的字段照旧。
    #[test]
    fn a_log_line_with_context_decodes_with_the_old_message_definition() {
        #[derive(Clone, PartialEq, prost::Message)]
        struct OldLogLine {
            #[prost(uint64, tag = "1")]
            seq: u64,
            #[prost(int64, tag = "2")]
            time_unix_ms: i64,
            #[prost(int32, tag = "3")]
            source: i32,
            #[prost(int32, tag = "4")]
            level: i32,
            #[prost(string, tag = "5")]
            text: String,
            #[prost(int64, tag = "6")]
            monotonic_ms: i64,
        }
        let line = LogLine {
            seq: 7,
            time_unix_ms: 1_000,
            monotonic_ms: 2_000,
            source: LogSource::Stdout.into(),
            level: LogLevel::Info.into(),
            text: "text".into(),
            before: "before".into(),
            after: "after".into(),
        };
        let old = OldLogLine::decode(line.encode_to_vec().as_slice()).unwrap();
        assert_eq!(
            (
                old.seq,
                old.time_unix_ms,
                old.monotonic_ms,
                old.text.as_str()
            ),
            (7, 1_000, 2_000, "text")
        );
        // 反过来：旧版本 Agent 发的行（没有这两个字段）解码成空串
        let from_old = LogLine::decode(old.encode_to_vec().as_slice()).unwrap();
        assert_eq!(
            (from_old.before.as_str(), from_old.after.as_str()),
            ("", "")
        );
    }
}

/// 一批日志、一批动作明细按字节数发出（[`MAX_BATCH_BYTES`]）：每个事件、每行都在各自的上限以内时，连接正常、队列是空的情况下
/// 没有一批因为大小被 [`Telemetry::send`] 整批丢掉。
#[cfg(test)]
mod batch_tests {
    use super::*;

    /// 一个 Forwarder，和一个把它发出的消息一条条收走的任务（相当于连接正常，队列不积压）。
    fn forwarder() -> (Forwarder, JoinHandle<Vec<AgentMessage>>) {
        let (telemetry, mut rx) = telemetry(DEFAULT_TELEMETRY_QUEUE_BYTES, 1000);
        let drain = tokio::spawn(async move {
            let mut got = Vec::new();
            while let Some(message) = rx.recv().await {
                got.push(message);
            }
            got
        });
        let forwarder = Forwarder {
            task_id: "task".into(),
            attempt: 1,
            telemetry,
            seq: 0,
            pending: Vec::new(),
            pending_bytes: 0,
            progress: Latest::default(),
            action_summary: Latest::default(),
            actions: Vec::new(),
            actions_bytes: 0,
            metrics: Merger::default(),
            throttle: Throttle::new(0),
            time_jumps: time_jump::Watch::start(),
        };
        (forwarder, drain)
    }

    /// 日志：每行都取最长（一段 [`MAX_LINE_BYTES`] 加上两段上下文）。
    fn full_line(i: usize) -> Pending {
        Pending {
            before: "b".repeat(SPLIT_CONTEXT_BYTES),
            after: "c".repeat(SPLIT_CONTEXT_BYTES),
            time_unix_ms: 1_790_000_000_000,
            monotonic_ms: i as i64,
            source: LogSource::Stdout,
            level: LogLevel::Info,
            text: "a".repeat(MAX_LINE_BYTES),
        }
    }

    #[tokio::test]
    async fn a_thousand_full_log_lines_are_not_dropped_as_one_batch_that_is_too_big() {
        let (mut forwarder, drain) = forwarder();
        // 1000 行 × (64 KiB + 2 × 16 KiB) 约 98 MB：按条数一批发出的话比队列上限（64 MiB）还大，队列是空的时候也整批被丢掉。
        let lines = 1000;
        for i in 0..lines {
            forwarder.lines(vec![full_line(i)]).await;
            tokio::task::yield_now().await;
        }
        forwarder.poll(true);
        drop(forwarder);
        let messages = drain.await.unwrap();
        let batches: Vec<&LogBatch> = messages
            .iter()
            .filter_map(|m| match &m.body {
                Some(agent_message::Body::Logs(batch)) => Some(batch),
                _ => None,
            })
            .collect();
        let seqs: Vec<u64> = batches
            .iter()
            .flat_map(|b| b.lines.iter().map(|l| l.seq))
            .collect();
        assert_eq!(
            seqs,
            (1..=lines as u64).collect::<Vec<_>>(),
            "每一行都送到了，序号没有缺口"
        );
        // 一批最多是 MAX_BATCH_BYTES 加上最后一行；整体约 98 MB，所以至少几十批
        let one_line = full_line(0).size();
        // 一批攒满 2 MiB 才发：批数不少，也不多（字节数发出之后要清零重新数，不然每一行都发一批）
        let expected = lines * one_line / MAX_BATCH_BYTES;
        assert!(batches.len() >= expected, "{} 批", batches.len());
        assert!(batches.len() <= expected + 2, "{} 批", batches.len());
        for (i, message) in messages.iter().enumerate() {
            assert!(
                message.encoded_len() <= MAX_BATCH_BYTES + 2 * one_line,
                "第 {i} 批 {} 字节",
                message.encoded_len()
            );
        }
    }

    /// 动作明细：每个事件都取最长（名称、8 个字段，全是 3 字节的字符，约 117 KiB）。
    fn full_action(i: usize) -> Vec<u8> {
        let name = "名".repeat(4160);
        let value = "值".repeat(4352);
        let fields: serde_json::Map<String, serde_json::Value> = (0..8)
            .map(|f| (format!("字段{f}"), serde_json::Value::String(value.clone())))
            .collect();
        let line = serde_json::json!({
            "type": "action_start",
            "id": i,
            "depth": 0,
            "name": name,
            "fields": fields,
        });
        let mut bytes = serde_json::to_vec(&line).unwrap();
        bytes.push(b'\n');
        bytes
    }

    #[tokio::test]
    async fn a_thousand_full_action_events_are_not_dropped_as_one_batch_that_is_too_big() {
        let (mut forwarder, drain) = forwarder();
        let events = 1000;
        for i in 0..events {
            let chunk = EventChunk {
                bytes: full_action(i),
                monotonic_ms: i as i64,
            };
            forwarder.events(&chunk).await;
            tokio::task::yield_now().await;
        }
        forwarder.poll(true);
        drop(forwarder);
        let messages = drain.await.unwrap();
        let batches: Vec<&ActionBatch> = messages
            .iter()
            .filter_map(|m| match &m.body {
                Some(agent_message::Body::Actions(batch)) => Some(batch),
                _ => None,
            })
            .collect();
        let received: usize = batches.iter().map(|b| b.events.len()).sum();
        assert_eq!(received, events, "每个事件都送到了");
        let one = full_action(0).len();
        let expected = events * one / MAX_BATCH_BYTES;
        assert!(batches.len() >= expected, "{} 批", batches.len());
        assert!(batches.len() <= expected + 2, "{} 批", batches.len());
        for message in &messages {
            assert!(message.encoded_len() <= MAX_BATCH_BYTES + 2 * one);
        }
    }

    #[tokio::test]
    async fn small_lines_still_go_out_in_batches_of_a_thousand_lines() {
        let (mut forwarder, drain) = forwarder();
        for i in 0..2500 {
            let mut line = full_line(i);
            line.text = "x".into();
            line.before.clear();
            line.after.clear();
            forwarder.lines(vec![line]).await;
        }
        forwarder.poll(true);
        drop(forwarder);
        let sizes: Vec<usize> = drain
            .await
            .unwrap()
            .iter()
            .filter_map(|m| match &m.body {
                Some(agent_message::Body::Logs(batch)) => Some(batch.lines.len()),
                _ => None,
            })
            .collect();
        assert_eq!(sizes, vec![1000, 1000, 500]);
    }
}
