//! sfly Agent：主动连接控制面的 Agent 网关（gRPC 双向流），在共享 venv 中执行任务。
//!
//! - [`connect`] 完成一次 Hello → Welcome 握手；
//! - [`run`] 是 Agent 主循环：连接、接收任务、上报结果，断线后自动重连。
//!
//! 标准输出是事件流（每行一个 JSON，例如 `{"event":"welcome","name":"..."}`），日志写到标准错误。

pub mod executor;
pub mod venv;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, bail};
use tokio::sync::{Mutex, mpsc};
use tokio_stream::wrappers::ReceiverStream;
use tonic::Streaming;

/// 由 `proto/sfly/agent/v1/agent.proto` 生成（见 build.rs）。
pub mod proto {
    tonic::include_proto!("sfly.agent.v1");
}

use proto::agent_gateway_client::AgentGatewayClient;
use proto::{
    AgentMessage, AssignTask, ErrorKind, Hello, InstalledPackage, ServerMessage, TaskResult,
    Welcome, agent_message, server_message,
};
use venv::{PackageMetadata, SharedVenv};

/// Agent 程序版本（随 Hello 上报）。
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 默认并发槽位数。
pub const DEFAULT_SLOTS: u32 = 4;

/// 重连等待：从 MIN 开始翻倍，最多 MAX；成功连上后重置。
const RECONNECT_MIN: Duration = Duration::from_millis(500);
const RECONNECT_MAX: Duration = Duration::from_secs(10);

/// Agent 配置。
#[derive(Debug, Clone)]
pub struct Config {
    /// 控制面 Agent 网关地址，例如 `http://127.0.0.1:50051`。
    pub server: String,
    /// Agent 名称，全局唯一。
    pub name: String,
    /// 可选的共享注册令牌。
    pub token: Option<String>,
    /// 并发槽位数（随 Hello 上报，控制面按它限制派发）。
    pub slots: u32,
    /// 共享 venv 路径。
    pub venv: PathBuf,
    /// 任务工作目录的根目录。
    pub work_dir: PathBuf,
    /// 安装节点包依赖用的 PyPI 镜像地址（#6 使用）。
    pub index_url: Option<String>,
}

impl Config {
    pub fn new(server: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            server: server.into(),
            name: name.into(),
            token: None,
            slots: DEFAULT_SLOTS,
            venv: PathBuf::from("venv"),
            work_dir: PathBuf::from("work"),
            index_url: None,
        }
    }
}

/// 已完成握手的连接。
pub struct Connection {
    pub welcome: Welcome,
    /// 发往控制面的消息。
    pub outbound: mpsc::Sender<AgentMessage>,
    /// 控制面推送的消息。
    pub inbound: Streaming<ServerMessage>,
}

/// 连接控制面，发送 Hello（带上已安装的节点包）并等待 Welcome。
pub async fn connect(
    config: &Config,
    installed_packages: Vec<InstalledPackage>,
) -> anyhow::Result<Connection> {
    let mut client = AgentGatewayClient::connect(config.server.clone())
        .await
        .with_context(|| format!("connect to control plane at {}", config.server))?;

    let (outbound, rx) = mpsc::channel(64);
    outbound
        .send(AgentMessage {
            body: Some(agent_message::Body::Hello(Hello {
                name: config.name.clone(),
                token: config.token.clone().unwrap_or_default(),
                agent_version: AGENT_VERSION.to_string(),
                os: std::env::consts::OS.to_string(),
                arch: std::env::consts::ARCH.to_string(),
                slots: config.slots,
                installed_packages,
            })),
        })
        .await
        .context("queue hello")?;

    let mut inbound = client
        .session(ReceiverStream::new(rx))
        .await
        .context("open agent stream")?
        .into_inner();

    match inbound.message().await.context("wait for welcome")? {
        Some(ServerMessage {
            body: Some(server_message::Body::Welcome(welcome)),
        }) => Ok(Connection {
            welcome,
            outbound,
            inbound,
        }),
        Some(other) => bail!("expected Welcome, got {other:?}"),
        None => bail!("control plane closed the stream before Welcome"),
    }
}

/// 向标准输出写一条事件。
fn emit(event: serde_json::Value) {
    println!("{event}");
}

/// 共享 venv 中已安装节点包的缓存。
struct Inventory {
    venv: SharedVenv,
    packages: Mutex<Vec<PackageMetadata>>,
}

impl Inventory {
    /// 重新读取已安装的节点包；失败时记录日志并视为没有安装任何包。
    async fn refresh(&self) -> Vec<InstalledPackage> {
        let packages = match self.venv.installed().await {
            Ok(packages) => packages,
            Err(error) => {
                eprintln!("cannot list packages in shared venv: {error:#}");
                Vec::new()
            }
        };
        let summary = packages
            .iter()
            .map(|p| InstalledPackage {
                name: p.name.clone(),
                version: p.version.clone(),
            })
            .collect();
        *self.packages.lock().await = packages;
        summary
    }

    async fn find(&self, task: &AssignTask) -> Option<Result<String, TaskResult>> {
        let packages = self.packages.lock().await;
        let package = packages.iter().find(|p| p.name == task.package)?;
        if package.version != task.package_version {
            return None;
        }
        Some(match package.nodes.iter().find(|n| n.name == task.node) {
            Some(node) => Ok(node.entry.clone()),
            None => Err(executor::failure(
                task,
                ErrorKind::ConfigError,
                format!(
                    "节点包 {}@{} 中没有节点 {}",
                    task.package, task.package_version, task.node
                ),
            )),
        })
    }

    /// 节点入口；缓存中没有该包版本时重新读取一次。
    async fn entry(&self, task: &AssignTask) -> Result<String, TaskResult> {
        if let Some(found) = self.find(task).await {
            return found;
        }
        self.refresh().await;
        if let Some(found) = self.find(task).await {
            return found;
        }
        let installed = self
            .packages
            .lock()
            .await
            .iter()
            .find(|p| p.name == task.package)
            .map(|p| format!("（已安装 {}@{}）", p.name, p.version))
            .unwrap_or_default();
        Err(executor::failure(
            task,
            ErrorKind::EnvError,
            format!(
                "节点包 {}@{} 没有安装在共享 venv 中{installed}",
                task.package, task.package_version
            ),
        ))
    }
}

struct Runtime {
    inventory: Inventory,
    work_dir: PathBuf,
    results: mpsc::UnboundedSender<TaskResult>,
}

impl Runtime {
    async fn run_task(&self, task: AssignTask) {
        let result = match self.inventory.entry(&task).await {
            Ok(entry) => {
                executor::execute(&self.inventory.venv, &self.work_dir, &task, &entry).await
            }
            Err(result) => result,
        };
        let _ = self.results.send(result);
    }
}

/// Agent 主循环：连接控制面并执行任务；连接失败或断开后按退避时间自动重连。
/// 只有不可恢复的错误（例如令牌被拒绝）才会返回。
///
/// 任务结果在收到控制面的 Ack 之前一直保留，每次重新连接后再次上报（控制面按 task_id + attempt 幂等处理）。
pub async fn run(config: Config) -> anyhow::Result<()> {
    std::fs::create_dir_all(&config.work_dir)
        .with_context(|| format!("create work dir {}", config.work_dir.display()))?;
    let work_dir = std::fs::canonicalize(&config.work_dir)?;
    // 共享 venv 不存在时照常连接：已安装的包为空，任务以 env_error 失败。
    let venv =
        std::fs::canonicalize(&config.venv).or_else(|_| std::path::absolute(&config.venv))?;

    let (results_tx, mut results_rx) = mpsc::unbounded_channel();
    let runtime = Arc::new(Runtime {
        inventory: Inventory {
            venv: SharedVenv::new(venv),
            packages: Mutex::new(Vec::new()),
        },
        work_dir,
        results: results_tx,
    });
    let mut unacked: BTreeMap<(String, u32), TaskResult> = BTreeMap::new();
    let mut delay = RECONNECT_MIN;

    loop {
        let installed = runtime.inventory.refresh().await;
        match connect(&config, installed).await {
            Ok(connection) => {
                delay = RECONNECT_MIN;
                emit(serde_json::json!({ "event": "welcome", "name": config.name }));
                match serve(connection, &runtime, &mut results_rx, &mut unacked).await {
                    Ok(()) => eprintln!("control plane closed the stream"),
                    Err(error) => eprintln!("connection lost: {error:#}"),
                }
            }
            Err(error) => {
                if let Some(status) = error.downcast_ref::<tonic::Status>()
                    && status.code() == tonic::Code::Unauthenticated
                {
                    return Err(error);
                }
                eprintln!("cannot connect: {error:#}");
            }
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(RECONNECT_MAX);
    }
}

fn result_message(result: TaskResult) -> AgentMessage {
    AgentMessage {
        body: Some(agent_message::Body::Result(result)),
    }
}

/// 在一条连接上收发消息，直到连接结束。
async fn serve(
    mut connection: Connection,
    runtime: &Arc<Runtime>,
    results: &mut mpsc::UnboundedReceiver<TaskResult>,
    unacked: &mut BTreeMap<(String, u32), TaskResult>,
) -> anyhow::Result<()> {
    for result in unacked.values() {
        connection
            .outbound
            .send(result_message(result.clone()))
            .await?;
    }
    loop {
        tokio::select! {
            message = connection.inbound.message() => {
                let Some(message) = message? else { return Ok(()) };
                match message.body {
                    Some(server_message::Body::Assign(task)) => {
                        let runtime = runtime.clone();
                        tokio::spawn(async move { runtime.run_task(task).await });
                    }
                    Some(server_message::Body::Ack(ack)) => {
                        unacked.remove(&(ack.task_id, ack.attempt));
                    }
                    other => eprintln!("ignored message from control plane: {other:?}"),
                }
            }
            Some(result) = results.recv() => {
                unacked.insert((result.task_id.clone(), result.attempt), result.clone());
                connection.outbound.send(result_message(result)).await?;
            }
        }
    }
}
