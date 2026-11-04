//! 切入点 B（Agent 一侧）：真实 Agent 读取执行器的标准输出 / 标准错误和事件文件，
//! 合并成一条日志流批量转发；进度在 Agent 端合并，每个任务每秒最多上报一次。

mod support;

use std::time::Duration;

use serde_json::json;
use sfly_agent::proto::{LogBatch, LogLevel, LogLine, LogSource, Progress, agent_message};
use support::{AgentOptions, FakeControlPlane, Received, spawn_agent, stub_task};

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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[tokio::test]
async fn print_subprocess_output_and_sdk_logs_form_one_numbered_log_stream_before_the_result() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-logs"));
    cp.hello(0).await;
    let before = now_ms();

    cp.assign(stub_task("task-chatter", "chatter", json!({})))
        .await;

    let (_, result_at) = cp.result_at("task-chatter").await;
    let after = now_ms();
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
    assert_eq!(progress[0].2.current, 1.0, "第一次进度立即上报");
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
