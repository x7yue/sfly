//! sfly Agent：主动连接控制面的 Agent 网关（gRPC 双向流），在共享 venv 中执行任务。
//!
//! - [`connect`] 完成一次 Hello → Welcome 握手；
//! - [`run`] 是 Agent 主循环：连接、接收任务、上报结果，断线后自动重连。
//!
//! 任务需要的节点包版本没有安装时，先下载并安装（[`install`]）；安装与启动新任务互斥。
//! `sfly dev` 通过本地 socket 让 Agent 加载开发版本 `包名@dev`（[`dev`]）。
//!
//! 标准输出是事件流（每行一个 JSON，例如 `{"event":"welcome","name":"..."}`），日志写到标准错误。

pub mod dev;
pub mod executor;
pub mod install;
pub mod logs;
pub mod process_tree;
pub mod venv;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, bail};
use tokio::sync::{Mutex, RwLock, mpsc, watch};
use tokio_stream::wrappers::ReceiverStream;
use tonic::Streaming;

/// 由 `proto/sfly/agent/v1/agent.proto` 生成（见 build.rs）。
pub mod proto {
    tonic::include_proto!("sfly.agent.v1");
}

use dev::{DEV_VERSION, DevRegistry, DevReply, DevRequest};
use install::Installer;
use proto::agent_gateway_client::AgentGatewayClient;
use proto::{
    AgentMessage, AssignTask, CancelTask, DevPackage, ErrorKind, Hello, InstallState,
    InstallStatus, InstalledPackage, ServerMessage, TaskResult, Welcome, agent_message,
    server_message,
};
use venv::{Installed, SharedVenv};

/// Agent 程序版本（随 Hello 上报）。
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 默认并发槽位数。
pub const DEFAULT_SLOTS: u32 = 4;

/// 终止任务时从优雅终止到强制杀掉进程树的默认宽限期（docs/SEMANTICS.md §3.4）。
pub const DEFAULT_TERMINATE_GRACE: Duration = Duration::from_secs(10);

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
    /// 安装节点包依赖用的 PyPI 镜像地址；未设置时使用 uv 自己的配置。
    pub index_url: Option<String>,
    /// uv 可执行文件。
    pub uv: PathBuf,
    /// `sfly dev` 连接的本地 socket；未设置时为 `<work_dir>/agent.sock`。
    pub dev_socket: Option<PathBuf>,
    /// 超时和取消时从优雅终止到强制杀掉进程树的宽限期。
    pub terminate_grace: Duration,
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
            uv: PathBuf::from("uv"),
            dev_socket: None,
            terminate_grace: DEFAULT_TERMINATE_GRACE,
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

/// 连接控制面，发送 Hello（带上已安装的节点包和开发版本）并等待 Welcome。
pub async fn connect(
    config: &Config,
    installed_packages: Vec<InstalledPackage>,
    dev_packages: Vec<DevPackage>,
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
                dev_packages,
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
    installed: Mutex<Installed>,
}

impl Inventory {
    /// 重新读取已安装的节点包；失败时记录日志并视为没有安装任何包。
    async fn refresh(&self) -> Vec<InstalledPackage> {
        let installed = match self.venv.installed().await {
            Ok(installed) => installed,
            Err(error) => {
                eprintln!("cannot list packages in shared venv: {error:#}");
                Installed::default()
            }
        };
        *self.installed.lock().await = installed;
        self.summary().await
    }

    async fn summary(&self) -> Vec<InstalledPackage> {
        self.installed
            .lock()
            .await
            .packages
            .iter()
            .map(|p| InstalledPackage {
                name: p.name.clone(),
                version: p.version.clone(),
            })
            .collect()
    }

    /// 任务需要的包版本已安装时给出节点入口（包里没有该节点时是 config_error 结果）。
    async fn find(&self, task: &AssignTask) -> Option<Result<String, TaskResult>> {
        let installed = self.installed.lock().await;
        let package = installed.packages.iter().find(|p| p.name == task.package)?;
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
}

struct Runtime {
    /// Agent 名称（用于错误消息）。
    name: String,
    inventory: Inventory,
    dev: DevRegistry,
    installer: Installer,
    work_dir: PathBuf,
    terminate_grace: Duration,
    /// 安装与启动新任务互斥：启动任务（查找入口到子进程启动）持有读锁，安装持有写锁。
    /// 已经在运行的任务不持有锁，安装期间照常运行。
    gate: RwLock<()>,
    results: mpsc::UnboundedSender<TaskResult>,
    installs: mpsc::UnboundedSender<InstallStatus>,
    /// 任务的日志与进度（[`logs`]）。
    telemetry: logs::Telemetry,
    /// 正在执行（含安装中）的任务的取消信号，键为 (task_id, attempt)。
    cancels: std::sync::Mutex<HashMap<(String, u32), CancelSender>>,
}

/// 发送任务的取消请求（见 [`executor::CancelSignal`]）。
type CancelSender = watch::Sender<Option<bool>>;

impl Runtime {
    async fn run_task(&self, task: AssignTask) {
        let key = (task.task_id.clone(), task.attempt);
        let (cancel_tx, cancel) = watch::channel(None);
        self.cancels.lock().unwrap().insert(key.clone(), cancel_tx);
        let result = match self.start_task(&task).await {
            // 安装期间收到的取消在子进程启动后立即生效。
            Ok(running) => running.wait(cancel).await,
            Err(result) => result,
        };
        self.cancels.lock().unwrap().remove(&key);
        let _ = self.results.send(result);
    }

    /// 处理控制面的取消指令；任务不在这个 Agent 上执行（或已经结束）时忽略。
    /// 优雅取消之后再收到强制取消会升级为立即杀掉。
    fn cancel_task(&self, cancel: &CancelTask) {
        let cancels = self.cancels.lock().unwrap();
        let Some(tx) = cancels.get(&(cancel.task_id.clone(), cancel.attempt)) else {
            eprintln!(
                "ignored cancel for task {} attempt {}: not running here",
                cancel.task_id, cancel.attempt
            );
            return;
        };
        tx.send_if_modified(|current| {
            let next = Some(current.unwrap_or(false) || cancel.force);
            let changed = *current != next;
            *current = next;
            changed
        });
    }

    async fn start_task(&self, task: &AssignTask) -> Result<executor::Running, TaskResult> {
        if task.package_version == DEV_VERSION && self.dev.get(&task.package).is_none() {
            return Err(executor::failure(
                task,
                ErrorKind::EnvError,
                format!(
                    "开发版本 {}@{DEV_VERSION} 没有在 Agent {} 上加载：开发版本只能在用 sfly dev 加载了它的 Agent 上执行",
                    task.package, self.name
                ),
            ));
        }
        {
            let _starting = self.gate.read().await;
            if let Some(entry) = self.inventory.find(task).await {
                return self.start(task, &entry?).await;
            }
        }
        let installing = self.gate.write().await;
        // 等锁期间可能已被其他任务装好；缓存也可能过期，重新读取一次。
        if self.inventory.find(task).await.is_none() {
            self.inventory.refresh().await;
        }
        if self.inventory.find(task).await.is_none() {
            self.install(task).await?;
        }
        let _starting = installing.downgrade();
        match self.inventory.find(task).await {
            Some(entry) => self.start(task, &entry?).await,
            None => Err(executor::failure(
                task,
                ErrorKind::EnvError,
                format!(
                    "节点包 {}@{} 安装后仍不在共享 venv 中",
                    task.package, task.package_version
                ),
            )),
        }
    }

    async fn start(&self, task: &AssignTask, entry: &str) -> Result<executor::Running, TaskResult> {
        executor::start(
            &self.inventory.venv,
            &self.work_dir,
            task,
            entry,
            &self.telemetry,
            self.terminate_grace,
        )
        .await
    }

    fn install_status(
        &self,
        package: &str,
        version: &str,
        task_id: &str,
        state: InstallState,
        output: String,
        installed_packages: Vec<InstalledPackage>,
    ) -> InstallStatus {
        InstallStatus {
            package: package.to_string(),
            version: version.to_string(),
            state: state.into(),
            task_id: task_id.to_string(),
            output,
            installed_packages,
            dev_packages: self.dev.list().iter().map(|e| e.to_proto()).collect(),
        }
    }

    /// 下载并安装任务需要的包版本（调用方持有写锁），通过 InstallStatus 上报状态。
    /// 开发版本用登记的可编辑 wheel 重新安装（它可能被已发布版本替换掉了）。
    async fn install(&self, task: &AssignTask) -> Result<(), TaskResult> {
        let status = |state: InstallState, output: String, installed_packages| {
            self.install_status(
                &task.package,
                &task.package_version,
                &task.task_id,
                state,
                output,
                installed_packages,
            )
        };
        let _ = self.installs.send(status(
            InstallState::Installing,
            String::new(),
            self.inventory.summary().await,
        ));
        let requires = self.inventory.installed.lock().await.requires.clone();
        let outcome = match self.dev.get(&task.package) {
            Some((_, wheel)) if task.package_version == DEV_VERSION => {
                self.installer
                    .install_dev(&task.package, &wheel, &requires)
                    .await
            }
            _ => self.installer.install(task, &requires).await,
        };
        let installed = self.inventory.refresh().await;
        match outcome {
            Ok(output) => {
                let _ = self
                    .installs
                    .send(status(InstallState::Installed, output, installed));
                Ok(())
            }
            Err(error) => {
                eprintln!("{}", error.message);
                let output = if error.output.is_empty() {
                    error.message.clone()
                } else {
                    error.output
                };
                let _ = self
                    .installs
                    .send(status(InstallState::Failed, output, installed));
                Err(executor::failure(task, ErrorKind::EnvError, error.message))
            }
        }
    }
}

impl Runtime {
    /// 处理 `sfly dev`：登记开发版本，以可编辑方式装进共享 venv（与启动新任务互斥），上报控制面。
    async fn load_dev(&self, request: DevRequest) -> DevReply {
        let _installing = self.gate.write().await;
        let (entry, wheel) = match self.dev.register(&request) {
            Ok(registered) => registered,
            Err(error) => return DevReply::error(format!("登记开发版本失败：{error:#}")),
        };
        let package = entry.package.as_str();
        let _ = self.installs.send(self.install_status(
            package,
            DEV_VERSION,
            "",
            InstallState::Installing,
            String::new(),
            self.inventory.summary().await,
        ));
        let requires = self.inventory.installed.lock().await.requires.clone();
        let outcome = self.installer.install_dev(package, &wheel, &requires).await;
        if outcome.is_err() {
            // 没装上的开发版本不算加载成功。
            self.dev.remove(package);
        }
        let installed = self.inventory.refresh().await;
        let (state, reply) = match outcome {
            Ok(output) => (
                InstallState::Installed,
                DevReply {
                    ok: true,
                    message: format!(
                        "已在 Agent {} 上加载开发版本 {package}@{DEV_VERSION}（源码 {}）",
                        self.name, entry.source
                    ),
                    output,
                },
            ),
            Err(error) => {
                eprintln!("{}", error.message);
                (
                    InstallState::Failed,
                    DevReply {
                        ok: false,
                        output: error.output,
                        message: error.message,
                    },
                )
            }
        };
        let _ = self.installs.send(self.install_status(
            package,
            DEV_VERSION,
            "",
            state,
            reply.output.clone(),
            installed,
        ));
        reply
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

    let scratch = work_dir.join(".install");
    let (results_tx, mut results_rx) = mpsc::unbounded_channel();
    let (installs_tx, mut installs_rx) = mpsc::unbounded_channel();
    let (telemetry_tx, mut telemetry_rx) = mpsc::unbounded_channel();
    let runtime = Arc::new(Runtime {
        name: config.name.clone(),
        dev: DevRegistry::new(work_dir.join(".dev")),
        inventory: Inventory {
            venv: SharedVenv::new(venv.clone()),
            installed: Mutex::new(Installed::default()),
        },
        installer: Installer {
            venv: SharedVenv::new(venv),
            scratch,
            index_url: config.index_url.clone(),
            uv: config.uv.clone(),
            http: reqwest::Client::new(),
        },
        work_dir: work_dir.clone(),
        terminate_grace: config.terminate_grace,
        gate: RwLock::new(()),
        results: results_tx,
        installs: installs_tx,
        telemetry: telemetry_tx,
        cancels: std::sync::Mutex::new(HashMap::new()),
    });
    let dev_socket = config
        .dev_socket
        .clone()
        .unwrap_or_else(|| work_dir.join("agent.sock"));
    // 本地 socket 不可用时照常运行，只是不能用 sfly dev。
    match dev::serve(&dev_socket, runtime.clone()) {
        Ok(_) => eprintln!("sfly dev socket: {}", dev_socket.display()),
        Err(error) => eprintln!("sfly dev is unavailable: {error:#}"),
    }
    let mut unacked: BTreeMap<(String, u32), TaskResult> = BTreeMap::new();
    let mut delay = RECONNECT_MIN;

    loop {
        // 断线期间的安装状态已经过时：重新连接时 Hello 带上最新的已安装列表。
        while installs_rx.try_recv().is_ok() {}
        let installed = runtime.inventory.refresh().await;
        let dev_packages = runtime.dev.list().iter().map(|e| e.to_proto()).collect();
        match connect(&config, installed, dev_packages).await {
            Ok(connection) => {
                delay = RECONNECT_MIN;
                emit(serde_json::json!({ "event": "welcome", "name": config.name }));
                let channels = Channels {
                    results: &mut results_rx,
                    installs: &mut installs_rx,
                    telemetry: &mut telemetry_rx,
                };
                match serve(connection, &runtime, channels, &mut unacked).await {
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

/// 任务执行方发往控制面的消息。
struct Channels<'a> {
    results: &'a mut mpsc::UnboundedReceiver<TaskResult>,
    installs: &'a mut mpsc::UnboundedReceiver<InstallStatus>,
    /// 日志与进度；先于结果处理，任务的日志总在它的结果之前发出。
    telemetry: &'a mut mpsc::UnboundedReceiver<AgentMessage>,
}

/// 在一条连接上收发消息，直到连接结束。
async fn serve(
    mut connection: Connection,
    runtime: &Arc<Runtime>,
    channels: Channels<'_>,
    unacked: &mut BTreeMap<(String, u32), TaskResult>,
) -> anyhow::Result<()> {
    let Channels {
        results,
        installs,
        telemetry,
    } = channels;
    for result in unacked.values() {
        connection
            .outbound
            .send(result_message(result.clone()))
            .await?;
    }
    loop {
        tokio::select! {
            biased;
            message = connection.inbound.message() => {
                let Some(message) = message? else { return Ok(()) };
                match message.body {
                    Some(server_message::Body::Assign(task)) => {
                        let runtime = runtime.clone();
                        tokio::spawn(async move { runtime.run_task(task).await });
                    }
                    Some(server_message::Body::Cancel(cancel)) => runtime.cancel_task(&cancel),
                    Some(server_message::Body::Ack(ack)) => {
                        unacked.remove(&(ack.task_id, ack.attempt));
                    }
                    other => eprintln!("ignored message from control plane: {other:?}"),
                }
            }
            Some(message) = telemetry.recv() => {
                connection.outbound.send(message).await?;
            }
            Some(result) = results.recv() => {
                unacked.insert((result.task_id.clone(), result.attempt), result.clone());
                connection.outbound.send(result_message(result)).await?;
            }
            Some(status) = installs.recv() => {
                connection
                    .outbound
                    .send(AgentMessage { body: Some(agent_message::Body::Install(status)) })
                    .await?;
            }
        }
    }
}
