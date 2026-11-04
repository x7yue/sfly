//! 任务日志与进度的转发（docs/ARCHITECTURE.md §5.3）。
//!
//! 执行器的标准输出、标准错误（包括继承了它们的子进程）和 SDK 写入的事件文件 `events.jsonl`
//! 合并成同一条日志流：每行分配任务内递增的序号，批量（约每 100 毫秒一批）以 `LogBatch` 发往控制面。
//!
//! - 标准输出 → 来源 stdout、级别 info；标准错误 → 来源 stderr、级别 error；
//! - 事件文件里的 `{"type":"log"}` → 来源 sdk、级别取 SDK 记录的级别；
//! - `{"type":"progress"}` 只保留最新值，每个任务每秒最多发一次 `Progress`，任务结束前补发最后一次。
//!
//! 同一批内按时间排序后再编号，所以不同来源的行大致按发生顺序排列；同一来源内保持写入顺序。
//! 标准输出 / 标准错误的原始内容同时写到工作目录的 `stdout.log` / `stderr.log`（失败消息取标准错误尾部）。

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::proto::{
    AgentMessage, AssignTask, LogBatch, LogLevel, LogLine, LogSource, Progress, agent_message,
};

/// 读取事件文件、发送一批日志的间隔。
const TICK: Duration = Duration::from_millis(100);
/// 同一任务两次进度上报的最小间隔。
const PROGRESS_INTERVAL: Duration = Duration::from_secs(1);
/// 一行的最大字节数；更长的行被拆成多行。
const MAX_LINE_BYTES: usize = 64 * 1024;
/// 一批最多的行数。
const MAX_BATCH_LINES: usize = 1000;
/// 执行器退出后，等待仍持有标准输出的后台子进程关闭管道的最长时间。
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// 发往控制面的日志与进度消息（`LogBatch` / `Progress`）。连接断开期间在通道里排队，重连后发送。
pub type Telemetry = mpsc::UnboundedSender<AgentMessage>;

/// 一个任务的日志转发；执行器退出后调用 [`Pump::finish`] 发完剩余的日志和最后一次进度。
pub struct Pump {
    exited: oneshot::Sender<()>,
    handle: JoinHandle<()>,
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
        ));
        tokio::spawn(read_pipe(
            stderr,
            dir.join("stderr.log"),
            LogSource::Stderr,
            LogLevel::Error,
            lines_tx,
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
        };
        let handle = tokio::spawn(forwarder.run(lines_rx, exited_rx));
        Pump { exited, handle }
    }

    /// 执行器已退出：读完管道（最多等 [`DRAIN_TIMEOUT`]）和事件文件，发出剩余日志和最后一次进度。
    pub async fn finish(self) {
        let _ = self.exited.send(());
        let _ = self.handle.await;
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

/// 逐行读取一个管道，原始内容同时写到 `copy`。
async fn read_pipe(
    mut pipe: impl AsyncRead + Unpin,
    copy: PathBuf,
    source: LogSource,
    level: LogLevel,
    lines: mpsc::UnboundedSender<Pending>,
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
        let _ = self.telemetry.send(AgentMessage { body: Some(body) });
    }
}
