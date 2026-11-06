//! 新版本的试用与回滚（ADR 0014）：状态文件、试用计数、坏版本和 `.prev`。
//!
//! 旧版本替换二进制之后、execve 之前写入状态文件 `bin/update-state.json`（[`Record`]：目标版本、旧版本、
//! 新二进制的 sha256、失败次数）。之后启动的进程如果正在运行的就是这个新二进制（sha256 相同），就是试用中的新版本：
//!
//! - 在启动最早期（读取 `agent.env`、解析参数之前，[`Trial::start`]）和每次连接控制面之前（[`Trial::begin`]）
//!   计一次尝试；
//! - 握手成功且环境准备完成时健康（[`Attempt::Healthy`]，删除状态文件）；连不上控制面时撤回这一次
//!   （[`Attempt::Unreachable`]）；退出（崩溃、读取配置或解析参数失败、环境准备失败）或连上后握手失败都留在计数里；
//! - 已经失败 [`MAX_ATTEMPTS`] 次时，下一次尝试恢复 `.prev`、把这个版本记为坏版本（[`Record::bad`]），
//!   然后 execve 恢复的旧版本。
//!
//! 坏版本：控制面的目标版本仍是它时不再自动尝试（[`bad_version`]）；目标版本回到与 Agent 一致时清除记录
//! （[`forget_bad_version`]），之后目标再变成它时重新尝试。
//!
//! 状态文件与 `.prev` 都在二进制所在的目录里，读写时持有替换二进制用的文件锁 `bin/.sfly-agent.lock`。

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::environment::EnvironmentError;

/// 新版本连续失败多少次后回滚。
pub const MAX_ATTEMPTS: u32 = 3;

/// 试用中的新版本环境准备失败时的退出码：systemd（`Restart=on-failure`）会重新启动它，
/// 不像 [`crate::environment::EXIT_CODE`] 那样不再拉起。
pub const TRIAL_FAILURE_EXIT_CODE: i32 = 1;

/// 自更新的状态文件（与二进制同一目录）。
const STATE_FILE: &str = "update-state.json";

/// 替换二进制、读写状态文件时持有的文件锁（与二进制同一目录）。
const LOCK_FILE: &str = ".sfly-agent.lock";

/// 状态文件的内容：最近一次替换。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(super) struct Record {
    /// 替换成的新版本。
    pub target: String,
    /// 替换前的旧版本（`.prev` 的版本）。
    pub from: String,
    /// 新二进制的 sha256：启动的进程靠它认出自己是试用中的新版本。
    #[serde(default)]
    pub sha256: String,
    /// 新版本失败的次数；进行中的一次尝试也计入（退出就留在里面），连不上控制面时撤回。
    pub attempts: u32,
    /// 新版本已被记为坏版本：控制面的目标仍是它时不再自动尝试。
    #[serde(default)]
    pub bad: bool,
    /// 记为坏版本的原因（上报为「更新失败」的原因）。
    #[serde(default)]
    pub reason: String,
}

pub(super) fn state_path(exe: &Path) -> PathBuf {
    exe.with_file_name(STATE_FILE)
}

pub(super) fn lock_path(exe: &Path) -> PathBuf {
    exe.with_file_name(LOCK_FILE)
}

/// 上一个版本的二进制：`<二进制>.prev`。
pub fn prev_path(exe: &Path) -> PathBuf {
    let mut name = exe.file_name().unwrap_or_default().to_os_string();
    name.push(".prev");
    exe.with_file_name(name)
}

/// 打开并锁住 `bin/.sfly-agent.lock`（阻塞等待）；锁随文件关闭释放，文件描述符带 CLOEXEC，execve 时也释放。
pub(super) fn lock(exe: &Path) -> std::io::Result<std::fs::File> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path(exe))?;
    file.lock()?;
    Ok(file)
}

pub(super) fn read_record(path: &Path) -> Option<Record> {
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
pub(super) fn save_record(path: &Path, record: &Record) -> std::io::Result<()> {
    let temp = path.with_extension(format!("json.{}", std::process::id()));
    let mut file = std::fs::File::create(&temp)?;
    file.write_all(&serde_json::to_vec_pretty(record).map_err(std::io::Error::other)?)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temp, path)?;
    std::fs::File::open(path.parent().unwrap_or(Path::new("/")))?.sync_all()
}

pub(super) fn write_record(path: &Path, record: &Record) {
    if let Err(error) = save_record(path, record) {
        eprintln!("warning: cannot write {}: {error}", path.display());
    }
}

/// 用 `.prev` 覆盖当前二进制，fsync 目录。
pub(super) fn restore(exe: &Path) -> std::io::Result<()> {
    std::fs::rename(prev_path(exe), exe)?;
    std::fs::File::open(exe.parent().unwrap_or(Path::new("/")))?.sync_all()
}

/// 目标版本 `target` 是已经回滚过的坏版本时，返回记为坏版本的原因。
pub(super) fn bad_version(exe: &Path, target: &str) -> Option<String> {
    read_record(&state_path(exe))
        .filter(|r| r.bad && r.target == target)
        .map(|r| r.reason)
}

/// 控制面的目标版本回到与 Agent 一致：清除坏版本记录，之后目标再变成那个版本时重新尝试。
pub(super) fn forget_bad_version(exe: &Path) {
    let path = state_path(exe);
    if !path.exists() {
        return;
    }
    let Ok(_lock) = lock(exe) else { return };
    if read_record(&path).is_some_and(|r| r.bad) {
        match std::fs::remove_file(&path) {
            Ok(()) => eprintln!(
                "控制面的版本与 Agent 一致，清除坏版本记录 {}",
                path.display()
            ),
            Err(error) => eprintln!("warning: cannot remove {}: {error}", path.display()),
        }
    }
}

/// 自更新无法继续：在日志里给出手动处理步骤，以 `code` 退出。
pub(super) fn exit_with_manual_steps(exe: &Path, code: i32) -> ! {
    eprintln!(
        "手动处理：
  1. 确认 {exe} 能运行：{exe} --version（不能运行时把 {prev} 改名为 {exe}，或重新运行安装脚本：
     curl -fsSL <控制面地址>/install.sh | sh -s -- --name <名称>）；
  2. 重新启动 Agent：systemd 服务用 systemctl restart sfly-agent（用户级服务加 --user），前台运行时重新执行原来的命令；
  3. 恢复的旧版本只连接、不接任务，不再自动尝试这个版本；控制面换成其他版本后会重新尝试。
     继续失败时把这段输出和 {state} 报告给平台管理员。",
        exe = exe.display(),
        prev = prev_path(exe).display(),
        state = state_path(exe).display(),
    );
    let _ = std::io::stderr().flush();
    std::process::exit(code);
}

/// 本进程作为新版本的试用状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// 还没看过状态文件。
    Unknown,
    /// 不是试用中的新版本，或已经健康。
    Off,
    /// 试用中，这一次尝试已计入状态文件。
    Counted,
    /// 试用中，上一次尝试已经有了结果（失败或撤回）。
    Uncounted,
}

/// 一次尝试的结果（[`Trial::end`]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attempt {
    /// 握手成功，环境也准备好了。
    Healthy,
    /// 连不上控制面：不计入失败次数。
    Unreachable,
    /// 连上了控制面却握手失败，或环境准备失败。
    Failed,
}

/// 本进程是不是试用中的新版本，以及这一次尝试是否已经计入。
#[derive(Debug)]
pub struct Trial {
    /// 启动时解析的可执行文件路径；None 时不参与试用。
    exe: Option<PathBuf>,
    state: Mutex<State>,
}

impl Trial {
    /// 不参与试用（只看版本、帮助的调用，或测试里直接调用 [`crate::run`]）。
    pub fn off() -> Self {
        Self {
            exe: None,
            state: Mutex::new(State::Off),
        }
    }

    /// 启动最早期调用（读取配置、解析参数之前）：本进程是试用中的新版本时计一次尝试；
    /// 已经失败 [`MAX_ATTEMPTS`] 次时回滚（不返回）。
    pub fn start(exe: Option<PathBuf>) -> Self {
        let trial = Self {
            exe,
            state: Mutex::new(State::Unknown),
        };
        trial.begin();
        trial
    }

    /// 试用中的新版本，还没有健康。
    pub fn in_trial(&self) -> bool {
        matches!(
            *self.state.lock().unwrap(),
            State::Counted | State::Uncounted
        )
    }

    /// 每次连接控制面之前调用：试用中、这一次还没计入时计一次尝试；已经失败 [`MAX_ATTEMPTS`] 次时回滚（不返回）。
    pub fn begin(&self) {
        let mut state = self.state.lock().unwrap();
        if matches!(*state, State::Off | State::Counted) {
            return;
        }
        let Some(exe) = &self.exe else {
            *state = State::Off;
            return;
        };
        let path = state_path(exe);
        if !path.exists() {
            *state = State::Off;
            return;
        }
        let _lock = match lock(exe) {
            Ok(lock) => lock,
            Err(error) => {
                eprintln!("warning: cannot lock {}: {error}", lock_path(exe).display());
                return;
            }
        };
        let Some(mut record) = read_record(&path).filter(|r| !r.bad) else {
            *state = State::Off;
            return;
        };
        // 第一次看状态文件：正在运行的二进制就是这次替换上的新二进制，才是它的试用。
        if *state == State::Unknown
            && !super::blocking_sha256(Path::new("/proc/self/exe"))
                .is_ok_and(|sha| sha == record.sha256)
        {
            *state = State::Off;
            return;
        }
        if record.attempts >= MAX_ATTEMPTS {
            roll_back(exe, record);
        }
        record.attempts += 1;
        write_record(&path, &record);
        eprintln!(
            "Agent 新版本 {} 第 {} 次尝试启动（连续失败 {MAX_ATTEMPTS} 次后恢复到 {}）",
            record.target, record.attempts, record.from
        );
        *state = State::Counted;
    }

    /// 一次尝试有了结果：健康则删除状态文件（试用结束），连不上控制面则撤回这一次。
    pub fn end(&self, outcome: Attempt) {
        let mut state = self.state.lock().unwrap();
        if *state != State::Counted {
            return;
        }
        let Some(exe) = &self.exe else { return };
        let path = state_path(exe);
        let Ok(_lock) = lock(exe) else { return };
        let record = read_record(&path).filter(|r| !r.bad);
        match (outcome, record) {
            (Attempt::Healthy, record) => {
                if record.is_some()
                    && let Err(error) = std::fs::remove_file(&path)
                {
                    eprintln!("warning: cannot remove {}: {error}", path.display());
                }
                *state = State::Off;
            }
            (Attempt::Unreachable, Some(mut record)) => {
                record.attempts = record.attempts.saturating_sub(1);
                write_record(&path, &record);
                *state = State::Uncounted;
            }
            (_, _) => *state = State::Uncounted,
        }
    }
}

/// 新版本连续失败：恢复 `.prev`，记为坏版本，execve 恢复的旧版本。调用方持有文件锁（随 execve 关闭）。不返回。
fn roll_back(exe: &Path, mut record: Record) -> ! {
    let path = state_path(exe);
    record.bad = true;
    record.reason = format!(
        "新版本 {} 连续 {MAX_ATTEMPTS} 次启动失败（退出，或连上控制面后握手失败），已恢复到 {}；控制面换成其他版本之前不再自动尝试",
        record.target, record.from
    );
    if let Err(error) = restore(exe) {
        record.reason = format!(
            "新版本 {} 连续 {MAX_ATTEMPTS} 次启动失败，但无法从 {} 恢复旧版本 {}：{error}",
            record.target,
            prev_path(exe).display(),
            record.from
        );
        write_record(&path, &record);
        eprintln!("error: Agent 自更新失败：{}", record.reason);
        exit_with_manual_steps(exe, crate::environment::EXIT_CODE);
    }
    write_record(&path, &record);
    eprintln!("error: Agent 自更新失败：{}", record.reason);
    let error = super::exec(
        exe,
        super::Handover::RolledBack {
            bad: &record.target,
        },
    );
    eprintln!("error: 执行恢复的旧版本 {} 失败：{error}", exe.display());
    exit_with_manual_steps(exe, 1);
}

/// 试用中的新版本环境准备失败：报告环境错误，以 [`TRIAL_FAILURE_EXIT_CODE`] 退出（systemd 会重新启动，
/// 连续失败 [`MAX_ATTEMPTS`] 次后回滚）。
#[derive(Debug)]
pub struct TrialFailed(pub EnvironmentError);

impl std::fmt::Display for TrialFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}\n这是刚自更新上来的新版本：计一次启动失败，以退出码 {TRIAL_FAILURE_EXIT_CODE} 退出；\
             连续 {MAX_ATTEMPTS} 次失败后恢复旧版本。",
            self.0
        )
    }
}

impl std::error::Error for TrialFailed {}
