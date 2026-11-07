//! 任务目录的保留期（#69）：结果、日志、产物都已交给控制面，工作目录里的任务目录只留作 Agent 侧排查。
//!
//! - 结果被 Ack 时写结束标记 [`FINISHED_MARKER`]；保留期为 0 时直接删除目录（[`finished`]）。
//! - Agent 启动时和之后每隔 [`SWEEP_INTERVAL`] 扫描工作目录（[`sweep`]），删除超过保留期的任务目录：
//!   有结束标记的按标记的修改时间（即 Ack 的时间）判断，没有的（上次运行被杀或崩溃时留下的）按目录的修改时间判断。
//! - 不动：手上的任务（正在执行或结果还没 Ack），以点开头的目录（`.dev`、`.install`），
//!   不是目录的条目（`agent.sock`），以及看起来不是任务目录的子目录（既没有结束标记也没有 `task.json`）。
//!
//! 后台进程目录 `<procs_dir>/<运行 ID>/`（`SFLY_PROCS`）按同一个保留期在同一次扫描里清理（[`sweep_procs`]）：
//! 按目录和其中直接条目的修改时间里最新的一个判断（后台进程还在写日志时不会过期），运行还有任务在手上
//! （正在执行或结果还没 Ack）时不动；以点开头的目录和不是目录的条目不动。没有结束标记：保留期为 0 时，
//! 运行的任务都不在手上之后的下一次扫描就会删除，哪怕后台进程还在运行。
//!
//! 删除时先把目录改名为 `<task_id>~deleted`（`~` 不会出现在任务 ID 里）再在后台删除：
//! 同一任务的下一次尝试可以立即在原来的位置新建目录；删到一半被打断的目录在下次扫描时删掉。

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

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

/// 任务的结果被 Ack：保留期为 0 时删除任务目录（改名后在后台线程里删），否则写结束标记。
/// 目录不存在时什么也不做。
pub fn finished(work_dir: &Path, task_id: &str, retention: Duration) {
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
}

/// 删除工作目录里超过保留期的任务目录；`held(任务 ID)` 为真的（手上的任务）不动。
pub fn sweep(work_dir: &Path, retention: Duration, held: impl Fn(&str) -> bool) {
    let Ok(entries) = std::fs::read_dir(work_dir) else {
        return;
    };
    let now = SystemTime::now();
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
        let marker = path.join(FINISHED_MARKER);
        let reference = if marker.exists() {
            marker
        } else if path.join("task.json").exists() {
            path.clone()
        } else {
            continue;
        };
        let expired = std::fs::metadata(&reference)
            .and_then(|m| m.modified())
            .is_ok_and(|at| now.duration_since(at).unwrap_or_default() >= retention);
        if expired && !held(&name) {
            remove(&path);
        }
    }
}

/// 删除后台进程目录的根目录里超过保留期的运行目录；`held(运行 ID)` 为真的（运行还有任务在手上）不动。
pub fn sweep_procs(procs_dir: &Path, retention: Duration, held: impl Fn(&str) -> bool) {
    let Ok(entries) = std::fs::read_dir(procs_dir) else {
        return;
    };
    let now = SystemTime::now();
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
        let expired = latest_write(&path)
            .is_some_and(|at| now.duration_since(at).unwrap_or_default() >= retention);
        if expired && !held(&name) {
            remove(&path);
        }
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
