//! 切入点 B（Agent 一侧）：真实 Agent 读取执行器的标准输出 / 标准错误和事件文件，
//! 合并成一条日志流批量转发；进度在 Agent 端合并，每个任务每秒最多上报一次。

mod support;

use std::time::Duration;

use serde_json::json;
use sfly_agent::clock;
use sfly_agent::proto::{LogBatch, LogLevel, LogLine, LogSource, Progress, agent_message};
use support::{
    AgentOptions, DAYS_613_MS, FakeControlPlane, Received, peak_rss_bytes, spawn_agent, stub_task,
    system_time_ms,
};

fn log_lines(all: &[Received], task_id: &str) -> Vec<(usize, LogLine)> {
    all.iter()
        .enumerate()
        .filter_map(|(i, r)| match &r.message.body {
            Some(agent_message::Body::Logs(LogBatch {
                task_id: id, lines, ..
            })) if id == task_id => Some(lines.iter().map(move |l| (i, l.clone()))),
            _ => None,
        })
        .flatten()
        .collect()
}

fn progress_of(all: &[Received], task_id: &str) -> Vec<(usize, Received, Progress)> {
    all.iter()
        .enumerate()
        .filter_map(|(i, r)| match &r.message.body {
            Some(agent_message::Body::Progress(p)) if p.task_id == task_id => {
                Some((i, r.clone(), p.clone()))
            }
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn print_subprocess_output_and_sdk_logs_form_one_numbered_log_stream_before_the_result() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-logs"));
    cp.hello(0).await;
    let before = system_time_ms();

    cp.assign(stub_task("task-chatter", "chatter", json!({})))
        .await;

    let (_, result_at) = cp.result_at("task-chatter").await;
    let after = system_time_ms();
    let lines = log_lines(&cp.received_with_session(), "task-chatter");

    assert!(
        lines.iter().all(|(i, _)| *i < result_at),
        "所有日志都在结果之前到达"
    );
    let seqs: Vec<u64> = lines.iter().map(|(_, l)| l.seq).collect();
    assert_eq!(seqs, (1..=lines.len() as u64).collect::<Vec<_>>());
    assert!(
        lines
            .iter()
            .all(|(_, l)| before <= l.time_unix_ms && l.time_unix_ms <= after)
    );

    let mut got: Vec<(LogSource, LogLevel, String)> = lines
        .iter()
        .map(|(_, l)| (l.source(), l.level(), l.text.clone()))
        .collect();
    got.sort_by(|a, b| a.2.cmp(&b.2));
    let mut want = vec![
        (LogSource::Stdout, LogLevel::Info, "来自 print".to_string()),
        (
            LogSource::Stderr,
            LogLevel::Error,
            "来自标准错误".to_string(),
        ),
        (LogSource::Stdout, LogLevel::Info, "来自子进程".to_string()),
        (LogSource::Stderr, LogLevel::Error, "子进程错误".to_string()),
        (LogSource::Sdk, LogLevel::Debug, "sdk 调试".to_string()),
        (LogSource::Sdk, LogLevel::Info, "sdk 信息 1".to_string()),
        (LogSource::Sdk, LogLevel::Warn, "sdk 警告".to_string()),
        (LogSource::Sdk, LogLevel::Error, "sdk 错误".to_string()),
    ];
    want.sort_by(|a, b| a.2.cmp(&b.2));
    assert_eq!(got, want);

    // 同一来源内保持写入顺序。
    let order = |source: LogSource| -> Vec<String> {
        lines
            .iter()
            .filter(|(_, l)| l.source() == source)
            .map(|(_, l)| l.text.clone())
            .collect()
    };
    assert_eq!(order(LogSource::Stdout), ["来自 print", "来自子进程"]);
    assert_eq!(
        order(LogSource::Sdk),
        ["sdk 调试", "sdk 信息 1", "sdk 警告", "sdk 错误"]
    );
}

/// 任务的所有日志行的 Agent 时间。
async fn line_times(cp: &FakeControlPlane, task_id: &str) -> Vec<i64> {
    cp.assign(stub_task(task_id, "chatter", json!({}))).await;
    cp.result(task_id).await;
    let lines = log_lines(&cp.received_with_session(), task_id);
    assert_eq!(lines.len(), 8, "{lines:?}");
    lines.iter().map(|(_, l)| l.time_unix_ms).collect()
}

#[tokio::test]
async fn log_lines_carry_the_agent_time_which_follows_the_test_offset_as_soon_as_it_changes() {
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(AgentOptions::new(&cp.url, "agent-logs-offset"));
    cp.hello(0).await;

    // 标准输出、标准错误（Agent 读到时打点）和 SDK 日志（SDK 按系统时钟打点）都落在同一个 Agent 时间上。
    for (task_id, offset) in [
        ("task-now", 0),
        ("task-ahead", DAYS_613_MS),
        ("task-back", -DAYS_613_MS),
        ("task-now-again", 0),
    ] {
        agent.set_agent_time_offset_ms(offset);
        let before = system_time_ms() + offset;
        let times = line_times(&cp, task_id).await;
        let after = system_time_ms() + offset;
        assert!(
            times.iter().all(|t| before <= *t && *t <= after),
            "{task_id}: {before} <= {times:?} <= {after}"
        );
    }
}

#[tokio::test]
async fn log_lines_and_progress_carry_the_monotonic_reading_taken_when_the_agent_read_them() {
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(AgentOptions::new(&cp.url, "agent-logs-monotonic"));
    cp.hello(0).await;
    // Agent 时间快 613 天：单调时钟读数不受影响，仍然落在任务执行的这段真实时间里。
    agent.set_agent_time_offset_ms(DAYS_613_MS);
    let before = clock::monotonic_ms();

    cp.assign(stub_task("task-mono", "chatter", json!({ "steps": 1 })))
        .await;
    cp.result("task-mono").await;
    let after = clock::monotonic_ms();
    let all = cp.received_with_session();
    let lines = log_lines(&all, "task-mono");
    assert_eq!(lines.len(), 8, "{lines:?}");
    let readings: Vec<i64> = lines.iter().map(|(_, l)| l.monotonic_ms).collect();
    assert!(
        readings.iter().all(|m| before <= *m && *m <= after),
        "{before} <= {readings:?} <= {after}"
    );
    // 行按读到的先后编号。
    assert!(readings.is_sorted(), "{readings:?}");
    assert!(
        lines
            .iter()
            .all(|(_, l)| l.time_unix_ms >= system_time_ms() + DAYS_613_MS - 60_000),
        "Agent 时间仍然带着偏移"
    );

    let progress = progress_of(&all, "task-mono");
    let (_, _, last) = progress.last().expect("进度");
    assert!(
        before <= last.monotonic_ms && last.monotonic_ms <= after,
        "{before} <= {} <= {after}",
        last.monotonic_ms
    );
}

#[tokio::test]
async fn monotonic_readings_keep_increasing_when_the_agent_time_jumps_back_mid_task() {
    const DAY_MS: i64 = 24 * 3600 * 1000;
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(AgentOptions::new(&cp.url, "agent-progress-jump"));
    cp.hello(0).await;

    // 约 4 秒里写 40 次进度；第一次进度上报之后把 Agent 时间往回拨一天。
    cp.assign(stub_task(
        "task-jump",
        "chatter",
        json!({ "steps": 40, "interval": 0.1 }),
    ))
    .await;
    cp.wait_for("第一次进度", |all| {
        (!progress_of(all, "task-jump").is_empty()).then_some(())
    })
    .await;
    agent.set_agent_time_offset_ms(-DAY_MS);
    let (result, _) = cp.result("task-jump").await;

    let progress: Vec<Progress> = progress_of(&cp.received_with_session(), "task-jump")
        .into_iter()
        .map(|(_, _, p)| p)
        .collect();
    assert!(progress.len() >= 3, "{progress:#?}");
    let (first, last) = (&progress[0], progress.last().unwrap());
    assert!(
        last.time_unix_ms < first.time_unix_ms - DAY_MS / 2,
        "Agent 时间倒退了：{} -> {}",
        first.time_unix_ms,
        last.time_unix_ms
    );
    for pair in progress.windows(2) {
        assert!(
            pair[1].monotonic_ms > pair[0].monotonic_ms,
            "单调时钟读数继续增加：{} -> {}",
            pair[0].monotonic_ms,
            pair[1].monotonic_ms
        );
    }
    // 进度的读数是读到这次进度的时刻，不是补发它的时刻：最后一次进度在任务结束之前读到，读数不晚于结果的读数。
    assert!(
        last.monotonic_ms <= result.monotonic_ms,
        "最后一次进度 {} 不晚于任务结束 {}",
        last.monotonic_ms,
        result.monotonic_ms
    );
}

#[tokio::test]
async fn progress_is_merged_to_at_most_once_per_second_and_the_last_value_precedes_the_result() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-progress"));
    cp.hello(0).await;

    // 30 步、每步 0.1 秒：约 3 秒内写出 30 次进度。
    cp.assign(stub_task(
        "task-progress",
        "chatter",
        json!({ "steps": 30, "interval": 0.1 }),
    ))
    .await;

    let (_, result_at) = cp.result_at("task-progress").await;
    let progress = progress_of(&cp.received_with_session(), "task-progress");

    assert!(
        (2..=5).contains(&progress.len()),
        "合并后约每秒一次，实际 {} 次：{progress:#?}",
        progress.len()
    );
    // 任务结束时补发的最后一次不受间隔限制。
    for pair in progress[..progress.len() - 1].windows(2) {
        let gap = pair[1].1.at - pair[0].1.at;
        assert!(
            gap >= Duration::from_millis(900),
            "两次进度上报间隔 {gap:?}"
        );
    }
    let (last_at, _, last) = progress.last().unwrap();
    assert!(*last_at < result_at, "最后一次进度在结果之前");
    assert_eq!(
        (last.current, last.total, last.message.as_str()),
        (30.0, Some(30.0), "第 30 步")
    );
    // 第一次上报的不一定是第 1 步：同 tests/action_summary.rs（#706），「第一份不等间隔」在 src/logs.rs 的 latest_tests 里断言。
}

#[tokio::test]
async fn a_silent_node_sends_no_empty_log_batches() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-long"));
    cp.hello(0).await;

    cp.assign(stub_task("task-long", "echo", json!({ "text": "x" })))
        .await;
    cp.result("task-long").await;
    // echo 不产生输出：没有日志批次。
    assert!(log_lines(&cp.received_with_session(), "task-long").is_empty());
}

#[tokio::test]
async fn logs_and_last_progress_of_a_timed_out_task_are_forwarded_before_the_timeout_result() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-timeout-logs"));
    cp.hello(0).await;

    // 每 0.05 秒一步，远超 2 秒的超时：被杀时最新的进度还没到上报间隔，只能由 finish 补发。
    let mut task = stub_task(
        "task-timeout-logs",
        "chatter",
        json!({ "steps": 1000, "interval": 0.05 }),
    );
    task.timeout_seconds = 2;
    cp.assign(task).await;

    let (result, result_at) = cp.result_at("task-timeout-logs").await;
    assert_eq!(
        result.error.as_ref().map(|e| e.kind()),
        Some(sfly_agent::proto::ErrorKind::Timeout),
        "{result:?}"
    );
    // 给晚到的消息一点时间：结果之后不应该再有这个任务的日志或进度。
    tokio::time::sleep(Duration::from_millis(500)).await;
    let all = cp.received_with_session();

    let lines = log_lines(&all, "task-timeout-logs");
    let texts: Vec<&str> = lines.iter().map(|(_, l)| l.text.as_str()).collect();
    for want in ["来自 print", "来自标准错误", "来自子进程", "sdk 错误"] {
        assert!(texts.contains(&want), "缺少日志 {want:?}：{texts:?}");
    }
    assert!(
        lines.iter().all(|(i, _)| *i < result_at),
        "超时任务的日志都在结果之前到达"
    );

    let progress = progress_of(&all, "task-timeout-logs");
    assert!(!progress.is_empty());
    // 包括被杀前最新的那次（由 finish 补发）在内，进度都在结果之前到达。
    assert!(
        progress.iter().all(|(i, _, _)| *i < result_at),
        "超时任务的进度都在结果之前到达：{progress:#?}"
    );
}

#[tokio::test]
async fn task_started_is_reported_when_the_executor_starts_before_its_logs_and_result() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-started"));
    cp.hello(0).await;

    cp.assign(stub_task("task-started", "chatter", json!({})))
        .await;
    let (_, result_at) = cp.result_at("task-started").await;
    let all = cp.received_with_session();
    let started: Vec<usize> = all
        .iter()
        .enumerate()
        .filter_map(|(i, r)| match &r.message.body {
            Some(agent_message::Body::Started(s)) if s.task_id == "task-started" => {
                assert_eq!(s.attempt, 1);
                Some(i)
            }
            _ => None,
        })
        .collect();
    assert_eq!(started.len(), 1, "恰好一次 TaskStarted");
    let lines = log_lines(&all, "task-started");
    assert!(!lines.is_empty());
    assert!(
        lines.iter().all(|(i, _)| *i > started[0]),
        "日志在 TaskStarted 之后"
    );
    assert!(started[0] < result_at);
}

#[tokio::test]
async fn logs_queued_while_disconnected_are_capped_and_the_result_still_arrives() {
    let cp = FakeControlPlane::start().await;
    let port = cp.port;
    let mut options = AgentOptions::new(&cp.url, "agent-log-cap");
    options.args = vec!["--log-queue-bytes".into(), "4096".into()];
    let _agent = spawn_agent(options);
    cp.hello(0).await;
    cp.assign(stub_task(
        "task-flood",
        "flood",
        json!({ "lines": 2000, "interval": 0.0005 }),
    ))
    .await;
    // 控制面下线：执行器继续输出，Agent 只在内存里排队有限的日志。
    drop(cp);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let cp = FakeControlPlane::start_on(port).await;

    let (result, _) = cp.result("task-flood").await;
    assert_eq!(
        result.status(),
        sfly_agent::proto::TaskStatus::Success,
        "{result:?}"
    );
    let lines = log_lines(&cp.received_with_session(), "task-flood");
    assert!(
        lines.len() < 2000,
        "断线期间超出上限的日志被丢弃，实际收到 {} 行",
        lines.len()
    );
    // 序号照常递增，控制面能看出缺口。
    let seqs: Vec<u64> = lines.iter().map(|(_, l)| l.seq).collect();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]));
}

#[tokio::test]
async fn stdout_written_faster_than_it_is_forwarded_makes_the_node_wait_instead_of_growing_agent_memory()
 {
    const MIB: u64 = 1024 * 1024;
    let cp = FakeControlPlane::start().await;
    let mut options = AgentOptions::new(&cp.url, "agent-backpressure");
    // 转发器每秒只处理 8 MiB：节点不受限地写，远快于转发。
    options.args = vec!["--log-forward-rate".into(), (8 * MIB).to_string()];
    let agent = spawn_agent(options);
    let pid = agent.child.id().unwrap();
    cp.hello(0).await;
    let before = peak_rss_bytes(pid);

    // 20 MiB 标准输出（每行 1 KiB），最后一行是「最后一行」。
    cp.assign(stub_task("task-spew", "spew", json!({ "stdout_mib": 20 })))
        .await;
    let (result, _) = cp.result("task-spew").await;
    assert_eq!(
        result.status(),
        sfly_agent::proto::TaskStatus::Success,
        "{result:?}"
    );
    let growth = peak_rss_bytes(pid).saturating_sub(before);

    // 日志不丢：标准输出的每一行都按顺序到达，序号连续。
    let lines = log_lines(&cp.received_with_session(), "task-spew");
    let seqs: Vec<u64> = lines.iter().map(|(_, l)| l.seq).collect();
    assert_eq!(seqs, (1..=lines.len() as u64).collect::<Vec<_>>());
    let stdout: Vec<&str> = lines
        .iter()
        .filter(|(_, l)| l.source() == LogSource::Stdout)
        .map(|(_, l)| l.text.as_str())
        .collect();
    assert_eq!(stdout.len(), 20 * 1024 + 1, "标准输出的行数");
    assert_eq!(stdout.last(), Some(&"最后一行"));

    // 转发跟不上时节点等待，Agent 不在内存里攒下没转发的输出（攒下的话至少增长十几 MiB）。
    assert!(
        growth < 10 * MIB,
        "Agent 峰值内存增长了 {} MiB",
        growth / MIB
    );

    // stdout.log 副本照常轮换：最多两个 8 MiB 的文件。
    let dir = agent.work_dir.path().join("task-spew");
    let size = |name: &str| std::fs::metadata(dir.join(name)).map(|m| m.len()).ok();
    let current = size("stdout.log").unwrap();
    let previous = size("stdout.log.1").expect("轮换出 .1");
    assert!(
        current <= 8 * MIB && previous <= 8 * MIB,
        "{current} + {previous}"
    );
    assert!(size("stdout.log.2").is_none());
}

/// 标准输出一行超过 64 KiB 被拆开时，每一段带着前后的上下文（`before` / `after`，只用来打码）：一个值正好跨在拆分处时，
/// 任何一段单独都看不到整个值，但「这一段加上它的上下文」里有整个值（#622）。
#[tokio::test]
async fn a_long_line_is_split_with_context_so_a_value_across_the_split_is_whole_in_one_piece() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-long-line"));
    cp.hello(0).await;

    // 65536 字节处正好落在值的中间：65526 个 a、21 个字符的值、70000 个 b。
    let value = "FAKE-VALUE-ABCDEFGHIJ";
    cp.assign(stub_task(
        "task-long",
        "long_line",
        json!({ "head": 65526, "value": value, "tail": 70000 }),
    ))
    .await;
    let (result, _) = cp.result("task-long").await;
    assert_eq!(
        result.status(),
        sfly_agent::proto::TaskStatus::Success,
        "{result:?}"
    );

    let lines: Vec<LogLine> = log_lines(&cp.received_with_session(), "task-long")
        .into_iter()
        .map(|(_, l)| l)
        .filter(|l| l.source() == LogSource::Stdout)
        .collect();
    let original = format!("{}{value}{}", "a".repeat(65526), "b".repeat(70000));
    let joined: String = lines.iter().map(|l| l.text.as_str()).collect();
    assert_eq!(joined, original);
    assert!(lines.len() >= 2, "没有拆开：{} 行", lines.len());
    assert!(lines.iter().all(|l| l.text.len() <= 64 * 1024));
    assert!(
        lines
            .iter()
            .all(|l| l.before.len() <= 16 * 1024 && l.after.len() <= 16 * 1024)
    );
    // 值被拆在两段里：任何一段的文字单独都没有整个值
    assert!(lines.iter().all(|l| !l.text.contains(value)));
    // 第一段没有 before，最后一段没有 after；第一段加上它的 after、第二段加上它的 before，各自有整个值
    assert_eq!(lines[0].before, "");
    assert_eq!(lines[lines.len() - 1].after, "");
    assert!(format!("{}{}", lines[0].text, lines[0].after).contains(value));
    assert!(format!("{}{}", lines[1].before, lines[1].text).contains(value));
    // 序号连续
    let seqs: Vec<u64> = lines.iter().map(|l| l.seq).collect();
    assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1));
}

/// 没有拆开的行（和事件管道里的行）不带上下文。
#[tokio::test]
async fn lines_that_are_not_split_carry_no_context() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-no-context"));
    cp.hello(0).await;
    cp.assign(stub_task("task-chatter", "chatter", json!({})))
        .await;
    let _ = cp.result_at("task-chatter").await;
    let lines = log_lines(&cp.received_with_session(), "task-chatter");
    assert!(!lines.is_empty());
    assert!(
        lines
            .iter()
            .all(|(_, l)| l.before.is_empty() && l.after.is_empty())
    );
}

/// SDK 日志（`ctx.log`）一条超过 64 KiB 时和标准输出的超长行一样拆开，每一段带前后的上下文：一个值正好跨在拆分处时，
/// 任何一段单独都看不到整个值，但「这一段加上它的上下文」里有整个值（#674）。拆开之后下一条日志照常。
#[tokio::test]
async fn an_sdk_log_message_over_64_kib_is_split_with_context_like_a_stdout_line() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-long-sdk-log"));
    cp.hello(0).await;

    // 65536 字节处正好落在值的中间：65526 个 a、21 个字符的值、70000 个 b。
    let value = "FAKE-VALUE-ABCDEFGHIJ";
    cp.assign(stub_task(
        "task-long-log",
        "long_log",
        json!({ "head": 65526, "value": value, "tail": 70000 }),
    ))
    .await;
    let (result, _) = cp.result("task-long-log").await;
    assert_eq!(
        result.status(),
        sfly_agent::proto::TaskStatus::Success,
        "{result:?}"
    );

    let lines: Vec<LogLine> = log_lines(&cp.received_with_session(), "task-long-log")
        .into_iter()
        .map(|(_, l)| l)
        .filter(|l| l.source() == LogSource::Sdk)
        .collect();
    let original = format!("{}{value}{}", "a".repeat(65526), "b".repeat(70000));
    let (pieces, rest) = lines.split_at(lines.len() - 1);
    assert_eq!(rest[0].text, "after", "拆开之后的下一条日志照常");
    let joined: String = pieces.iter().map(|l| l.text.as_str()).collect();
    assert_eq!(joined, original);
    assert!(pieces.len() >= 2, "没有拆开：{} 行", pieces.len());
    assert!(pieces.iter().all(|l| l.text.len() <= 64 * 1024));
    assert!(
        pieces
            .iter()
            .all(|l| l.before.len() <= 16 * 1024 && l.after.len() <= 16 * 1024)
    );
    assert!(pieces.iter().all(|l| !l.text.contains(value)));
    assert_eq!(pieces[0].before, "");
    assert_eq!(pieces[pieces.len() - 1].after, "");
    assert!(format!("{}{}", pieces[0].text, pieces[0].after).contains(value));
    assert!(format!("{}{}", pieces[1].before, pieces[1].text).contains(value));
    assert!(rest[0].before.is_empty() && rest[0].after.is_empty());
    let seqs: Vec<u64> = lines.iter().map(|l| l.seq).collect();
    assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1));
}

/// 事件管道里一行超过上限（4 MiB）时整行丢弃，Agent 写一行警告（只有大小，没有内容）：一行 200 MiB、没有换行的内容不会让
/// Agent 的内存涨到 200 MiB 以上，前后的日志照常到达，节点照常成功（#674）。
#[tokio::test]
async fn an_event_line_over_the_cap_is_dropped_with_a_warning_and_the_agent_does_not_grow() {
    const MIB: u64 = 1024 * 1024;
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(AgentOptions::new(&cp.url, "agent-event-line-cap"));
    let pid = agent.child.id().unwrap();
    cp.hello(0).await;
    let before = peak_rss_bytes(pid);

    let size = 200 * MIB;
    cp.assign(stub_task(
        "task-big-event",
        "long_event_line",
        json!({ "size": size }),
    ))
    .await;
    let (result, _) = cp.result("task-big-event").await;
    assert_eq!(
        result.status(),
        sfly_agent::proto::TaskStatus::Success,
        "{result:?}"
    );
    let growth = peak_rss_bytes(pid).saturating_sub(before);

    let lines: Vec<LogLine> = log_lines(&cp.received_with_session(), "task-big-event")
        .into_iter()
        .map(|(_, l)| l)
        .collect();
    let texts: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
    assert_eq!(texts.len(), 3, "{texts:?}");
    assert_eq!(texts[0], "before");
    assert_eq!(texts[2], "after");
    // 警告排在被丢弃的行原来的位置，来源 agent、级别 warn，写了这一行的字节数和上限，没有这一行的内容
    assert_eq!(lines[1].source(), LogSource::Agent);
    assert_eq!(lines[1].level(), LogLevel::Warn);
    assert!(
        texts[1].contains(&size.to_string()) && texts[1].contains(&(4 * MIB).to_string()),
        "{}",
        texts[1]
    );
    assert!(!texts[1].contains("xxxx"));
    // 开头认不出是哪一种事件：不说是日志，也不叫人拆开写。
    assert!(
        texts[1].contains("认不出") && !texts[1].contains("日志") && !texts[1].contains("拆开写"),
        "{}",
        texts[1]
    );
    let seqs: Vec<u64> = lines.iter().map(|l| l.seq).collect();
    assert_eq!(seqs, vec![1, 2, 3]);
    // 不丢弃的话，这一行在 Agent 里至少攒两三份（读到的、转成字符串的、拆出来的）
    assert!(
        growth < 40 * MIB,
        "Agent 峰值内存增长了 {} MiB",
        growth / MIB
    );
}

const MIB: u64 = 1024 * 1024;

/// 跑一个往事件管道写超长行的任务（桩节点 `long_event_line`），返回任务成功后收到的全部日志，按序号。
async fn long_event_logs(
    cp: &FakeControlPlane,
    id: &str,
    input: serde_json::Value,
) -> Vec<LogLine> {
    cp.assign(stub_task(id, "long_event_line", input)).await;
    let (result, _) = cp.result(id).await;
    assert_eq!(
        result.status(),
        sfly_agent::proto::TaskStatus::Success,
        "{result:?}"
    );
    log_lines(&cp.received_with_session(), id)
        .into_iter()
        .map(|(_, l)| l)
        .collect()
}

/// 被丢掉的一行是一条日志（合法的 JSON，message 很长）：警告写明是日志、请拆开写，不带内容；前后的日志照常（#674）。
#[tokio::test]
async fn an_oversized_log_event_is_dropped_and_the_warning_says_it_was_a_log() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-oversized-log"));
    cp.hello(0).await;

    let size = 5 * MIB;
    let lines = long_event_logs(
        &cp,
        "task-oversized-log",
        json!({ "size": size, "kind": "log" }),
    )
    .await;
    let texts: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
    assert_eq!(texts.len(), 3, "{texts:?}");
    assert_eq!((texts[0], texts[2]), ("before", "after"));
    assert_eq!(lines[1].source(), LogSource::Agent);
    assert_eq!(lines[1].level(), LogLevel::Warn);
    assert!(
        texts[1].contains("日志") && texts[1].contains("拆开写"),
        "{}",
        texts[1]
    );
    assert!(
        texts[1].contains(&size.to_string()) && texts[1].contains(&(4 * MIB).to_string()),
        "{}",
        texts[1]
    );
    assert!(!texts[1].contains("xxxx"));
}

/// 被丢掉的一行是动作摘要（合法的 JSON）：警告写明是动作摘要、摘要停在之前的一份，不说「日志写得太长」——
/// 节点没有写过长日志，按那句话无从下手（#674 的第一次审查）。
#[tokio::test]
async fn an_oversized_summary_event_is_dropped_and_the_warning_says_it_was_the_summary() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-oversized-summary"));
    cp.hello(0).await;

    let size = 5 * MIB;
    let lines = long_event_logs(
        &cp,
        "task-oversized-summary",
        json!({ "size": size, "kind": "action_summary" }),
    )
    .await;
    let texts: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
    assert_eq!(texts.len(), 3, "{texts:?}");
    assert_eq!((texts[0], texts[2]), ("before", "after"));
    assert_eq!(lines[1].source(), LogSource::Agent);
    assert!(
        texts[1].contains("动作摘要") && texts[1].contains("停在之前的一份"),
        "{}",
        texts[1]
    );
    assert!(!texts[1].contains("拆开写"), "{}", texts[1]);
    assert!(texts[1].contains(&size.to_string()), "{}", texts[1]);
}

/// 审查的复现（#674 第一次审查的 `rv_summary_with_many_names`）：节点用 `ctx.action` 记了很多种名称（每种的长度都在文档上限以内），
/// 摘要超过 4 MiB 之后每份都被丢掉，包括退出时的最后一份：控制面上的摘要停在之前的一份；任务日志里每个任务只有一行完整的
/// 警告（说的是动作摘要，不是日志）、结束时一行合计，不是每秒一行。
///
/// 这个场景要名称的种类没有上限才出现（#726 把它限到 1000 种之后 SDK 写不出这样的摘要，那时删掉这条，上面直接写一行的那条留着）。
#[tokio::test]
async fn a_summary_that_grows_over_the_cap_stops_at_the_last_one_and_warns_once() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-many-names"));
    cp.hello(0).await;

    // 每秒新开 8000 种名称（每种 64 个字符），8 秒共 64000 种：每份摘要约 130 字节一种，第 4 秒起超过 4 MiB。
    cp.assign(stub_task(
        "task-many-names",
        "many_action_names",
        json!({ "per_second": 8000, "seconds": 8 }),
    ))
    .await;
    let (result, result_at) = cp.result_at("task-many-names").await;
    assert_eq!(
        result.status(),
        sfly_agent::proto::TaskStatus::Success,
        "{result:?}"
    );
    let all = cp.received_with_session();
    let summaries: Vec<(usize, i64)> = all
        .iter()
        .enumerate()
        .filter_map(|(i, r)| match &r.message.body {
            Some(agent_message::Body::ActionSummary(s)) if s.task_id == "task-many-names" => {
                let summary: serde_json::Value = serde_json::from_str(&s.event_json).unwrap();
                assert!(
                    s.event_json.len() as u64 <= 4 * MIB,
                    "超过上限的摘要不会送到"
                );
                Some((i, summary["total"].as_i64().unwrap()))
            }
            _ => None,
        })
        .collect();
    assert!(!summaries.is_empty(), "前几秒的摘要照常送到");
    assert!(summaries.iter().all(|(i, _)| *i < result_at));

    let lines: Vec<LogLine> = log_lines(&all, "task-many-names")
        .into_iter()
        .map(|(_, l)| l)
        .collect();
    let names: i64 = lines
        .iter()
        .find_map(|l| l.text.strip_prefix("names=")?.parse().ok())
        .expect("节点最后写了总数");
    assert_eq!(names, 64_000);
    let last = summaries.last().unwrap().1;
    assert!(
        last < names,
        "控制面上的摘要停在之前的一份：{last} / {names}"
    );

    // 警告：都是 Agent 写的；完整的只有一行，说的是动作摘要；任务结束时一行合计。
    let warnings: Vec<&str> = lines
        .iter()
        .filter(|l| l.source() == LogSource::Agent)
        .map(|l| l.text.as_str())
        .collect();
    let with = |needle: &str| warnings.iter().filter(|w| w.contains(needle)).count();
    assert_eq!(with("停在之前的一份"), 1, "{warnings:#?}");
    assert_eq!(with("拆开写"), 0, "{warnings:#?}");
    let total = warnings
        .iter()
        .find(|w| w.contains("一共被丢弃了"))
        .unwrap_or_else(|| panic!("没有合计：{warnings:#?}"));
    assert!(total.contains("动作摘要"), "{total}");
    assert_eq!(warnings.len(), 2, "{warnings:#?}");
    assert_eq!(
        lines.last().unwrap().text,
        **total,
        "合计在任务结束时写，排在最后"
    );
}

/// 管道在一行中间关闭：超长的一行（没有换行）写警告，不超长的最后半行也写一行警告（只有大小）；
/// 之前的日志照常（#674）。
#[tokio::test]
async fn a_line_the_pipe_closes_in_the_middle_of_is_reported() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-pipe-closes-mid-line"));
    cp.hello(0).await;

    // 超长：一行 5 MiB，没有换行，节点退出。
    let lines = long_event_logs(
        &cp,
        "task-closed-long",
        json!({ "size": 5 * MIB, "kind": "log", "newline": false }),
    )
    .await;
    let texts: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
    assert_eq!(texts.len(), 2, "{texts:?}");
    assert_eq!(texts[0], "before");
    assert_eq!(lines[1].source(), LogSource::Agent);
    assert!(
        texts[1].contains(&(5 * MIB).to_string()) && texts[1].contains("日志"),
        "{}",
        texts[1]
    );

    // 不超长：1000 字节，没有换行，节点退出：原来不声不响地丢掉，现在写一行警告。
    let lines = long_event_logs(
        &cp,
        "task-closed-short",
        json!({ "size": 1000, "newline": false }),
    )
    .await;
    let texts: Vec<&str> = lines.iter().map(|l| l.text.as_str()).collect();
    assert_eq!(texts.len(), 2, "{texts:?}");
    assert_eq!(texts[0], "before");
    assert_eq!(lines[1].source(), LogSource::Agent);
    assert_eq!(lines[1].level(), LogLevel::Warn);
    assert!(
        texts[1].contains("没有写完") && texts[1].contains("1000 字节"),
        "{}",
        texts[1]
    );
    assert!(!texts[1].contains("xxxx"));
}
