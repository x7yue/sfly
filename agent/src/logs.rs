//! 任务日志与进度的转发（docs/ARCHITECTURE.md §5.4）。
//!
//! 执行器的标准输出、标准错误（包括继承了它们的子进程）和 SDK 写入的事件管道 `events.fifo`（[`EventsPipe`]，ADR 0015）
//! 合并成同一条日志流：每行分配任务内递增的序号，批量（约每 100 毫秒一批，一批最多 [`MAX_BATCH_LINES`] 行、[`MAX_BATCH_BYTES`] 字节）
//! 以 `LogBatch` 发往控制面。
//!
//! - 标准输出 → 来源 stdout、级别 info；标准错误 → 来源 stderr、级别 error；
//! - 事件管道里的 `{"type":"log"}` → 来源 sdk、级别取 SDK 记录的级别；消息超过 [`MAX_LINE_BYTES`] 字节时和标准输出的超长行一样
//!   拆成几条、每条带上下文（[`LineSplitter::split_whole`]）；一行超过 [`MAX_EVENT_LINE_BYTES`] 字节整行丢弃，
//!   Agent 写一行警告（来源 agent、级别 warn）说明丢了多少字节、丢的是哪一种事件（[`EventKind`]）、后果是什么；
//! - 任务执行中途 Agent 时间跳变（[`crate::time_jump`]）→ Agent 自己写一行提示，来源 agent、级别 warn；
//! - `{"type":"progress"}` 只保留最新值，每个任务每秒最多发一次 `Progress`，任务结束前补发最后一次；
//! - `{"type":"metric"}` 按「序列（指标名 + 标签）× 单调时钟秒」合并（[`crate::metrics`]），每个任务每秒最多发一批 `MetricBatch`，
//!   任务结束前发完；
//! - `{"type":"notify"}`（`ctx.notify`，ADR 0020）先发出已经读到的日志，再把这一行原文放进 `Notification` 转给控制面，
//!   Agent 不解析消息内容；
//! - `{"type":"action_summary"}`（`ctx.action`、`ctx.mark` 的摘要，规格 #345，格式见 sdk/python/src/sfly/context.py）：
//!   和进度一样只保留最新一份，每个任务每秒最多发一次 `ActionSummary`（这一行原文，Agent 不解析内容），
//!   任务结束前补发最后一份；断线期间每个任务只排队最新的一份（[`Telemetry::send_action_summary`]）。
//!   摘要不超过 [`MAX_EVENT_LINE_BYTES`] 时整行转发，超过时整份丢弃，控制面上的摘要停在之前的一份（[`read_events`]）；
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

use std::collections::{BTreeMap, HashMap};
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
/// 读出、还没处理的事件管道内容最多排这么多块（每块不超过一次读取的 64 KiB 加上跨块的不完整行，一行不超过 [`MAX_EVENT_LINE_BYTES`]）。
const EVENT_CHUNKS: usize = 16;
/// 读出、还没处理的标准输出 / 标准错误最多排这么多块（每块是一次读取拆出的行，不超过 16 KiB 加上跨块的不完整行）。
const LINE_CHUNKS: usize = 16;
/// 标准输出 / 标准错误一行的最大字节数；更长的行被拆成多行。事件管道里的日志（SDK 日志的消息、不认识的内容）也一样，
/// 一条超过它就拆成几条（[`LineSplitter::split_whole`]）。
const MAX_LINE_BYTES: usize = 64 * 1024;
/// 事件管道一行的最大字节数（含 JSON 的引号和转义）；更长的一行整行丢弃，Agent 写一行警告日志说明丢了多少字节、丢的是哪一种事件
/// （[`read_events`]、[`Forwarder::dropped_line`]）。
/// 不丢的话，一行没有换行的内容会让 `read_events` 的缓冲区一直涨，Agent 的内存跟着节点写的量走；一行日志整条发给控制面，
/// 也会超过网关一条消息的上限（80 MiB，#674）。
///
/// 这个数够不够用要看动作摘要（SDK 能写出的最长的一行）：摘要里每种动作名称一项，名称的种类没有上限的时候（#726 之前的 SDK），
/// 名称每种都在文档上限以内（64 个字符）、种类够多（约 2.5 万种，审查实测）就超过 4 MiB，这时整份摘要被丢弃，
/// 控制面上的摘要停在之前的一份，警告里写明丢的是动作摘要；名称的种类有上限、摘要有字节上界之后
/// （#726：名称最多 1000 种，一份摘要序列化之后不超过 1 MiB），新的 SDK 写的摘要碰不到这个上限，4 MiB 够用。
/// 旧的 SDK、不经 SDK 写事件的节点写出的摘要（列满的三个列表、名称取到传输余量、全是 3 字节的字符时约 16 MiB）超过它，那样的一行被丢弃。
/// 读取这边攒着的一行因此不超过它，排队的块最多 [`EVENT_CHUNKS`] 块；没有量出事件管道在 Agent 里占的内存的整体上界
/// （没超过上限的行一口气写出一批时，Agent 的峰值内存审查实测涨约 266 MiB：40 行、每行 4 MiB 的不认识的内容，见 docs/ARCHITECTURE.md §5.4）。
const MAX_EVENT_LINE_BYTES: usize = 4 * 1024 * 1024;
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
/// [`MAX_LINE_BYTES`] 加两段上下文，输出不是合法的 UTF-8 时有损转换最坏是 3 倍，约 300 KiB；动作明细一条最多约 224 KiB
/// （SDK 能发出的最长的事件：名称、8 个字段的键和值、失败原因都取到传输上限，3 字节的字符；全是 4 字节的字符时约 298 KiB）），
/// 远在队列上限以内，队列是空的时候没有一批因为大小被丢掉，
/// 断线时队列里也能排下几十批；也让控制面一次处理的一批、网关一次收的一条消息有个上界（几 MiB），不随节点写得多快而变大。
/// 再小的话批太碎（一个节点每秒写几百 MiB 时每秒上百批），再大就接近队列上限。
///
/// 例外：不经 SDK 写事件才会有比这个数大的动作明细（SDK 发不出，事件管道的一行可以到 [`MAX_EVENT_LINE_BYTES`]）：这样的一条
/// **自己成一批**，攒着的先发出去（[`Forwarder::push_action`]），前面正常的事件不受它影响；它自己比队列上限还大时只丢它，
/// 并在标准错误里写明（[`Telemetry::send`]）。日志行不会比一批大：标准输出的超长行、事件管道里的一条日志超过 [`MAX_LINE_BYTES`]
/// 都拆开（[`Forwarder::push_text`]，#674），每拆出一条检查一次要不要发出这一批，一条加上两段上下文约 300 KiB；
/// [`Forwarder::push_pending`] 对日志行有同样的规矩，只是兜底。
const MAX_BATCH_BYTES: usize = 2 * 1024 * 1024;
/// 一行日志编码之后除了文字之外大约占的字节数（序号、两个时间、来源、级别和各字段的标签）：估算一批的大小用。
const LOG_LINE_OVERHEAD: usize = 64;
/// 执行器退出后，等待仍持有标准输出（或事件管道）的后台子进程关闭管道的最长时间。
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// 日志、通知和动作明细排队的字节数的默认上限：连接断开时它们排着等重连，连接正常时是发出之前的缓冲，同一个上限。
pub const DEFAULT_TELEMETRY_QUEUE_BYTES: usize = 64 * 1024 * 1024;

/// 发往控制面的任务消息（`TaskStarted` / `LogBatch` / `Progress` / `MetricBatch` / `Notification` / `ActionSummary` /
/// `ActionBatch`）。连接断开期间在通道里排队，重连后按顺序发送：先重发没被 Ack 的结果，排队的消息随后发出
/// （断线期间结束的任务，控制面先收到结果、再收到它排队的日志和指标）。
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

/// 丢掉一条比整个队列还大的消息时写进标准错误的一行：哪一种、哪个任务、多大。不带消息的内容
/// （日志行、通知、动作明细里可能有 secret 值）。
fn oversize_note(message: &AgentMessage, size: usize, limit: usize) -> String {
    let (kind, task_id) = match &message.body {
        Some(agent_message::Body::Logs(batch)) => ("log lines", batch.task_id.as_str()),
        Some(agent_message::Body::Notification(notification)) => {
            ("notification", notification.task_id.as_str())
        }
        Some(agent_message::Body::Actions(batch)) => ("action details", batch.task_id.as_str()),
        _ => ("message", ""),
    };
    format!(
        "telemetry message ({kind}) of task {task_id} is {size} bytes, larger than the whole queue ({limit} bytes): dropping this one message; the ones before and after it are not affected"
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
        if limited && size > self.limit {
            // 这一条比整个队列还大，什么时候都排不下：只丢它（前后的消息不受影响），每次都写明（哪一种、哪个任务、多大），
            // 不并进下面「队列满了」的说明，也不动 `dropping`：队列没满，下一次真的满了时那条说明照常写一次。
            eprintln!("{}", oversize_note(&message, size, self.limit));
            return;
        }
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
            too_long: BTreeMap::new(),
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
    /// 这一块里读到结尾、被丢弃的行（[`Dropped`]）：位置之前的内容先处理、再写这一行的警告，警告就排在被丢弃的行原来所在的地方。
    /// 管道在一行中间关闭时，这一行也算（位置是 0）。
    dropped: Vec<Dropped>,
}

/// 事件管道里被丢弃的一行：只留下大小和开头的一小段，不留内容。
struct Dropped {
    /// 这一行原来在 [`EventChunk::bytes`] 里的位置。
    at: usize,
    /// 这一行的字节数（不含换行）。
    size: u64,
    /// 为什么丢。
    reason: DropReason,
    /// 这一行开头最多 [`EVENT_HEAD_BYTES`] 个字节（固定大小，不随行的长度变），只用来认出事件的种类（[`EventKind::of_head`]），
    /// 不写进日志。[`DropReason::Unfinished`] 不认种类，不留。
    head: Vec<u8>,
}

/// 事件管道的一行为什么被丢弃。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DropReason {
    /// 超过 [`MAX_EVENT_LINE_BYTES`]（包括还没读到的后半截，一直丢到这一行的换行；管道在这一行中间关闭也算）。
    TooLong,
    /// 管道关闭时最后一行没有写完（没有换行结尾）：和超长的行一样不处理，只是原来不吭声。
    Unfinished,
}

/// 被丢弃的一行开头留下的字节数：认出 `type` 够了（SDK 写的事件 `type` 是第一个字段，最长的 `action_summary` 也只在开头几十个字节里）。
const EVENT_HEAD_BYTES: usize = 256;

/// 事件的种类（事件里的 `type`，[`Event`]）：丢弃一行时用它说明丢的是什么、后果是什么。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum EventKind {
    Log,
    Progress,
    Metric,
    Notify,
    ActionSummary,
    ActionStart,
    ActionEnd,
    Mark,
}

/// 事件里的 `type` 和它对应的种类（[`Event`] 的各个变体）：两端和用例表里的 `event_types` 一致。
const EVENT_KINDS: [(&str, EventKind); 8] = [
    ("log", EventKind::Log),
    ("progress", EventKind::Progress),
    ("metric", EventKind::Metric),
    ("notify", EventKind::Notify),
    ("action_summary", EventKind::ActionSummary),
    ("action_start", EventKind::ActionStart),
    ("action_end", EventKind::ActionEnd),
    ("mark", EventKind::Mark),
];

impl EventKind {
    /// 从一行开头的一小段认出事件的种类：`{"type": "名字"` 开头（`type` 是第一个字段，前后可以有 JSON 允许的空白），
    /// 名字是认识的种类。认不出（不是对象、`type` 不是第一个字段、种类不认识、开头被截断）是 `None`。
    /// 不解析整行：这一行被丢了，也不是一个能解析的完整 JSON。
    fn of_head(head: &[u8]) -> Option<EventKind> {
        fn skip(bytes: &[u8]) -> &[u8] {
            let start = bytes
                .iter()
                .position(|b| !matches!(b, b' ' | b'\t' | b'\n' | b'\r'))
                .unwrap_or(bytes.len());
            &bytes[start..]
        }
        let rest = skip(head).strip_prefix(b"{")?;
        let rest = skip(rest).strip_prefix(b"\"type\"")?;
        let rest = skip(rest).strip_prefix(b":")?;
        let rest = skip(rest).strip_prefix(b"\"")?;
        let end = rest.iter().position(|&b| b == b'"')?;
        let name = &rest[..end];
        EVENT_KINDS
            .iter()
            .find(|(type_name, _)| type_name.as_bytes() == name)
            .map(|&(_, kind)| kind)
    }
}

/// 认出的种类（`None` = 认不出）叫什么：写在警告里，只用固定的名字，不用被丢的内容。
fn kind_name(kind: Option<EventKind>) -> &'static str {
    match kind {
        Some(EventKind::Log) => "日志",
        Some(EventKind::Progress) => "进度",
        Some(EventKind::Metric) => "指标",
        Some(EventKind::Notify) => "通知",
        Some(EventKind::ActionSummary) => "动作摘要",
        Some(EventKind::ActionStart) => "动作开始的明细",
        Some(EventKind::ActionEnd) => "动作结束的明细",
        Some(EventKind::Mark) => "标记",
        None => "认不出种类的内容",
    }
}

/// 超过上限的一行被丢弃时写的警告：只写种类、大小和上限，不写这一行的内容；认得出种类时写这一种丢了以后会怎样。
fn too_long_warning(kind: Option<EventKind>, size: u64) -> String {
    let what = match kind {
        Some(EventKind::Log) => "这条日志没有记下来。日志写得太长，请拆开写",
        Some(EventKind::ActionSummary) => {
            "动作摘要没有更新，停在之前的一份（动作名称的种类太多，摘要太大了）"
        }
        Some(EventKind::Progress) => "进度没有更新，停在之前的一次",
        Some(EventKind::Notify) => "这条通知没有发出",
        Some(EventKind::Metric) => "这个指标点没有记下来",
        Some(EventKind::ActionStart | EventKind::ActionEnd | EventKind::Mark) => {
            "这条动作明细没有记下来"
        }
        None => "这一行开头认不出是哪一种事件，说不清丢掉的是什么",
    };
    format!(
        "事件管道里的一行有 {size} 字节，超过上限 {MAX_EVENT_LINE_BYTES} 字节，已丢弃：这一行是{}，{what}",
        kind_name(kind)
    )
}

/// 管道关闭时最后一行没有写完的警告。
fn unfinished_warning(size: u64) -> String {
    format!("事件管道关闭时最后一行没有写完（没有换行结尾，有 {size} 字节），已丢弃")
}

/// 任务里同一种事件超过上限被丢弃的合计：这一种第一次丢弃时写完整的警告，之后只计数，任务结束时写一行合计。
#[derive(Default)]
struct DropTotal {
    lines: u64,
    largest: u64,
}

fn drop_total_warning(kind: Option<EventKind>, total: &DropTotal) -> String {
    format!(
        "这个任务事件管道里超过上限的{}一共被丢弃了 {} 行，最大的一行有 {} 字节",
        kind_name(kind),
        total.lines,
        total.largest
    )
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
        self.emit_rest(emit);
    }

    /// 把 `partial` 里剩下的交出去；还比一段长就先一段一段拆。
    fn emit_rest(&mut self, emit: &mut impl FnMut(Line)) {
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

    /// 把一段文字当作完整的一行：不按换行再拆、不去掉行尾的 `\r`（事件里的文字，SDK 日志的一条消息可以有多行），
    /// 超过 [`MAX_LINE_BYTES`] 就和标准输出的超长行一样拆开、每段带上下文，每段至多 [`MAX_LINE_BYTES`] 字节，
    /// 拆在字符边界上，拆在哪里只取决于这段文字。
    pub fn split_whole(text: String, mut emit: impl FnMut(Line)) {
        let mut splitter = LineSplitter {
            partial: text.into_bytes(),
            before: Vec::new(),
        };
        splitter.emit_rest(&mut emit);
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

/// 读取事件管道，把以换行结尾的完整内容按块交给 `chunks`，直到所有写端关闭。
/// 每块带上读到它的那一刻的单调时钟读数：SDK 不改，事件的单调时钟读数由 Agent 在这里打上。
/// 通道有界：处理跟不上时不再读管道，写满后 SDK 的写入等待（背压），Agent 内存里不会越积越多。
///
/// 丢弃的行记在读到这一行结尾的那一块的 [`EventChunk::dropped`] 里（大小、开头一小段、原因），不留内容：
/// - 一行超过 [`MAX_EVENT_LINE_BYTES`] 时整行丢弃（包括还没读到的后半截，一直丢到这一行的换行）；
///   不是读到什么就先攒着，攒到换行才发现太长；
/// - 管道关闭时最后一行没有换行结尾（没写完）：丢弃，原因 [`DropReason::Unfinished`]；
///   管道在超长行的中间关闭时，这一行按超长算。
async fn read_events(mut pipe: impl AsyncRead + Unpin, chunks: mpsc::Sender<EventChunk>) {
    let mut partial = Vec::new();
    // 正在丢弃一行：到现在为止的字节数，和这一行开头的一小段。
    let mut discarding: Option<(u64, Vec<u8>)> = None;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match pipe.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let monotonic_ms = clock::monotonic_ms();
        let mut bytes = Vec::new();
        let mut dropped: Vec<Dropped> = Vec::new();
        let mut rest = &buf[..n];
        while !rest.is_empty() {
            let (piece, ended) = match rest.iter().position(|&b| b == b'\n') {
                Some(i) => (&rest[..i], true),
                None => (rest, false),
            };
            rest = &rest[(piece.len() + usize::from(ended)).min(rest.len())..];
            if let Some((size, head)) = discarding.as_mut() {
                *size += piece.len() as u64;
                if ended {
                    dropped.push(Dropped {
                        at: bytes.len(),
                        size: *size,
                        reason: DropReason::TooLong,
                        head: std::mem::take(head),
                    });
                    discarding = None;
                }
                continue;
            }
            partial.extend_from_slice(piece);
            if partial.len() > MAX_EVENT_LINE_BYTES {
                let size = partial.len() as u64;
                let head = partial[..EVENT_HEAD_BYTES].to_vec();
                if ended {
                    dropped.push(Dropped {
                        at: bytes.len(),
                        size,
                        reason: DropReason::TooLong,
                        head,
                    });
                } else {
                    discarding = Some((size, head));
                }
                partial.clear();
            } else if ended {
                bytes.append(&mut partial);
                bytes.push(b'\n');
            }
        }
        if bytes.is_empty() && dropped.is_empty() {
            continue;
        }
        if chunks
            .send(EventChunk {
                bytes,
                monotonic_ms,
                dropped,
            })
            .await
            .is_err()
        {
            return;
        }
    }
    // 管道关闭：还在丢弃的超长行、没有写完的最后一行都要说一声。
    let last = match discarding {
        Some((size, head)) => Some(Dropped {
            at: 0,
            size,
            reason: DropReason::TooLong,
            head,
        }),
        None if !partial.is_empty() => Some(Dropped {
            at: 0,
            size: partial.len() as u64,
            reason: DropReason::Unfinished,
            head: Vec::new(),
        }),
        None => None,
    };
    if let Some(last) = last {
        let _ = chunks
            .send(EventChunk {
                bytes: Vec::new(),
                monotonic_ms: clock::monotonic_ms(),
                dropped: vec![last],
            })
            .await;
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
    /// 事件管道里超过上限被丢弃的行，按种类（`None` = 认不出）合计：每一种只在第一次写警告，任务结束时写合计（[`Forwarder::drop_totals`]）。
    too_long: BTreeMap<Option<EventKind>, DropTotal>,
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
        self.drop_totals();
        self.poll(true);
    }

    /// 排一行日志。比一批的字节上限（[`MAX_BATCH_BYTES`]）还大的一行：先把攒着的发出去，这一行自己成一批，
    /// 不和前面的合成一批（合成一批的话，这一批比队列剩下的空间大时整批被丢掉，前面正常的行也跟着丢）。
    /// 这一行自己的那一批由调用的人接着调的 [`Forwarder::flush_full_batch`] 发出（字节数到了上限就发，这时
    /// 攒着的只有它一行）：这里只管「排进去之前先发」，不再重复发一次。调用的人都是排一个、检查一次（`lines`、`events`）。
    fn push_pending(&mut self, line: Pending) {
        let size = line.size();
        if size > MAX_BATCH_BYTES {
            self.flush_lines();
        }
        self.pending_bytes += size;
        self.pending.push(line);
    }

    /// 排一个动作明细事件，规矩同 [`Forwarder::push_pending`]。
    fn push_action(&mut self, event: ActionEvent) {
        let size = event.encoded_len();
        if size > MAX_BATCH_BYTES {
            self.flush_actions();
        }
        self.actions_bytes += size;
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
        let mut dropped = chunk.dropped.iter().peekable();
        let mut rest = chunk.bytes.as_slice();
        let mut offset = 0;
        loop {
            // 被丢弃的行原来所在的位置：它前面的行都处理完了，这里写它的警告（只写大小，不带内容）。
            while let Some(line) = dropped.next_if(|line| line.at <= offset) {
                self.dropped_line(line, chunk.monotonic_ms);
                self.flush_full_batch();
            }
            if rest.is_empty() {
                break;
            }
            let end = rest.iter().position(|&b| b == b'\n').unwrap_or(rest.len());
            let line = &rest[..end];
            let consumed = (end + 1).min(rest.len());
            rest = &rest[consumed..];
            offset += consumed;
            if !line.is_empty() {
                self.event(line, chunk.monotonic_ms);
                self.flush_full_batch();
            }
        }
    }

    /// 一行被丢弃：写一行 Agent 警告（来源 agent、级别 warn）。超过上限的行认出种类，写这一种丢了以后会怎样；
    /// 同一种在这个任务里第一次丢时写完整的警告，之后只计数，任务结束时写一行合计（[`Forwarder::drop_totals`]）：
    /// 摘要每秒一份，节点跑一小时不会写出几千行同样的警告。
    fn dropped_line(&mut self, line: &Dropped, monotonic_ms: i64) {
        let text = match line.reason {
            DropReason::Unfinished => unfinished_warning(line.size),
            DropReason::TooLong => {
                let kind = EventKind::of_head(&line.head);
                let total = self.too_long.entry(kind).or_default();
                total.lines += 1;
                total.largest = total.largest.max(line.size);
                if total.lines > 1 {
                    return;
                }
                too_long_warning(kind, line.size)
            }
        };
        self.warn(text, monotonic_ms);
    }

    /// 任务结束：这一种事件被丢弃过不止一行的，写一行合计（丢了几行、最大的一行多大）。
    fn drop_totals(&mut self) {
        for (kind, total) in std::mem::take(&mut self.too_long) {
            if total.lines > 1 {
                self.warn(drop_total_warning(kind, &total), clock::monotonic_ms());
            }
        }
    }

    /// Agent 自己写一行警告日志（来源 agent、级别 warn）。
    fn warn(&mut self, text: String, monotonic_ms: i64) {
        self.push_pending(Pending {
            before: String::new(),
            after: String::new(),
            time_unix_ms: clock::agent_time_ms(),
            monotonic_ms,
            source: LogSource::Agent,
            level: LogLevel::Warn,
            text,
        });
    }

    /// 事件里的一段文字记成日志：超过 [`MAX_LINE_BYTES`] 就拆成几条，每条带上下文（和标准输出的超长行一样）；
    /// 每条都检查一次要不要发出这一批，一条很长的日志不会攒成一个很大的批。
    fn push_text(&mut self, text: String, time_unix_ms: i64, monotonic_ms: i64, level: LogLevel) {
        let push = |this: &mut Self, line: Line| {
            this.push_pending(Pending {
                before: line.before,
                after: line.after,
                time_unix_ms,
                monotonic_ms,
                source: LogSource::Sdk,
                level,
                text: line.text,
            });
            this.flush_full_batch();
        };
        if text.len() <= MAX_LINE_BYTES {
            push(
                self,
                Line {
                    text,
                    before: String::new(),
                    after: String::new(),
                },
            );
            return;
        }
        let mut pieces = Vec::new();
        LineSplitter::split_whole(text, |line| pieces.push(line));
        for line in pieces {
            push(self, line);
        }
    }

    /// 处理事件管道里的一行；`monotonic_ms` 是读到它所在的那一块时的单调时钟读数，日志、进度和指标都用它。
    fn event(&mut self, line: &[u8], monotonic_ms: i64) {
        match serde_json::from_slice::<Event>(line) {
            Ok(Event::Log { ts, level, message }) => {
                self.push_text(message, sdk_time_ms(ts), monotonic_ms, sdk_level(&level));
            }
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
            // 不认识的内容原样记成一行 SDK 日志（太长就拆开，同上）。
            Err(_) => self.push_text(
                String::from_utf8_lossy(line).into_owned(),
                clock::agent_time_ms(),
                monotonic_ms,
                LogLevel::Info,
            ),
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
        forwarder_with_queue(DEFAULT_TELEMETRY_QUEUE_BYTES)
    }

    /// 同 [`forwarder`]，遥测队列的上限（字节）自己定。
    fn forwarder_with_queue(queue_bytes: usize) -> (Forwarder, JoinHandle<Vec<AgentMessage>>) {
        let (telemetry, mut rx) = telemetry(queue_bytes, 1000);
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
            too_long: BTreeMap::new(),
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

    // SDK 能发出的最长的文字（`sdk/python/src/sfly/actions.py`：比控制面的上限多 `TRANSPORT_MARGIN_CHARS` = 4096 个字符才截断）：
    // 名称、字段的键 64 + 4096，字段的值 256 + 4096，失败原因 4096 + 4096 个字符，字段最多 8 个。
    const NAME_CHARS: usize = 64 + 4096;
    const VALUE_CHARS: usize = 256 + 4096;
    const REASON_CHARS: usize = 4096 + 4096;
    const FIELDS: usize = 8;

    /// 8 个字段，键互不相同、都取最长，值取最长；`ch` 是组成它们的字符。
    fn longest_fields(ch: char) -> serde_json::Map<String, serde_json::Value> {
        let one = ch.to_string();
        (0..FIELDS)
            .map(|f| {
                (
                    // 开头一个数字让键互不相同，其余取满
                    format!("{f}{}", one.repeat(NAME_CHARS - 1)),
                    serde_json::Value::String(one.repeat(VALUE_CHARS)),
                )
            })
            .collect()
    }

    /// 一个动作事件，取 SDK 能发出的最长的：依次是开始（名称、8 个字段）、结束（失败原因、8 个补充的字段）、标记（名称、8 个字段）。
    fn longest_action_event(i: usize, ch: char) -> Vec<u8> {
        let one = ch.to_string();
        let common = |kind: &str| {
            serde_json::json!({
                "type": kind,
                "ts": 1_790_000_000_000_i64,
                "mono": i,
                "id": i,
                "parent": i,
                "depth": 0,
                "fields": longest_fields(ch),
            })
        };
        let mut line = match i % 3 {
            0 => common("action_start"),
            1 => common("action_end"),
            _ => common("mark"),
        };
        match i % 3 {
            1 => {
                line["result"] = "failed".into();
                line["reason"] = one.repeat(REASON_CHARS).into();
            }
            _ => line["name"] = one.repeat(NAME_CHARS).into(),
        }
        let mut bytes = serde_json::to_vec(&line).unwrap();
        bytes.push(b'\n');
        bytes
    }

    /// `events` 个最长的事件（每个字符 `ch.len_utf8()` 个字节）一个个送进来：每个都送到、顺序不变，一批按字节数发出，
    /// 没有一批大到被 [`Telemetry::send`] 整批丢掉。
    async fn longest_action_events_are_all_sent(ch: char, events: usize) {
        let (mut forwarder, drain) = forwarder();
        for i in 0..events {
            let chunk = EventChunk {
                bytes: longest_action_event(i, ch),
                monotonic_ms: i as i64,
                dropped: Vec::new(),
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
        let ids: Vec<(usize, u64)> = batches
            .iter()
            .flat_map(|b| &b.events)
            .map(|e| match &e.kind {
                Some(action_event::Kind::Start(s)) => (0, s.id),
                Some(action_event::Kind::End(x)) => (1, x.id),
                Some(action_event::Kind::Mark(m)) => (2, m.id),
                None => panic!("事件没有内容"),
            })
            .collect();
        assert_eq!(
            ids,
            (0..events).map(|i| (i % 3, i as u64)).collect::<Vec<_>>(),
            "每个事件都送到了，顺序没变"
        );
        let sizes: Vec<usize> = batches
            .iter()
            .flat_map(|b| &b.events)
            .map(|e| e.encoded_len())
            .collect();
        let total: usize = sizes.iter().sum();
        let longest = *sizes.iter().max().unwrap();
        // 一次性发出的话会比队列上限还大（这个用例才说明得了问题）
        assert!(total > DEFAULT_TELEMETRY_QUEUE_BYTES, "{total} 字节");
        // 每一批攒到 MAX_BATCH_BYTES 才发，最后一个事件可以超出：批数既不会少（按条数发出），
        // 也不会多（发出后字节数没有清零的话，每个事件都发一批）
        let n = batches.len();
        assert!(n * (MAX_BATCH_BYTES + longest) >= total, "{n} 批");
        assert!((n - 1) * MAX_BATCH_BYTES <= total, "{n} 批");
        for (i, message) in messages.iter().enumerate() {
            assert!(
                message.encoded_len() <= MAX_BATCH_BYTES + longest + 1024,
                "第 {i} 批 {} 字节",
                message.encoded_len()
            );
        }
    }

    #[tokio::test]
    async fn the_longest_action_events_of_three_byte_characters_are_not_dropped_as_one_batch_that_is_too_big()
     {
        longest_action_events_are_all_sent('名', 400).await;
    }

    #[tokio::test]
    async fn the_longest_action_events_of_four_byte_characters_are_not_dropped_as_one_batch_that_is_too_big()
     {
        longest_action_events_are_all_sent('\u{20000}', 300).await;
    }

    /// 一个标记事件，名称是 `name_bytes` 个 ASCII 字符（`id` 区分）。
    fn mark_event(id: usize, name_bytes: usize) -> Vec<u8> {
        let line = serde_json::json!({
            "type": "mark",
            "id": id,
            "depth": 0,
            "name": "h".repeat(name_bytes),
        });
        let mut bytes = serde_json::to_vec(&line).unwrap();
        bytes.push(b'\n');
        bytes
    }

    /// 前面 5 个、后面 5 个小事件，中间一个 `huge_bytes` 字节的：每一批里的事件 ID（标记的 ID 就是它是第几个）。
    async fn mark_batches_around_a_huge_event(
        queue_bytes: usize,
        huge_bytes: usize,
    ) -> Vec<Vec<u64>> {
        let (mut forwarder, drain) = forwarder_with_queue(queue_bytes);
        for i in 0..11 {
            let name_bytes = if i == 5 { huge_bytes } else { 10 };
            let chunk = EventChunk {
                bytes: mark_event(i, name_bytes),
                monotonic_ms: i as i64,
                dropped: Vec::new(),
            };
            forwarder.events(&chunk).await;
            tokio::task::yield_now().await;
        }
        forwarder.poll(true);
        drop(forwarder);
        drain
            .await
            .unwrap()
            .iter()
            .filter_map(|m| match &m.body {
                Some(agent_message::Body::Actions(batch)) => Some(
                    batch
                        .events
                        .iter()
                        .map(|e| match &e.kind {
                            Some(action_event::Kind::Mark(mark)) => mark.id,
                            _ => panic!("不是标记"),
                        })
                        .collect(),
                ),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn an_action_event_bigger_than_a_batch_goes_out_alone_after_the_ones_before_it() {
        // 3 MiB 的一个事件：比一批的字节上限大。前面攒着的 5 个先发出去，它自己一批，后面的接着攒。
        let batches =
            mark_batches_around_a_huge_event(DEFAULT_TELEMETRY_QUEUE_BYTES, 3 << 20).await;
        assert_eq!(
            batches,
            vec![vec![0, 1, 2, 3, 4], vec![5], vec![6, 7, 8, 9, 10]]
        );
    }

    #[tokio::test]
    async fn an_action_event_bigger_than_the_whole_queue_is_dropped_alone() {
        // 队列上限 4 MiB，事件 5 MiB：什么时候都排不下，只丢它；前面和后面的事件都送到。
        let batches = mark_batches_around_a_huge_event(4 << 20, 5 << 20).await;
        assert_eq!(batches, vec![vec![0, 1, 2, 3, 4], vec![6, 7, 8, 9, 10]]);
    }

    /// 前面 5 行、后面 5 行，中间一行 `huge_bytes` 字节的：送到的日志行的序号。
    async fn log_seqs_around_a_huge_line(queue_bytes: usize, huge_bytes: usize) -> Vec<Vec<u64>> {
        let (mut forwarder, drain) = forwarder_with_queue(queue_bytes);
        for i in 0..11 {
            let mut line = full_line(i);
            line.text = "x".repeat(if i == 5 { huge_bytes } else { 10 });
            line.before.clear();
            line.after.clear();
            forwarder.lines(vec![line]).await;
            tokio::task::yield_now().await;
        }
        forwarder.poll(true);
        drop(forwarder);
        drain
            .await
            .unwrap()
            .iter()
            .filter_map(|m| match &m.body {
                Some(agent_message::Body::Logs(batch)) => {
                    Some(batch.lines.iter().map(|l| l.seq).collect())
                }
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn a_log_line_bigger_than_a_batch_goes_out_alone_after_the_lines_before_it() {
        let batches = log_seqs_around_a_huge_line(DEFAULT_TELEMETRY_QUEUE_BYTES, 3 << 20).await;
        assert_eq!(
            batches,
            vec![vec![1, 2, 3, 4, 5], vec![6], vec![7, 8, 9, 10, 11]]
        );
    }

    #[tokio::test]
    async fn a_log_line_bigger_than_the_whole_queue_is_dropped_alone_and_leaves_a_gap_in_the_sequence()
     {
        // 第 6 行（序号 6）被丢掉，控制面按序号看到一个缺口；前后的行都送到。
        let batches = log_seqs_around_a_huge_line(4 << 20, 5 << 20).await;
        assert_eq!(batches, vec![vec![1, 2, 3, 4, 5], vec![7, 8, 9, 10, 11]]);
    }

    fn log_batch_message(task_id: &str, lines: usize) -> AgentMessage {
        AgentMessage {
            body: Some(agent_message::Body::Logs(LogBatch {
                task_id: task_id.into(),
                attempt: 1,
                lines: (0..lines)
                    .map(|i| LogLine {
                        seq: i as u64,
                        text: "x".repeat(100),
                        ..Default::default()
                    })
                    .collect(),
            })),
        }
    }

    /// 比整个队列还大的一条只丢它：不动 `dropping`（队列没有满），队列里已有的和后面的消息照常进出。
    /// 去掉 `Telemetry::send` 里专门的那一支，它会落进「队列满了」那一支、把 `dropping` 设成 true，这条用例才红。
    #[tokio::test]
    async fn an_oversize_message_is_dropped_alone_without_marking_the_queue_as_full() {
        let (telemetry, mut rx) = telemetry(10_000, 1000);
        telemetry.send(log_batch_message("t", 3)); // 排得下的，已经在队列里
        let queued = telemetry.queued.load(Ordering::SeqCst);
        assert!(queued > 0);

        telemetry.send(log_batch_message("t", 500)); // 比整个队列（10 000 字节）还大
        assert!(
            !telemetry.dropping.load(Ordering::SeqCst),
            "队列没有满：不能当成「队列满了」，否则下一次真的满了时那条说明被当成已经写过而不写"
        );
        assert_eq!(
            telemetry.queued.load(Ordering::SeqCst),
            queued,
            "队列的用量不变"
        );

        telemetry.send(log_batch_message("t", 2)); // 之后的照常进来
        assert!(telemetry.queued.load(Ordering::SeqCst) > queued);
        drop(telemetry);
        let mut got = 0;
        while rx.recv().await.is_some() {
            got += 1;
        }
        assert_eq!(got, 2, "前后两条都送到，只丢了超大的那一条");
    }

    /// 队列真的满了时，另一支照旧：`dropping` 为 true（说明只写一次），超大的那一支不碰它。
    #[tokio::test]
    async fn a_full_queue_still_marks_it_and_an_oversize_one_does_not_clear_it() {
        let (telemetry, _rx) = telemetry(2_000, 1000);
        telemetry.send(log_batch_message("t", 10)); // 约 1.3 KB
        telemetry.send(log_batch_message("t", 10)); // 装不下：队列满了
        assert!(telemetry.dropping.load(Ordering::SeqCst));
        telemetry.send(log_batch_message("t", 100)); // 比整个队列还大：只丢它，不改状态
        assert!(telemetry.dropping.load(Ordering::SeqCst));
    }

    #[test]
    fn the_oversize_note_names_the_kind_and_the_task_but_not_the_content() {
        let mut logs = log_batch_message("task-7", 1);
        let Some(agent_message::Body::Logs(batch)) = &mut logs.body else {
            unreachable!()
        };
        batch.lines[0].text = "hunter2-the-secret".into();
        let note = oversize_note(&logs, 5_000_000, 4_000_000);
        assert!(note.contains("log lines"), "{note}");
        assert!(note.contains("task-7"), "{note}");
        assert!(
            note.contains("5000000") && note.contains("4000000"),
            "{note}"
        );
        assert!(!note.contains("hunter2"), "不写内容：{note}");

        let notification = AgentMessage {
            body: Some(agent_message::Body::Notification(Notification {
                task_id: "task-8".into(),
                attempt: 1,
                event_json: "{\"message\":\"hunter2\"}".into(),
            })),
        };
        let note = oversize_note(&notification, 10, 5);
        assert!(
            note.contains("notification") && note.contains("task-8"),
            "{note}"
        );
        assert!(!note.contains("hunter2"), "{note}");

        let actions = AgentMessage {
            body: Some(agent_message::Body::Actions(ActionBatch {
                task_id: "task-9".into(),
                attempt: 1,
                events: Vec::new(),
            })),
        };
        let note = oversize_note(&actions, 10, 5);
        assert!(
            note.contains("action details") && note.contains("task-9"),
            "{note}"
        );
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

/// 进度和动作摘要的「只留最新一份、每秒最多一次」（[`Latest`]）。集成测试（tests/logs.rs、tests/action_summary.rs）
/// 量得到间隔和「最后一份先于结果」，量不准「第一份是哪一份」：转发只在 [`TICK`] 上发生，节点写得和它一样快时，第一次
/// 转发之前节点可能已经写了第二份（机器忙时更常见，#706）。第一份不等间隔这一条在这里按状态断言。
#[cfg(test)]
mod latest_tests {
    use super::*;

    #[test]
    fn the_first_value_is_due_at_once_later_ones_wait_for_the_interval_and_the_last_is_always_due()
    {
        let mut latest = Latest::default();
        assert_eq!(latest.take_due(false), None::<u32>, "没有值时什么也不发");
        latest.set(1);
        latest.set(2);
        assert_eq!(
            latest.take_due(false),
            Some(2),
            "第一份不等间隔，发的是最新的一份"
        );
        latest.set(3);
        assert_eq!(latest.take_due(false), None, "距上一次不满间隔：不发");
        latest.set(4);
        assert_eq!(latest.take_due(true), Some(4), "任务结束时不受间隔限制");
        latest.set(5);
        latest.sent_at = Some(Instant::now() - LATEST_INTERVAL);
        assert_eq!(latest.take_due(false), Some(5), "满了间隔：发最新的一份");
        assert_eq!(latest.take_due(true), None, "发过的不再发");
    }
}

/// 事件管道里的一行太长：日志（SDK 日志的消息、不认识的内容）超过 [`MAX_LINE_BYTES`] 拆开，一行超过
/// [`MAX_EVENT_LINE_BYTES`] 丢弃并写一行警告（#674）。
#[cfg(test)]
mod long_event_tests {
    use super::*;

    /// 一个 Forwarder，和一个把它发出的消息一条条收走的任务。
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
            too_long: BTreeMap::new(),
        };
        (forwarder, drain)
    }

    fn log_event(message: &str) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(&serde_json::json!({
            "type": "log", "ts": 1_700_000_000_000_i64, "level": "warn", "message": message,
        }))
        .unwrap();
        bytes.push(b'\n');
        bytes
    }

    /// 把这些事件行交给 Forwarder，返回它发出的全部日志批次。
    async fn batches_of(chunks: Vec<EventChunk>) -> Vec<LogBatch> {
        let (mut forwarder, drain) = forwarder();
        for chunk in &chunks {
            forwarder.events(chunk).await;
            tokio::task::yield_now().await;
        }
        forwarder.poll(true);
        drop(forwarder);
        drain
            .await
            .unwrap()
            .into_iter()
            .filter_map(|m| match m.body {
                Some(agent_message::Body::Logs(batch)) => Some(batch),
                _ => None,
            })
            .collect()
    }

    fn chunk(bytes: Vec<u8>) -> EventChunk {
        EventChunk {
            bytes,
            monotonic_ms: 5,
            dropped: Vec::new(),
        }
    }

    fn lines_of(batches: &[LogBatch]) -> Vec<&LogLine> {
        batches.iter().flat_map(|b| &b.lines).collect()
    }

    /// 65536 字节处正好落在值的中间。
    const VALUE: &str = "FAKE-VALUE-ABCDEFGHIJ";

    fn across_the_split() -> String {
        format!("{}{VALUE}{}", "a".repeat(65526), "b".repeat(70000))
    }

    #[tokio::test]
    async fn an_sdk_log_message_over_the_limit_is_split_with_context_like_a_stdout_line() {
        let message = across_the_split();
        let batches = batches_of(vec![chunk(log_event(&message))]).await;
        let lines = lines_of(&batches);
        assert!(lines.len() >= 2, "没有拆开：{} 行", lines.len());
        let joined: String = lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(joined, message);
        assert!(lines.iter().all(|l| l.text.len() <= MAX_LINE_BYTES));
        assert!(lines.iter().all(|l| l.source() == LogSource::Sdk));
        assert!(lines.iter().all(|l| l.level() == LogLevel::Warn));
        // 每一段的时间、读到的单调时钟读数都是这一条消息的
        assert!(lines.iter().all(|l| l.time_unix_ms == 1_700_000_000_000));
        assert!(lines.iter().all(|l| l.monotonic_ms == 5));
        assert!(
            lines.iter().all(|l| !l.text.contains(VALUE)),
            "值被拆在两段里"
        );
        assert_eq!(lines[0].before, "");
        assert_eq!(lines[lines.len() - 1].after, "");
        assert!(format!("{}{}", lines[0].text, lines[0].after).contains(VALUE));
        assert!(format!("{}{}", lines[1].before, lines[1].text).contains(VALUE));
        let seqs: Vec<u64> = lines.iter().map(|l| l.seq).collect();
        assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1));
    }

    /// 拆法和标准输出的同一行完全一样：同一段文字，从标准输出读和从事件管道读，每一段的文字和上下文都相同。
    #[tokio::test]
    async fn the_pieces_are_the_same_as_when_the_text_is_one_stdout_line() {
        let message = across_the_split();
        let batches = batches_of(vec![chunk(log_event(&message))]).await;
        let mut from_stdout = Vec::new();
        let mut splitter = LineSplitter::default();
        splitter.push(message.as_bytes(), |line| from_stdout.push(line));
        splitter.finish(|line| from_stdout.push(line));
        let pieces: Vec<(&str, &str, &str)> = lines_of(&batches)
            .iter()
            .map(|l| (l.text.as_str(), l.before.as_str(), l.after.as_str()))
            .collect();
        let expected: Vec<(&str, &str, &str)> = from_stdout
            .iter()
            .map(|l| (l.text.as_str(), l.before.as_str(), l.after.as_str()))
            .collect();
        assert_eq!(pieces, expected);
    }

    #[tokio::test]
    async fn a_message_that_fits_is_one_line_with_no_context_and_keeps_its_newlines() {
        let exactly = "x".repeat(MAX_LINE_BYTES);
        let multi = "第一行\n第二行\r\n第三行\r".to_string();
        let mut bytes = log_event(&exactly);
        bytes.extend(log_event(&multi));
        let batches = batches_of(vec![chunk(bytes)]).await;
        let lines = lines_of(&batches);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, exactly);
        assert_eq!(
            lines[1].text, multi,
            "一条消息里的换行和行尾的 \\r 原样保留"
        );
        assert!(
            lines
                .iter()
                .all(|l| l.before.is_empty() && l.after.is_empty())
        );
    }

    /// 超过一段的消息末尾的 `\r` 也原样保留（不像标准输出的行尾那样去掉）。
    #[tokio::test]
    async fn the_end_of_a_split_message_is_kept_as_written() {
        let message = format!("{}\r", "y".repeat(MAX_LINE_BYTES + 10));
        let batches = batches_of(vec![chunk(log_event(&message))]).await;
        let joined: String = lines_of(&batches).iter().map(|l| l.text.as_str()).collect();
        assert_eq!(joined, message);
    }

    #[tokio::test]
    async fn an_unrecognised_line_over_the_limit_is_split_too() {
        let junk = format!("not json {}", "z".repeat(MAX_LINE_BYTES * 2));
        let mut bytes = junk.clone().into_bytes();
        bytes.push(b'\n');
        let batches = batches_of(vec![chunk(bytes)]).await;
        let lines = lines_of(&batches);
        assert!(lines.len() >= 3, "{} 行", lines.len());
        let joined: String = lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(joined, junk);
        assert!(lines.iter().all(|l| l.source() == LogSource::Sdk));
        assert!(lines.iter().all(|l| l.level() == LogLevel::Info));
        assert!(lines.iter().all(|l| l.text.len() <= MAX_LINE_BYTES));
    }

    /// 一条几 MiB 的日志拆开之后一批一批发出，每一批不超过 [`MAX_BATCH_BYTES`] 加上最后一条，不攒成一个大批。
    #[tokio::test]
    async fn a_very_long_message_goes_out_in_batches_of_bounded_size() {
        let message = "m".repeat(6 * 1024 * 1024);
        let batches = batches_of(vec![chunk(log_event(&message))]).await;
        assert!(batches.len() >= 3, "{} 批", batches.len());
        let one_line = MAX_LINE_BYTES + 2 * SPLIT_CONTEXT_BYTES + LOG_LINE_OVERHEAD;
        for batch in &batches {
            let size: usize = batch
                .lines
                .iter()
                .map(|l| l.text.len() + l.before.len() + l.after.len() + LOG_LINE_OVERHEAD)
                .sum();
            assert!(size <= MAX_BATCH_BYTES + one_line, "一批 {size} 字节");
        }
        let joined: usize = lines_of(&batches).iter().map(|l| l.text.len()).sum();
        assert_eq!(joined, message.len());
    }

    /// 一行被丢弃的记录：超过上限、开头是 `head`。
    fn too_long(at: usize, size: u64, head: &[u8]) -> Dropped {
        Dropped {
            at,
            size,
            reason: DropReason::TooLong,
            head: head.to_vec(),
        }
    }

    const OVER: u64 = MAX_EVENT_LINE_BYTES as u64 + 7;

    #[tokio::test]
    async fn a_dropped_line_leaves_one_agent_warning_with_its_size_and_nothing_of_its_content() {
        let mut bytes = log_event("before");
        let at = bytes.len();
        bytes.extend(log_event("after"));
        let batches = batches_of(vec![EventChunk {
            bytes,
            monotonic_ms: 9,
            dropped: vec![too_long(at, OVER, br#"{"type": "log", "message": "SECRET"#)],
        }])
        .await;
        let lines = lines_of(&batches);
        // 警告排在被丢弃的行原来所在的地方：前一行之后、后一行之前。
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].text, "before");
        assert_eq!(lines[2].text, "after");
        assert_eq!(lines[1].source(), LogSource::Agent);
        assert_eq!(lines[1].level(), LogLevel::Warn);
        let warning = &lines[1].text;
        assert!(warning.len() < 300, "警告只写大小：{warning}");
        assert!(
            warning.contains(&OVER.to_string())
                && warning.contains(&MAX_EVENT_LINE_BYTES.to_string()),
            "{warning}"
        );
        assert!(!warning.contains("SECRET"), "不写这一行的内容：{warning}");
    }

    /// 每种事件被丢弃时的警告：认得出种类就写种类和后果；日志才说「拆开写」；认不出种类的不说是日志、也不猜。
    #[test]
    fn the_warning_for_a_dropped_line_says_what_was_dropped_and_what_follows() {
        let size = OVER;
        let warning = |kind| too_long_warning(kind, size);
        let log = warning(Some(EventKind::Log));
        assert!(log.contains("日志") && log.contains("拆开写"), "{log}");
        let summary = warning(Some(EventKind::ActionSummary));
        assert!(
            summary.contains("动作摘要") && summary.contains("停在之前的一份"),
            "{summary}"
        );
        assert!(
            summary.contains("名称的种类太多") && !summary.contains("拆开写"),
            "{summary}"
        );
        for (kind, name, consequence) in [
            (EventKind::Progress, "进度", "停在之前的一次"),
            (EventKind::Notify, "通知", "没有发出"),
            (EventKind::Metric, "指标", "没有记下来"),
            (EventKind::ActionStart, "动作开始的明细", "没有记下来"),
            (EventKind::ActionEnd, "动作结束的明细", "没有记下来"),
            (EventKind::Mark, "标记", "没有记下来"),
        ] {
            let text = warning(Some(kind));
            assert!(
                text.contains(name) && text.contains(consequence) && !text.contains("拆开写"),
                "{text}"
            );
        }
        let unknown = warning(None);
        assert!(
            unknown.contains("认不出") && !unknown.contains("日志") && !unknown.contains("拆开写"),
            "{unknown}"
        );
        for text in [&log, &summary, &unknown] {
            assert!(
                text.contains(&size.to_string())
                    && text.contains(&MAX_EVENT_LINE_BYTES.to_string()),
                "{text}"
            );
        }
    }

    /// 同一种事件每个任务只在第一次写警告，之后只计数，任务结束时补一行合计；只丢了一行的不补。
    #[tokio::test]
    async fn the_same_kind_of_dropped_line_warns_once_per_task_and_is_totalled_at_the_end() {
        let summary = br#"{"type": "action_summary", "ts": 1, "names": {"#;
        let (mut forwarder, drain) = forwarder();
        for (i, size) in [5_000_000_u64, 9_000_000, 7_000_000]
            .into_iter()
            .enumerate()
        {
            let mut dropped = vec![too_long(0, size, summary)];
            if i == 1 {
                dropped.push(too_long(0, OVER, br#"{"type": "log", "message": "x"#));
            }
            forwarder
                .events(&EventChunk {
                    bytes: Vec::new(),
                    monotonic_ms: i as i64,
                    dropped,
                })
                .await;
        }
        forwarder.drop_totals();
        forwarder.poll(true);
        drop(forwarder);
        let batches: Vec<LogBatch> = drain
            .await
            .unwrap()
            .into_iter()
            .filter_map(|m| match m.body {
                Some(agent_message::Body::Logs(batch)) => Some(batch),
                _ => None,
            })
            .collect();
        let texts: Vec<&str> = lines_of(&batches).iter().map(|l| l.text.as_str()).collect();
        let with = |needle: &str| texts.iter().filter(|t| t.contains(needle)).count();
        assert_eq!(texts.len(), 3, "{texts:#?}");
        assert_eq!(with("停在之前的一份"), 1, "动作摘要只写第一次：{texts:#?}");
        assert_eq!(
            with("拆开写"),
            1,
            "日志只丢了一行：只有它自己的警告：{texts:#?}"
        );
        let total = texts
            .iter()
            .find(|t| t.contains("一共被丢弃了"))
            .expect("合计");
        assert!(
            total.contains("动作摘要")
                && total.contains("3 行")
                && total.contains(&format!("{} 字节", 9_000_000)),
            "{total}"
        );
    }

    /// 管道 `data` 读完之后 `read_events` 交出的全部块：内容接起来，丢弃的行（位置按接起来之后的内容算）。
    async fn read_all(data: &[u8]) -> (Vec<u8>, Vec<Dropped>) {
        let (tx, mut rx) = mpsc::channel(1024);
        read_events(data, tx).await;
        let mut bytes = Vec::new();
        let mut dropped = Vec::new();
        while let Some(chunk) = rx.recv().await {
            let base = bytes.len();
            dropped.extend(chunk.dropped.into_iter().map(|mut line| {
                line.at += base;
                line
            }));
            bytes.extend(chunk.bytes);
        }
        (bytes, dropped)
    }

    /// 丢弃的行的（位置，字节数，原因）。
    fn shape(dropped: &[Dropped]) -> Vec<(usize, u64, DropReason)> {
        dropped.iter().map(|d| (d.at, d.size, d.reason)).collect()
    }

    #[tokio::test]
    async fn read_events_hands_over_whole_lines_and_reports_the_unfinished_last_one() {
        let (bytes, dropped) = read_all(b"one\n\ntwo\nthree-without-newline").await;
        assert_eq!(bytes, b"one\n\ntwo\n");
        assert_eq!(
            shape(&dropped),
            vec![(b"one\n\ntwo\n".len(), 21, DropReason::Unfinished)]
        );
        assert!(
            dropped[0].head.is_empty(),
            "没写完的一行不认种类，也不留内容"
        );
        let (bytes, dropped) = read_all(b"one\n").await;
        assert_eq!(bytes, b"one\n");
        assert!(dropped.is_empty(), "最后一行写完了：没有警告");
    }

    /// 没写完的最后一行写一行警告：只有大小，没有内容。
    #[tokio::test]
    async fn the_unfinished_last_line_leaves_one_warning_with_its_size_only() {
        let batches = batches_of(vec![EventChunk {
            bytes: Vec::new(),
            monotonic_ms: 9,
            dropped: vec![Dropped {
                at: 0,
                size: 21,
                reason: DropReason::Unfinished,
                head: Vec::new(),
            }],
        }])
        .await;
        let lines = lines_of(&batches);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].source(), LogSource::Agent);
        assert_eq!(lines[0].level(), LogLevel::Warn);
        assert!(
            lines[0].text.contains("没有写完") && lines[0].text.contains("21 字节"),
            "{}",
            lines[0].text
        );
    }

    #[tokio::test]
    async fn a_line_of_exactly_the_cap_is_kept_and_one_byte_more_is_dropped() {
        let mut data = vec![b'a'; MAX_EVENT_LINE_BYTES];
        data.push(b'\n');
        data.extend(vec![b'b'; MAX_EVENT_LINE_BYTES + 1]);
        data.extend(b"\nnext\n");
        let (bytes, dropped) = read_all(&data).await;
        let mut expected = vec![b'a'; MAX_EVENT_LINE_BYTES];
        expected.extend(b"\nnext\n");
        assert!(bytes == expected, "留下的内容不对：{} 字节", bytes.len());
        assert_eq!(
            shape(&dropped),
            vec![(
                MAX_EVENT_LINE_BYTES + 1,
                MAX_EVENT_LINE_BYTES as u64 + 1,
                DropReason::TooLong
            )],
            "位置是它前面那一行（连换行）之后"
        );
    }

    /// 超长的一行跨很多次读取、中间读不到换行：整行都丢，丢到换行为止，之后的行照常。
    #[tokio::test]
    async fn the_rest_of_a_dropped_line_is_dropped_up_to_its_newline_whatever_the_read_sizes() {
        let junk = MAX_EVENT_LINE_BYTES * 2 + 12_345;
        let mut data = b"first\n".to_vec();
        data.extend(vec![b'x'; junk]);
        data.extend(b"\nsecond\n");
        data.extend(vec![b'y'; MAX_EVENT_LINE_BYTES + 1]);
        data.extend(b"\nthird\n");
        let (bytes, dropped) = read_all(&data).await;
        assert_eq!(bytes, b"first\nsecond\nthird\n");
        assert_eq!(
            shape(&dropped),
            vec![
                (b"first\n".len(), junk as u64, DropReason::TooLong),
                (
                    b"first\nsecond\n".len(),
                    MAX_EVENT_LINE_BYTES as u64 + 1,
                    DropReason::TooLong
                )
            ]
        );
    }

    /// 被丢弃的行留下开头固定大小的一小段，不随行的长度变；认种类看的就是它。
    #[tokio::test]
    async fn a_dropped_line_keeps_a_fixed_size_head_whatever_its_length() {
        let head = br#"{"type": "action_summary", "ts": 1, "names": {"#;
        for filler in [MAX_EVENT_LINE_BYTES, MAX_EVENT_LINE_BYTES * 3 + 5] {
            let mut data = head.to_vec();
            data.extend(vec![b'x'; filler]);
            data.extend(b"\nafter\n");
            let (bytes, dropped) = read_all(&data).await;
            assert_eq!(bytes, b"after\n");
            assert_eq!(dropped.len(), 1);
            assert_eq!(
                dropped[0].head.len(),
                EVENT_HEAD_BYTES,
                "留下的开头大小固定"
            );
            assert_eq!(&dropped[0].head[..head.len()], head);
            assert_eq!(
                EventKind::of_head(&dropped[0].head),
                Some(EventKind::ActionSummary)
            );
        }
    }

    #[tokio::test]
    async fn a_dropped_line_that_the_pipe_ends_in_the_middle_of_is_still_reported() {
        let mut data = b"ok\n".to_vec();
        data.extend(br#"{"type": "log", "message": ""#);
        data.extend(vec![b'x'; MAX_EVENT_LINE_BYTES + 100]);
        let (bytes, dropped) = read_all(&data).await;
        assert_eq!(bytes, b"ok\n");
        assert_eq!(dropped.len(), 1);
        assert_eq!(dropped[0].reason, DropReason::TooLong);
        assert_eq!(dropped[0].size, MAX_EVENT_LINE_BYTES as u64 + 100 + 28);
        assert_eq!(EventKind::of_head(&dropped[0].head), Some(EventKind::Log));
    }
}
