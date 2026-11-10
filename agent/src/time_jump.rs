//! Agent 时间跳变的检测（ADR 0018，#176）。
//!
//! 定期比较「Agent 时间 − 单调时钟」：系统时间没被改动时这个差值不变，相邻两次检查之间变化超过
//! [`JUMP_THRESHOLD_MS`] 就是一次跳变（NTP 的小幅校正达不到）。每个任务的日志转发器各持有一个 [`Watch`]，
//! 在自己的检查点（约每 100 毫秒一次，不在逐行处理日志的路径上）调用 [`Watch::check`]，跳变时往任务日志里写一行
//! [`Jump::notice`]；连接断开期间照常检查，提示行随日志排队。

use chrono::{Local, TimeZone};

use crate::clock;

/// 相邻两次检查之间，「Agent 时间 − 单调时钟」变化超过这么多才算跳变。
pub const JUMP_THRESHOLD_MS: i64 = 2000;

/// 一次跳变。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Jump {
    /// 没有跳变的话现在的 Agent 时间（Unix 毫秒）。
    pub before_ms: i64,
    /// 现在的 Agent 时间（Unix 毫秒）。
    pub after_ms: i64,
}

/// 记着上一次检查时的「Agent 时间 − 单调时钟」。
pub struct Watch {
    offset_ms: i64,
}

impl Watch {
    /// 从现在开始看。
    pub fn start() -> Watch {
        let now = clock::Reading::now();
        Watch {
            offset_ms: now.agent_time_ms.saturating_sub(now.monotonic_ms),
        }
    }

    /// 从上一次检查（或开始）到现在 Agent 时间是否跳变了。
    pub fn check(&mut self) -> Option<Jump> {
        let now = clock::Reading::now();
        self.check_at(now.agent_time_ms, now.monotonic_ms)
    }

    fn check_at(&mut self, agent_ms: i64, monotonic_ms: i64) -> Option<Jump> {
        let offset_ms = agent_ms.saturating_sub(monotonic_ms);
        let previous = std::mem::replace(&mut self.offset_ms, offset_ms);
        (offset_ms.saturating_sub(previous).abs() > JUMP_THRESHOLD_MS).then(|| Jump {
            before_ms: previous.saturating_add(monotonic_ms),
            after_ms: agent_ms,
        })
    }
}

impl Jump {
    /// 写进任务日志的提示行，例如「Agent 时间向后跳了 613 天（2026-11-10 10:04:39 → 2028-07-15 06:34:24）」。
    /// 「向后」是时间变晚，「往回」是变早；两个时间按 Agent 机器的时区写。
    pub fn notice(&self) -> String {
        let change = self.after_ms.saturating_sub(self.before_ms);
        format!(
            "Agent 时间{}跳了 {}（{} → {}）",
            if change > 0 { "向后" } else { "往回" },
            amount(change.unsigned_abs()),
            local_time(self.before_ms),
            local_time(self.after_ms),
        )
    }
}

/// 变化量：取天、小时、分钟、秒里数值不小于 1 的最大单位；不到 10 时保留一位小数，否则取整。
fn amount(ms: u64) -> String {
    const UNITS: [(u64, &str); 4] = [
        (24 * 3600 * 1000, "天"),
        (3600 * 1000, "小时"),
        (60 * 1000, "分钟"),
        (1000, "秒"),
    ];
    let (unit_ms, unit) = UNITS
        .into_iter()
        .find(|(unit_ms, _)| ms >= *unit_ms)
        .unwrap_or(UNITS[3]);
    let value = ms as f64 / unit_ms as f64;
    let tenths = (value * 10.0).round() / 10.0;
    if tenths >= 10.0 {
        format!("{} {unit}", value.round())
    } else {
        format!("{tenths} {unit}")
    }
}

/// `YYYY-MM-DD HH:MM:SS`（Agent 机器的时区）；超出可表示的范围时写 Unix 毫秒数。
fn local_time(unix_ms: i64) -> String {
    match Local.timestamp_millis_opt(unix_ms).earliest() {
        Some(time) => time.format("%Y-%m-%d %H:%M:%S").to_string(),
        None => format!("Unix 毫秒 {unix_ms}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_change_of_more_than_two_seconds_between_checks_is_a_jump() {
        let mut watch = Watch {
            offset_ms: 1_000_000,
        };
        // 单调时钟走了 100 毫秒，Agent 时间也走了 100 毫秒。
        assert_eq!(watch.check_at(1_000_200, 200), None);
        // 小幅校正：不算，之后以校正后的为准。
        assert_eq!(watch.check_at(1_002_300, 300), None);
        assert_eq!(watch.check_at(1_004_400, 400), None);
        // 往后 2.001 秒。
        assert_eq!(
            watch.check_at(1_006_501, 500),
            Some(Jump {
                before_ms: 1_004_500,
                after_ms: 1_006_501
            })
        );
        // 往回 1 小时；之后不再重复报告。
        assert_eq!(
            watch.check_at(1_006_601 - 3_600_000, 600),
            Some(Jump {
                before_ms: 1_006_601,
                after_ms: 1_006_601 - 3_600_000
            })
        );
        assert_eq!(watch.check_at(1_006_701 - 3_600_000, 700), None);
    }

    #[test]
    fn the_amount_uses_the_largest_fitting_unit() {
        let cases = [
            (2_001, "2 秒"),
            (2_500, "2.5 秒"),
            (59_000, "59 秒"),
            (60_000, "1 分钟"),
            (90_000, "1.5 分钟"),
            (5 * 60_000 + 20, "5 分钟"),
            (45 * 60_000, "45 分钟"),
            (2 * 3_600_000, "2 小时"),
            (23 * 3_600_000 + 1_800_000, "24 小时"),
            (36 * 3_600_000, "1.5 天"),
            (613 * 86_400_000 - 3 * 3_600_000, "613 天"),
        ];
        for (ms, want) in cases {
            assert_eq!(amount(ms), want, "{ms} ms");
        }
    }
}
