//! Agent 发出的每一条结果都有上界（#723）：控制面一条消息有上限（`readMaxBytes`，#674），超过的会被拒绝，没有 Ack 的结果每次
//! 重连都先重发，一直被拒的话 Agent 一直重连、任务一直 running、排在后面的结果和心跳过不去。
//!
//! - 失败结果的文字有上界：节点抛出一条很长的异常，结果里的文字留开头和末尾，中间写明省掉了多少；
//! - 节点的输出超过 1 MB：Agent 自己判失败（和控制面同一句话），不发出去；
//! - 执行器写出的 output.json 超过读取上限：不读，按异常退出判失败，附上标准错误的尾部；
//! - 控制面用「消息超过上限」拒绝了这条连接：超过上限的结果换成失败再发，没超过的（被拒的是遥测）不动；
//! - 握手成功、马上又被断开：重连的等待逐次翻倍，不是每次都从头开始。

mod support;

use std::time::Duration;

use prost::Message as _;
use serde_json::json;
use sfly_agent::proto::{ErrorKind, TaskResult, TaskStatus, agent_message};
use support::{AgentOptions, FakeControlPlane, spawn_agent, stub_task};

const MIB: usize = 1024 * 1024;

async fn result_of(
    cp: &FakeControlPlane,
    task: &str,
    node: &str,
    inputs: serde_json::Value,
) -> TaskResult {
    cp.assign(stub_task(task, node, inputs)).await;
    let (result, _) = cp.result(task).await;
    result
}

#[tokio::test]
async fn a_failure_with_a_huge_exception_text_is_bounded_and_keeps_its_start_and_end() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-big-exception"));
    cp.hello(0).await;

    // 3 MiB 的异常文字：output.json 里 message 和 traceback 各一份，共 6 MiB 多
    let result = result_of(&cp, "t-big", "big_exception", json!({ "size": 3 * MIB })).await;
    assert_eq!(
        result.status(),
        TaskStatus::Failed,
        "{:?}",
        result.error.as_ref().map(|e| e.message.len())
    );
    let error = result.error.as_ref().expect("失败带着原因");
    assert_eq!(error.kind(), ErrorKind::NodeError);
    assert!(
        error.message.len() < MIB + 300,
        "{} 字节",
        error.message.len()
    );
    assert!(error.message.contains("失败的文字有"), "写明省掉了");
    // 开头是异常的类型和消息，末尾是整份文字的末尾（异常的文字；堆栈在被省掉的中间）
    assert!(
        error.message.starts_with("RuntimeError: eeee"),
        "{}",
        &error.message[..80]
    );
    assert!(error.message.ends_with("eeee"));
    assert!(
        result.encoded_len() < 2 * MIB,
        "整条结果 {} 字节",
        result.encoded_len()
    );
}

#[tokio::test]
async fn an_output_json_over_the_read_limit_is_not_read_and_is_a_bounded_failure() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-huge-output-file"));
    cp.hello(0).await;

    // 节点绕过执行器的检查，直接写出 17 MiB 的 output.json（失败的、message 17 MiB）
    let result = result_of(
        &cp,
        "t-huge",
        "raw_output",
        json!({ "kind": "failed", "size": 17 * MIB }),
    )
    .await;
    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.as_ref().expect("失败带着原因");
    assert_eq!(error.kind(), ErrorKind::NodeError);
    assert!(
        error.message.contains("output.json 超过"),
        "{}",
        &error.message[..120.min(error.message.len())]
    );
    assert!(
        error.message.len() < 64 * 1024,
        "{} 字节",
        error.message.len()
    );
    assert!(result.encoded_len() < 128 * 1024);
}

#[tokio::test]
async fn outputs_over_one_megabyte_are_failed_by_the_agent_itself() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-big-outputs"));
    cp.hello(0).await;

    // 绕过执行器的检查：outputs 序列化之后比 1 MiB 多一点
    let result = result_of(
        &cp,
        "t-out",
        "raw_output",
        json!({ "kind": "success", "size": MIB + 100 }),
    )
    .await;
    assert_eq!(result.status(), TaskStatus::Failed);
    assert_eq!(result.outputs_json, "");
    let error = result.error.as_ref().expect("失败带着原因");
    assert_eq!(error.kind(), ErrorKind::NodeError);
    // 和控制面（apps/server/src/engine/output-limit.ts）同一句话
    assert!(
        error.message.starts_with("节点输出超过 1 MB 上限（"),
        "{}",
        error.message
    );
    assert!(error.message.ends_with(" 字节）"));

    // 不超过的照常
    let ok = result_of(
        &cp,
        "t-ok",
        "raw_output",
        json!({ "kind": "success", "size": 1000 }),
    )
    .await;
    assert_eq!(ok.status(), TaskStatus::Success);
}

/// 控制面一条消息最多 100 KiB（假的）：节点的结果有 300 KB 超过它，被以「消息超过上限」拒绝。Agent 重连之后不再原样重发，
/// 换成写明原因的失败再发，任务就能结束（不换的话每次重连都被拒，一直重试，#723）。
#[tokio::test]
async fn a_result_over_the_control_planes_message_limit_is_replaced_by_a_failure_and_delivered() {
    let cp = FakeControlPlane::start().await;
    cp.set_message_limit(100 * 1024);
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-result-over-limit"));
    cp.hello(0).await;

    let result = result_of(
        &cp,
        "t-over",
        "echo",
        json!({ "text": "t".repeat(300_000) }),
    )
    .await;
    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.as_ref().expect("失败带着原因");
    assert_eq!(error.kind(), ErrorKind::NodeError);
    assert!(
        error
            .message
            .contains("超过控制面接收一条消息的上限 102400 字节"),
        "{}",
        error.message
    );
    assert!(result.outputs_json.is_empty());
    // 是重连之后发出的（第一次的被拒了），控制面没有记下那条超限的
    let (_, session) = cp.result("t-over").await;
    assert!(session >= 1, "会话 {session}");
    let results = cp
        .received()
        .into_iter()
        .filter(
            |m| matches!(&m.body, Some(agent_message::Body::Result(r)) if r.task_id == "t-over"),
        )
        .count();
    assert_eq!(results, 1, "超限的那条没有记下，只有换过的这一条");
}

/// 被拒的是遥测（一批日志超过上限）：没有结果超过上限，成功的结果不能因此变成失败。
#[tokio::test]
async fn a_rejected_telemetry_batch_does_not_turn_a_successful_result_into_a_failure() {
    let cp = FakeControlPlane::start().await;
    cp.set_message_limit(100 * 1024);
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-telemetry-over-limit"));
    cp.hello(0).await;

    // 标准输出一行 300 KB：拆成几段、每段带前后文，一批日志有 400 多 KB，超过 100 KiB 的上限被拒
    let result = result_of(
        &cp,
        "t-log",
        "long_line",
        json!({ "head": 300_000, "value": "v", "tail": 0 }),
    )
    .await;
    assert_eq!(result.status(), TaskStatus::Success, "{:?}", result.error);
}

/// 握手成功、马上又被断开：重连的等待逐次翻倍（0.5、1、2 秒……），不是握手一成功就回到 0.5 秒。
#[tokio::test]
async fn a_connection_dropped_right_after_the_welcome_is_retried_with_growing_waits() {
    let cp = FakeControlPlane::start().await;
    cp.end_sessions_after_welcome(0..4);
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-flapping"));
    // 第 4 个会话（序号 4）是第一个不被断开的
    cp.hello(4).await;
    let hellos: Vec<tokio::time::Instant> = cp
        .received_with_session()
        .into_iter()
        .filter(|r| matches!(r.message.body, Some(agent_message::Body::Hello(_))))
        .map(|r| r.at)
        .collect();
    let gaps: Vec<Duration> = hellos.windows(2).map(|w| w[1] - w[0]).collect();
    assert!(gaps.len() >= 4, "{gaps:?}");
    // 每次连上都被断开：等待从 0.5 秒起翻倍，下限比实际的小一点（握手、准备环境各占一点时间）
    assert!(gaps[0] >= Duration::from_millis(450), "{gaps:?}");
    assert!(gaps[1] >= Duration::from_millis(950), "{gaps:?}");
    assert!(gaps[2] >= Duration::from_millis(1950), "{gaps:?}");
    assert!(gaps[3] >= Duration::from_millis(3950), "{gaps:?}");
}

/// 连得稳（撑过了 `--stable-connection-ms`）之后被断开：重连的等待回到最短（0.5 秒），不接着翻倍。
#[tokio::test]
async fn a_connection_that_lasted_long_enough_is_retried_after_the_shortest_wait() {
    let cp = FakeControlPlane::start().await;
    let mut options = AgentOptions::new(&cp.url, "agent-stable");
    options.args = vec!["--stable-connection-ms".into(), "1000".into()];
    let _agent = spawn_agent(options);
    let mut waits = Vec::new();
    for session in 0..3 {
        cp.hello(session).await;
        // 连上之后撑过 1 秒再断开
        tokio::time::sleep(Duration::from_millis(1300)).await;
        let ended = tokio::time::Instant::now();
        cp.end_session();
        cp.hello(session + 1).await;
        let hello_at = cp
            .received_with_session()
            .into_iter()
            .filter(|r| matches!(r.message.body, Some(agent_message::Body::Hello(_))))
            .nth(session + 1)
            .map(|r| r.at)
            .expect("下一个 Hello");
        waits.push(hello_at.saturating_duration_since(ended));
    }
    // 每次都是 0.5 秒加上握手、准备环境的时间；不重置的话第三次要等 2 秒
    assert!(waits[0] >= Duration::from_millis(450), "{waits:?}");
    assert!(
        waits.iter().all(|w| *w < Duration::from_millis(1500)),
        "{waits:?}"
    );
}
