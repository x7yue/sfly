//! Hello 和 Heartbeat 带上 Agent 时间与单调时钟读数（#172，ADR 0018）。

mod support;

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sfly_agent::proto::{Heartbeat, agent_message};
use support::{AgentOptions, FakeControlPlane, Received, spawn_agent};

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
