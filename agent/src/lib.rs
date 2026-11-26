//! sfly Agent：主动连接控制面的 Agent 网关（gRPC 双向流），在共享 venv 中执行任务。
//!
//! - [`connect`] 完成一次 Hello → Welcome 握手；
//! - [`run`] 是 Agent 主循环：连接、接收任务、上报结果，断线后自动重连。
//!
//! 任务需要的节点包版本没有安装时，先下载并安装（[`install`]）；安装与启动新任务互斥。
//! `sfly dev` 通过本地 socket（[`socket`]）让 Agent 加载开发版本 `包名@dev`（[`dev`]）。
//!
//! 其它 Agent 连接本机的端口和 Agent 能力见 [`peer`]、[`capabilities`]（ADR 0019）；节点经本地 socket 调用 Agent 能力
//! 见 [`calls`]。
//!
//! 标准输出是事件流（每行一个 JSON，例如 `{"event":"welcome","name":"..."}`），日志写到标准错误。

pub mod artifacts;
pub mod calls;
pub mod capabilities;
pub mod clock;
pub mod dev;
pub mod environment;
pub mod executor;
pub mod home;
pub mod install;
mod ledger;
pub mod logs;
pub mod metrics;
pub mod peer;
pub mod process_tree;
pub mod retention;
pub mod sdk;
pub mod secret;
mod socket;
pub mod subprocess;
pub mod time_jump;
pub mod update;
pub mod venv;

use std::collections::HashSet;
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
// 带凭据的消息（`AssignTask`、`Hello`）的 `Debug`：凭据的位置写 `<redacted>`。
mod proto_debug;

use dev::{DEV_VERSION, DevRegistry, DevReply, DevRequest};
use environment::{Mirrors, Setup};
use install::Installer;
use ledger::Ledger;
use proto::agent_gateway_client::AgentGatewayClient;
use proto::{
    AgentMessage, AssignTask, DevPackage, ErrorKind, Heartbeat, Hello, InstallState, InstallStatus,
    InstalledPackage, PeerEndpoint, RunningTask, ServerMessage, TaskAction, TaskResult, Welcome,
    agent_message, server_message,
};
use venv::{Installed, SharedVenv};

/// Agent 程序版本（默认随 Hello 上报，见 [`Config::version`]）。
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 默认并发槽位数。
pub const DEFAULT_SLOTS: u32 = 4;

/// 终止任务时从优雅终止到强制杀掉进程树的默认宽限期（docs/SEMANTICS.md §3.4）。
pub const DEFAULT_TERMINATE_GRACE: Duration = Duration::from_secs(10);

/// 重连等待：从 MIN 开始翻倍，最多 MAX；连得稳（撑过 [`STABLE_CONNECTION`]）之后才重置，握手成功不重置。
const RECONNECT_MIN: Duration = Duration::from_millis(500);
const RECONNECT_MAX: Duration = Duration::from_secs(10);
/// 连上之后至少撑过这么久才算连得稳：重连的等待只在连得稳之后才回到 [`RECONNECT_MIN`]。握手一成功就重置的话，
/// 握手成功、马上又被断开（比如重发的结果超过控制面一条消息的上限，每次都被拒）的 Agent 会每半秒重连一次，
/// 控制面每次都要为它走一遍握手、续约（#723）。
pub const STABLE_CONNECTION: Duration = Duration::from_secs(30);

/// 控制面明确拒绝了这条连接（凭据无效或被吊销、名字和凭据不一致、Agent 被停用……）之后的重试等待：从 MIN 开始翻倍，
/// 最多 MAX，连上一次就重置（[`Config::rejected_retry_min`]、[`Config::rejected_retry_max`] 默认取这两个值，测试里改短）。
/// 比普通的重连慢得多：被拒绝不是网络问题，要管理员在控制面改好才会变，快速重试只会刷屏、白白占用控制面。
pub const REJECTED_RETRY_MIN: Duration = Duration::from_secs(30);
pub const REJECTED_RETRY_MAX: Duration = Duration::from_secs(300);

/// Welcome 没有给出心跳间隔时的默认值（控制面默认租约 30 秒的三分之一）。
pub const DEFAULT_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);

/// Agent 配置。
#[derive(Debug, Clone)]
pub struct Config {
    /// 控制面 Agent 网关地址，例如 `http://127.0.0.1:50051`。
    pub server: String,
    /// Agent 名称，全局唯一。
    pub name: String,
    /// Agent 凭据（`sfly_agt_` 开头，按台签发，管理员在控制台或命令行签发）；过渡期里也可以是共享注册令牌或没有。
    /// 用 [`secret::Secret`] 包着：配置被 `{:?}` 打印时不会把它写出去。
    pub token: Option<secret::Secret>,
    /// 被控制面拒绝之后的重试等待的起点和封顶（[`REJECTED_RETRY_MIN`]、[`REJECTED_RETRY_MAX`]），
    /// 以及加不加抖动（默认加：每次等待取算出来的时长的一半到全部）。
    pub rejected_retry_min: Duration,
    pub rejected_retry_max: Duration,
    pub rejected_retry_jitter: bool,
    /// 并发槽位数（随 Hello 上报，控制面按它限制派发）。
    pub slots: u32,
    /// 共享 venv 路径。
    pub venv: PathBuf,
    /// 任务工作目录的根目录。
    pub work_dir: PathBuf,
    /// 后台进程目录的根目录：每次运行一个子目录 `<procs_dir>/<运行 ID>/`，通过 `SFLY_PROCS` 交给执行器，
    /// 和任务目录按同一个保留期清理（[`retention::Tracker::sweep_procs`]）。
    pub procs_dir: PathBuf,
    /// 任务目录在结果被 Ack 后保留多久（0 表示立即删除，[`retention`]）。
    pub task_dir_retention: Duration,
    /// 两次扫描工作目录、删除过期任务目录的间隔（[`retention::SWEEP_INTERVAL`]，测试里改短）。
    pub task_dir_sweep_interval: Duration,
    /// 本机对镜像的覆盖，优先于控制面下发的镜像（[`environment::Mirrors`]）；
    /// 都没有时使用 uv 自己的配置。
    pub mirrors: environment::LocalMirrors,
    /// 下载 uv 安装脚本、运行安装脚本时 curl、wget 带的 User-Agent（[`environment::default_user_agent`]）。
    pub user_agent: String,
    /// uv 可执行文件。
    pub uv: PathBuf,
    /// uv 由 Agent 管理（没有指定 `--uv`，`uv` 是 `SFLY_HOME/bin/uv`）：不存在时从镜像安装（[`environment`]）。
    pub manage_uv: bool,
    /// 本地 socket（[`socket`]）：`sfly dev` 加载开发版本、节点调用 Agent 能力都经过它；未设置时为 `<work_dir>/agent.sock`。
    /// 命令行参数沿用最早的名字 `--dev-socket`（`SFLY_DEV_SOCKET`，SDK 的 `sfly dev` 也按这个名字找）。
    pub local_socket: Option<PathBuf>,
    /// 超时和取消时从优雅终止到强制杀掉进程树的宽限期。
    pub terminate_grace: Duration,
    /// 共享 venv 不存在时，`uv venv --python` 用的解释器（版本号或路径）；
    /// 未设置时为 [`environment::PYTHON_VERSION`]。
    pub python: Option<String>,
    /// 与控制面断开期间最多排队多少字节的日志；超出后丢弃新的日志批次（控制面看到序号缺口）。
    pub telemetry_queue_bytes: usize,
    /// 与控制面断开期间最多排队多少个指标点（所有任务合计）；超出后丢弃最早的点，恢复后上报丢弃计数。
    pub metric_queue_points: usize,
    /// 只在测试中使用：转发器每秒最多处理多少字节的标准输出 / 标准错误 / 事件管道内容（0 = 不限制，[`logs::Pump::start`]）。
    pub log_forward_rate: u64,
    /// 连上之后撑过这么久才算连得稳、重连的等待才回到最短（默认 [`STABLE_CONNECTION`]，测试里改短）。
    pub stable_connection: Duration,
    /// 自更新下载新二进制时每次读取的超时（[`update::DEFAULT_READ_TIMEOUT`]）。
    pub update_read_timeout: Duration,
    /// 随 Hello 上报的 Agent 版本：默认 [`AGENT_VERSION`]，测试用隐藏参数 `--version-override` 覆盖，
    /// 让同一个二进制扮演新旧两个版本。与控制面版本比较、选择 SDK 运行时都用它。
    pub version: String,
    /// 只在测试中使用：Agent 时间偏移文件（隐藏参数 `--agent-time-offset-file`，[`clock::use_offset_file`]）。
    pub agent_time_offset_file: Option<PathBuf>,
    /// 能否自更新（ADR 0014，[`update`]）。
    pub self_update: update::SelfUpdate,
    /// 本进程是不是试用中的新版本（[`update::trial`]）：main 在启动最早期创建。
    pub trial: Arc<update::Trial>,
    /// 供其它 Agent 连接的端口（[`peer`]）；0 由系统分配。
    pub listen_port: u16,
    /// 安装时显式配置的对外地址（[`peer::parse_public_address`]）；没有配置时控制面用连接来源地址。
    pub public_address: Option<String>,
    /// 监听目录时队列里最多有多少个还没发出的事件，超过时重新给快照
    /// （[`capabilities::file_watch::DEFAULT_QUEUE_EVENTS`]；测试用隐藏参数 `--watch-queue-events` 改小，模拟调用方读得太慢）。
    pub watch_queue_events: usize,
}

impl Config {
    pub fn new(server: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            server: server.into(),
            name: name.into(),
            token: None,
            rejected_retry_min: REJECTED_RETRY_MIN,
            rejected_retry_max: REJECTED_RETRY_MAX,
            rejected_retry_jitter: true,
            slots: DEFAULT_SLOTS,
            venv: PathBuf::from("venv"),
            work_dir: PathBuf::from("work"),
            procs_dir: PathBuf::from("procs"),
            task_dir_retention: retention::DEFAULT_RETENTION,
            task_dir_sweep_interval: retention::SWEEP_INTERVAL,
            mirrors: environment::LocalMirrors::default(),
            user_agent: environment::default_user_agent(),
            uv: PathBuf::from("uv"),
            manage_uv: false,
            local_socket: None,
            terminate_grace: DEFAULT_TERMINATE_GRACE,
            python: None,
            telemetry_queue_bytes: logs::DEFAULT_TELEMETRY_QUEUE_BYTES,
            metric_queue_points: metrics::DEFAULT_METRIC_QUEUE_POINTS,
            log_forward_rate: 0,
            stable_connection: STABLE_CONNECTION,
            update_read_timeout: update::DEFAULT_READ_TIMEOUT,
            version: AGENT_VERSION.to_string(),
            agent_time_offset_file: None,
            self_update: update::SelfUpdate::detect(true, None),
            trial: Arc::new(update::Trial::off()),
            listen_port: peer::DEFAULT_LISTEN_PORT,
            public_address: None,
            watch_queue_events: capabilities::file_watch::DEFAULT_QUEUE_EVENTS,
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

/// Hello 里随 Agent 当前状态变化的内容（名称、令牌、版本等其余字段来自 [`Config`]）。
#[derive(Debug, Clone, Default)]
pub struct HelloContent {
    /// 共享 venv 中已安装的节点包。
    pub installed_packages: Vec<InstalledPackage>,
    /// 以开发模式加载的节点包。
    pub dev_packages: Vec<DevPackage>,
    /// 手上的任务：正在执行（含安装中）的，以及已经结束、结果还没收到 Ack 的。
    pub running_tasks: Vec<RunningTask>,
    /// 供其它 Agent 连接的端口（[`peer::serve`] 的结果）；没有监听时为 None。
    pub peer: Option<PeerEndpoint>,
}

/// 连接控制面，发送 Hello（带上已安装的节点包、开发版本和手上的任务）并等待 Welcome。
pub async fn connect(config: &Config, content: HelloContent) -> anyhow::Result<Connection> {
    let HelloContent {
        installed_packages,
        dev_packages,
        running_tasks,
        peer,
    } = content;
    let mut client = AgentGatewayClient::connect(config.server.clone())
        .await
        .with_context(|| {
            format!(
                "connect to control plane at {}",
                secret::without_userinfo(&config.server)
            )
        })?;

    let (outbound, rx) = mpsc::channel(64);
    let now = clock::Reading::now();
    outbound
        .send(AgentMessage {
            body: Some(agent_message::Body::Hello(Hello {
                name: config.name.clone(),
                token: config
                    .token
                    .as_ref()
                    .map(|token| token.expose().to_string())
                    .unwrap_or_default(),
                agent_version: config.version.clone(),
                os: std::env::consts::OS.to_string(),
                arch: std::env::consts::ARCH.to_string(),
                slots: config.slots,
                installed_packages,
                dev_packages,
                running_tasks,
                agent_time_unix_ms: now.agent_time_ms,
                monotonic_ms: now.monotonic_ms,
                capabilities: capabilities::reported(),
                peer,
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
        // 共享 venv 还没创建（在 Welcome 之后创建）：没有安装任何包。
        let installed = match self.venv.installed().await {
            Err(_) if !self.venv.python().exists() => Installed::default(),
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
    /// 这台 Agent：名称、上报的版本，和能力需要的设置（[`Config`] 里来的，启动时构造一次）。
    host: capabilities::Host,
    inventory: Inventory,
    dev: DevRegistry,
    installer: Installer,
    work_dir: PathBuf,
    /// 后台进程目录的根目录（[`Config::procs_dir`]）。
    procs_dir: PathBuf,
    /// 任务目录的保留期（[`Config::task_dir_retention`]）。
    retention: Duration,
    /// 任务目录和后台进程目录各自从哪一刻开始算保留期。
    dirs: retention::Tracker,
    /// [`Config::log_forward_rate`]。
    log_forward_rate: u64,
    /// 安装与启动新任务互斥：启动任务（查找入口到子进程启动）持有读锁，安装持有写锁。
    /// 已经在运行的任务不持有锁，安装期间照常运行。
    gate: RwLock<()>,
    installs: mpsc::UnboundedSender<InstallStatus>,
    /// 任务的日志与进度（[`logs`]）。
    telemetry: logs::Telemetry,
    /// 手上的任务：每个（任务, 尝试）在派发协议里的阶段，和它们属于哪次运行（[`ledger`]）。
    ledger: Ledger,
    /// 任务结束后上传产物（[`artifacts`]）。
    uploader: artifacts::Uploader,
    /// 下载 SDK 运行时用。
    http: reqwest::Client,
    uv: PathBuf,
    scratch: PathBuf,
    /// 本地 socket（[`socket`]）：执行器的 `SFLY_AGENT_SOCKET`，节点经它调用 Agent 能力。
    agent_socket: PathBuf,
    /// 节点调用另一台 Agent 的能力时用的连接（[`calls`]）。
    peers: calls::Peers,
}

impl Runtime {
    async fn run_task(&self, task: AssignTask, cancel: executor::CancelSignal) {
        let result = match self.start_task(&task).await {
            // 安装期间收到的取消在子进程启动后立即生效。
            Ok(running) => {
                self.ledger.started(&task.task_id, task.attempt);
                let dir = running.artifacts_dir();
                // 超时进入收尾时间时，这个任务正在进行的能力调用也放弃（和取消同一个口径，结局不变）。
                let wind_down = || {
                    self.ledger.cancel(&task.task_id, task.attempt, false);
                };
                let result = running.wait(cancel, wind_down).await;
                // 产物先于结果上传：结果上报后控制面不再接受这个任务的产物。
                self.uploader.finish(&task, &dir, result).await
            }
            Err(result) => result,
        };
        // 任务到这里结束（产物也已上传）：打上这一刻的 Agent 时间与单调时钟读数。
        let result = executor::stamp_end(result);
        let status = result.status();
        self.ledger.finish(result);
        // 结果已经交出、台账里的任务已经换了阶段之后才打这一行：测试据此等到这一刻（agent/tests/recovery.rs）。
        eprintln!(
            "task {} attempt {} finished: {status:?}",
            task.task_id, task.attempt
        );
    }

    /// 节点调用 Agent 能力（[`calls::serve`]）：按请求里的任务找到它的名单和取消信号；任务不在手上时拒绝。
    async fn call(
        &self,
        request: calls::CallRequest,
        reader: impl tokio::io::AsyncRead + Unpin + Send,
        writer: impl tokio::io::AsyncWrite + Send + Sync + 'static,
    ) {
        let task = self.ledger.calls_of(&request.task_id, request.attempt);
        calls::serve(request, reader, writer, &self.host, task, &self.peers).await;
    }

    /// 任务的结果被 Ack：任务落定时（[`Ledger::ack`]），写结束标记或删除任务目录（[`retention::Tracker::task_acked`]）；
    /// 它所属的运行没有别的任务还在手上时，运行的后台进程目录开始算保留期（[`retention::Tracker::run_ended`]）。
    fn acked(&self, task_id: &str, attempt: u32) {
        let Some(settled) = self.ledger.ack(task_id, attempt) else {
            return;
        };
        self.dirs
            .task_acked(&self.work_dir, task_id, self.retention);
        if let Some(run_id) = settled.run_ended {
            self.dirs.run_ended(&run_id);
        }
    }

    /// 在后台扫描工作目录和后台进程目录，删除超过保留期的任务目录（[`retention::Tracker::sweep`]）和运行目录
    /// （[`retention::Tracker::sweep_procs`]）：手上的任务按现在的快照，删除前再查一次（扫描期间可能收到新任务）。
    fn sweep(self: &Arc<Self>) {
        let held: HashSet<String> = self.ledger.held().into_iter().map(|t| t.task_id).collect();
        // 不再在手上的任务：没有等到 Ack 的（被控制面放弃的）从现在开始算保留期。
        for task_id in self.ledger.forget_runs_except(&held) {
            self.dirs.task_released(&task_id);
        }
        let runtime = self.clone();
        tokio::task::spawn_blocking(move || {
            let is_held =
                |task_id: &str| held.contains(task_id) || runtime.ledger.holds_task(task_id);
            runtime
                .dirs
                .sweep(&runtime.work_dir, runtime.retention, is_held);
            runtime
                .dirs
                .sweep_procs(&runtime.procs_dir, runtime.retention, |run_id| {
                    runtime
                        .ledger
                        .tasks_of_run(run_id)
                        .iter()
                        .any(|task_id| is_held(task_id))
                });
        });
    }

    async fn start_task(&self, task: &AssignTask) -> Result<executor::Running, TaskResult> {
        if task.package_version == DEV_VERSION && self.dev.get(&task.package).is_none() {
            return Err(executor::failure(
                task,
                ErrorKind::EnvError,
                format!(
                    "开发版本 {}@{DEV_VERSION} 没有在 Agent {} 上加载：开发版本只能在用 sfly dev 加载了它的 Agent 上执行",
                    task.package, self.host.name
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
        let settings = executor::Settings {
            work_root: &self.work_dir,
            procs_root: &self.procs_dir,
            grace: self.host.terminate_grace,
            log_forward_rate: self.log_forward_rate,
            agent_socket: &self.agent_socket,
        };
        executor::start(
            &self.inventory.venv,
            &settings,
            task,
            entry,
            &self.telemetry,
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
    /// 共享 venv 里的 SDK 运行时与 Agent 版本不一致（或没有安装）时，按 Welcome 给出的地址下载安装
    /// （[`sdk`]；与启动新任务互斥）。版本一致时不重装；控制面没有提供地址时只记日志，任务照常尝试执行。
    async fn ensure_sdk(&self, welcome: &Welcome) {
        let venv = &self.inventory.venv;
        let version = self.host.version.as_str();
        let installed = sdk::installed_version(venv).await;
        if installed.as_deref() == Some(version) {
            return;
        }
        if welcome.sdk_wheel_url.is_empty() {
            eprintln!(
                "shared venv has SDK {} but the agent is {version}, and the control plane offers no SDK wheel for it",
                installed.as_deref().unwrap_or("(none)")
            );
            return;
        }
        let _installing = self.gate.write().await;
        match sdk::install(
            &self.http,
            &self.uv,
            venv,
            &self.scratch,
            &welcome.sdk_wheel_url,
            &welcome.sdk_wheel_sha256,
        )
        .await
        {
            Ok(_) => {
                emit(serde_json::json!({ "event": "sdk_installed", "version": version }));
                self.inventory.refresh().await;
            }
            Err(error) => eprintln!("cannot install SDK runtime {version}: {error:#}"),
        }
    }

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
                        self.host.name, entry.source
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
/// 只有不可恢复的错误（例如环境准备失败 [`environment::EnvironmentError`]）才会返回。控制面拒绝这台 Agent 的连接
/// （凭据无效或被吊销、名字和凭据不一致、被停用……）**不退出**：按 [`REJECTED_RETRY_MIN`] 起的退避重试，管理员在
/// 控制面改好之后它自己连上（[`Rejections`]）。
///
/// 任务结果在收到控制面的 Ack 之前一直保留，每次重新连接后再次上报（控制面按 task_id + attempt 幂等处理）。
pub async fn run(config: Config) -> anyhow::Result<()> {
    if let Some(file) = &config.agent_time_offset_file {
        clock::use_offset_file(file.clone());
    }
    let http = reqwest::Client::new();
    let uv_marker = config
        .manage_uv
        .then(|| {
            config
                .uv
                .parent()
                .map(|dir| dir.join(environment::UV_UPDATE_MARKER))
        })
        .flatten();
    let updater = update::Updater::new(
        config.self_update.clone(),
        config.version.clone(),
        uv_marker,
        update::download_client(config.update_read_timeout)?,
    );
    std::fs::create_dir_all(&config.work_dir)
        .with_context(|| format!("create work dir {}", config.work_dir.display()))?;
    let work_dir = std::fs::canonicalize(&config.work_dir)?;
    std::fs::create_dir_all(&config.procs_dir)
        .with_context(|| format!("create procs dir {}", config.procs_dir.display()))?;
    let procs_dir = std::fs::canonicalize(&config.procs_dir)?;
    let venv =
        std::fs::canonicalize(&config.venv).or_else(|_| std::path::absolute(&config.venv))?;

    let scratch = work_dir.join(".install");
    let local_socket = config
        .local_socket
        .clone()
        .unwrap_or_else(|| work_dir.join("agent.sock"));
    let host = capabilities::Host {
        name: config.name.clone(),
        version: config.version.clone(),
        terminate_grace: config.terminate_grace,
        watch_queue_events: config.watch_queue_events,
    };
    let (installs_tx, mut installs_rx) = mpsc::unbounded_channel();
    let (telemetry_tx, mut telemetry_rx) =
        logs::telemetry(config.telemetry_queue_bytes, config.metric_queue_points);
    let runtime = Arc::new(Runtime {
        host: host.clone(),
        dev: DevRegistry::new(work_dir.join(".dev")),
        inventory: Inventory {
            venv: SharedVenv::new(venv.clone()),
            installed: Mutex::new(Installed::default()),
        },
        installer: Installer {
            venv: SharedVenv::new(venv),
            scratch: scratch.clone(),
            index_url: std::sync::Mutex::new(config.mirrors.pypi.clone()),
            package_index: std::sync::Mutex::new(None),
            uv: config.uv.clone(),
            http: http.clone(),
            token: config.token.clone(),
        },
        work_dir: work_dir.clone(),
        procs_dir,
        retention: config.task_dir_retention,
        dirs: retention::Tracker::new(),
        log_forward_rate: config.log_forward_rate,
        gate: RwLock::new(()),
        installs: installs_tx,
        telemetry: telemetry_tx,
        ledger: Ledger::default(),
        uploader: artifacts::Uploader {
            http: http.clone(),
            token: config.token.clone(),
        },
        http,
        uv: config.uv.clone(),
        scratch,
        agent_socket: std::path::absolute(&local_socket).unwrap_or_else(|_| local_socket.clone()),
        peers: calls::Peers::default(),
    });
    // 本地 socket 不可用时照常运行，只是不能用 sfly dev，节点也调用不了 Agent 能力（调用时报连不上本机 Agent）。
    match socket::serve(&local_socket, runtime.clone()) {
        Ok(_) => eprintln!("sfly dev socket: {}", local_socket.display()),
        Err(error) => eprintln!("sfly dev and agent capabilities are unavailable: {error:#}"),
    }
    // 端口监听不了时照常运行，只是能力不能被其它 Agent 调用（原因随 Hello 上报）。
    let endpoint = peer::serve(config.listen_port, config.public_address.clone(), host).await;
    let mut delay = RECONNECT_MIN;
    let mut rejections = Rejections::new(
        config.rejected_retry_min,
        config.rejected_retry_max,
        config.rejected_retry_jitter,
    );
    // 启动时扫描一次工作目录，之后每隔 task_dir_sweep_interval 一次（断线重连期间也照常进行）。
    let mut sweep = Sweep {
        next: tokio::time::Instant::now(),
        interval: config.task_dir_sweep_interval,
    };
    if let Some(from) = std::env::var_os(update::UPDATED_FROM_ENV) {
        eprintln!(
            "Agent 已从 {} 自更新到 {}",
            from.to_string_lossy(),
            config.version
        );
    }
    if let Some(bad) = std::env::var_os(update::ROLLED_BACK_FROM_ENV) {
        eprintln!(
            "Agent 已从坏版本 {} 回滚到 {}",
            bad.to_string_lossy(),
            config.version
        );
    }

    loop {
        // 断线期间的安装状态已经过时：重新连接时 Hello 带上最新的已安装列表。
        while installs_rx.try_recv().is_ok() {}
        if sweep.due() {
            runtime.sweep();
        }
        let installed_packages = runtime.inventory.refresh().await;
        let hello = HelloContent {
            installed_packages,
            dev_packages: runtime.dev.list().iter().map(|e| e.to_proto()).collect(),
            // 手上的任务：正在执行的，加上已经结束、结果还没收到 Ack 的（断线期间结束的也算）。
            // 清点已安装的包可能很慢，期间结束的任务也要算上（#132）：任务的清点排在它之后。
            running_tasks: runtime.ledger.hello(),
            peer: Some(endpoint.clone()),
        };
        // 试用中的新版本每次连接计一次尝试；握手成功且环境准备完成才算健康（ADR 0014）。
        config.trial.begin();
        let connected = connect(&config, hello).await;
        match &connected {
            Ok(_) => {}
            Err(error) if unreachable(error) => config.trial.end(update::Attempt::Unreachable),
            // 被控制面拒绝（凭据、停用……）也在这里：试用中的新版本一启动就被拒绝，多半是它自己的毛病
            // （握手写错了、没带上凭据）；算作失败，连续失败后回滚到旧版本，回滚之后的旧版本被拒绝时照旧
            // 不退出（下面）。不算的话它永远不回滚，也收不到修好的下一个版本。
            Err(_) => config.trial.end(update::Attempt::Failed),
        }
        match connected {
            Ok(connection) => {
                // 握手成功不重置重连的等待：连得稳了才重置（[`STABLE_CONNECTION`]，见下面 serve 结束之后）。
                if rejections.accepted() {
                    eprintln!("控制面接受了这台 Agent 的连接（之前被拒绝）");
                }
                // uv 和共享 venv 在收到 Welcome 之后才准备：控制面在 Welcome 里下发镜像配置（ADR 0012）。
                // 准备失败时 Agent 退出，不带着坏环境继续连接。
                // 本机的覆盖优先。节点包依赖（`uv pip install`）是 Agent 唯一访问 PyPI 的 uv 调用：
                // SDK 运行时 `--no-deps` 安装，`uv venv` 不解析包。
                let mirrors = Mirrors::new(&connection.welcome, &config.mirrors);
                *runtime.installer.index_url.lock().unwrap() =
                    mirrors.pypi().map(|(url, _)| url.to_string());
                // 控制面的包索引（#556）：平台自己的包（标准节点包 sfly-std）只从这里取；旧版本控制面不带这个字段。
                *runtime.installer.package_index.lock().unwrap() =
                    environment::package_index(&connection.welcome);
                if let Err(error) = prepare_environment(&config, &runtime, &mirrors).await {
                    // 试用中的新版本：计一次失败，以 systemd 会重启的退出码退出，连续失败后回滚；
                    // 否则以固定退出码退出，systemd 不再重启。
                    if config.trial.in_trial() {
                        config.trial.end(update::Attempt::Failed);
                        return Err(update::TrialFailed(error).into());
                    }
                    return Err(error.into());
                }
                config.trial.end(update::Attempt::Healthy);
                // SDK 运行时与 Agent 版本不一致（或还没装）时，先从控制面下载安装，再开始接收任务。
                runtime.ensure_sdk(&connection.welcome).await;
                emit(serde_json::json!({ "event": "welcome", "name": config.name }));
                for disposition in &connection.welcome.dispositions {
                    if disposition.action() != TaskAction::Abandon {
                        continue;
                    }
                    eprintln!(
                        "control plane abandoned task {} attempt {}",
                        disposition.task_id, disposition.attempt
                    );
                    runtime
                        .ledger
                        .abandon(&disposition.task_id, disposition.attempt);
                }
                // 版本与控制面不一致：控制面不再派新任务；能自更新时开始（或继续）更新，在心跳里上报更新状态（ADR 0014）。
                updater.on_welcome(&connection.welcome);
                let channels = Channels {
                    installs: &mut installs_rx,
                    telemetry: &mut telemetry_rx,
                };
                let served_at = tokio::time::Instant::now();
                match serve(connection, &runtime, channels, &updater, &mut sweep).await {
                    Ok(()) => eprintln!("control plane closed the stream"),
                    Err(error) => {
                        eprintln!("connection lost: {error:#}");
                        // 控制面用「消息超过上限」拒绝了这条连接：超过上限的结果不能再原样重发（每次重连都先重发
                        // 没 Ack 的结果，每次都被拒），换成失败再发（#723）。被拒的是遥测时没有结果超过上限，不动。
                        if let Some(limit) = message_limit_exceeded(&error) {
                            let replaced = runtime.ledger.replace_results_over(limit);
                            if replaced > 0 {
                                eprintln!(
                                    "控制面收一条消息最多 {limit} 字节：{replaced} 个任务的结果超过它，已换成失败，重连后发出"
                                );
                            }
                        }
                    }
                }
                if served_at.elapsed() >= config.stable_connection {
                    delay = RECONNECT_MIN;
                }
            }
            Err(error) => {
                // 控制面明确拒绝了这条连接：不退出（退出了 systemd 每 5 秒拉起一次，等于快速重试），退避重试；
                // 原因只在第一次和变了的时候打一行，不带凭据的任何部分（只有控制面回的说明）。
                if let Some(status) = rejection(&error) {
                    let (wait, report) = rejections.rejected(status);
                    if report {
                        eprintln!(
                            "控制面拒绝了这台 Agent 的连接（{:?}）：{}。Agent 不会退出，等管理员在控制面处理好之后自己连上；\
                             重试的间隔从 {} 秒翻倍到最长 {} 秒，原因不变时不再重复提示",
                            status.code(),
                            status.message(),
                            config.rejected_retry_min.as_secs_f64(),
                            config.rejected_retry_max.as_secs_f64(),
                        );
                    }
                    tokio::time::sleep(wait).await;
                    continue;
                }
                eprintln!("cannot connect: {error:#}");
            }
        }
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(RECONNECT_MAX);
    }
}

/// 控制面因为一条消息超过它的上限（`readMaxBytes`，#674）结束了这条连接：返回它说的上限（字节）。
/// 控制面回的状态是 `resource_exhausted`，说明是 `message size <声明的大小> is larger than configured readMaxBytes <上限>`。
fn message_limit_exceeded(error: &anyhow::Error) -> Option<usize> {
    let status = error
        .chain()
        .find_map(|e| e.downcast_ref::<tonic::Status>())
        .filter(|status| status.code() == tonic::Code::ResourceExhausted)?;
    let (_, after) = status.message().split_once("readMaxBytes ")?;
    let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

/// 任务目录的定期扫描（[`Runtime::sweep`]）。
struct Sweep {
    next: tokio::time::Instant,
    interval: Duration,
}

impl Sweep {
    /// 到了扫描时间：返回 true 并安排下一次。
    fn due(&mut self) -> bool {
        let now = tokio::time::Instant::now();
        if now < self.next {
            return false;
        }
        self.next = now + self.interval;
        true
    }
}

/// 控制面明确拒绝了这条连接（握手时回 `Unauthenticated` 或 `PermissionDenied`）：凭据无效、被吊销、名字和凭据不一致、
/// Agent 被停用、旧方式的连接顶不掉带凭据的同名连接……返回控制面的状态（里面是它写的原因）。
fn rejection(error: &anyhow::Error) -> Option<&tonic::Status> {
    error
        .chain()
        .find_map(|e| e.downcast_ref::<tonic::Status>())
        .filter(|status| {
            matches!(
                status.code(),
                tonic::Code::Unauthenticated | tonic::Code::PermissionDenied
            )
        })
}

/// 被控制面拒绝之后的重试：下一次等多久，和上一次打印过的原因。
///
/// 等待从 `min` 开始每次翻倍、最多 `max`，连上一次就重置；加抖动时每次实际等的是算出来的时长的一半到全部
/// （[`jittered`]）：管理员一次吊销、停用很多台 Agent 之后，它们不按同一个节奏一起重试。原因（状态码加说明）和上一次
/// 打印的不同才再打一行，同一个原因反复被拒绝时不刷屏。
struct Rejections {
    min: Duration,
    max: Duration,
    jitter: bool,
    next: Duration,
    reported: Option<(tonic::Code, String)>,
}

impl Rejections {
    fn new(min: Duration, max: Duration, jitter: bool) -> Self {
        Self {
            min,
            max,
            jitter,
            next: min,
            reported: None,
        }
    }

    /// 又被拒绝了一次：返回这次要等多久，和要不要打印原因（第一次，或原因和上一次打印的不同）。
    fn rejected(&mut self, status: &tonic::Status) -> (Duration, bool) {
        let reason = (status.code(), status.message().to_string());
        let report = self.reported.as_ref() != Some(&reason);
        if report {
            self.reported = Some(reason);
        }
        let wait = self.next;
        self.next = (self.next * 2).min(self.max);
        (if self.jitter { jittered(wait) } else { wait }, report)
    }

    /// 连上了：重置等待；之前被拒绝过时返回 true。
    fn accepted(&mut self) -> bool {
        self.next = self.min;
        self.reported.take().is_some()
    }
}

/// `wait` 的一半到全部之间的一个随机时长（上限不变，所以「最长 5 分钟」仍然成立）。
/// 随机数取自标准库的 `RandomState`（每个进程的种子由系统随机给出），不为这一处多引入一个依赖。
fn jittered(wait: Duration) -> Duration {
    use std::hash::BuildHasher as _;
    let half = wait / 2;
    let span = u64::try_from(half.as_nanos()).unwrap_or(u64::MAX).max(1);
    half + Duration::from_nanos(std::collections::hash_map::RandomState::new().hash_one(0u8) % span)
}

/// 连不上控制面（建立连接失败，或 gRPC 报告不可用）：与「连上了却握手失败」区分，前者不算新版本的失败。
fn unreachable(error: &anyhow::Error) -> bool {
    error.chain().any(|e| {
        e.downcast_ref::<tonic::transport::Error>().is_some()
            || e.downcast_ref::<tonic::Status>()
                .is_some_and(|s| s.code() == tonic::Code::Unavailable)
    })
}

/// 准备 uv（Agent 管理的 uv 不存在时从镜像安装）和共享 venv（不存在时创建）；已经准备好时只检查 uv 能运行。
async fn prepare_environment(
    config: &Config,
    runtime: &Runtime,
    mirrors: &Mirrors,
) -> Result<(), environment::EnvironmentError> {
    let setup = Setup {
        uv: &config.uv,
        manage_uv: config.manage_uv,
        mirrors,
        scratch: &runtime.scratch,
        user_agent: &config.user_agent,
    };
    let installed = setup.ensure_uv().await?;
    if installed {
        emit(serde_json::json!({ "event": "uv_installed", "path": config.uv }));
    }
    // 安装后（自更新后）的首次启动：更新一次 uv，刚装的 uv 已是最新版不再更新；只尝试一次，失败只告警。
    if config.manage_uv
        && let Some(marker) = config
            .uv
            .parent()
            .map(|dir| dir.join(environment::UV_UPDATE_MARKER))
        && marker.exists()
    {
        if !installed {
            match setup.update_uv().await {
                Ok(()) => emit(serde_json::json!({ "event": "uv_updated", "path": config.uv })),
                Err(error) => eprintln!(
                    "warning: 更新 uv 失败，继续使用现有的 uv。失败的命令：{}\n{}",
                    error.command,
                    error.output.trim_end()
                ),
            }
            // 更新把 uv 弄坏了时不能继续。
            setup.check_uv().await?;
        }
        if let Err(error) = std::fs::remove_file(&marker) {
            eprintln!("warning: cannot remove {}: {error}", marker.display());
        }
    }
    let venv = &runtime.inventory.venv;
    if setup.ensure_venv(venv, config.python.as_deref()).await? {
        emit(serde_json::json!({ "event": "venv_created", "path": venv.root() }));
    }
    Ok(())
}

fn result_message(result: TaskResult) -> AgentMessage {
    AgentMessage {
        body: Some(agent_message::Body::Result(result)),
    }
}

/// `AgentMessage.result` 的字段号（`proto/sfly/agent/v1/agent.proto`）：[`result_message_size`] 用；测试把它和真的编码对一遍。
const RESULT_FIELD: u32 = 6;

/// 这条结果作为一条 `AgentMessage`（[`result_message`]）发出时编码之后的大小：控制面的网关拿一条消息的上限比的是它
/// （长度前缀里的长度），不是结果自己的编码长度，差一个字段标签加长度前缀（4 到 5 个字节）。不复制结果，直接算。
pub(crate) fn result_message_size(result: &TaskResult) -> usize {
    use prost::Message as _;
    use prost::encoding::{encoded_len_varint, key_len};
    let len = result.encoded_len();
    key_len(RESULT_FIELD) + encoded_len_varint(len as u64) + len
}

/// 任务执行方发往控制面的消息。
struct Channels<'a> {
    installs: &'a mut mpsc::UnboundedReceiver<InstallStatus>,
    /// 日志、进度与指标；先于结果处理，任务的日志和指标总在它的结果之前发出。
    telemetry: &'a mut logs::TelemetryReceiver,
}

/// 在一条连接上收发消息，直到连接结束。
async fn serve(
    mut connection: Connection,
    runtime: &Arc<Runtime>,
    channels: Channels<'_>,
    updater: &Arc<update::Updater>,
    sweep: &mut Sweep,
) -> anyhow::Result<()> {
    let Channels {
        installs,
        telemetry,
    } = channels;
    let interval = match connection.welcome.heartbeat_interval_ms {
        0 => DEFAULT_HEARTBEAT_INTERVAL,
        ms => Duration::from_millis(ms.into()),
    };
    let mut heartbeat = tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut status = updater.subscribe();
    let heartbeat_message = |running_tasks, status: &mut watch::Receiver<proto::AgentUpdate>| {
        let now = clock::Reading::now();
        AgentMessage {
            body: Some(agent_message::Body::Heartbeat(Heartbeat {
                running_tasks,
                update: Some(status.borrow_and_update().clone()),
                // 控制面据此更新时钟偏差（ADR 0018）。
                agent_time_unix_ms: now.agent_time_ms,
                monotonic_ms: now.monotonic_ms,
            })),
        }
    };
    for result in runtime.ledger.unacked() {
        connection.outbound.send(result_message(result)).await?;
    }
    // 准备好环境、开始接收任务：立即发一次心跳，不等第一个心跳周期。控制面把 Welcome 之后的第一次心跳当作
    // 已准备好，从这时起才派发（#219）；它同时为重连前手上的任务续约，需要更新时界面上也马上能看到更新状态。
    connection
        .outbound
        .send(heartbeat_message(runtime.ledger.held(), &mut status))
        .await?;
    loop {
        // 排空：手上的任务都结束、结果都被 Ack 后替换并 execve（成功时不返回）。
        if updater.poll(runtime.ledger.held().len()) == update::Drain::Replace {
            connection
                .outbound
                .send(heartbeat_message(Vec::new(), &mut status))
                .await?;
            updater.replace_and_exec().await;
        }
        tokio::select! {
            biased;
            message = connection.inbound.message() => {
                let Some(message) = message? else { return Ok(()) };
                match message.body {
                    // 排空中不接新任务：不执行、不续约，控制面按 agent_lost 处理。
                    Some(server_message::Body::Assign(task)) if updater.draining() => {
                        eprintln!(
                            "ignored task {} attempt {}: the agent is updating itself",
                            task.task_id, task.attempt
                        );
                    }
                    Some(server_message::Body::Assign(task)) => match runtime.ledger.accept(&task) {
                        Some(cancel) => {
                            let runtime = runtime.clone();
                            tokio::spawn(async move { runtime.run_task(task, cancel).await });
                        }
                        None => eprintln!(
                            "ignored task {} attempt {}: already held",
                            task.task_id, task.attempt
                        ),
                    },
                    Some(server_message::Body::Cancel(cancel)) => {
                        if !runtime
                            .ledger
                            .cancel(&cancel.task_id, cancel.attempt, cancel.force)
                        {
                            eprintln!(
                                "ignored cancel for task {} attempt {}: not running here",
                                cancel.task_id, cancel.attempt
                            );
                        }
                    }
                    // 立即更新：控制面已让这些任务以 agent_lost 失败。按取消流程终止它们（取消标记、SIGTERM、宽限期），
                    // 结果照常上报、被 Ack 后 poll 看到 0 就替换。
                    Some(server_message::Body::UpdateNow(_)) => {
                        updater.update_now();
                        let terminated = runtime.ledger.cancel_all(false);
                        eprintln!(
                            "control plane asked to update now: terminating {terminated} task(s)"
                        );
                    }
                    Some(server_message::Body::Ack(ack)) => runtime.acked(&ack.task_id, ack.attempt),
                    other => eprintln!("ignored message from control plane: {other:?}"),
                }
            }
            Some(message) = telemetry.recv() => {
                connection.outbound.send(message).await?;
            }
            _ = heartbeat.tick() => {
                // 只为手上的任务续约；控制面据此发现 Agent 已经丢失的任务。
                connection
                    .outbound
                    .send(heartbeat_message(runtime.ledger.held(), &mut status))
                    .await?;
            }
            // 更新状态变化时立即上报。
            Ok(()) = status.changed() => {
                connection
                    .outbound
                    .send(heartbeat_message(runtime.ledger.held(), &mut status))
                    .await?;
            }
            result = runtime.ledger.next_result() => {
                connection.outbound.send(result_message(result)).await?;
            }
            // 被放弃的任务结束：没有结果要发，手上却少了一个任务。回到循环顶部重新判断排空，
            // 不等下一次心跳（自更新在排空时等着手上的任务都结束）。
            () = runtime.ledger.discarded() => {}
            Some(status) = installs.recv() => {
                connection
                    .outbound
                    .send(AgentMessage { body: Some(agent_message::Body::Install(status)) })
                    .await?;
            }
            () = tokio::time::sleep_until(sweep.next) => {
                if sweep.due() {
                    runtime.sweep();
                }
            }
        }
    }
}

#[cfg(test)]
mod limit_tests {
    use super::*;

    fn exhausted(message: &str) -> anyhow::Error {
        anyhow::Error::from(tonic::Status::resource_exhausted(message)).context("wrapped")
    }

    #[test]
    fn the_limit_is_read_from_the_control_planes_status() {
        let error =
            exhausted("message size 83886081 is larger than configured readMaxBytes 83886080");
        assert_eq!(message_limit_exceeded(&error), Some(83_886_080));
        let at_the_end = exhausted("larger than configured readMaxBytes 4194304");
        assert_eq!(message_limit_exceeded(&at_the_end), Some(4_194_304));
    }

    #[test]
    fn other_errors_are_not_a_message_limit() {
        assert_eq!(
            message_limit_exceeded(&exhausted("too many requests")),
            None
        );
        assert_eq!(
            message_limit_exceeded(&exhausted("readMaxBytes unknown")),
            None
        );
        let other_code = anyhow::Error::from(tonic::Status::internal(
            "message size 9 is larger than configured readMaxBytes 8",
        ));
        assert_eq!(message_limit_exceeded(&other_code), None);
        assert_eq!(message_limit_exceeded(&anyhow::anyhow!("plain")), None);
    }

    /// 控制面比的是整条消息：这个数和真的编码一样，长度前缀的字节数变化的几个边界（127/128、16383/16384、2 MiB）两侧都对。
    #[test]
    fn the_size_of_a_result_message_is_the_size_of_the_whole_message() {
        use prost::Message as _;
        let sizes = [
            0, 1, 100, 120, 124, 125, 126, 127, 128, 129, 16_380, 16_383, 16_384, 16_385,
        ];
        let big = [
            2 * 1024 * 1024 - 1,
            2 * 1024 * 1024,
            2 * 1024 * 1024 + 1,
            40 * 1024 * 1024,
        ];
        for text in sizes.into_iter().chain(big) {
            let result = TaskResult {
                task_id: "t".into(),
                attempt: 1,
                outputs_json: "x".repeat(text),
                ..Default::default()
            };
            assert_eq!(
                result_message_size(&result),
                result_message(result.clone()).encoded_len(),
                "输出 {text} 字节"
            );
            assert!(result_message_size(&result) > result.encoded_len());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(code: tonic::Code, message: &str) -> tonic::Status {
        tonic::Status::new(code, message)
    }

    #[test]
    fn only_unauthenticated_and_permission_denied_are_rejections() {
        for code in [tonic::Code::Unauthenticated, tonic::Code::PermissionDenied] {
            let error = anyhow::Error::new(status(code, "no")).context("wait for welcome");
            assert!(rejection(&error).is_some(), "{code:?}");
        }
        for code in [
            tonic::Code::Unavailable,
            tonic::Code::InvalidArgument,
            tonic::Code::Internal,
            tonic::Code::Unknown,
        ] {
            let error = anyhow::Error::new(status(code, "no")).context("open agent stream");
            assert!(rejection(&error).is_none(), "{code:?}");
        }
        assert!(rejection(&anyhow::anyhow!("connect refused")).is_none());
    }

    #[test]
    fn the_wait_doubles_up_to_the_cap_and_resets_after_a_connection() {
        let mut rejections =
            Rejections::new(Duration::from_secs(30), Duration::from_secs(300), false);
        let rejected = status(tonic::Code::Unauthenticated, "吊销了");
        let waits: Vec<u64> = (0..7)
            .map(|_| rejections.rejected(&rejected).0.as_secs())
            .collect();
        assert_eq!(waits, [30, 60, 120, 240, 300, 300, 300]);
        assert!(rejections.accepted(), "之前被拒绝过");
        assert!(!rejections.accepted(), "没有被拒绝过的不再提示");
        assert_eq!(rejections.rejected(&rejected).0.as_secs(), 30);
    }

    #[test]
    fn with_jitter_every_wait_is_between_half_and_all_of_the_backoff_and_they_differ() {
        let rejected = status(tonic::Code::Unauthenticated, "吊销了");
        let mut distinct = std::collections::HashSet::new();
        for _ in 0..200 {
            let mut rejections =
                Rejections::new(Duration::from_secs(30), Duration::from_secs(300), true);
            for base in [30, 60, 120, 240, 300, 300] {
                let wait = rejections.rejected(&rejected).0;
                assert!(
                    wait >= Duration::from_secs(base) / 2 && wait <= Duration::from_secs(base),
                    "{wait:?} 不在 {base} 秒的一半到全部之间"
                );
                if base == 30 {
                    distinct.insert(wait);
                }
            }
        }
        // 第一次重试的等待在 15 到 30 秒之间随机：200 次里不会只有几个值（没有抖动时恰好是 30 秒一个值）。
        assert!(distinct.len() > 100, "只有 {} 个不同的值", distinct.len());
    }

    #[test]
    fn a_reason_is_reported_the_first_time_and_when_it_changes() {
        let mut rejections = Rejections::new(Duration::from_secs(1), Duration::from_secs(8), false);
        let revoked = status(tonic::Code::Unauthenticated, "吊销了");
        let disabled = status(tonic::Code::PermissionDenied, "停用了");
        let reports: Vec<bool> = [&revoked, &revoked, &revoked, &disabled, &disabled, &revoked]
            .into_iter()
            .map(|s| rejections.rejected(s).1)
            .collect();
        assert_eq!(reports, [true, false, false, true, false, true]);
        // 说明一样、状态码不一样也是不同的原因。
        let same_text = status(tonic::Code::PermissionDenied, "吊销了");
        assert!(rejections.rejected(&same_text).1);
    }
}
