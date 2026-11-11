//! 节点调用 Agent 能力（ADR 0019）：SDK 只和自己所在的 Agent 通信，由这台 Agent 执行（调用自己）或连到目标 Agent
//! 代为调用（调用另一台）。目标 Agent 只能是任务的 `referenced_agents`（通过「Agent」类型的输入拿到的）和自己。
//!
//! SDK 经 Agent 的本地 socket（[`crate::socket`]，执行器的环境变量 `SFLY_AGENT_SOCKET`）发来一行 JSON 请求：
//!
//! ```json
//! {"command": "call", "task_id": "...", "attempt": 1, "agent": "名称（空串为自己）",
//!  "method": "files.list", "args": {...}, "timeout_ms": 30000}
//! ```
//!
//! Agent 回复若干行 JSON，最后一行是结果或错误，之后关闭连接：
//!
//! - `{"item": ...}`：流式方法（例如列出文件）的一项，零到多行（[`Call::item`]）；
//! - `{"data": N}` 一行之后紧跟 N 个原始字节：传输文件内容的方法（[`Call::data`]）；
//! - `{"result": ...}`：调用成功，带方法的返回值（流式方法为 null）；
//! - `{"error": {"kind": "...", "message": "...", "agent": "..."}}`：调用失败，`kind` 见 [`ErrorKind`]。
//!
//! 往对方传数据的方法（流式写入文件）在请求之后由调用方接着发 `{"data": N}` + N 个字节的帧，最后发 `{"end": true}`
//! （[`input`]，方法用 [`Call::input`] 取）。
//!
//! - **超时**：`timeout_ms`（0 为不限）是等对方回应的上限：一次性的方法是整个调用，流式方法是相邻两次回应之间
//!   （[`Call::within`]）。超时后 Agent 放弃调用（丢掉 gRPC 请求，目标 Agent 随之结束处理），以 `timeout` 回复。
//! - **取消**：任务被取消（或已经结束）时立即放弃调用，以 `cancelled` 回复；SDK 抛出 `sfly.Cancelled`。
//! - **调用方断开**：SDK 关掉连接（节点进程退出、提前停止迭代、写入时出错）时 Agent 放弃调用。
//!
//! 方法的实现在各项能力里（[`crate::capabilities`]）：[`Method`] 拿到 [`Call`]，按 [`Target`] 直接调用本机服务的实现
//! 或用 gRPC 客户端调用目标 Agent，把 gRPC 状态交给 [`Target::error`] 转成能区分原因的 [`CallError`]。

pub mod input;
mod target;

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt as _, BufReader};
use tokio::sync::{mpsc, watch};

pub use input::Input;
pub use target::{Peers, Remote, Target};

use crate::capabilities;
use crate::proto::ReferencedAgent;

/// 一次调用的请求（本地 socket 上的一行 JSON，`command` 为 `call`）。
#[derive(Debug, Clone, Deserialize)]
pub struct CallRequest {
    /// 发起调用的任务。
    pub task_id: String,
    pub attempt: u32,
    /// 目标 Agent 的名称；空串表示自己所在的 Agent。
    #[serde(default)]
    pub agent: String,
    /// 方法名，例如 `files.list`。
    pub method: String,
    /// 方法的参数（JSON 对象）。
    #[serde(default)]
    pub args: Value,
    /// 等对方回应的上限（毫秒），0 为不限。
    #[serde(default)]
    pub timeout_ms: u64,
}

/// 调用失败的原因，SDK 据此抛出不同的异常。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// 连不通：两台 Agent 之间连不上（或目标 Agent 的端口没在监听）。
    Unreachable,
    /// 对方不支持：目标 Agent 的版本没有这项能力（或这个方法）。
    Unsupported,
    /// 文件（或目录）不存在。
    NotFound,
    /// 没有权限。
    PermissionDenied,
    /// 超时。
    Timeout,
    /// 目标 Agent 不是通过「Agent」类型的输入拿到的。
    NotReferenced,
    /// 参数不合法（例如路径不是绝对路径、要列出的不是目录）。
    Invalid,
    /// 任务被取消或已经结束。
    Cancelled,
    /// 其它失败。
    Failed,
}

/// 调用失败：原因和给人看的消息（消息里写明是哪台 Agent）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallError {
    pub kind: ErrorKind,
    pub message: String,
}

impl CallError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

/// 发起调用的任务给调用的约束（[`crate::Runtime`] 按 `task_id` + `attempt` 找到手上的任务后给出）。
pub struct TaskCalls {
    /// 任务通过「Agent」类型的输入引用的 Agent：只能调用它们和自己。
    pub referenced: Vec<ReferencedAgent>,
    /// 任务的取消请求（[`crate::executor::CancelSignal`]）：有值或发送端已丢弃（任务已结束）时放弃调用。
    pub cancel: watch::Receiver<Option<bool>>,
}

/// 方法的实现：拿到一次调用，返回 `result`（流式方法用 [`Call::item`] 逐项回复，返回 null）。
pub type Handler = for<'a> fn(Call<'a>) -> BoxFuture<'a, Result<Value, CallError>>;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 节点可调用的一个方法。
pub struct Method {
    /// 方法名，以能力名开头，例如 `files.list`。
    pub name: &'static str,
    pub call: Handler,
}

/// 一次调用：目标、参数、超时，以及流式回复的出口。
pub struct Call<'a> {
    pub target: &'a Target,
    pub method: &'static str,
    pub args: Value,
    /// 等对方回应的上限（[`CallRequest::timeout_ms`]）。
    pub timeout: Option<Duration>,
    out: &'a mut Replies,
    input: &'a mut Input,
}

impl Call<'_> {
    /// 把参数解析成方法的参数类型；不合法时是 `invalid`。
    pub fn args<T: serde::de::DeserializeOwned>(&self) -> Result<T, CallError> {
        serde_json::from_value(self.args.clone()).map_err(|error| {
            CallError::new(
                ErrorKind::Invalid,
                format!("{} 的参数不合法：{error}", self.method),
            )
        })
    }

    /// 等一次回应（一次性方法的整个调用、流式方法的下一项），最多等 [`Call::timeout`]，超过时是 `timeout`。
    pub async fn within<T>(&self, future: impl Future<Output = T>) -> Result<T, CallError> {
        match self.timeout {
            None => Ok(future.await),
            Some(limit) => tokio::time::timeout(limit, future).await.map_err(|_| {
                CallError::new(
                    ErrorKind::Timeout,
                    format!(
                        "Agent {} 超过 {} 秒没有回应 {}",
                        self.target.name(),
                        format_seconds(limit),
                        self.method
                    ),
                )
            }),
        }
    }

    /// 回复流式方法的一项。调用方已经断开时返回错误（调用随之结束）。
    pub async fn item(&mut self, item: Value) -> Result<(), CallError> {
        self.out
            .frame(&serde_json::json!({ "item": item }))
            .await
            .map_err(|error| CallError::new(ErrorKind::Failed, format!("回复调用方失败：{error}")))
    }

    /// 调用方发来的下一段数据（流式写入）；发完了时为 None。不设超时：数据什么时候来由节点决定。
    pub async fn input(&mut self) -> Result<Option<Vec<u8>>, CallError> {
        self.input.next().await
    }

    /// 回复一段原始字节（传输文件内容的方法）：`{"data": N}` 一行之后紧跟这 N 个字节。
    pub async fn data(&mut self, bytes: &[u8]) -> Result<(), CallError> {
        let sent = async {
            self.out
                .frame(&serde_json::json!({ "data": bytes.len() }))
                .await?;
            self.out.writer.write_all(bytes).await
        };
        sent.await
            .map_err(|error| CallError::new(ErrorKind::Failed, format!("回复调用方失败：{error}")))
    }
}

/// 秒数（给人看）：整数秒不带小数。
fn format_seconds(duration: Duration) -> String {
    let seconds = duration.as_secs_f64();
    if seconds.fract() == 0.0 {
        format!("{seconds:.0}")
    } else {
        format!("{seconds}")
    }
}

/// 回复调用方：每帧一行 JSON。
struct Replies {
    writer: Pin<Box<dyn AsyncWrite + Send + Sync>>,
}

impl Replies {
    async fn frame(&mut self, frame: &Value) -> std::io::Result<()> {
        let mut bytes = serde_json::to_vec(frame)?;
        bytes.push(b'\n');
        self.writer.write_all(&bytes).await
    }
}

/// 处理一次调用：找目标、检查名单和对方的能力、执行方法，期间任务被取消或调用方断开时放弃；写完最后一帧后返回。
/// `reader` 是请求那一行之后的连接（只用来发现调用方断开），`own` 是这台 Agent 的名称，
/// `task` 是发起调用的任务（不在这台 Agent 上时为 None）。
pub async fn serve(
    request: CallRequest,
    mut reader: impl AsyncRead + Unpin + Send,
    writer: impl AsyncWrite + Send + Sync + 'static,
    own: &str,
    task: Option<TaskCalls>,
    peers: &Peers,
) {
    let mut out = Replies {
        writer: Box::pin(writer),
    };
    // 找到目标之前的错误也写明要找的是哪台 Agent。
    let wanted = if request.agent.is_empty() {
        own.to_string()
    } else {
        request.agent.clone()
    };
    let Some(TaskCalls {
        referenced,
        mut cancel,
    }) = task
    else {
        let error = CallError::new(
            ErrorKind::Invalid,
            format!(
                "任务 {} 的第 {} 次尝试不在 Agent {own} 上执行",
                request.task_id, request.attempt
            ),
        );
        finish(&mut out, Err(error), &wanted).await;
        return;
    };
    let target = match target::resolve(&request.agent, own, &referenced, peers) {
        Ok(target) => target,
        Err(error) => {
            finish(&mut out, Err(error), &wanted).await;
            return;
        }
    };
    let timeout = (request.timeout_ms > 0).then(|| Duration::from_millis(request.timeout_ms));
    let (input_tx, input_rx) = mpsc::channel(4);
    let mut input = Input::new(input_rx);
    let outcome = {
        let call = run(&target, &request, timeout, peers, &mut out, &mut input);
        let cancelled = async {
            loop {
                if cancel.borrow_and_update().is_some() || cancel.changed().await.is_err() {
                    return;
                }
            }
        };
        // 读调用方发来的数据，连接关闭时结束。
        let gone = input::pump(BufReader::new(&mut reader), input_tx);
        tokio::select! {
            outcome = call => outcome,
            () = cancelled => Err(CallError::new(ErrorKind::Cancelled, "任务已取消，调用已放弃")),
            // 调用方已经断开：没有人收回复。
            () = gone => return,
        }
    };
    finish(&mut out, outcome, target.name()).await;
}

async fn run(
    target: &Target,
    request: &CallRequest,
    timeout: Option<Duration>,
    peers: &Peers,
    out: &mut Replies,
    input: &mut Input,
) -> Result<Value, CallError> {
    let Some((capability, method)) = capabilities::method(&request.method) else {
        return Err(CallError::new(
            ErrorKind::Unsupported,
            format!(
                "Agent {} 不支持 {}：这台 Agent 的版本没有这个方法",
                target.own(),
                request.method
            ),
        ));
    };
    if let Target::Remote(remote) = target {
        peers.require(remote, capability, timeout).await?;
    }
    (method.call)(Call {
        target,
        method: method.name,
        args: request.args.clone(),
        timeout,
        out,
        input,
    })
    .await
}

/// 写最后一帧。
async fn finish(out: &mut Replies, outcome: Result<Value, CallError>, agent: &str) {
    let frame = match outcome {
        Ok(result) => serde_json::json!({ "result": result }),
        Err(error) => serde_json::json!({
            "error": { "kind": error.kind, "message": error.message, "agent": agent }
        }),
    };
    let _ = out.frame(&frame).await;
    let _ = out.writer.shutdown().await;
}
