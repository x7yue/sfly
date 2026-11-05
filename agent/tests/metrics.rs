//! 切入点 B（Agent 一侧）：真实 Agent + SDK 执行器 + 桩节点 `metrics` 上报指标（#29）。
//! Agent 按「任务 × 指标 × 秒」合并，每个任务每秒最多发一批 `MetricBatch`，任务结束前发完；
//! 断线期间在内存里排队（有上限，超出丢弃最早的点），恢复后上报丢弃计数。

mod support;

use std::time::Duration;

use serde_json::{Value, json};
use sfly_agent::proto::{LogBatch, MetricBatch, MetricPoint, TaskStatus, agent_message};
use support::{AgentOptions, FakeControlPlane, Received, spawn_agent, stub_task};

fn batches_of(all: &[Received], task_id: &str) -> Vec<(usize, Received, MetricBatch)> {
    all.iter()
        .enumerate()
        .filter_map(|(i, r)| match &r.message.body {
            Some(agent_message::Body::Metrics(b)) if b.task_id == task_id => {
                Some((i, r.clone(), b.clone()))
            }
            _ => None,
        })
        .collect()
}

fn points_of(batches: &[(usize, Received, MetricBatch)], name: &str) -> Vec<MetricPoint> {
    batches
        .iter()
        .flat_map(|(_, _, b)| b.points.iter().filter(|p| p.name == name).cloned())
        .collect()
}

fn sdk_logs(all: &[Received], task_id: &str) -> Vec<String> {
    all.iter()
        .filter_map(|r| match &r.message.body {
            Some(agent_message::Body::Logs(LogBatch {
                task_id: id, lines, ..
            })) if id == task_id => Some(lines.iter().map(|l| l.text.clone())),
            _ => None,
        })
        .flatten()
        .collect()
}

/// 每 `interval` 秒上报一次 `level`（值为序号），共 `n` 次。
fn steady(n: usize, interval: f64) -> Vec<Value> {
    (0..n)
        .flat_map(|i| [json!(["level", i]), json!(interval)])
        .collect()
}

#[tokio::test]
async fn points_are_merged_per_metric_and_second_and_non_finite_values_are_dropped() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-metrics"));
    cp.hello(0).await;

    cp.assign(stub_task(
        "task-merge",
        "metrics",
        json!({ "steps": [
            "align",
            ["level", 5], ["level", 1], ["level", "nan"], ["level", 3],
            ["total", 10], ["total", 20], ["total", "inf"],
            ["typo", 1],
            "align",
            ["level", 7], ["total", 30],
        ] }),
    ))
    .await;

    let (result, result_at) = cp.result_at("task-merge").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let all = cp.received_with_session();
    let batches = batches_of(&all, "task-merge");
    assert!(
        batches
            .iter()
            .all(|(i, _, b)| *i < result_at && b.attempt == 1),
        "指标都在结果之前到达"
    );

    let level = points_of(&batches, "level");
    let total = points_of(&batches, "total");
    assert_eq!(level.len(), 2, "每秒一个点：{level:?}");
    assert_eq!(total.len(), 2, "每秒一个点：{total:?}");
    // gauge：这一秒最后一个值，带最小值和最大值。
    assert_eq!(
        (level[0].value, level[0].min, level[0].max),
        (3.0, 1.0, 5.0)
    );
    assert_eq!(
        (level[1].value, level[1].min, level[1].max),
        (7.0, 7.0, 7.0)
    );
    // counter：这一秒结束时的值。
    assert_eq!(
        (total[0].value, total[0].min, total[0].max),
        (20.0, 20.0, 20.0)
    );
    assert_eq!(total[1].value, 30.0);
    assert_eq!(level[1].time_unix_s, level[0].time_unix_s + 1);
    assert_eq!(total[0].time_unix_s, level[0].time_unix_s);
    assert!(points_of(&batches, "typo").is_empty(), "未声明的指标被丢弃");

    // SDK 丢弃非有限值和未声明的指标时写警告日志；指标事件本身不会变成日志。
    let logs = sdk_logs(&all, "task-merge");
    assert!(
        logs.iter()
            .any(|l| l.contains("'typo'") && l.contains("未声明")),
        "{logs:?}"
    );
    assert!(
        logs.iter()
            .any(|l| l.contains("'level'") && l.contains("有限")),
        "{logs:?}"
    );
    assert!(logs.iter().all(|l| !l.contains("\"metric\"")), "{logs:?}");
}

#[tokio::test]
async fn metric_batches_are_sent_at_most_once_per_second() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-metric-rate"));
    cp.hello(0).await;

    // 约 3 秒内每 0.05 秒上报一次。
    cp.assign(stub_task(
        "task-rate",
        "metrics",
        json!({ "steps": steady(60, 0.05) }),
    ))
    .await;

    let (_, result_at) = cp.result_at("task-rate").await;
    let batches = batches_of(&cp.received_with_session(), "task-rate");
    assert!(
        (2..=5).contains(&batches.len()),
        "每秒最多一批，实际 {} 批",
        batches.len()
    );
    // 任务结束时补发的最后一批不受间隔限制。
    for pair in batches[..batches.len() - 1].windows(2) {
        let gap = pair[1].1.at - pair[0].1.at;
        assert!(gap >= Duration::from_millis(900), "两批间隔 {gap:?}");
    }
    assert!(batches.iter().all(|(i, _, _)| *i < result_at));
    let level = points_of(&batches, "level");
    let seconds: Vec<i64> = level.iter().map(|p| p.time_unix_s).collect();
    assert!(
        seconds.windows(2).all(|w| w[0] < w[1]),
        "同一秒只有一个点，按时间递增：{seconds:?}"
    );
    assert_eq!(level.last().map(|p| p.value), Some(59.0), "最后一个值");
}

#[tokio::test]
async fn points_queued_while_disconnected_are_capped_by_dropping_the_oldest() {
    let cp = FakeControlPlane::start().await;
    let port = cp.port;
    let mut options = AgentOptions::new(&cp.url, "agent-metric-cap");
    options.args = vec!["--metric-queue-points".into(), "1".into()];
    let _agent = spawn_agent(options);
    cp.hello(0).await;
    // 约 6 秒，每秒约 4 次。
    cp.assign(stub_task(
        "task-cap",
        "metrics",
        json!({ "steps": steady(24, 0.25) }),
    ))
    .await;
    cp.wait_for("first metric batch", |all| {
        (!batches_of(all, "task-cap").is_empty()).then_some(())
    })
    .await;
    // 控制面下线约 3 秒（每秒合并成一个点）：Agent 只在内存里保留最新的 1 个点。
    drop(cp);
    tokio::time::sleep(Duration::from_millis(3000)).await;
    let cp = FakeControlPlane::start_on(port).await;

    let (result, _) = cp.result("task-cap").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let batches = batches_of(&cp.received_with_session(), "task-cap");
    let dropped: u64 = batches.iter().map(|(_, _, b)| b.dropped_points).sum();
    assert!(dropped > 0, "上报了丢弃计数：{batches:#?}");
    let first = &batches[0].2;
    assert!(first.dropped_points > 0, "恢复后的第一批就带上丢弃计数");
    assert!(
        first.points.len() <= 1,
        "排队的点不超过上限：{:?}",
        first.points
    );
    let seconds: Vec<i64> = points_of(&batches, "level")
        .iter()
        .map(|p| p.time_unix_s)
        .collect();
    assert!(
        seconds.windows(2).all(|w| w[0] < w[1]),
        "保留的是最新的点，按时间递增：{seconds:?}"
    );
    assert_eq!(
        points_of(&batches, "level").last().map(|p| p.value),
        Some(23.0),
        "最后一个值"
    );
}
