//! Agent 发出的每一条结果都有上界（#723）：控制面一条消息有上限（`readMaxBytes`，#674），超过的会被拒绝，没有 Ack 的结果每次
//! 重连都先重发，一直被拒的话 Agent 一直重连、任务一直 running、排在后面的结果和心跳过不去。
//!
//! - 失败结果的文字有上界：新版本的执行器（SDK）自己限长，异常的类型、出错的位置、说明的首尾、堆栈的最后几帧都在；
//!   旧版本的执行器写出的两段文字都很大时，Agent 把中间省掉，开头和末尾各留一半，写明省掉了多少；
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

/// 新版本的执行器（SDK）：节点抛出 45 MiB 文字的异常，写出的失败原因里有异常的类型、出错的位置、说明的首尾和堆栈，
/// 总共不到 100 KiB；Agent 的限长碰不到（`output.json` 远小于读取上限），完整的文字在任务日志的标准错误里。
#[tokio::test]
async fn a_huge_exception_keeps_its_type_its_place_and_both_ends_of_its_text() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-big-exception"));
    cp.hello(0).await;

    let result = result_of(&cp, "t-big", "big_exception", json!({ "size": 45 * MIB })).await;
    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.as_ref().expect("失败带着原因");
    assert_eq!(error.kind(), ErrorKind::NodeError);
    // 出错的位置（节点代码里 raise 的那一行）和堆栈：旧的做法在这里什么都没有
    assert!(
        error.location.starts_with("sfly_stub.big_exception 第 "),
        "{:?}",
        error.location
    );
    let message = &error.message;
    assert!(
        message.starts_with("RuntimeError: eeee"),
        "{}",
        &message[..60]
    );
    assert!(message.contains("异常的文字有"), "写明省掉了多少");
    assert!(message.contains("Traceback (most recent call last):"));
    assert!(message.contains("big_exception"), "堆栈里有节点的那一帧");
    assert!(message.len() < 100 * 1024, "{} 字节", message.len());
    // 同样的文字不存两份：堆栈末尾不再是几万个 e
    assert!(!message.ends_with("eeee"));
    assert!(message.contains("这条异常的文字就是上面的说明"));
    // 完整的文字进了任务日志（标准错误），没有因为限长而丢
    let logged: usize = cp
        .received()
        .iter()
        .filter_map(|m| match &m.body {
            Some(agent_message::Body::Logs(batch)) if batch.task_id == "t-big" => Some(
                batch
                    .lines
                    .iter()
                    .map(|l| l.text.matches('e').count())
                    .sum::<usize>(),
            ),
            _ => None,
        })
        .sum();
    assert!(logged >= 40 * MIB, "任务日志里有 {logged} 个 e");
}

/// 旧版本的执行器（说明和堆栈都不限长）：两段加起来超过 1 MiB，Agent 兜住——开头和末尾各留一半，写明省掉了多少。
#[tokio::test]
async fn a_failure_text_from_an_older_executor_is_bounded_and_keeps_its_start_and_end() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-old-executor"));
    cp.hello(0).await;

    // message 和 traceback 各 3 MiB（output.json 共 6 MiB 多，在读取上限之内）
    let result = result_of(
        &cp,
        "t-old",
        "raw_output",
        json!({ "kind": "failed", "size": 3 * MIB, "traceback_size": 3 * MIB }),
    )
    .await;
    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.as_ref().expect("失败带着原因");
    assert_eq!(error.kind(), ErrorKind::NodeError);
    assert!(
        error.message.len() < MIB + 300,
        "{} 字节",
        error.message.len()
    );
    assert!(error.message.contains("失败的文字有"), "写明省掉了");
    // 末尾是能照着做的话：升级 SDK
    assert!(
        error
            .message
            .ends_with("完整的堆栈在任务日志的标准错误里。）"),
        "{}",
        &error.message[error.message.len() - 120..]
    );
    assert!(error.message.contains("升级 SDK"));
    assert!(error.message.starts_with("mmmm"));
    assert!(
        result.encoded_len() < 2 * MIB,
        "整条结果 {} 字节",
        result.encoded_len()
    );
}

/// 多字节的字符：字符数在 1 Mi 之下、字节数超过 1 MiB 的失败文字也要截（按字节算），截在字符边界上。
#[tokio::test]
async fn a_multibyte_failure_text_is_bounded_by_bytes_not_by_characters() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-multibyte"));
    cp.hello(0).await;

    // 两段各 40 万个「中」（各 1.2 MB）：拼起来 80 万个字符（在 1 Mi 之下）、约 2.4 MB
    let result = result_of(
        &cp,
        "t-wide",
        "raw_output",
        json!({ "kind": "failed", "size": 400_000, "traceback_size": 400_000, "char": "中" }),
    )
    .await;
    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.as_ref().expect("失败带着原因");
    assert!(
        error.message.len() < MIB + 300,
        "{} 字节、{} 个字符",
        error.message.len(),
        error.message.chars().count()
    );
    assert!(error.message.contains("失败的文字有"), "写明省掉了");
    assert!(error.message.starts_with("中中中"));
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
    // 能照着做的话：升级 SDK 就能看到类型和位置；完整的堆栈在任务日志里
    assert!(
        error.message.contains("升级节点包用的 SDK") && error.message.contains("任务日志"),
        "{}",
        &error.message[..400.min(error.message.len())]
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
    // 写明原来是成功的、整条消息多大、怎么办
    assert!(
        error.message.starts_with("任务成功了，结果有 "),
        "{}",
        error.message
    );
    assert!(error.message.contains("办法："), "{}", error.message);
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
    // 那一批日志确实被拒绝了：连接断开、结果是在重连之后的会话里收到的（日志先于结果，被拒的时候结果还没送到）
    let (_, session) = cp.result("t-log").await;
    assert!(session >= 1, "会话 {session}：没有被拒绝过");
}

/// 某个任务在 `min_session` 及之后的会话里收到的第一条结果：（结果, 会话, 整条 AgentMessage 的字节数）。
fn result_in_session(
    cp: &FakeControlPlane,
    task: &str,
    min_session: usize,
) -> Option<(TaskResult, usize, usize)> {
    cp.received_with_session()
        .into_iter()
        .find_map(|r| match &r.message.body {
            Some(agent_message::Body::Result(res))
                if res.task_id == task && r.session >= min_session =>
            {
                Some((res.clone(), r.session, r.message.encoded_len()))
            }
            _ => None,
        })
}

async fn wait_for_result(
    cp: &FakeControlPlane,
    task: &str,
    min_session: usize,
    within: Duration,
) -> Option<(TaskResult, usize, usize)> {
    let deadline = tokio::time::Instant::now() + within;
    loop {
        if let Some(found) = result_in_session(cp, task, min_session) {
            return Some(found);
        }
        if tokio::time::Instant::now() > deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 控制面比的是整条消息（`AgentMessage`，比结果自己的编码多 4 到 5 个字节）：结果自己不超过上限、整条超过的，
/// 也会被拒，所以也要换掉；只比结果自己的话，它被拒、不被换，照原样重发，一直被拒。
#[tokio::test]
async fn a_result_over_the_limit_only_by_its_envelope_is_still_replaced() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-envelope"));
    cp.hello(0).await;
    let text = "t".repeat(200_000);
    cp.assign(stub_task("w-aaaa", "echo", json!({ "text": text })))
        .await;
    let (first, _, wire) = wait_for_result(&cp, "w-aaaa", 0, Duration::from_secs(30))
        .await
        .expect("第一条结果");
    assert_eq!(first.status(), TaskStatus::Success);
    // 同样大小的第二条：整条消息比上限多 1 个字节，结果自己的编码不超过上限
    let limit = wire - 1;
    assert!(first.encoded_len() <= limit);
    cp.set_message_limit(limit);
    cp.assign(stub_task("w-bbbb", "echo", json!({ "text": text })))
        .await;
    let (result, _, _) = wait_for_result(&cp, "w-bbbb", 0, Duration::from_secs(30))
        .await
        .expect("超限的结果换成失败送到，不是一直被拒");
    assert_eq!(result.status(), TaskStatus::Failed);
    let message = &result.error.as_ref().expect("失败带着原因").message;
    assert!(message.contains(&format!("上限 {limit} 字节")), "{message}");
}

/// 被拒的是遥测：一条已经发出、没 Ack、大小在上限之下（但超过上限的一半）的成功结果，重连之后原样重发，仍是成功。
/// 成功变失败是最坏的方向：只要它在上限之下就不能换。
#[tokio::test]
async fn an_unacked_success_under_the_limit_is_resent_unchanged_after_a_telemetry_rejection() {
    let cp = FakeControlPlane::start().await;
    cp.set_message_limit(100 * 1024);
    cp.stop_acking();
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-under-limit"));
    cp.hello(0).await;
    // 90 KB 的成功结果：在 100 KiB 的上限之下、上限的一半之上；发出去不回 Ack，留在待 Ack 里
    cp.assign(stub_task(
        "u-ok",
        "raw_output",
        json!({ "kind": "success", "size": 90_000 }),
    ))
    .await;
    let (first, session, wire) = wait_for_result(&cp, "u-ok", 0, Duration::from_secs(30))
        .await
        .expect("第一次发出的结果");
    assert_eq!(first.status(), TaskStatus::Success);
    assert!(wire < 100 * 1024 && wire > 50 * 1024, "{wire}");
    // 一批日志超过上限，连接被拒；重连之后待 Ack 的结果重发
    cp.assign(stub_task(
        "u-log",
        "long_line",
        json!({ "head": 300_000, "value": "v", "tail": 0 }),
    ))
    .await;
    let (resent, again, _) = wait_for_result(&cp, "u-ok", session + 1, Duration::from_secs(30))
        .await
        .expect("被拒之后重发（在重连之后的会话里）");
    assert!(again > session);
    assert_eq!(
        resent.status(),
        TaskStatus::Success,
        "没超过上限的成功结果不能换成失败"
    );
    assert_eq!(resent.outputs_json, first.outputs_json);
}

/// 两条超限的结果先后被拒：两条都换成失败送到（不是每个进程只换一次）。
#[tokio::test]
async fn two_results_rejected_one_after_another_are_both_replaced() {
    let cp = FakeControlPlane::start().await;
    cp.set_message_limit(100 * 1024);
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-twice"));
    cp.hello(0).await;
    for task in ["two-1", "two-2"] {
        let result = result_of(&cp, task, "echo", json!({ "text": "t".repeat(300_000) })).await;
        assert_eq!(result.status(), TaskStatus::Failed, "{task}");
        let message = &result.error.as_ref().expect("失败带着原因").message;
        assert!(message.contains("上限 102400 字节"), "{task}：{message}");
    }
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
