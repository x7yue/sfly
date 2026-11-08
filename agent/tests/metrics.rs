//! 切入点 B（Agent 一侧）：真实 Agent + SDK 执行器 + 桩节点 `metrics` 上报指标（#29）。
//! Agent 按「任务 × 序列（指标名 + 标签）× 秒」合并，每个任务每秒最多发一批 `MetricBatch`，任务结束前发完；
//! 断线期间在内存里排队（有上限，超出丢弃最早的点），恢复后上报丢弃计数。

mod support;

use std::collections::HashMap;
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

fn labels(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
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
async fn points_of_different_series_in_the_same_second_are_merged_separately() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-metric-labels"));
    cp.hello(0).await;

    let a = json!({ "host": "a", "port": 1 });
    let b = json!({ "port": "1", "host": "b" });
    cp.assign(stub_task(
        "task-labels",
        "metrics",
        json!({ "steps": [
            "align",
            ["conn", 5, a], ["conn", 1, b], ["conn", 3, a], ["conn", 2, b], ["level", 9],
            "align",
            ["conn", 7, a],
        ] }),
    ))
    .await;

    let (result, _) = cp.result("task-labels").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let batches = batches_of(&cp.received_with_session(), "task-labels");
    let conn = points_of(&batches, "conn");
    let of = |host: &str| -> Vec<(i64, f64, f64, f64)> {
        conn.iter()
            .filter(|p| p.labels == labels(&[("host", host), ("port", "1")]))
            .map(|p| (p.time_unix_s, p.value, p.min, p.max))
            .collect()
    };
    let (series_a, series_b) = (of("a"), of("b"));
    assert_eq!(conn.len(), 3, "每个序列每秒一个点：{conn:?}");
    assert_eq!(series_a.len(), 2, "{conn:?}");
    assert_eq!(series_b.len(), 1, "{conn:?}");
    // 同一秒里两个序列各自取最后一个值、最小值和最大值，互不影响。
    assert_eq!(
        (series_a[0].1, series_a[0].2, series_a[0].3),
        (3.0, 3.0, 5.0)
    );
    assert_eq!(
        (series_b[0].1, series_b[0].2, series_b[0].3),
        (2.0, 1.0, 2.0)
    );
    assert_eq!(series_a[1].1, 7.0);
    let level = points_of(&batches, "level");
    assert_eq!(level.len(), 1);
    assert!(level[0].labels.is_empty(), "不带标签的指标没有标签");
    assert_eq!(series_b[0].0, level[0].time_unix_s);
    assert_eq!(series_a[0].0, level[0].time_unix_s);
    assert_eq!(series_a[1].0, level[0].time_unix_s + 1);
}

#[tokio::test]
async fn an_event_recorded_at_the_end_of_a_second_but_read_late_is_merged_into_that_second() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-metric-late"));
    cp.hello(0).await;

    // 第 S 秒开始上报 1；过了 S+1 秒 Agent 发过一批后，才读到时间戳为 S.999 的 5。
    cp.assign(stub_task(
        "task-late",
        "metrics",
        json!({ "steps": [
            "align", ["level", 1], 1.4, ["late", "level", 5], ["level", 2], 1.5,
        ] }),
    ))
    .await;

    let (result, _) = cp.result("task-late").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let level = points_of(
        &batches_of(&cp.received_with_session(), "task-late"),
        "level",
    );
    assert_eq!(level.len(), 2, "每秒一个点：{level:?}");
    assert_eq!(
        (level[0].value, level[0].min, level[0].max),
        (5.0, 1.0, 5.0),
        "后读到的值并入同一秒：{level:?}"
    );
    assert_eq!(level[1].time_unix_s, level[0].time_unix_s + 1);
    assert_eq!(level[1].value, 2.0);
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
    // 不另外要求前后两批覆盖的秒不重叠：实现不保证这一点——晚于宽限期才读到的点会让已发过的秒
    // 出现在下一批（见单元测试 at_most_one_batch_per_second_even_when_late_points_arrive）。
    // 这里只查实现保证的性质：上面的批数上限，和下面的同一指标按时间递增（这个任务只有 level，
    // 递增就意味着没有重复的秒；只有读取迟到超过一秒宽限这种极端负载才会打破它）。
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

#[tokio::test]
async fn labels_survive_queueing_while_disconnected() {
    let cp = FakeControlPlane::start().await;
    let port = cp.port;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-metric-labels-queue"));
    cp.hello(0).await;
    // 约 5 秒，每 0.25 秒给两个序列各上报一次。
    let steps: Vec<Value> = (0..20)
        .flat_map(|i| {
            [
                json!(["conn", i, { "host": "a", "port": 1 }]),
                json!(["conn", i, { "host": "b", "port": 1 }]),
                json!(0.25),
            ]
        })
        .collect();
    cp.assign(stub_task(
        "task-labels-queue",
        "metrics",
        json!({ "steps": steps }),
    ))
    .await;
    cp.wait_for("first metric batch", |all| {
        (!batches_of(all, "task-labels-queue").is_empty()).then_some(())
    })
    .await;
    // 控制面下线：这期间的点在 Agent 内存里排队，恢复后补发。第 t 秒的点在墙上时钟到第 t + 2 秒时才发出
    // （合并的一秒加 1 秒宽限），所以第 down_at 秒到第 up_at - 3 秒的点都是下线期间发出、排队后补发的；
    // 至少等到 down_at + 3 再恢复，这一段才不为空（任务约 5 秒，这时还在上报）。
    drop(cp);
    let down_at = unix_now();
    while unix_now() < down_at + 3 {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let up_at = unix_now();
    let cp = FakeControlPlane::start_on(port).await;

    let (result, _) = cp.result("task-labels-queue").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let conn = points_of(
        &batches_of(&cp.received_with_session(), "task-labels-queue"),
        "conn",
    );
    let a = labels(&[("host", "a"), ("port", "1")]);
    let b = labels(&[("host", "b"), ("port", "1")]);
    assert!(
        conn.iter().all(|p| p.labels == a || p.labels == b),
        "补发的点带着各自的标签：{conn:?}"
    );
    for series in [&a, &b] {
        let points: Vec<(i64, f64)> = conn
            .iter()
            .filter(|p| p.labels == *series)
            .map(|p| (p.time_unix_s, p.value))
            .collect();
        // 不按点数断言（取决于下线时长和机器负载），只要求下线期间发出的点带着标签补发到了。
        assert!(
            points.iter().any(|&(t, _)| t >= down_at && t + 2 < up_at),
            "{series:?} 下线期间（{down_at}–{up_at}）的点：{points:?}"
        );
        assert_eq!(
            points.last().map(|&(_, v)| v),
            Some(19.0),
            "{series:?}: {points:?}"
        );
    }
}

/// 墙上时钟的 Unix 秒（与 SDK 上报的时间戳同一个时钟）。
fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("时钟早于 1970 年")
        .as_secs() as i64
}
