//! Hello 和 Heartbeat 带上 Agent 时间与单调时钟读数（#172，ADR 0018）；
//! TaskStarted 和 TaskResult 带上任务开始、结束那一刻的（#175）。

mod support;

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::json;
use sfly_agent::proto::{Heartbeat, TaskStarted, TaskStatus, agent_message};
use support::{AgentOptions, FakeControlPlane, Received, WAIT, spawn_agent, stub_task};

const DAY_MS: i64 = 86_400_000;

fn system_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn heartbeats(all: &[Received]) -> Vec<Heartbeat> {
    all.iter()
        .filter_map(|r| match &r.message.body {
            Some(agent_message::Body::Heartbeat(h)) => Some(h.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn hello_carries_the_agent_time_and_a_monotonic_reading() {
    let cp = FakeControlPlane::start().await;
    let before = system_time_ms();
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-clock"));

    let hello = cp.hello(0).await;
    let after = system_time_ms();
    assert!(
        (before..=after).contains(&hello.agent_time_unix_ms),
        "agent time {} not in {before}..={after}",
        hello.agent_time_unix_ms
    );
    assert!(hello.monotonic_ms > 0, "{}", hello.monotonic_ms);
}

#[tokio::test]
async fn heartbeat_agent_time_follows_the_agent_clock_while_the_monotonic_reading_does_not() {
    let cp = FakeControlPlane::start().await;
    cp.set_heartbeat_interval(Duration::from_millis(100));
    let agent = spawn_agent(AgentOptions::new(&cp.url, "agent-clock"));
    let hello = cp.hello(0).await;

    // 没有拨动时，心跳里的 Agent 时间就是系统时间。
    let started = system_time_ms();
    let first = cp
        .wait_for("a heartbeat with the agent time", |all| {
            heartbeats(all).into_iter().find(|h| h.monotonic_ms > 0)
        })
        .await;
    assert!(
        (started - 60_000..=system_time_ms()).contains(&first.agent_time_unix_ms),
        "{first:?}"
    );
    assert!(first.monotonic_ms >= hello.monotonic_ms, "{first:?}");

    // 往后拨 613 天：心跳里的 Agent 时间跟着变。
    agent.set_agent_time_offset_ms(613 * DAY_MS);
    let ahead = cp
        .wait_for("a heartbeat 613 days ahead", |all| {
            heartbeats(all)
                .into_iter()
                .find(|h| h.agent_time_unix_ms >= started + 613 * DAY_MS)
        })
        .await;
    assert!(
        ahead.agent_time_unix_ms <= system_time_ms() + 613 * DAY_MS,
        "{ahead:?}"
    );

    // 往回拨 1 天：Agent 时间倒退。
    agent.set_agent_time_offset_ms(-DAY_MS);
    cp.wait_for("a heartbeat a day behind", |all| {
        heartbeats(all)
            .into_iter()
            .find(|h| h.monotonic_ms > 0 && h.agent_time_unix_ms <= system_time_ms() - DAY_MS)
    })
    .await;

    // 单调时钟读数不受拨动影响：全程不倒退，总共只走了真实流逝的时长（远小于拨动的量）。
    let readings: Vec<i64> = heartbeats(&cp.received_with_session())
        .iter()
        .map(|h| h.monotonic_ms)
        .collect();
    assert!(readings.windows(2).all(|w| w[0] <= w[1]), "{readings:?}");
    let elapsed = system_time_ms() - started;
    let advanced = readings.last().unwrap() - hello.monotonic_ms;
    assert!(
        (0..=elapsed + 60_000).contains(&advanced),
        "monotonic advanced {advanced}ms in {elapsed}ms: {readings:?}"
    );
}

/// 某个任务的 TaskStarted。
async fn task_started(cp: &FakeControlPlane, task_id: &str) -> TaskStarted {
    cp.wait_for(&format!("TaskStarted of {task_id}"), |all| {
        all.iter().find_map(|r| match &r.message.body {
            Some(agent_message::Body::Started(s)) if s.task_id == task_id => Some(s.clone()),
            _ => None,
        })
    })
    .await
}

#[tokio::test]
async fn task_started_and_result_carry_the_agent_time_of_their_own_moment() {
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(AgentOptions::new(&cp.url, "agent-clock"));
    let hello = cp.hello(0).await;
    let dir = tempfile::tempdir().unwrap();
    let (ready, release) = (dir.path().join("ready"), dir.path().join("release"));

    // 任务开始时 Agent 时间比系统时间快 613 天。
    agent.set_agent_time_offset_ms(613 * DAY_MS);
    let before_start = system_time_ms();
    cp.assign(stub_task(
        "task-clock",
        "gate",
        json!({ "ready_file": ready, "release_file": release }),
    ))
    .await;
    let started = task_started(&cp, "task-clock").await;
    assert!(
        (before_start + 613 * DAY_MS..=system_time_ms() + 613 * DAY_MS)
            .contains(&started.agent_time_unix_ms),
        "{started:?}"
    );
    assert!(started.monotonic_ms >= hello.monotonic_ms, "{started:?}");

    // 执行中途把 Agent 时间改成比系统时间慢 1 天，再让任务结束。
    let deadline = tokio::time::Instant::now() + WAIT;
    while !ready.exists() {
        assert!(tokio::time::Instant::now() < deadline, "task never started");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    agent.set_agent_time_offset_ms(-DAY_MS);
    let before_end = system_time_ms();
    std::fs::write(&release, "").unwrap();
    let (result, _) = cp.result("task-clock").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert!(
        (before_end - DAY_MS..=system_time_ms() - DAY_MS).contains(&result.agent_time_unix_ms),
        "{result:?}"
    );

    // 单调时钟读数不受拨动影响：从开始到结束只走了真实流逝的时长。
    let elapsed = system_time_ms() - before_start;
    let advanced = result.monotonic_ms - started.monotonic_ms;
    assert!(
        (0..=elapsed).contains(&advanced),
        "monotonic advanced {advanced}ms in {elapsed}ms"
    );
}

#[tokio::test]
async fn a_task_that_fails_before_its_executor_starts_still_reports_when_it_ended() {
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(AgentOptions::new(&cp.url, "agent-clock"));
    let hello = cp.hello(0).await;

    agent.set_agent_time_offset_ms(613 * DAY_MS);
    let before = system_time_ms();
    cp.assign(stub_task("task-missing", "no_such_node", json!({})))
        .await;
    let (result, _) = cp.result("task-missing").await;
    assert_eq!(result.status(), TaskStatus::Failed, "{result:?}");
    assert!(
        (before + 613 * DAY_MS..=system_time_ms() + 613 * DAY_MS)
            .contains(&result.agent_time_unix_ms),
        "{result:?}"
    );
    assert!(result.monotonic_ms >= hello.monotonic_ms, "{result:?}");
}
