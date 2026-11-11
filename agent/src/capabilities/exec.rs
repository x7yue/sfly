//! Agent 能力 `exec`：在一台 Agent 上执行一条命令（`exec.run`）。协议见 `proto/sfly/agent/v1/exec.proto`。
//!
//! 规则见 ADR 0019：命令归属于发起调用的任务，不占执行它的 Agent 的槽位，不产生任务，不用来启动常驻进程。
//!
//! - 执行它的 Agent（[`Exec`]）把命令启动成一棵进程树（[`ProcessTree`]，和任务的执行器相同），把输出原样传回；
//!   超时、调用方放弃（取消调用、连接断开：gRPC 回复流被丢弃）、命令自己退出后还剩下子进程时，整棵树被结束
//!   （先 SIGTERM，宽限期过后 SIGKILL，[`ProcessTree::terminate`]）。
//! - 发起调用的 Agent（[`run`]）把输出按行切开，每行前面标上来自哪台 Agent，逐行回复给节点（`{"stdout": ...}`、
//!   `{"stderr": ...}`），SDK 把它们写到执行器的标准输出 / 标准错误，于是进入调用方任务的日志；结果是退出码。
//!   调用方任务被取消、结束，或节点放弃调用时，[`crate::calls`] 丢下这次调用，执行它的 Agent 随之结束进程树。

use std::collections::HashMap;
use std::os::unix::process::ExitStatusExt as _;
use std::pin::Pin;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt as _};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::{Stream, StreamExt as _};
use tonic::{Request, Response, Status};

use super::files::{absolute, io_status};
use super::{Capability, Host, Module};
use crate::calls::{BoxFuture, Call, CallError, ErrorKind, Method, Target};
use crate::logs::LineSplitter;
use crate::process_tree::ProcessTree;
use crate::proto::agent_exec_client::AgentExecClient;
use crate::proto::agent_exec_server::{AgentExec, AgentExecServer};
use crate::proto::run_command_response::Part;
use crate::proto::{
    CommandExit, CommandOutput, OutputStream, RunCommandRequest, RunCommandResponse,
};

pub const MODULE: Module = Module {
    capability: Capability {
        name: "exec",
        version: 1,
    },
    methods: &[Method {
        name: "exec.run",
        call: run_call,
    }],
    add_service,
};

fn add_service(routes: &mut tonic::service::RoutesBuilder, host: &Host) {
    routes.add_service(AgentExecServer::new(Exec {
        grace: host.terminate_grace,
    }));
}

/// 一次读输出最多多少字节。
const READ_CHUNK: usize = 64 * 1024;

/// 进程树结束之后，等仍持有输出管道的进程（自己 `setsid` 离开了进程组的）关闭管道的最长时间。
const DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// 发起调用的 Agent 在超时之外多等多久：执行它的 Agent 超时后要结束进程树（最多一个宽限期）才回复。
const REPLY_SLACK: Duration = Duration::from_secs(10);

type RunStream = Pin<Box<dyn Stream<Item = Result<RunCommandResponse, Status>> + Send>>;

/// `AgentExec` 服务：供其它 Agent 调用，也被自己所在的 Agent 直接调用（[`Target::Local`]）。
pub struct Exec {
    /// 结束进程树时的宽限期。
    grace: Duration,
}

#[tonic::async_trait]
impl AgentExec for Exec {
    type RunStream = RunStream;

    async fn run(
        &self,
        request: Request<RunCommandRequest>,
    ) -> Result<Response<Self::RunStream>, Status> {
        let RunCommandRequest {
            argv,
            cwd,
            env,
            timeout_ms,
        } = request.into_inner();
        let Some(program) = argv.first().filter(|p| !p.is_empty()) else {
            return Err(Status::invalid_argument("要执行的命令是空的"));
        };
        if timeout_ms == 0 {
            return Err(Status::invalid_argument(
                "执行命令必须给超时：命令最多运行多久",
            ));
        }
        let cwd = if cwd.is_empty() { "/".to_string() } else { cwd };
        let dir = absolute(&cwd)?;
        match tokio::fs::metadata(&dir).await {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                return Err(Status::invalid_argument(format!("工作目录 {cwd} 不是目录")));
            }
            Err(error) => return Err(io_status(&error, &format!("工作目录 {cwd}"))),
        }
        let mut command = tokio::process::Command::new(program);
        command
            .args(&argv[1..])
            .current_dir(&dir)
            .envs(&env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut process = ProcessTree::spawn(&mut command).map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => Status::not_found(format!("找不到程序 {program}")),
            std::io::ErrorKind::PermissionDenied => {
                Status::permission_denied(format!("没有权限执行 {program}"))
            }
            _ => Status::internal(format!("启动 {program} 失败：{error}")),
        })?;
        let (Some(stdout), Some(stderr)) = process.take_output_pipes() else {
            unreachable!("stdout and stderr are piped");
        };
        let (tx, rx) = mpsc::channel(8);
        tokio::spawn(supervise(
            process,
            (stdout, stderr),
            Duration::from_millis(timeout_ms),
            self.grace,
            tx,
        ));
        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }
}

/// 命令怎样结束的。
enum End {
    /// 自己退出了。
    Exited(std::io::Result<ExitStatus>),
    /// 超过了超时。
    TimedOut(Duration),
    /// 调用方放弃了（回复流被丢弃）：没有人收结果。
    Abandoned,
}

/// 看着命令直到它结束：边运行边把输出交给 `tx`；无论怎样结束，都结束整棵进程树，等输出发完再发最后一条。
async fn supervise(
    mut process: ProcessTree,
    (stdout, stderr): (
        impl AsyncRead + Unpin + Send + 'static,
        impl AsyncRead + Unpin + Send + 'static,
    ),
    limit: Duration,
    grace: Duration,
    tx: mpsc::Sender<Result<RunCommandResponse, Status>>,
) {
    let readers = [
        tokio::spawn(forward(stdout, OutputStream::Stdout, tx.clone())),
        tokio::spawn(forward(stderr, OutputStream::Stderr, tx.clone())),
    ];
    let end = tokio::select! {
        status = process.wait() => End::Exited(status),
        () = tokio::time::sleep(limit) => End::TimedOut(limit),
        () = tx.closed() => End::Abandoned,
    };
    // 命令退出之后还剩下的子进程也结束：不用来启动常驻进程。
    let _ = process.terminate(grace).await;
    let drained = async {
        for reader in &readers {
            while !reader.is_finished() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
    };
    let _ = tokio::time::timeout(DRAIN_TIMEOUT, drained).await;
    for reader in &readers {
        reader.abort();
    }
    let last = match end {
        End::Exited(Ok(status)) => Ok(RunCommandResponse {
            part: Some(Part::Exit(CommandExit {
                exit_code: exit_code(status),
            })),
        }),
        End::Exited(Err(error)) => Err(Status::internal(format!("等待命令退出失败：{error}"))),
        End::TimedOut(limit) => Err(Status::deadline_exceeded(format!(
            "命令超过 {} 秒没有结束，已结束它的进程树",
            seconds(limit)
        ))),
        End::Abandoned => return,
    };
    let _ = tx.send(last).await;
}

/// 退出码；被信号终止时为 128 + 信号值。
fn exit_code(status: ExitStatus) -> i32 {
    status
        .code()
        .or_else(|| status.signal().map(|signal| 128 + signal))
        .unwrap_or(-1)
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

/// 把一个输出管道的内容原样交给 `tx`，直到管道关闭。调用方已经放弃时照常读完（丢掉），命令不会因为写不出去而卡住。
async fn forward(
    mut pipe: impl AsyncRead + Unpin,
    stream: OutputStream,
    tx: mpsc::Sender<Result<RunCommandResponse, Status>>,
) {
    let mut buf = vec![0u8; READ_CHUNK];
    let mut open = true;
    loop {
        let n = match pipe.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        if open {
            let output = CommandOutput {
                stream: stream.into(),
                data: buf[..n].to_vec(),
            };
            open = tx
                .send(Ok(RunCommandResponse {
                    part: Some(Part::Output(output)),
                }))
                .await
                .is_ok();
        }
    }
}

// ---- 节点调用（[`crate::calls`]）----

#[derive(Deserialize)]
struct RunArgs {
    argv: Vec<String>,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    env: HashMap<String, String>,
}

fn run_call(call: Call<'_>) -> BoxFuture<'_, Result<Value, CallError>> {
    Box::pin(run(call))
}

/// `exec.run`：输出逐行回复（`{"stdout": "[Agent 名称] 一行"}`、`{"stderr": ...}`），结果是 `{"exit_code": N}`。
/// 调用的超时就是命令最多运行多久，必须给。
async fn run(mut call: Call<'_>) -> Result<Value, CallError> {
    let RunArgs { argv, cwd, env } = call.args()?;
    let Some(limit) = call.timeout else {
        return Err(CallError::new(
            ErrorKind::Invalid,
            "exec.run 必须给超时：命令最多运行多久",
        ));
    };
    let request = RunCommandRequest {
        argv,
        cwd,
        env,
        timeout_ms: u64::try_from(limit.as_millis()).unwrap_or(u64::MAX),
    };
    let target = call.target;
    // 执行它的 Agent 自己按超时结束命令；它一直不回复（例如卡住了）时，到这个时刻放弃调用，它随之结束进程树。
    let deadline = tokio::time::Instant::now() + limit + call.host.terminate_grace + REPLY_SLACK;
    let tag = format!("[Agent {}] ", target.name());
    let mut out = Lines::new(tag);
    let outcome = tokio::time::timeout_at(deadline, async {
        let mut stream: RunStream = match target {
            Target::Local { .. } => Exec {
                grace: call.host.terminate_grace,
            }
            .run(Request::new(request))
            .await
            .map_err(|status| target.error(status))?
            .into_inner(),
            Target::Remote(remote) => Box::pin(
                AgentExecClient::new(remote.channel())
                    .run(Request::new(request))
                    .await
                    .map_err(|status| target.error(status))?
                    .into_inner(),
            ),
        };
        while let Some(message) = stream.next().await {
            match message.map_err(|status| target.error(status))?.part {
                Some(Part::Output(output)) => {
                    let lines = out.push(output.stream(), &output.data);
                    reply(&mut call, lines).await?;
                }
                Some(Part::Exit(exit)) => return Ok(exit.exit_code),
                None => {}
            }
        }
        Err(target.error(Status::unavailable("命令的输出在它退出之前中断了")))
    })
    .await
    .unwrap_or_else(|_| {
        Err(CallError::new(
            ErrorKind::Timeout,
            format!(
                "Agent {} 超过 {} 秒没有结束命令，也没有回应",
                target.name(),
                seconds(limit)
            ),
        ))
    });
    // 没有换行结尾的最后一段也是一行（超时、出错时已经收到的输出照常给出）。
    reply(&mut call, out.finish()).await?;
    outcome.map(|exit_code| json!({ "exit_code": exit_code }))
}

async fn reply(call: &mut Call<'_>, lines: Vec<Value>) -> Result<(), CallError> {
    for line in lines {
        call.item(line).await?;
    }
    Ok(())
}

/// 把标准输出、标准错误分别按行切开，每行前面标上来自哪台 Agent。
struct Lines {
    tag: String,
    stdout: LineSplitter,
    stderr: LineSplitter,
}

impl Lines {
    fn new(tag: String) -> Self {
        Self {
            tag,
            stdout: LineSplitter::default(),
            stderr: LineSplitter::default(),
        }
    }

    /// 一段输出切出的完整的行（回复给节点的各项）。
    fn push(&mut self, stream: OutputStream, data: &[u8]) -> Vec<Value> {
        let (key, splitter) = match stream {
            OutputStream::Stderr => ("stderr", &mut self.stderr),
            _ => ("stdout", &mut self.stdout),
        };
        let mut lines = Vec::new();
        splitter.push(data, |text| {
            lines.push(json!({ key: format!("{}{text}", self.tag) }));
        });
        lines
    }

    /// 两个流各自剩下的没有换行结尾的内容。
    fn finish(self) -> Vec<Value> {
        let mut lines = Vec::new();
        for (key, splitter) in [("stdout", self.stdout), ("stderr", self.stderr)] {
            splitter.finish(|text| {
                lines.push(json!({ key: format!("{}{text}", self.tag) }));
            });
        }
        lines
    }
}
