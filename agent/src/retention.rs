//! 任务目录的保留期（#69）：结果、日志、产物都已交给控制面，工作目录里的任务目录只留作 Agent 侧排查。
//!
//! 保留期按真实流逝的时长判断（单调时钟，[`clock::monotonic_ms`]），不看 Agent 时间，也不看文件的修改时间（ADR 0018）：
//! Agent 时间往后改不会让目录提前过期，往回改也不会让它们永不过期。开始计时的时刻只记在内存里（[`Tracker`]）；
//! Agent 或机器重启后，已有的目录从启动那一刻重新计时，宁可多留也不误删。
//!
//! - 结果被 Ack 时写结束标记 [`FINISHED_MARKER`]，并从这一刻开始计时；保留期为 0 时直接删除目录（[`Tracker::task_acked`]）。
//! - Agent 启动时和之后每隔 [`SWEEP_INTERVAL`] 扫描工作目录（[`Tracker::sweep`]），删除超过保留期的任务目录。
//!   没有记录的目录（上次运行留下的，不论有没有结束标记）从 Agent 启动那一刻开始计时。
//! - 不动：手上的任务（正在执行或结果还没 Ack），以点开头的目录（`.dev`、`.install`），
//!   不是目录的条目（`agent.sock`），以及看起来不是任务目录的子目录（既没有结束标记也没有 `task.json`）。
//!
//! 后台进程目录 `<procs_dir>/<运行 ID>/`（`SFLY_PROCS`）按同一个保留期在同一次扫描里清理（[`Tracker::sweep_procs`]）：
//! 从运行在这台 Agent 上的最后一个任务结束（结果被 Ack）那一刻开始计时（[`Tracker::run_ended`]），没有记录的同样从
//! Agent 启动那一刻算起；两次扫描之间目录里有新的写入（目录和其中直接条目的修改时间变了，后台进程还在写日志）时
//! 从这次扫描重新算起。运行还有任务在手上（正在执行或结果还没 Ack）时不动；以点开头的目录和不是目录的条目不动。
//! 保留期为 0 时，运行的任务都不在手上之后的下一次扫描就会删除，哪怕后台进程还在运行。
//!
//! 删除时先把目录改名为 `<task_id>~deleted`（`~` 不会出现在任务 ID 里）再在后台删除：
//! 同一任务的下一次尝试可以立即在原来的位置新建目录；删到一半被打断的目录在下次扫描时删掉。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use crate::clock;

/// 默认保留期：7 天。
pub const DEFAULT_RETENTION: Duration = Duration::from_secs(7 * 24 * 3600);
/// 两次扫描的间隔。
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(3600);
/// 结果被 Ack 时写在任务目录里的结束标记。
pub const FINISHED_MARKER: &str = ".finished";
/// 改名后等待删除的目录的后缀。
const DELETED_SUFFIX: &str = "~deleted";

/// 解析保留期：`0`，或数字加单位 `s`、`m`、`h`、`d`（例如 `30m`、`24h`、`7d`）。
pub fn parse_retention(text: &str) -> Result<Duration, String> {
    let text = text.trim();
    if text == "0" {
        return Ok(Duration::ZERO);
    }
    let invalid = || format!("无效的保留期 {text:?}：写成 0、30m、24h、7d 这样（单位 s、m、h、d）");
    let (number, unit) = text.split_at(text.len().saturating_sub(1));
    let seconds: u64 = match unit {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 24 * 3600,
        _ => return Err(invalid()),
    };
    let number: u64 = number.parse().map_err(|_| invalid())?;
    number
        .checked_mul(seconds)
        .map(Duration::from_secs)
        .ok_or_else(invalid)
}

/// 任务目录和后台进程目录各自从哪一刻（单调时钟，[`clock::monotonic_ms`]）开始算保留期。只在内存里：
/// Agent 重启后没有记录的目录从启动那一刻算起。
pub struct Tracker {
    /// 这个 Agent 进程启动的时刻。
    started_ms: i64,
    /// 任务 ID → 任务结束（结果被 Ack，或不再在手上）的时刻。
    tasks: Mutex<HashMap<String, i64>>,
    /// 运行 ID → 运行在这台 Agent 上的最后一个任务结束的时刻。
    runs: Mutex<HashMap<String, i64>>,
    /// 运行 ID → 上一次扫描时后台进程目录里最新的修改时间：只用来看两次扫描之间有没有写入，不和任何时钟比较。
    run_writes: Mutex<HashMap<String, SystemTime>>,
}

impl Default for Tracker {
    fn default() -> Self {
        Self::new()
    }
}

impl Tracker {
    pub fn new() -> Self {
        Self {
            started_ms: clock::monotonic_ms(),
            tasks: Mutex::default(),
            runs: Mutex::default(),
            run_writes: Mutex::default(),
        }
    }

    /// 任务的结果被 Ack：保留期为 0 时删除任务目录（改名后在后台线程里删），否则写结束标记，
    /// 保留期从现在算起。目录不存在时什么也不做。
    pub fn task_acked(&self, work_dir: &Path, task_id: &str, retention: Duration) {
        let dir = work_dir.join(task_id);
        if !dir.is_dir() {
            return;
        }
        if retention.is_zero() {
            if let Some(target) = rename(&dir) {
                std::thread::spawn(move || delete(&target));
            }
            return;
        }
        if let Err(error) = std::fs::write(dir.join(FINISHED_MARKER), b"") {
            eprintln!(
                "cannot write {}: {error}",
                dir.join(FINISHED_MARKER).display()
            );
        }
        let now = clock::monotonic_ms();
        self.tasks.lock().unwrap().insert(task_id.to_string(), now);
    }

    /// 任务没有等到 Ack 就不在手上了（例如被控制面放弃）：还没有记录时，保留期从现在算起。
    pub fn task_released(&self, task_id: &str) {
        let now = clock::monotonic_ms();
        self.tasks
            .lock()
            .unwrap()
            .entry(task_id.to_string())
            .or_insert(now);
    }

    /// 运行在这台 Agent 上的最后一个任务结束：它的后台进程目录的保留期从现在算起。
    pub fn run_ended(&self, run_id: &str) {
        let now = clock::monotonic_ms();
        self.runs.lock().unwrap().insert(run_id.to_string(), now);
    }

    /// 删除工作目录里超过保留期的任务目录；`held(任务 ID)` 为真的（手上的任务）不动。
    pub fn sweep(&self, work_dir: &Path, retention: Duration, held: impl Fn(&str) -> bool) {
        let is_task_dir =
            |path: &Path| path.join(FINISHED_MARKER).exists() || path.join("task.json").exists();
        self.sweep_dirs(
            work_dir,
            &self.tasks,
            retention,
            held,
            is_task_dir,
            |_, _| false,
        );
    }

    /// 删除后台进程目录的根目录里超过保留期的运行目录；`held(运行 ID)` 为真的（运行还有任务在手上）不动。
    pub fn sweep_procs(&self, procs_dir: &Path, retention: Duration, held: impl Fn(&str) -> bool) {
        let written = |run_id: &str, dir: &Path| {
            let Some(latest) = latest_write(dir) else {
                return false;
            };
            let mut writes = self.run_writes.lock().unwrap();
            writes
                .insert(run_id.to_string(), latest)
                .is_some_and(|previous| previous != latest)
        };
        self.sweep_dirs(procs_dir, &self.runs, retention, held, |_| true, written);
        self.run_writes
            .lock()
            .unwrap()
            .retain(|run_id, _| procs_dir.join(run_id).is_dir());
    }

    /// 扫描 `root` 下的子目录：等待删除的删掉；`eligible` 的子目录从 `ended` 里记的时刻（没有记录的从 Agent
    /// 启动那一刻）起超过保留期、且不在手上时删除；`written(名字, 目录)` 为真（上次扫描之后有写入）的从现在重新算。
    /// 目录已经不在的记录一并清掉。
    fn sweep_dirs(
        &self,
        root: &Path,
        ended: &Mutex<HashMap<String, i64>>,
        retention: Duration,
        held: impl Fn(&str) -> bool,
        eligible: impl Fn(&Path) -> bool,
        written: impl Fn(&str, &Path) -> bool,
    ) {
        let Ok(entries) = std::fs::read_dir(root) else {
            return;
        };
        let now = clock::monotonic_ms();
        let retention_ms = i64::try_from(retention.as_millis()).unwrap_or(i64::MAX);
        let mut kept = HashSet::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if name.starts_with('.') || !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            if name.ends_with(DELETED_SUFFIX) {
                delete(&path);
                continue;
            }
            if !eligible(&path) {
                continue;
            }
            let since = if written(&name, &path) {
                ended.lock().unwrap().insert(name.clone(), now);
                now
            } else {
                let recorded = ended.lock().unwrap().get(&name).copied();
                recorded.unwrap_or(self.started_ms)
            };
            let expired = now.saturating_sub(since) >= retention_ms;
            if expired && !held(&name) {
                remove(&path);
            } else {
                kept.insert(name);
            }
        }
        // 只清掉这次扫描开始之前记下的：扫描期间新记下的留给下一次。
        ended
            .lock()
            .unwrap()
            .retain(|name, at| kept.contains(name) || *at >= now);
    }
}

/// 目录和其中直接条目的修改时间里最新的一个；目录读不到时为 None。
fn latest_write(dir: &Path) -> Option<SystemTime> {
    let mut latest = std::fs::metadata(dir).and_then(|m| m.modified()).ok()?;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        if let Ok(at) = entry.metadata().and_then(|m| m.modified()) {
            latest = latest.max(at);
        }
    }
    Some(latest)
}

/// 改名后删除（见模块文档）。
fn remove(dir: &Path) {
    if let Some(target) = rename(dir) {
        delete(&target);
    }
}

fn rename(dir: &Path) -> Option<PathBuf> {
    let mut target = dir.as_os_str().to_owned();
    target.push(DELETED_SUFFIX);
    let target = PathBuf::from(target);
    match std::fs::rename(dir, &target) {
        Ok(()) => Some(target),
        Err(error) => {
            eprintln!("cannot remove {}: {error}", dir.display());
            None
        }
    }
}

fn delete(dir: &Path) {
    if let Err(error) = std::fs::remove_dir_all(dir) {
        eprintln!("cannot remove {}: {error}", dir.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retention_accepts_zero_and_durations_with_units() {
        assert_eq!(parse_retention("0"), Ok(Duration::ZERO));
        assert_eq!(parse_retention("90s"), Ok(Duration::from_secs(90)));
        assert_eq!(parse_retention("30m"), Ok(Duration::from_secs(1800)));
        assert_eq!(parse_retention("24h"), Ok(Duration::from_secs(86_400)));
        assert_eq!(parse_retention("7d"), Ok(DEFAULT_RETENTION));
        for bad in ["", "7", "d", "1.5h", "-1d", "7w", "7 d"] {
            assert!(parse_retention(bad).is_err(), "{bad:?}");
        }
    }
}
