//! Agent 读时间的统一入口（ADR 0018）。agent/ 里不直接调用 `SystemTime::now()`，都经过这里。
//!
//! - **Agent 时间**（[`agent_time_ms`]；别处按系统时钟得到的时间用 [`to_agent_time_ms`] 换算）：这台机器的系统时间，测试可能随时改动它。只用来原样记录，
//!   不用来计时或判断过期。
//! - **单调时钟**（[`monotonic_ms`]）：不受系统时间修改影响，同一次开机内 Agent 进程重启前后读数连续。
//!   时长、保留期、以及交给控制面折算成控制面时间的打点都用它。
//!
//! 只供测试使用的隐藏选项 `--agent-time-offset-file`（[`use_offset_file`]）：每次读 Agent 时间时加上文件里写的
//! 偏移量（十进制整数，毫秒，可以为负），不需要 root 权限就能模拟修改系统时间。每次读取都重新读文件，改了立即生效；
//! 文件不存在或内容不是整数时偏移量为 0。

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static OFFSET_FILE: OnceLock<PathBuf> = OnceLock::new();

/// 启用隐藏选项：之后读到的 Agent 时间都加上 `file` 里写的偏移量。进程内只生效一次（启动时由 [`crate::run`] 调用）。
pub fn use_offset_file(file: PathBuf) {
    let _ = OFFSET_FILE.set(file);
}

/// 隐藏选项给出的偏移量（毫秒）；没有启用时为 0。
fn offset_ms() -> i64 {
    OFFSET_FILE
        .get()
        .and_then(|file| std::fs::read_to_string(file).ok())
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or(0)
}

/// 现在的 Agent 时间（Unix 毫秒）。
pub fn agent_time_ms() -> i64 {
    to_agent_time_ms(system_time_ms(SystemTime::now()))
}

/// 把按系统时钟得到的时间（Unix 毫秒，例如 SDK 事件里的时间戳、文件的修改时间）换成 Agent 时间：
/// 隐藏选项生效时加上偏移量，否则原样返回。
pub fn to_agent_time_ms(system_ms: i64) -> i64 {
    system_ms.saturating_add(offset_ms())
}

fn system_time_ms(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(since) => since.as_millis() as i64,
        Err(before) => -(before.duration().as_millis() as i64),
    }
}

/// 单调时钟的读数（毫秒）：不受系统时间修改影响，只用来算差值和交给控制面折算。
///
/// Linux 上是开机以来经过的时间，包含休眠（`CLOCK_BOOTTIME`）；其他 Unix 用 `CLOCK_MONOTONIC`。
/// 同一次开机内 Agent 进程重启前后读数连续；机器重启后重新开始。
#[cfg(unix)]
pub fn monotonic_ms() -> i64 {
    use nix::time::{ClockId, clock_gettime};
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const CLOCK: ClockId = ClockId::CLOCK_BOOTTIME;
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    const CLOCK: ClockId = ClockId::CLOCK_MONOTONIC;
    let now = clock_gettime(CLOCK).expect("read the monotonic clock");
    now.tv_sec() as i64 * 1000 + now.tv_nsec() as i64 / 1_000_000
}

/// 没有系统级单调时钟接口的平台：从本进程第一次读取起算（进程重启后重新开始）。
#[cfg(not(unix))]
pub fn monotonic_ms() -> i64 {
    static START: OnceLock<std::time::Instant> = OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_monotonic_clock_never_goes_back() {
        let first = monotonic_ms();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let second = monotonic_ms();
        assert!(second >= first + 20, "{first} -> {second}");
    }
}
