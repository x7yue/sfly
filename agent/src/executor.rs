//! 在共享 venv 中启动执行器子进程（`python -m sfly.runner`）运行一个任务。
//!
//! 本地协议（docs/ARCHITECTURE.md §5.4）：每个任务一个工作目录 `<work_dir>/<task_id>/`，
//!
//! | 环境变量 | 路径 |
//! |---|---|
//! | `SFLY_TASK` | `task.json`：入口、已解析的输入等 |
//! | `SFLY_OUTPUT` | `output.json`：执行器写入的结果 |
//! | `SFLY_ARTIFACTS` | `artifacts/`：产物目录（任务结束后由 [`crate::artifacts`] 上传） |
//! | `SFLY_ARTIFACTS_URL` | 产物下载地址前缀（`AssignTask.artifact_upload_url`，为空时不设置） |
//! | `SFLY_EVENTS` | `events.jsonl`：结构化日志与进度 |
//! | `SFLY_CANCEL` | `cancel`：取消标记文件 |
//!
//! 执行器的标准输出 / 标准错误和事件文件由 [`crate::logs`] 合并转发给控制面，
//! 原始的标准输出 / 标准错误同时写到工作目录下的 `stdout.log` / `stderr.log`。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::logs::{Pump, Telemetry};
use crate::process_tree::ProcessTree;
use crate::proto::{
    AgentMessage, AssignTask, ErrorKind, TaskError, TaskResult, TaskStarted, TaskStatus,
    agent_message,
};
use crate::venv::SharedVenv;

/// 失败时附带的标准错误尾部的最大字节数。
const STDERR_TAIL_BYTES: usize = 8 * 1024;

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum Output {
    Success { outputs: Value },
    Failed { error: RunnerError },
}

#[derive(Deserialize)]
struct RunnerError {
    message: String,
    #[serde(default)]
    traceback: String,
}

pub fn success(task: &AssignTask, outputs: &Value) -> TaskResult {
    TaskResult {
        task_id: task.task_id.clone(),
        attempt: task.attempt,
        status: TaskStatus::Success.into(),
        outputs_json: outputs.to_string(),
        error: None,
    }
}

pub fn failure(task: &AssignTask, kind: ErrorKind, message: impl Into<String>) -> TaskResult {
    TaskResult {
        task_id: task.task_id.clone(),
        attempt: task.attempt,
        status: TaskStatus::Failed.into(),
        outputs_json: String::new(),
        error: Some(TaskError {
            kind: kind.into(),
            message: message.into(),
        }),
    }
}

/// 任务 ID 用作目录名，只允许安全字符。
fn valid_task_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// 准备工作目录并启动执行器子进程；启动失败时直接给出结果。
/// 返回的 [`Running`] 用 [`Running::wait`] 等待结果（不会返回错误：所有失败都转成 TaskResult）。
/// `grace`：超时后从优雅终止到强制杀掉进程树的宽限期。
pub async fn start(
    venv: &SharedVenv,
    work_root: &Path,
    task: &AssignTask,
    entry: &str,
    telemetry: &Telemetry,
    grace: Duration,
) -> Result<Running, TaskResult> {
    if !valid_task_id(&task.task_id) {
        return Err(failure(
            task,
            ErrorKind::ConfigError,
            format!("非法的任务 ID：{:?}", task.task_id),
        ));
    }
    let inputs: Value = match serde_json::from_str(&task.inputs_json) {
        Ok(value @ Value::Object(_)) => value,
        _ => {
            return Err(failure(
                task,
                ErrorKind::ConfigError,
                "任务输入不是 JSON 对象",
            ));
        }
    };
    let dir = work_root.join(&task.task_id);
    if let Err(error) = prepare_dir(&dir, task, entry, inputs).await {
        return Err(failure(
            task,
            ErrorKind::EnvError,
            format!("准备工作目录 {} 失败：{error}", dir.display()),
        ));
    }
    spawn_process(venv, &dir, task, telemetry, grace)
}

async fn prepare_dir(
    dir: &Path,
    task: &AssignTask,
    entry: &str,
    inputs: Value,
) -> std::io::Result<()> {
    if tokio::fs::try_exists(dir).await? {
        tokio::fs::remove_dir_all(dir).await?;
    }
    tokio::fs::create_dir_all(dir.join("artifacts")).await?;
    let spec = json!({
        "task_id": task.task_id,
        "attempt": task.attempt,
        "run_id": task.run_id,
        "node_id": task.node_id,
        "package": task.package,
        "package_version": task.package_version,
        "node": task.node,
        "entry": entry,
        "inputs": inputs,
        "timeout_seconds": task.timeout_seconds,
    });
    tokio::fs::write(dir.join("task.json"), spec.to_string()).await
}

struct Paths {
    output: PathBuf,
    stderr: PathBuf,
    /// 取消标记文件（`SFLY_CANCEL`）：存在时 `ctx.cancelled()` 为 true。
    cancel: PathBuf,
    artifacts: PathBuf,
}

/// 任务的取消请求：None 表示没有取消，`Some(false)` 优雅取消，`Some(true)` 强制取消。
pub type CancelSignal = watch::Receiver<Option<bool>>;

/// 正在运行的执行器子进程。
pub struct Running {
    process: ProcessTree,
    paths: Paths,
    task: AssignTask,
    /// 日志与进度转发。
    pump: Pump,
    grace: Duration,
}

fn spawn_process(
    venv: &SharedVenv,
    dir: &Path,
    task: &AssignTask,
    telemetry: &Telemetry,
    grace: Duration,
) -> Result<Running, TaskResult> {
    let paths = Paths {
        output: dir.join("output.json"),
        stderr: dir.join("stderr.log"),
        cancel: dir.join("cancel"),
        artifacts: dir.join("artifacts"),
    };

    let mut command = venv.python_command();
    command
        // -u：标准输出 / 标准错误不缓冲，日志实时到达。
        .args(["-u", "-m", "sfly.runner"])
        .current_dir(dir)
        .env("SFLY_TASK", dir.join("task.json"))
        .env("SFLY_OUTPUT", &paths.output)
        .env("SFLY_ARTIFACTS", &paths.artifacts)
        .env("SFLY_EVENTS", dir.join("events.jsonl"))
        .env("SFLY_CANCEL", &paths.cancel)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !task.artifact_upload_url.is_empty() {
        command.env("SFLY_ARTIFACTS_URL", &task.artifact_upload_url);
    }

    // 每个任务是一棵进程树，超时、取消时整体终止。
    match ProcessTree::spawn(&mut command) {
        Ok(mut process) => {
            let (Some(stdout), Some(stderr)) = process.take_output_pipes() else {
                unreachable!("stdout and stderr are piped");
            };
            // 执行器已启动：控制面收到 TaskStarted 后把任务记为 running（超时也从这时开始算，见 wait）。
            // 先于日志进入同一个通道，控制面总是先看到 TaskStarted。
            telemetry.send(AgentMessage {
                body: Some(agent_message::Body::Started(TaskStarted {
                    task_id: task.task_id.clone(),
                    attempt: task.attempt,
                })),
            });
            let pump = Pump::start(task, stdout, stderr, dir.to_path_buf(), telemetry.clone());
            Ok(Running {
                process,
                paths,
                task: task.clone(),
                pump,
                grace,
            })
        }
        Err(error) => Err(failure(
            task,
            ErrorKind::EnvError,
            format!(
                "无法启动共享 venv 中的 Python（{}）：{error}",
                venv.python().display()
            ),
        )),
    }
}

impl Running {
    /// 任务的产物目录。
    pub fn artifacts_dir(&self) -> PathBuf {
        self.paths.artifacts.clone()
    }

    /// 等待执行器退出并读取结果。超过 `timeout_seconds`（0 表示不限制）时终止进程树，以 timeout 失败；
    /// 收到取消请求时先写取消标记再终止进程树，以 cancelled 上报（[`Running::cancel`]）。
    pub async fn wait(mut self, mut cancel: CancelSignal) -> TaskResult {
        let seconds = self.task.timeout_seconds;
        let deadline = (seconds > 0)
            .then(|| tokio::time::Instant::now() + Duration::from_secs(seconds.into()));
        let mut cancellable = true;
        let status = loop {
            let requested = *cancel.borrow_and_update();
            if let Some(force) = requested {
                return self.cancel(force, cancel).await;
            }
            tokio::select! {
                status = self.process.wait() => break status,
                () = sleep_until(deadline) => return self.time_out(seconds).await,
                changed = cancel.changed(), if cancellable => cancellable = changed.is_ok(),
            }
        };
        // 日志和最后一次进度先于结果发出；之后 stderr.log 也已完整。
        self.pump.finish().await;
        let task = &self.task;
        let paths = &self.paths;
        let status = match status {
            Ok(status) => status,
            Err(error) => {
                return failure(
                    task,
                    ErrorKind::NodeError,
                    format!("等待执行器失败：{error}"),
                );
            }
        };

        let output = tokio::fs::read(&paths.output)
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Output>(&bytes).ok());
        match output {
            Some(Output::Success { outputs }) if status.success() => success(task, &outputs),
            Some(Output::Failed { error }) => {
                let message = if error.traceback.is_empty() {
                    error.message
                } else {
                    format!("{}\n\n{}", error.message, error.traceback.trim_end())
                };
                failure(task, ErrorKind::NodeError, message)
            }
            _ => failure(
                task,
                ErrorKind::NodeError,
                format!(
                    "执行器异常退出（{status}），没有写出结果\n\n{}",
                    stderr_tail(&paths.stderr).await
                ),
            ),
        }
    }
}

/// 到 deadline 为止；没有 deadline 时永远不返回。
async fn sleep_until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

impl Running {
    /// 取消任务（docs/SEMANTICS.md §3.4）：先写取消标记，再优雅终止进程树，宽限期过后强制杀掉；
    /// 强制取消（或优雅终止期间又收到强制取消）时立即杀掉。
    async fn cancel(mut self, force: bool, mut cancel: CancelSignal) -> TaskResult {
        if let Err(error) = tokio::fs::write(&self.paths.cancel, b"").await {
            eprintln!(
                "cannot write cancel marker {}: {error}",
                self.paths.cancel.display()
            );
        }
        let graceful = if force {
            None
        } else {
            let escalate = async {
                if cancel.wait_for(|c| *c == Some(true)).await.is_err() {
                    std::future::pending::<()>().await;
                }
            };
            tokio::select! {
                status = self.process.terminate(self.grace) => Some(status),
                () = escalate => None,
            }
        };
        let terminated = graceful.is_some();
        let status = match graceful {
            Some(status) => status,
            None => {
                self.process.kill();
                self.process.wait().await
            }
        };
        let how = match (terminated, status) {
            (_, Err(error)) => format!("终止进程树时出错：{error}"),
            (true, Ok(_)) => "已终止进程树".to_string(),
            (false, Ok(_)) => "已强制杀掉进程树".to_string(),
        };
        self.pump.finish().await;
        TaskResult {
            task_id: self.task.task_id.clone(),
            attempt: self.task.attempt,
            status: TaskStatus::Cancelled.into(),
            outputs_json: String::new(),
            error: Some(TaskError {
                kind: ErrorKind::Unspecified.into(),
                message: format!("任务已取消，{how}"),
            }),
        }
    }

    async fn time_out(mut self, seconds: u32) -> TaskResult {
        let killed = match self.process.terminate(self.grace).await {
            Ok(_) => "已终止进程树".to_string(),
            Err(error) => format!("终止进程树时出错：{error}"),
        };
        // 进程树被杀后管道关闭：把已经产生的日志和最后一次进度发完再报告超时。
        self.pump.finish().await;
        failure(
            &self.task,
            ErrorKind::Timeout,
            format!("任务执行超过 {seconds} 秒，{killed}"),
        )
    }
}

async fn stderr_tail(path: &Path) -> String {
    let bytes = tokio::fs::read(path).await.unwrap_or_default();
    let start = bytes.len().saturating_sub(STDERR_TAIL_BYTES);
    String::from_utf8_lossy(&bytes[start..])
        .trim_end()
        .to_string()
}
