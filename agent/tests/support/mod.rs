//! 测试支撑：可编程的假控制面（真实 tonic gRPC 服务端，监听随机端口）、
//! 启动真实 Agent 二进制、准备装好桩节点包的共享 venv。
#![allow(dead_code)] // 各测试文件只用到其中一部分。

pub mod mirror;
pub mod packages;

use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use sfly_agent::proto::agent_gateway_server::{AgentGateway, AgentGatewayServer};
use sfly_agent::proto::{
    Ack, AgentMessage, AgentUpdate, AssignTask, Hello, InstallState, InstallStatus, ServerMessage,
    TaskAction, TaskDisposition, TaskResult, Welcome, agent_message, server_message,
};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};
use tokio_stream::{Stream, StreamExt};
use tonic::{Request, Response, Status, Streaming};

/// 等待条件成立的默认超时。
pub const WAIT: Duration = Duration::from_secs(20);

/// 收到的一条消息：第几个会话（从 0 开始）+ 消息本身。
#[derive(Debug, Clone)]
pub struct Received {
    pub session: usize,
    pub message: AgentMessage,
    /// 假控制面收到这条消息的时间。
    pub at: tokio::time::Instant,
}

#[derive(Default)]
struct State {
    received: Mutex<Vec<Received>>,
    sessions: AtomicUsize,
    /// 当前会话的出站通道；置空即结束当前会话的响应流。
    current: Mutex<Option<mpsc::Sender<Result<ServerMessage, Status>>>>,
    /// 是否对 TaskResult 回 Ack（默认是）。
    no_ack: AtomicBool,
    /// Welcome 中要放弃的任务（其余 Hello.running_tasks 一律继续）。
    abandon: Mutex<HashSet<String>>,
    /// Welcome 中的心跳间隔（毫秒，0 = Agent 默认值）。
    heartbeat_interval_ms: AtomicU32,
    /// Welcome 中的 SDK 运行时 wheel（下载地址, sha256）。
    sdk_wheel: Mutex<(String, String)>,
    /// Welcome 中的镜像（PyPI 镜像, GitHub Release 镜像）。
    mirrors: Mutex<(String, String)>,
    /// Welcome 中的目标 Agent 版本（空串 = 与 Hello.agent_version 相同，即版本一致）。
    target_version: Mutex<String>,
    /// Welcome 中目标版本的 Agent 二进制（下载地址, sha256）。
    agent_binary: Mutex<(String, String)>,
    /// 这些会话（序号从 0 开始）里的 Hello 不回 Welcome，直接结束会话（握手失败）。
    reject_sessions: Mutex<HashSet<usize>>,
}

/// 假控制面：记录收到的全部 AgentMessage，对 Hello 回复 Welcome，对 TaskResult 回复 Ack；
/// 可以向当前会话推送消息、主动结束会话。
pub struct FakeControlPlane {
    pub url: String,
    pub port: u16,
    state: Arc<State>,
    shutdown: Option<oneshot::Sender<()>>,
}

impl FakeControlPlane {
    pub async fn start() -> Self {
        Self::start_on(0).await
    }

    /// 在指定端口（0 为随机）上启动。
    pub async fn start_on(port: u16) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        let state = Arc::new(State::default());
        let service = Gateway {
            state: state.clone(),
        };
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(AgentGatewayServer::new(service))
                .serve_with_incoming_shutdown(TcpListenerStream::new(listener), async {
                    let _ = rx.await;
                })
                .await
                .unwrap();
        });
        Self {
            url: format!("http://{addr}"),
            port: addr.port(),
            state,
            shutdown: Some(tx),
        }
    }

    pub fn received(&self) -> Vec<AgentMessage> {
        self.received_with_session()
            .into_iter()
            .map(|r| r.message)
            .collect()
    }

    pub fn received_with_session(&self) -> Vec<Received> {
        self.state.received.lock().unwrap().clone()
    }

    /// 等到 `pick` 在已收到的消息中找到结果。
    pub async fn wait_for<T>(&self, what: &str, pick: impl Fn(&[Received]) -> Option<T>) -> T {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            if let Some(found) = pick(&self.received_with_session()) {
                return found;
            }
            if tokio::time::Instant::now() > deadline {
                panic!(
                    "timed out waiting for {what}; received: {:#?}",
                    self.received()
                );
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// 第 `n` 个 Hello（从 0 开始）。
    pub async fn hello(&self, n: usize) -> Hello {
        self.wait_for(&format!("hello #{n}"), |all| {
            all.iter()
                .filter_map(|r| match &r.message.body {
                    Some(agent_message::Body::Hello(h)) => Some(h.clone()),
                    _ => None,
                })
                .nth(n)
        })
        .await
    }

    /// 某个任务的第一条 TaskResult，以及它所在的会话。
    pub async fn result(&self, task_id: &str) -> (TaskResult, usize) {
        self.wait_for(&format!("result of {task_id}"), |all| {
            all.iter().find_map(|r| match &r.message.body {
                Some(agent_message::Body::Result(res)) if res.task_id == task_id => {
                    Some((res.clone(), r.session))
                }
                _ => None,
            })
        })
        .await
    }

    /// 某个任务的第一条 TaskResult，以及它在全部已收消息中的位置（用于判断先后）。
    pub async fn result_at(&self, task_id: &str) -> (TaskResult, usize) {
        self.wait_for(&format!("result of {task_id}"), |all| {
            all.iter()
                .enumerate()
                .find_map(|(i, r)| match &r.message.body {
                    Some(agent_message::Body::Result(res)) if res.task_id == task_id => {
                        Some((res.clone(), i))
                    }
                    _ => None,
                })
        })
        .await
    }

    /// 已收到的全部 InstallStatus（按到达顺序）。
    pub fn installs(&self) -> Vec<InstallStatus> {
        self.received()
            .into_iter()
            .filter_map(|m| match m.body {
                Some(agent_message::Body::Install(s)) => Some(s),
                _ => None,
            })
            .collect()
    }

    /// 等到某个包版本的某个安装状态，返回它和它在全部已收消息中的位置。
    pub async fn install_status(
        &self,
        package: &str,
        version: &str,
        state: InstallState,
    ) -> (InstallStatus, usize) {
        self.wait_for(&format!("install {package}@{version} {state:?}"), |all| {
            all.iter()
                .enumerate()
                .find_map(|(i, r)| match &r.message.body {
                    Some(agent_message::Body::Install(s))
                        if s.package == package && s.version == version && s.state() == state =>
                    {
                        Some((s.clone(), i))
                    }
                    _ => None,
                })
        })
        .await
    }

    /// 向当前会话推送一条消息。
    pub async fn send(&self, body: server_message::Body) {
        let tx = self
            .state
            .current
            .lock()
            .unwrap()
            .clone()
            .expect("no active session");
        tx.send(Ok(ServerMessage { body: Some(body) }))
            .await
            .expect("session closed");
    }

    pub async fn assign(&self, task: AssignTask) {
        self.send(server_message::Body::Assign(task)).await;
    }

    /// 结束当前会话的响应流（模拟控制面断开连接）。
    pub fn end_session(&self) {
        self.state.current.lock().unwrap().take();
    }

    /// 之后的 Welcome 让 Agent 放弃这个任务。
    pub fn abandon(&self, task_id: &str) {
        self.state
            .abandon
            .lock()
            .unwrap()
            .insert(task_id.to_string());
    }

    /// 之后的 Welcome 要求的心跳间隔。
    pub fn set_heartbeat_interval(&self, interval: Duration) {
        self.state
            .heartbeat_interval_ms
            .store(interval.as_millis() as u32, Ordering::SeqCst);
    }

    /// 之后的 Welcome 给出的 SDK 运行时 wheel（下载地址, sha256）。
    pub fn set_sdk_wheel(&self, url: &str, sha256: &str) {
        *self.state.sdk_wheel.lock().unwrap() = (url.to_string(), sha256.to_string());
    }

    /// 之后的 Welcome 下发的镜像（PyPI 镜像, GitHub Release 镜像；空串表示未配置）。
    pub fn set_mirrors(&self, pypi: &str, github_release: &str) {
        *self.state.mirrors.lock().unwrap() = (pypi.to_string(), github_release.to_string());
    }

    /// 之后的 Welcome 给出的目标 Agent 版本（控制面版本）；不设置时回给 Agent 它自己上报的版本。
    pub fn set_target_version(&self, version: &str) {
        *self.state.target_version.lock().unwrap() = version.to_string();
    }

    /// 之后的 Welcome 给出的目标版本 Agent 二进制（下载地址, sha256）。
    pub fn set_agent_binary(&self, url: &str, sha256: &str) {
        *self.state.agent_binary.lock().unwrap() = (url.to_string(), sha256.to_string());
    }

    /// 第 `sessions` 个会话（从 0 开始）里的 Hello 不回 Welcome、直接结束会话（连得上却握手失败）。
    pub fn reject_hellos_in(&self, sessions: impl IntoIterator<Item = usize>) {
        self.state.reject_sessions.lock().unwrap().extend(sessions);
    }

    /// 等到一条带更新状态、且 `pick` 接受的 Heartbeat，返回其中的更新状态。
    pub async fn update_status(
        &self,
        what: &str,
        pick: impl Fn(&AgentUpdate) -> bool,
    ) -> AgentUpdate {
        self.wait_for(what, |all| {
            all.iter().find_map(|r| match &r.message.body {
                Some(agent_message::Body::Heartbeat(h)) => h.update.clone().filter(|u| pick(u)),
                _ => None,
            })
        })
        .await
    }

    /// 已收到的 Heartbeat（会话序号与到达时间）。
    pub fn heartbeats(&self) -> Vec<Received> {
        self.received_with_session()
            .into_iter()
            .filter(|r| matches!(r.message.body, Some(agent_message::Body::Heartbeat(_))))
            .collect()
    }

    /// 之后收到的 TaskResult 不再回 Ack。
    pub fn stop_acking(&self) {
        self.state.no_ack.store(true, Ordering::SeqCst);
    }

    /// 之后收到的 TaskResult 恢复回 Ack。
    pub fn start_acking(&self) {
        self.state.no_ack.store(false, Ordering::SeqCst);
    }
}

impl Drop for FakeControlPlane {
    fn drop(&mut self) {
        self.end_session();
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

struct Gateway {
    state: Arc<State>,
}

type ServerStream = Pin<Box<dyn Stream<Item = Result<ServerMessage, Status>> + Send>>;

#[tonic::async_trait]
impl AgentGateway for Gateway {
    type SessionStream = ServerStream;

    async fn session(
        &self,
        request: Request<Streaming<AgentMessage>>,
    ) -> Result<Response<Self::SessionStream>, Status> {
        let mut inbound = request.into_inner();
        let state = self.state.clone();
        let session = state.sessions.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel(16);
        *state.current.lock().unwrap() = Some(tx.clone());
        let tx = tx.downgrade();
        tokio::spawn(async move {
            while let Some(Ok(message)) = inbound.next().await {
                if let Some(agent_message::Body::Hello(_)) = &message.body
                    && state.reject_sessions.lock().unwrap().contains(&session)
                {
                    state.received.lock().unwrap().push(Received {
                        session,
                        message,
                        at: tokio::time::Instant::now(),
                    });
                    state.current.lock().unwrap().take();
                    return;
                }
                let reply = match &message.body {
                    Some(agent_message::Body::Hello(hello)) => {
                        let abandon = state.abandon.lock().unwrap().clone();
                        let (sdk_wheel_url, sdk_wheel_sha256) =
                            state.sdk_wheel.lock().unwrap().clone();
                        let (pypi_mirror, github_release_mirror) =
                            state.mirrors.lock().unwrap().clone();
                        let target_agent_version =
                            match state.target_version.lock().unwrap().clone() {
                                target if target.is_empty() => hello.agent_version.clone(),
                                target => target,
                            };
                        let (agent_binary_url, agent_binary_sha256) =
                            state.agent_binary.lock().unwrap().clone();
                        Some(server_message::Body::Welcome(Welcome {
                            dispositions: hello
                                .running_tasks
                                .iter()
                                .map(|t| TaskDisposition {
                                    task_id: t.task_id.clone(),
                                    attempt: t.attempt,
                                    action: if abandon.contains(&t.task_id) {
                                        TaskAction::Abandon
                                    } else {
                                        TaskAction::Continue
                                    }
                                    .into(),
                                })
                                .collect(),
                            heartbeat_interval_ms: state
                                .heartbeat_interval_ms
                                .load(Ordering::SeqCst),
                            sdk_wheel_url,
                            sdk_wheel_sha256,
                            pypi_mirror,
                            github_release_mirror,
                            target_agent_version,
                            agent_binary_url,
                            agent_binary_sha256,
                        }))
                    }
                    Some(agent_message::Body::Result(r))
                        if !state.no_ack.load(Ordering::SeqCst) =>
                    {
                        Some(server_message::Body::Ack(Ack {
                            task_id: r.task_id.clone(),
                            attempt: r.attempt,
                        }))
                    }
                    _ => None,
                };
                state.received.lock().unwrap().push(Received {
                    session,
                    message,
                    at: tokio::time::Instant::now(),
                });
                if let (Some(body), Some(tx)) = (reply, tx.upgrade()) {
                    let _ = tx.send(Ok(ServerMessage { body: Some(body) })).await;
                }
            }
        });
        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }
}

/// 仓库根目录。
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

/// 装好 SDK 运行时和桩节点包（testdata/stub-package，sfly-stub@0.1.0）的共享 venv；
/// 每个测试进程准备一次（scripts/stub-venv.sh）。
pub fn stub_venv() -> &'static Path {
    static VENV: OnceLock<PathBuf> = OnceLock::new();
    VENV.get_or_init(|| {
        let base = Path::new(env!("CARGO_TARGET_TMPDIR"));
        remove_stale_venvs(base);
        let venv = base.join(format!("stub-venv-{}", std::process::id()));
        let status = std::process::Command::new(repo_root().join("scripts/stub-venv.sh"))
            .arg(&venv)
            .status()
            .expect("run scripts/stub-venv.sh");
        assert!(status.success(), "scripts/stub-venv.sh failed");
        venv
    })
}

/// 删除早先测试进程留下的 venv（进程已不存在）。
fn remove_stale_venvs(base: &Path) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(pid) = name.strip_prefix("stub-venv-") else {
            continue;
        };
        if !Path::new("/proc").join(pid).exists() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// 以子进程方式运行的真实 Agent（[`spawn_agent`]）与它的工作目录。
pub struct AgentProcess {
    pub child: AgentChild,
    pub work_dir: tempfile::TempDir,
}

/// Agent 的隐藏选项：指向 Agent 时间偏移文件（`sfly_agent::clock`）。[`spawn_agent`] 总是设置它。
pub const AGENT_TIME_OFFSET_FILE_ENV: &str = "SFLY_AGENT_TIME_OFFSET_FILE";

impl AgentProcess {
    /// 这个 Agent 的 Agent 时间偏移文件（[`spawn_agent`] 时用环境变量交给了 Agent）。
    pub fn agent_time_offset_file(&self) -> PathBuf {
        self.work_dir.path().join(AGENT_TIME_OFFSET_FILE)
    }

    /// 模拟修改这台 Agent 的系统时间：之后 Agent 读到的 Agent 时间 = 系统时间 + `offset_ms`（负数是往回拨），
    /// 立即生效，执行任务的中途也可以改。再次调用是重新设置，不是累加；0 恢复成系统时间。
    pub fn set_agent_time_offset_ms(&self, offset_ms: i64) {
        write_agent_time_offset(&self.agent_time_offset_file(), offset_ms);
    }
}

/// Agent 时间偏移文件在 [`spawn_agent`] 的工作目录里的文件名。
const AGENT_TIME_OFFSET_FILE: &str = "agent-time-offset";

/// 把偏移量（毫秒）写进 Agent 时间偏移文件：先写临时文件再改名，Agent 不会读到写了一半的内容。
/// 自己用 [`agent_command`] 启动 Agent 的测试用它，并把 [`AGENT_TIME_OFFSET_FILE_ENV`] 指向同一个文件。
pub fn write_agent_time_offset(file: &Path, offset_ms: i64) {
    let mut tmp = file.as_os_str().to_owned();
    tmp.push(".tmp");
    std::fs::write(&tmp, offset_ms.to_string()).unwrap();
    std::fs::rename(&tmp, file).unwrap();
}

/// 测试结束时等 Agent 收到 SIGTERM 后自行退出的上限（Agent 默认的终止宽限期是 10 秒）。
const AGENT_STOP_TIMEOUT: Duration = Duration::from_secs(15);

/// 运行中的 Agent 进程（[`agent_command`] 启动，自成进程组）。被丢弃时先发 SIGTERM，让它终止手上任务的执行器
/// 后退出（执行器自成进程组，直接 SIGKILL 掉 Agent 会留下孤儿执行器，#113）；然后杀掉 Agent 的整个进程组并等它
/// 结束：Agent 准备环境时启动的 uv（下载 Python、建 venv）在这个组里，只杀 Agent 时它们成了孤儿，在测试的
/// 临时目录删掉之后还在往里写，每次运行都留下上百 MB，填满 /tmp，还占着 CPU 拖慢后面的测试。
pub struct AgentChild {
    child: tokio::process::Child,
    /// 进程组号，就是 Agent 的进程号；Agent 被 kill() 或自己退出、已经收尸后 `child.id()` 为空，组里的进程可能还在。
    group: Option<u32>,
}

impl std::ops::Deref for AgentChild {
    type Target = tokio::process::Child;
    fn deref(&self) -> &Self::Target {
        &self.child
    }
}

impl std::ops::DerefMut for AgentChild {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.child
    }
}

impl Drop for AgentChild {
    fn drop(&mut self) {
        use nix::sys::signal::{Signal, kill, killpg};
        use nix::unistd::Pid;
        let Some(group) = self.group else {
            return;
        };
        let group = Pid::from_raw(group as i32);
        let deadline = std::time::Instant::now() + AGENT_STOP_TIMEOUT;
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = kill(group, Signal::SIGTERM);
            while matches!(self.child.try_wait(), Ok(None)) && std::time::Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        let _ = killpg(group, Signal::SIGKILL);
        // 等组里的进程都结束（被杀的孤儿由 init 收尸）再让调用方删临时目录。
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while killpg(group, None).is_ok() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// `agent_command(...)....spawn_agent()`：启动 Agent，得到被丢弃时连同它的子进程一起结束的 [`AgentChild`]。
pub trait SpawnAgent {
    fn spawn_agent(&mut self) -> AgentChild;
}

impl SpawnAgent for tokio::process::Command {
    fn spawn_agent(&mut self) -> AgentChild {
        let child = self.spawn().expect("spawn sfly-agent");
        let group = child.id();
        AgentChild { child, group }
    }
}

pub struct AgentOptions<'a> {
    pub server: String,
    pub name: &'a str,
    pub venv: &'a Path,
    pub args: Vec<String>,
    pub env: Vec<(&'a str, &'a str)>,
    /// 把 Agent 的标准错误接成管道（[`AgentProcess::child`] 的 `stderr`）；默认继承测试进程的。
    /// 接了就要一直读，否则管道写满会卡住 Agent。
    pub pipe_stderr: bool,
}

impl<'a> AgentOptions<'a> {
    pub fn new(server: &str, name: &'a str) -> Self {
        Self {
            server: server.to_string(),
            name,
            venv: stub_venv(),
            args: Vec::new(),
            env: Vec::new(),
            pipe_stderr: false,
        }
    }
}

/// 真实 Agent 二进制的命令：`SFLY_HOME` 指向 `home`（不读开发者自己的 `~/.sfly/agent.env`），
/// 标准输出丢弃，测试结束时被杀掉。其余参数由调用方添加。
///
/// 默认 `SFLY_UV=uv`（用测试机 PATH 上的 uv，不让 Agent 去安装自己管理的 uv）；
/// 测 Agent 管理 uv 的测试用 `env_remove("SFLY_UV")` 去掉它。
pub fn agent_command(home: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_sfly-agent"));
    command
        .env("SFLY_HOME", home)
        .env("SFLY_UV", "uv")
        .stdout(Stdio::null())
        // 自成进程组：测试结束时连同 Agent 启动的 uv 等子进程一起杀掉（[`AgentChild`]）。
        .process_group(0)
        .kill_on_drop(true);
    command
}

/// 仓库约定的 Python 版本（`.python-version`）。
pub fn python_version() -> String {
    std::fs::read_to_string(repo_root().join(".python-version"))
        .unwrap()
        .trim()
        .to_string()
}

/// 仓库约定版本的 Python 解释器的绝对路径（`uv python find`）：改了 HOME 的测试里 uv 找不到自己管理的 Python。
pub fn python_interpreter() -> String {
    let output = std::process::Command::new("uv")
        .args(["python", "find", "--no-project"])
        .arg(python_version())
        .output()
        .expect("run uv python find");
    assert!(output.status.success(), "uv python find failed");
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

pub fn spawn_agent(options: AgentOptions<'_>) -> AgentProcess {
    let work_dir = tempfile::tempdir().unwrap();
    let mut command = agent_command(&work_dir.path().join("sfly-home"));
    command
        .arg("--server")
        .arg(&options.server)
        .arg("--name")
        .arg(options.name)
        .arg("--venv")
        .arg(options.venv)
        .arg("--work-dir")
        .arg(work_dir.path())
        .args(&options.args)
        .env(
            AGENT_TIME_OFFSET_FILE_ENV,
            work_dir.path().join(AGENT_TIME_OFFSET_FILE),
        )
        .envs(options.env.iter().copied());
    if options.pipe_stderr {
        command.stderr(Stdio::piped());
    }
    AgentProcess {
        child: command.spawn_agent(),
        work_dir,
    }
}

/// 派发给桩节点包的任务。
pub fn stub_task(task_id: &str, node: &str, inputs: serde_json::Value) -> AssignTask {
    AssignTask {
        task_id: task_id.to_string(),
        attempt: 1,
        package: "sfly-stub".into(),
        package_version: "0.1.0".into(),
        node: node.into(),
        inputs_json: inputs.to_string(),
        timeout_seconds: 3600,
        run_id: "run-1".into(),
        node_id: format!("node-{node}"),
        ..Default::default()
    }
}
