//! Agent 时间在任务执行中途跳变（超过 2 秒）时，Agent 往本机每个正在执行的任务的日志里写一行提示（ADR 0018，#176）。
//! 假控制面加真实 Agent，用隐藏的 Agent 时间偏移选项模拟修改系统时间。

mod support;

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{FixedOffset, NaiveDateTime, TimeZone};
use serde_json::json;
use sfly_agent::proto::{LogBatch, LogLevel, LogLine, LogSource, TaskStatus, agent_message};
use support::{
    AgentOptions, AgentProcess, FakeControlPlane, Received, WAIT, spawn_agent, stub_task,
};

const SECOND_MS: i64 = 1000;
const MINUTE_MS: i64 = 60 * SECOND_MS;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAYS_613_MS: i64 = 613 * 24 * HOUR_MS;

/// Agent 机器的时区：提示行里的时间按它写。
const AGENT_TZ: &str = "Asia/Shanghai";
const AGENT_UTC_OFFSET_SECONDS: i32 = 8 * 3600;

fn spawn_agent_in_tz(cp: &FakeControlPlane, name: &str) -> AgentProcess {
    let mut options = AgentOptions::new(&cp.url, name);
    options.env = vec![("TZ", AGENT_TZ)];
    spawn_agent(options)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// 任务到目前为止收到的日志行。
fn log_lines(all: &[Received], task_id: &str) -> Vec<LogLine> {
    all.iter()
        .filter_map(|r| match &r.message.body {
            Some(agent_message::Body::Logs(LogBatch {
                task_id: id, lines, ..
            })) if id == task_id => Some(lines.clone()),
            _ => None,
        })
        .flatten()
        .collect()
}

/// 等到任务的日志里有 `count` 行来源为 Agent 的提示行，返回最后那一行。
async fn agent_line(cp: &FakeControlPlane, task_id: &str, count: usize) -> LogLine {
    cp.wait_for(&format!("agent log line {count} of {task_id}"), |all| {
        log_lines(all, task_id)
            .into_iter()
            .filter(|l| l.source() == LogSource::Agent)
            .nth(count - 1)
    })
    .await
}

struct Gate {
    task_id: &'static str,
    ready: PathBuf,
    release: PathBuf,
}

/// 派发一个闸门任务并等它开始执行；它自己不写任何日志。
async fn start_gate(cp: &FakeControlPlane, dir: &Path, task_id: &'static str) -> Gate {
    let gate = Gate {
        task_id,
        ready: dir.join(format!("{task_id}.ready")),
        release: dir.join(format!("{task_id}.release")),
    };
    cp.assign(stub_task(
        task_id,
        "gate",
        json!({ "ready_file": gate.ready, "release_file": gate.release }),
    ))
    .await;
    let deadline = tokio::time::Instant::now() + WAIT;
    while !gate.ready.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "{task_id} never started"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    gate
}

async fn finish(cp: &FakeControlPlane, gate: &Gate) {
    std::fs::write(&gate.release, "").unwrap();
    let (result, _) = cp.result(gate.task_id).await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
}

/// 提示行的文字：「Agent 时间<方向>跳了 <变化量>（<跳变前> → <跳变后>）」，两个时间按 Agent 机器的时区写。
/// 返回（方向与变化量, 跳变前的 Unix 毫秒, 跳变后的 Unix 毫秒）。
fn parse_notice(text: &str) -> (String, i64, i64) {
    let rest = text
        .strip_prefix("Agent 时间")
        .unwrap_or_else(|| panic!("{text:?}"));
    let (change, times) = rest.split_once('（').unwrap_or_else(|| panic!("{text:?}"));
    let (before, after) = times
        .strip_suffix('）')
        .and_then(|t| t.split_once(" → "))
        .unwrap_or_else(|| panic!("{text:?}"));
    let zone = FixedOffset::east_opt(AGENT_UTC_OFFSET_SECONDS).unwrap();
    let unix_ms = |s: &str| {
        let local = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
            .unwrap_or_else(|e| panic!("{s:?}: {e}"));
        zone.from_local_datetime(&local).unwrap().timestamp_millis()
    };
    (change.to_string(), unix_ms(before), unix_ms(after))
}

/// 提示行写明方向与变化量 `change`，跳变前后的 Agent 时间分别是系统时间加 `from_offset`、`to_offset`
/// （`since`..现在 之间，文字里的时间精确到秒）；行本身的 Agent 时间是跳变之后的。
fn assert_notice(line: &LogLine, change: &str, since: i64, from_offset: i64, to_offset: i64) {
    let until = now_ms();
    assert_eq!(line.level(), LogLevel::Warn, "{line:?}");
    let (got_change, before, after) = parse_notice(&line.text);
    assert_eq!(got_change, change, "{line:?}");
    let within = |t: i64, offset: i64| since + offset - SECOND_MS <= t && t <= until + offset;
    assert!(within(before, from_offset), "跳变前的时间：{line:?}");
    assert!(within(after, to_offset), "跳变后的时间：{line:?}");
    assert!(
        since + to_offset <= line.time_unix_ms && line.time_unix_ms <= until + to_offset,
        "行的 Agent 时间：{line:?}"
    );
}

#[tokio::test]
async fn each_running_task_gets_one_log_line_per_agent_time_jump_of_more_than_two_seconds() {
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent_in_tz(&cp, "agent-time-jump");
    cp.hello(0).await;
    let dir = tempfile::tempdir().unwrap();
    let gates = [
        start_gate(&cp, dir.path(), "task-jump-a").await,
        start_gate(&cp, dir.path(), "task-jump-b").await,
    ];

    // 往后拨 613 天。
    let since = now_ms();
    agent.set_agent_time_offset_ms(DAYS_613_MS);
    for gate in &gates {
        let line = agent_line(&cp, gate.task_id, 1).await;
        assert_notice(&line, "向后跳了 613 天", since, 0, DAYS_613_MS);
    }

    // 只拨 1 秒（NTP 校正的量级）：不提示。给 Agent 几个检查周期，再做下一次拨动。
    agent.set_agent_time_offset_ms(DAYS_613_MS + SECOND_MS);
    tokio::time::sleep(Duration::from_millis(500)).await;

    // 往回拨 5 分钟。
    let since = now_ms();
    let back = DAYS_613_MS + SECOND_MS - 5 * MINUTE_MS;
    agent.set_agent_time_offset_ms(back);
    for gate in &gates {
        let line = agent_line(&cp, gate.task_id, 2).await;
        assert_notice(
            &line,
            "往回跳了 5 分钟",
            since,
            DAYS_613_MS + SECOND_MS,
            back,
        );
    }

    for gate in &gates {
        finish(&cp, gate).await;
        // 每次跳变恰好一行，沿用任务的日志序号。
        let lines = log_lines(&cp.received_with_session(), gate.task_id);
        let got: Vec<(u64, LogSource)> = lines.iter().map(|l| (l.seq, l.source())).collect();
        assert_eq!(
            got,
            [(1, LogSource::Agent), (2, LogSource::Agent)],
            "{lines:#?}"
        );
    }
}

#[tokio::test]
async fn a_jump_while_disconnected_is_logged_and_delivered_after_reconnecting() {
    let cp = FakeControlPlane::start().await;
    let port = cp.port;
    let agent = spawn_agent_in_tz(&cp, "agent-time-jump-offline");
    cp.hello(0).await;
    let dir = tempfile::tempdir().unwrap();
    let gate = start_gate(&cp, dir.path(), "task-jump-offline").await;

    // 控制面下线期间往回拨 2 小时。
    drop(cp);
    let since = now_ms();
    agent.set_agent_time_offset_ms(-2 * HOUR_MS);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let cp = FakeControlPlane::start_on(port).await;

    let line = agent_line(&cp, gate.task_id, 1).await;
    assert_notice(&line, "往回跳了 2 小时", since, 0, -2 * HOUR_MS);
    assert_eq!(line.seq, 1);
    finish(&cp, &gate).await;
}
