//! Agent 自更新（ADR 0014）：Agent 的版本与控制面不一致时更新到控制面的版本（高于或低于都算）。
//!
//! 控制面在 Welcome 里给出目标版本（控制面的版本）和这个架构的二进制地址、sha256；版本不一致时控制面不再派新任务。
//! 能不能自更新由 [`SelfUpdate::blocker`] 判断；不能时上报「需要手动升级」及原因。能自更新时由 [`Updater`] 执行：
//!
//! 1. 下载中（[`AgentUpdateState::Downloading`]）：在后台把新二进制下载到 `bin/.sfly-agent.update.<pid>`，
//!    校验 sha256，fsync，试运行 `--version`。当前文件已经是目标 sha256（同一 `SFLY_HOME` 下的另一个 Agent
//!    已经替换过）时跳过下载；目标就是正在运行的二进制（它报的版本不是目标版本，替换后还会不一致）时算失败。
//!    失败时上报「更新失败」及原因，继续以旧版本运行；下一次 Welcome 重试。
//! 2. 等待任务结束（[`AgentUpdateState::WaitingForTasks`]，附剩余任务数）：不再接新任务（派来的任务直接忽略，
//!    控制面按 agent_lost 处理），等手上的任务都结束、结果都被 Ack（不设超时）。断线重连后继续排空。
//! 3. 替换中（[`AgentUpdateState::Replacing`]）：持有 `bin/.sfly-agent.lock` 的文件锁（同一 `SFLY_HOME` 下串行），
//!    当前文件已经是目标 sha256 时不替换；否则把当前文件保存为 `sfly-agent.prev`（硬链接），`rename` 覆盖，
//!    fsync 目录。Agent 管理 uv 时写入「首次启动更新 uv」的标记（[`crate::environment::UV_UPDATE_MARKER`]）。
//!    然后以原来的参数和环境 `execve` 启动时记住的路径，附加 `SFLY_UPDATED_FROM=<旧版本>`；
//!    只在测试中使用的版本覆盖（`--version-override` / `SFLY_VERSION_OVERRIDE`）描述的是旧二进制，不传给新进程。
//!    execve 前写状态文件 `bin/update-state.json`（目标版本、旧版本、尝试次数）。execve 失败时恢复 `.prev`，
//!    把目标版本记为坏版本，在日志里给出手动处理步骤并以非零码退出（systemd 会拉起恢复的旧版本）。
//! 4. 新版本的试用（[`Updater::begin_attempt`] / [`Updater::end_attempt`]）：新版本每次启动、每次握手前计一次尝试，
//!    握手成功即健康（删除状态文件）；连不上控制面时撤回这一次；崩溃（由 systemd 重启）或连上后握手失败都算失败。
//!    连续 [`MAX_ATTEMPTS`] 次失败后恢复 `.prev`，把这个版本记为坏版本并 execve 旧版本。旧版本看到目标仍是坏版本时
//!    上报「更新失败」及原因，不再自动尝试（版本不一致，控制面不派任务）；控制面的目标版本变了就重新尝试。
//!
//! 开发版本登记在工作目录里（[`crate::dev`]），新进程重新读取，所以自更新后仍然有效。

use std::ffi::OsString;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::sync::watch;

use crate::proto::{AgentUpdate, AgentUpdateState, Welcome};

/// execve 新版本时附加的环境变量：旧版本号。
pub const UPDATED_FROM_ENV: &str = "SFLY_UPDATED_FROM";

/// 回滚到旧版本后 execve 时附加的环境变量：被回滚的坏版本号。
pub const ROLLED_BACK_FROM_ENV: &str = "SFLY_ROLLED_BACK_FROM";

/// 新版本连续失败多少次后回滚。
pub const MAX_ATTEMPTS: u32 = 3;

/// 自更新的状态文件（与二进制同一目录，持有文件锁时读写）。
const STATE_FILE: &str = "update-state.json";

/// 只在测试中使用：上报的版本等于它时，Agent 记下这次启动（[`Updater::begin_attempt`]）后立即以非零码退出，
/// 模拟「能通过 `--version` 试运行、启动后却崩溃」的新版本。
const CRASH_ON_START_ENV: &str = "SFLY_TEST_CRASH_ON_START";

/// 只在测试中使用的版本覆盖（main.rs 的隐藏参数），不传给替换后的新二进制。
const VERSION_OVERRIDE_ENV: &str = "SFLY_VERSION_OVERRIDE";
const VERSION_OVERRIDE_ARG: &str = "--version-override";

/// 替换二进制时持有的文件锁（与二进制同一目录）。
const LOCK_FILE: &str = ".sfly-agent.lock";

/// 下载中的新二进制：`<目录>/.sfly-agent.update.<pid>`。
const DOWNLOAD_PREFIX: &str = ".sfly-agent.update.";

/// 试运行 `--version` 的超时。
const TRIAL_TIMEOUT: Duration = Duration::from_secs(30);

/// 判断能否自更新所需的信息（启动时确定）。
#[derive(Debug, Clone)]
pub struct SelfUpdate {
    /// 是否允许自动更新（没有指定 `--no-auto-update`）。
    pub enabled: bool,
    /// 当前可执行文件的路径：启动时解析并记住（替换之后 `/proc/self/exe` 会变成「(deleted)」）。
    pub exe: Option<PathBuf>,
    /// `SFLY_HOME`；找不到时为 None。
    pub home: Option<PathBuf>,
}

impl SelfUpdate {
    /// 启动时调用：解析当前可执行文件的路径。
    pub fn detect(enabled: bool, home: Option<PathBuf>) -> Self {
        let exe = std::env::current_exe()
            .ok()
            .map(|exe| std::fs::canonicalize(&exe).unwrap_or(exe));
        Self { enabled, exe, home }
    }

    /// 不能自更新的原因；能自更新时为 None。依次检查：`--no-auto-update`、二进制在 `SFLY_HOME/bin` 下、目录可写。
    pub fn blocker(&self) -> Option<String> {
        if !self.enabled {
            return Some("已指定 --no-auto-update，不自动更新".to_string());
        }
        let Some(exe) = &self.exe else {
            return Some("无法确定 Agent 二进制的路径".to_string());
        };
        let Some(home) = &self.home else {
            return Some(format!(
                "找不到 SFLY_HOME，无法确认 Agent 二进制 {} 是否由安装脚本安装",
                exe.display()
            ));
        };
        let bin = home.join("bin");
        let dir = exe.parent().unwrap_or(Path::new("/"));
        let in_bin = std::fs::canonicalize(&bin).is_ok_and(|bin| bin == dir);
        if !in_bin {
            return Some(format!(
                "Agent 二进制 {} 不在 {} 下（只更新安装脚本安装的 Agent）",
                exe.display(),
                bin.display()
            ));
        }
        if let Err(error) = probe_writable(dir) {
            return Some(format!("{} 不可写：{error}", bin.display()));
        }
        None
    }
}

/// 在目录里创建再删除一个临时文件：替换二进制要在同一目录写临时文件并 rename。
fn probe_writable(dir: &Path) -> std::io::Result<()> {
    let probe = dir.join(format!(".sfly-agent.write-test.{}", std::process::id()));
    std::fs::File::create(&probe)?;
    std::fs::remove_file(&probe)
}

/// 更新的目标：Welcome 给出的版本、二进制地址和 sha256。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Target {
    version: String,
    url: String,
    sha256: String,
}

/// 准备好的新二进制。
#[derive(Debug)]
enum Staged {
    /// 下载、校验、试运行过的文件（与二进制同一目录）。
    Downloaded(PathBuf),
    /// 当前文件已经是目标 sha256，不需要替换。
    AlreadyInstalled,
}

/// 更新流程所处的阶段。
#[derive(Debug)]
enum Phase {
    Downloading(tokio::task::JoinHandle<()>),
    /// 新二进制已准备好：排空中。
    Ready(Staged),
    Replacing,
    /// 这次尝试失败了：下一次 Welcome 重试。
    Failed,
}

/// [`Updater::poll`] 的结果。
#[derive(Debug, PartialEq, Eq)]
pub enum Drain {
    /// 不在排空，或还有任务没结束。
    Continue,
    /// 手上的任务都结束、结果都被 Ack 了：现在替换（[`Updater::replace_and_exec`]）。
    Replace,
}

struct Job {
    target: Target,
    phase: Phase,
}

/// 状态文件的内容：最近一次替换。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct Record {
    /// 替换成的新版本。
    target: String,
    /// 替换前的旧版本（`.prev` 的版本）。
    from: String,
    /// 新版本失败的次数；进行中的一次尝试也计入（崩溃就留在里面），连不上控制面时撤回。
    attempts: u32,
    /// 新版本已被记为坏版本：控制面的目标仍是它时不再自动尝试。
    #[serde(default)]
    bad: bool,
    /// 记为坏版本的原因（上报为「更新失败」的原因）。
    #[serde(default)]
    reason: String,
}

/// 本进程作为新版本的试用状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Trial {
    /// 还没看过状态文件。
    Unknown,
    /// 不是刚替换上的新版本，或已经握手成功。
    Off,
    /// 试用中，这一次尝试已计入状态文件。
    Counted,
    /// 试用中，上一次尝试已经有了结果（失败或撤回）。
    Uncounted,
}

/// 一次握手尝试的结果（[`Updater::end_attempt`]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attempt {
    /// 收到 Welcome。
    Welcomed,
    /// 连不上控制面：不计入失败次数。
    Unreachable,
    /// 连上了控制面却握手失败。
    Failed,
}

/// 自更新的状态机，跨连接存在（断线重连后继续）。
pub struct Updater {
    config: SelfUpdate,
    /// 上报的 Agent 版本。
    version: String,
    /// Agent 管理的 uv 的「首次启动更新 uv」标记；不管理 uv 时为 None。
    uv_marker: Option<PathBuf>,
    http: reqwest::Client,
    status: watch::Sender<AgentUpdate>,
    job: Mutex<Option<Job>>,
    /// 最近一次 [`Updater::poll`] 看到的剩余任务数。
    held: AtomicUsize,
    trial: Mutex<Trial>,
}

fn clamp(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn update(state: AgentUpdateState, remaining_tasks: u32, reason: String) -> AgentUpdate {
    AgentUpdate {
        state: state.into(),
        remaining_tasks,
        reason,
    }
}

impl Updater {
    pub fn new(
        config: SelfUpdate,
        version: String,
        uv_marker: Option<PathBuf>,
        http: reqwest::Client,
    ) -> Arc<Self> {
        let (status, _) = watch::channel(update(AgentUpdateState::None, 0, String::new()));
        Arc::new(Self {
            config,
            version,
            uv_marker,
            http,
            status,
            job: Mutex::new(None),
            held: AtomicUsize::new(0),
            trial: Mutex::new(Trial::Unknown),
        })
    }

    fn state_path(&self) -> Option<PathBuf> {
        Some(self.config.exe.as_deref()?.with_file_name(STATE_FILE))
    }

    fn lock_path(&self) -> Option<PathBuf> {
        Some(self.config.exe.as_deref()?.with_file_name(LOCK_FILE))
    }

    /// 启动时和每次连接控制面之前调用。本进程是刚替换上、还没握手成功的新版本时，在状态文件里计一次尝试；
    /// 已经失败 [`MAX_ATTEMPTS`] 次时恢复 `.prev`、把这个版本记为坏版本并 execve 旧版本（成功时不返回）。
    pub fn begin_attempt(&self) {
        let mut trial = self.trial.lock().unwrap();
        if matches!(*trial, Trial::Off | Trial::Counted) {
            return;
        }
        let (Some(path), Some(lock)) = (self.state_path(), self.lock_path()) else {
            *trial = Trial::Off;
            return;
        };
        if !path.exists() {
            *trial = Trial::Off;
            return;
        }
        let _lock = match open_lock(&lock) {
            Ok(lock) => lock,
            Err(error) => {
                eprintln!("warning: cannot lock {}: {error}", lock.display());
                return;
            }
        };
        let Some(mut record) = read_record(&path).filter(|r| r.target == self.version && !r.bad)
        else {
            *trial = Trial::Off;
            return;
        };
        if record.attempts >= MAX_ATTEMPTS {
            self.roll_back(record);
        }
        record.attempts += 1;
        write_record(&path, &record);
        eprintln!(
            "Agent 新版本 {} 第 {} 次尝试启动（连续失败 {MAX_ATTEMPTS} 次后恢复到 {}）",
            record.target, record.attempts, record.from
        );
        *trial = Trial::Counted;
    }

    /// 一次握手尝试有了结果：成功则新版本健康（删除状态文件），连不上控制面则撤回这一次。
    pub fn end_attempt(&self, outcome: Attempt) {
        let mut trial = self.trial.lock().unwrap();
        if *trial != Trial::Counted {
            return;
        }
        let (Some(path), Some(lock)) = (self.state_path(), self.lock_path()) else {
            return;
        };
        let Ok(_lock) = open_lock(&lock) else { return };
        let record = read_record(&path).filter(|r| r.target == self.version && !r.bad);
        match (outcome, record) {
            (Attempt::Welcomed, record) => {
                if record.is_some()
                    && let Err(error) = std::fs::remove_file(&path)
                {
                    eprintln!("warning: cannot remove {}: {error}", path.display());
                }
                *trial = Trial::Off;
            }
            (Attempt::Unreachable, Some(mut record)) => {
                record.attempts = record.attempts.saturating_sub(1);
                write_record(&path, &record);
                *trial = Trial::Uncounted;
            }
            (_, _) => *trial = Trial::Uncounted,
        }
    }

    /// 新版本连续失败：恢复 `.prev`，记为坏版本，execve 旧版本。调用方持有文件锁（随 execve 关闭）。不返回。
    fn roll_back(&self, mut record: Record) -> ! {
        let path = self.state_path().expect("state file is known");
        let exe = self.exe().expect("exe is known").to_path_buf();
        let prev = prev_path(&exe);
        record.bad = true;
        record.reason = format!(
            "新版本 {} 连续 {MAX_ATTEMPTS} 次启动失败（崩溃，或连上控制面后握手失败），已恢复到 {}；控制面换成其他版本之前不再自动尝试",
            record.target, record.from
        );
        if let Err(error) = restore(&exe, &prev) {
            record.reason = format!(
                "新版本 {} 连续 {MAX_ATTEMPTS} 次启动失败，但无法从 {} 恢复旧版本 {}：{error}",
                record.target,
                prev.display(),
                record.from
            );
            write_record(&path, &record);
            eprintln!("error: Agent 自更新失败：{}", record.reason);
            exit_with_manual_steps(&exe, crate::environment::EXIT_CODE);
        }
        write_record(&path, &record);
        eprintln!("error: Agent 自更新失败：{}", record.reason);
        let error = exec_rollback(&exe, &record);
        eprintln!("error: 执行恢复的旧版本 {} 失败：{error}", exe.display());
        exit_with_manual_steps(&exe, 1);
    }

    /// 当前要上报的更新状态。
    pub fn status(&self) -> AgentUpdate {
        self.status.borrow().clone()
    }

    /// 订阅更新状态的变化（状态变化时立即发一次心跳）。
    pub fn subscribe(&self) -> watch::Receiver<AgentUpdate> {
        self.status.subscribe()
    }

    fn set_status(&self, next: AgentUpdate) {
        self.status.send_if_modified(|current| {
            let changed = *current != next;
            *current = next;
            changed
        });
    }

    fn fail(&self, reason: String) {
        eprintln!(
            "warning: Agent 自更新失败，继续使用版本 {}：{reason}",
            self.version
        );
        self.set_status(update(AgentUpdateState::Failed, 0, reason));
    }

    /// 排空中：不接新任务。
    pub fn draining(&self) -> bool {
        matches!(
            self.job.lock().unwrap().as_ref().map(|j| &j.phase),
            Some(Phase::Ready(_) | Phase::Replacing)
        )
    }

    /// 每次收到 Welcome 后调用：按目标版本开始、继续或放弃更新。
    pub fn on_welcome(self: &Arc<Self>, welcome: &Welcome) {
        let target = welcome.target_agent_version.as_str();
        // 控制面没有给出目标版本（旧版本控制面）时视为一致。
        if target.is_empty() || target == self.version {
            self.abandon();
            self.set_status(update(AgentUpdateState::None, 0, String::new()));
            return;
        }
        if let Some(reason) = self.config.blocker() {
            self.abandon();
            self.warn_mismatch(target, &format!("需要手动升级：{reason}"));
            self.set_status(update(AgentUpdateState::ManualUpgradeRequired, 0, reason));
            return;
        }
        // 目标是已经回滚过的坏版本：不再自动尝试，直到控制面换成别的版本。
        if let Some(record) = self
            .state_path()
            .and_then(|path| read_record(&path))
            .filter(|r| r.bad && r.target == target)
        {
            self.abandon();
            self.warn_mismatch(target, &format!("不再自动更新：{}", record.reason));
            self.set_status(update(AgentUpdateState::Failed, 0, record.reason));
            return;
        }
        if welcome.agent_binary_url.is_empty() {
            self.abandon();
            let reason = format!(
                "控制面没有提供 {} 架构的 Agent 二进制 {target}",
                std::env::consts::ARCH
            );
            self.warn_mismatch(target, &reason);
            self.set_status(update(AgentUpdateState::Failed, 0, reason));
            return;
        }
        let target = Target {
            version: target.to_string(),
            url: welcome.agent_binary_url.clone(),
            sha256: welcome.agent_binary_sha256.to_ascii_lowercase(),
        };
        let mut job = self.job.lock().unwrap();
        if let Some(current) = job.as_ref()
            && current.target == target
            && !matches!(current.phase, Phase::Failed)
        {
            return; // 同一个目标的更新还在进行（断线重连）。
        }
        if let Some(previous) = job.take() {
            self.discard(previous);
        }
        self.warn_mismatch(&target.version, "开始自更新");
        self.set_status(update(AgentUpdateState::Downloading, 0, String::new()));
        let this = self.clone();
        let staging = target.clone();
        let handle = tokio::spawn(async move {
            let prepared = this.prepare(&staging).await;
            let mut job = this.job.lock().unwrap();
            let Some(current) = job.as_mut().filter(|j| j.target == staging) else {
                return;
            };
            match prepared {
                Ok(staged) => {
                    current.phase = Phase::Ready(staged);
                    let remaining = clamp(this.held.load(Ordering::SeqCst));
                    this.set_status(update(
                        AgentUpdateState::WaitingForTasks,
                        remaining,
                        String::new(),
                    ));
                }
                Err(reason) => {
                    current.phase = Phase::Failed;
                    drop(job);
                    this.fail(reason);
                }
            }
        });
        *job = Some(Job {
            target,
            phase: Phase::Downloading(handle),
        });
    }

    fn warn_mismatch(&self, target: &str, what: &str) {
        eprintln!(
            "warning: Agent 版本 {} 与控制面 {target} 不一致，控制面不会派新任务；{what}",
            self.version
        );
    }

    /// 放弃进行中的更新（目标变了，或不再需要更新）。
    fn abandon(&self) {
        if let Some(job) = self.job.lock().unwrap().take() {
            self.discard(job);
        }
    }

    fn discard(&self, job: Job) {
        match job.phase {
            Phase::Downloading(handle) => {
                handle.abort();
                if let Some(path) = self.download_path() {
                    let _ = std::fs::remove_file(path);
                }
            }
            Phase::Ready(Staged::Downloaded(path)) => {
                let _ = std::fs::remove_file(path);
            }
            _ => {}
        }
    }

    fn exe(&self) -> Result<&Path, String> {
        self.config
            .exe
            .as_deref()
            .ok_or_else(|| "无法确定 Agent 二进制的路径".to_string())
    }

    fn download_path(&self) -> Option<PathBuf> {
        let dir = self.config.exe.as_deref()?.parent()?;
        Some(dir.join(format!("{DOWNLOAD_PREFIX}{}", std::process::id())))
    }

    /// 下载、校验、试运行新二进制；当前文件已经是目标 sha256 时跳过下载。
    async fn prepare(&self, target: &Target) -> Result<Staged, String> {
        let exe = self.exe()?.to_path_buf();
        let dir = exe.parent().unwrap_or(Path::new("/")).to_path_buf();
        remove_stale_downloads(&dir);
        // 目标二进制就是正在运行的这个（`/proc/self/exe` 在文件被替换后仍指向运行中的映像）：
        // 它的版本不是目标版本，execve 之后还会不一致，不能循环重启。
        if file_sha256(Path::new("/proc/self/exe"))
            .await
            .is_ok_and(|sha| sha == target.sha256)
        {
            return Err(format!(
                "控制面提供的 Agent 二进制就是正在运行的这个，它的版本是 {}，不是目标版本 {}",
                self.version, target.version
            ));
        }
        if file_sha256(&exe)
            .await
            .is_ok_and(|sha| sha == target.sha256)
        {
            return Ok(Staged::AlreadyInstalled);
        }
        let path = self.download_path().ok_or("无法确定下载位置")?;
        let result = async {
            self.download(target, &path).await?;
            trial_run(&path).await
        }
        .await;
        match result {
            Ok(()) => Ok(Staged::Downloaded(path)),
            Err(reason) => {
                let _ = tokio::fs::remove_file(&path).await;
                Err(reason)
            }
        }
    }

    async fn download(&self, target: &Target, path: &Path) -> Result<(), String> {
        use tokio::io::AsyncWriteExt as _;

        let url = &target.url;
        let mut response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| format!("下载 Agent 二进制 {url} 失败：{e}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "下载 Agent 二进制 {url} 失败：{}",
                response.status()
            ));
        }
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o755)
            .open(path)
            .await
            .map_err(|e| format!("创建 {} 失败：{e}", path.display()))?;
        let mut hasher = Sha256::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("下载 Agent 二进制 {url} 失败：{e}"))?
        {
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
        }
        file.sync_all()
            .await
            .map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
        drop(file);
        let actual = hex(&hasher.finalize());
        if actual != target.sha256 {
            return Err(format!(
                "下载的 Agent 二进制 sha256 不符：期望 {}，实际 {actual}（{url}）",
                target.sha256
            ));
        }
        Ok(())
    }

    /// 在连接上收发消息时反复调用：排空中时更新剩余任务数（手上的任务 + 还没被 Ack 的结果）；
    /// 为 0 时进入替换中，返回 [`Drain::Replace`]。
    pub fn poll(&self, remaining: usize) -> Drain {
        self.held.store(remaining, Ordering::SeqCst);
        let mut job = self.job.lock().unwrap();
        let Some(job) = job.as_mut() else {
            return Drain::Continue;
        };
        if !matches!(job.phase, Phase::Ready(_)) {
            return Drain::Continue;
        }
        if remaining > 0 {
            self.set_status(update(
                AgentUpdateState::WaitingForTasks,
                clamp(remaining),
                String::new(),
            ));
            return Drain::Continue;
        }
        self.set_status(update(AgentUpdateState::Replacing, 0, String::new()));
        Drain::Replace
    }

    /// 替换二进制并 execve（成功时不返回）。execve 之前失败时上报「更新失败」，继续以旧版本运行；
    /// execve 本身失败时恢复旧版本、记为坏版本并退出进程。
    pub async fn replace_and_exec(self: &Arc<Self>) {
        let (target, staged) = {
            let mut job = self.job.lock().unwrap();
            let Some(job) = job.as_mut() else { return };
            let Phase::Ready(staged) = std::mem::replace(&mut job.phase, Phase::Replacing) else {
                return;
            };
            (job.target.clone(), staged)
        };
        let this = self.clone();
        let error =
            tokio::task::spawn_blocking(move || this.replace_and_exec_blocking(&target, staged))
                .await
                .unwrap_or_else(|e| format!("替换二进制的线程异常退出：{e}"));
        if let Some(job) = self.job.lock().unwrap().as_mut() {
            job.phase = Phase::Failed;
        }
        self.fail(error);
    }

    /// 持有文件锁替换并 execve；返回 execve 之前的失败原因（execve 失败时退出进程）。
    fn replace_and_exec_blocking(&self, target: &Target, staged: Staged) -> String {
        let exe = match self.exe() {
            Ok(exe) => exe,
            Err(reason) => return reason,
        };
        let dir = exe.parent().unwrap_or(Path::new("/"));
        let staged_path = match &staged {
            Staged::Downloaded(path) => Some(path.clone()),
            Staged::AlreadyInstalled => None,
        };
        let cleanup = || {
            if let Some(path) = &staged_path {
                let _ = std::fs::remove_file(path);
            }
        };
        // 同一 SFLY_HOME 下的 Agent 串行替换；锁随 execve 关闭（文件描述符带 CLOEXEC）。
        let lock = match open_lock(&dir.join(LOCK_FILE)) {
            Ok(lock) => lock,
            Err(error) => {
                cleanup();
                return format!(
                    "获取 {} 的文件锁失败：{error}",
                    dir.join(LOCK_FILE).display()
                );
            }
        };
        let prev = prev_path(exe);
        let replaced = if blocking_sha256(exe).is_ok_and(|sha| sha == target.sha256) {
            // 另一个 Agent 已经替换过（或文件本来就是目标版本）：直接 execve。
            cleanup();
            false
        } else {
            let Some(path) = &staged_path else {
                return format!(
                    "{} 在等待任务结束期间被改动，不再是目标版本 {}",
                    exe.display(),
                    target.version
                );
            };
            if let Err(error) = replace(exe, path, &prev) {
                cleanup();
                return format!("替换 {} 失败：{error}", exe.display());
            }
            true
        };
        // 新版本首次启动时更新一次 uv（ADR 0012）。
        if let Some(marker) = &self.uv_marker
            && let Err(error) = std::fs::write(marker, "")
        {
            eprintln!("warning: cannot write {}: {error}", marker.display());
        }
        // 新版本的试用从这里开始：它每次启动计一次尝试，连续失败时自己回滚。
        let state = dir.join(STATE_FILE);
        let mut record = Record {
            target: target.version.clone(),
            from: self.version.clone(),
            attempts: 0,
            bad: false,
            reason: String::new(),
        };
        if let Err(error) = save_record(&state, &record) {
            if replaced && let Err(restore) = std::fs::rename(&prev, exe) {
                eprintln!(
                    "warning: cannot restore {} from {}: {restore}",
                    exe.display(),
                    prev.display()
                );
            }
            return format!("写入 {} 失败：{error}", state.display());
        }
        eprintln!(
            "Agent 自更新：{} → {}，重新执行 {}",
            self.version,
            target.version,
            exe.display()
        );
        let error = exec(exe, &self.version);
        // execve 失败：恢复旧版本，把新版本记为坏版本（systemd 拉起的旧版本不会再试它），以非零码退出。
        record.bad = true;
        record.reason = format!("执行新版本 {} 失败：{error}", exe.display());
        if replaced {
            match restore(exe, &prev) {
                Ok(()) => record
                    .reason
                    .push_str(&format!("；已恢复到 {}", self.version)),
                Err(restore) => record.reason.push_str(&format!(
                    "；无法从 {} 恢复旧版本：{restore}",
                    prev.display()
                )),
            }
        }
        write_record(&state, &record);
        drop(lock);
        eprintln!("error: Agent 自更新失败：{}", record.reason);
        exit_with_manual_steps(exe, 1);
    }
}

fn read_record(path: &Path) -> Option<Record> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text) {
        Ok(record) => Some(record),
        Err(error) => {
            eprintln!("warning: ignored {}: {error}", path.display());
            None
        }
    }
}

/// 写状态文件：同一目录临时文件 + fsync + rename。
fn save_record(path: &Path, record: &Record) -> std::io::Result<()> {
    let temp = path.with_extension(format!("json.{}", std::process::id()));
    let mut file = std::fs::File::create(&temp)?;
    file.write_all(&serde_json::to_vec_pretty(record).map_err(std::io::Error::other)?)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temp, path)?;
    std::fs::File::open(path.parent().unwrap_or(Path::new("/")))?.sync_all()
}

fn write_record(path: &Path, record: &Record) {
    if let Err(error) = save_record(path, record) {
        eprintln!("warning: cannot write {}: {error}", path.display());
    }
}

/// 用 `.prev` 覆盖当前二进制，fsync 目录。
fn restore(exe: &Path, prev: &Path) -> std::io::Result<()> {
    std::fs::rename(prev, exe)?;
    std::fs::File::open(exe.parent().unwrap_or(Path::new("/")))?.sync_all()
}

/// 自更新无法继续：在日志里给出手动处理步骤，以 `code` 退出。
fn exit_with_manual_steps(exe: &Path, code: i32) -> ! {
    let dir = exe.parent().unwrap_or(Path::new("/"));
    eprintln!(
        "手动处理：
  1. 确认 {exe} 能运行：{exe} --version（不能运行时把 {prev} 改名为 {exe}，或重新运行安装脚本：
     curl -fsSL <控制面地址>/install.sh | sh -s -- --name <名称>）；
  2. 重新启动 Agent：systemd 服务用 systemctl restart sfly-agent（用户级服务加 --user），前台运行时重新执行原来的命令；
  3. 恢复的旧版本只连接、不接任务，不再自动尝试这个版本；控制面换成其他版本后会重新尝试。
     继续失败时把这段输出和 {state} 报告给平台管理员。",
        exe = exe.display(),
        prev = prev_path(exe).display(),
        state = dir.join(STATE_FILE).display(),
    );
    let _ = std::io::stderr().flush();
    std::process::exit(code);
}

/// 只在测试中使用（[`CRASH_ON_START_ENV`]）：模拟启动即崩溃的新版本。
pub fn crash_on_start_for_tests(version: &str) {
    if std::env::var(CRASH_ON_START_ENV).is_ok_and(|v| v == version) {
        eprintln!("{CRASH_ON_START_ENV}={version}: 模拟启动即崩溃");
        std::process::exit(101);
    }
}

/// 上一个版本的二进制：`<二进制>.prev`。
pub fn prev_path(exe: &Path) -> PathBuf {
    let mut name = exe.file_name().unwrap_or_default().to_os_string();
    name.push(".prev");
    exe.with_file_name(name)
}

fn open_lock(path: &Path) -> std::io::Result<std::fs::File> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    file.lock()?;
    Ok(file)
}

/// 把当前文件保存为 `.prev`（硬链接，不支持时复制），用准备好的文件 `rename` 覆盖，fsync 目录。
fn replace(exe: &Path, staged: &Path, prev: &Path) -> std::io::Result<()> {
    let _ = std::fs::remove_file(prev);
    if std::fs::hard_link(exe, prev).is_err() {
        std::fs::copy(exe, prev)?;
        std::fs::File::open(prev)?.sync_all()?;
    }
    std::fs::rename(staged, exe)?;
    let dir = exe.parent().unwrap_or(Path::new("/"));
    std::fs::File::open(dir)?.sync_all()
}

/// 以原来的参数和环境 execve `exe`（成功时不返回），附加 `SFLY_UPDATED_FROM`，去掉测试用的版本覆盖。
fn exec(exe: &Path, from: &str) -> std::io::Error {
    use std::os::unix::process::CommandExt as _;

    let mut args = std::env::args_os();
    let arg0 = args
        .next()
        .unwrap_or_else(|| exe.as_os_str().to_os_string());
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    std::process::Command::new(exe)
        .arg0(arg0)
        .args(without_version_override(args))
        .env_remove(VERSION_OVERRIDE_ENV)
        .env(UPDATED_FROM_ENV, from)
        .exec()
}

/// 回滚后 execve 恢复的旧版本（成功时不返回），附加 `SFLY_ROLLED_BACK_FROM`。
/// 恢复的二进制就是旧版本 `from`，所以让它上报 `from`（正常安装时就是它自己的版本号；
/// 测试里同一个二进制靠版本覆盖扮演旧版本）。
fn exec_rollback(exe: &Path, record: &Record) -> std::io::Error {
    use std::os::unix::process::CommandExt as _;

    let mut args = std::env::args_os();
    let arg0 = args
        .next()
        .unwrap_or_else(|| exe.as_os_str().to_os_string());
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    std::process::Command::new(exe)
        .arg0(arg0)
        .args(without_version_override(args))
        .env(VERSION_OVERRIDE_ENV, &record.from)
        .env_remove(UPDATED_FROM_ENV)
        .env(ROLLED_BACK_FROM_ENV, &record.target)
        .exec()
}

/// 去掉 `--version-override <版本>` 和 `--version-override=<版本>`。
fn without_version_override(args: impl Iterator<Item = OsString>) -> Vec<OsString> {
    let mut kept = Vec::new();
    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        if arg == VERSION_OVERRIDE_ARG {
            args.next();
            continue;
        }
        if arg
            .to_str()
            .is_some_and(|a| a.starts_with(&format!("{VERSION_OVERRIDE_ARG}=")))
        {
            continue;
        }
        kept.push(arg);
    }
    kept
}

/// 删除已经不存在的进程留下的下载文件。
fn remove_stale_downloads(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(pid) = name.strip_prefix(DOWNLOAD_PREFIX)
            && pid.parse::<u32>().is_ok()
            && !Path::new("/proc").join(pid).exists()
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// 试运行 `<新二进制> --version`：挡住架构不对、文件截断等起不来的二进制。
async fn trial_run(path: &Path) -> Result<(), String> {
    let line = format!("{} --version", path.display());
    let mut attempts = 0;
    let output = loop {
        let run = tokio::process::Command::new(path)
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output();
        match tokio::time::timeout(TRIAL_TIMEOUT, run).await {
            Err(_) => return Err(format!("试运行 `{line}` 超时")),
            Ok(Ok(output)) => break output,
            // 刚写完的文件可能还被并发 fork 的子进程继承着写句柄（ETXTBSY），稍后重试。
            Ok(Err(error)) if error.raw_os_error() == Some(26) && attempts < 10 => {
                attempts += 1;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Ok(Err(error)) => return Err(format!("试运行 `{line}` 失败：{error}")),
        }
    };
    if output.status.success() {
        return Ok(());
    }
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Err(format!(
        "试运行 `{line}` 失败（{}）：{}",
        output.status,
        text.trim()
    ))
}

async fn file_sha256(path: &Path) -> std::io::Result<String> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || blocking_sha256(&path))
        .await
        .map_err(std::io::Error::other)?
}

fn blocking_sha256(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1 << 16];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_override_is_not_passed_to_the_new_binary() {
        let args = [
            "--name",
            "a",
            "--version-override",
            "1.0.0",
            "--version-override=2",
            "--slots",
            "2",
        ]
        .map(OsString::from);
        assert_eq!(
            without_version_override(args.into_iter()),
            ["--name", "a", "--slots", "2"].map(OsString::from)
        );
    }
}
