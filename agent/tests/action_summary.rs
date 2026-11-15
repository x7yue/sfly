//! 切入点 B（Agent 一侧）：节点写进事件管道的动作摘要（`action_summary`，规格 #345，格式见 sdk/python/src/sfly/context.py）
//! 由 Agent 以 ActionSummary 消息原样转发：和进度一样只保留最新一份，每个任务每秒最多发一次，任务结束前把最后一份
//! 发完再发结果；断线期间每个任务只排队最新的一份。一行事件不限长度，最长的摘要也整行到达。

mod support;

use std::time::Duration;

use serde_json::{Value, json};
use sfly_agent::proto::{ActionSummary, TaskStatus, agent_message};
use support::{AgentOptions, FakeControlPlane, Received, spawn_agent, stub_task, wait_until};

/// 某个任务收到的动作摘要：在全部已收消息中的位置、收到的那条消息、解析后的摘要。
fn summaries_of(all: &[Received], task_id: &str) -> Vec<(usize, Received, Value)> {
    all.iter()
        .enumerate()
        .filter_map(|(i, r)| match &r.message.body {
            Some(agent_message::Body::ActionSummary(ActionSummary {
                task_id: id,
                event_json,
                ..
            })) if id == task_id => {
                let summary = serde_json::from_str(event_json).expect("event_json 是 JSON");
                Some((i, r.clone(), summary))
            }
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn only_the_latest_summary_is_forwarded_at_most_once_per_second_and_the_last_precedes_the_result()
 {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-summary-rate"));
    cp.hello(0).await;

    // 约 3 秒写出 30 份摘要，比 SDK 自己的每秒一份快得多。
    cp.assign(stub_task(
        "task-summary-rate",
        "summary_burst",
        json!({ "count": 30, "interval": 0.1 }),
    ))
    .await;

    let (result, result_at) = cp.result_at("task-summary-rate").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let summaries = summaries_of(&cp.received_with_session(), "task-summary-rate");
    assert!(
        (2..=5).contains(&summaries.len()),
        "合并后约每秒一份，实际 {} 份",
        summaries.len()
    );
    // 任务结束时补发的最后一份不受间隔限制。
    for pair in summaries[..summaries.len() - 1].windows(2) {
        let gap = pair[1].1.at - pair[0].1.at;
        assert!(gap >= Duration::from_millis(900), "两份摘要的间隔 {gap:?}");
    }
    let totals: Vec<&Value> = summaries.iter().map(|(_, _, s)| &s["total"]).collect();
    assert_eq!(totals[0], &json!(1), "第一份立即转发：{totals:?}");
    assert_eq!(
        totals.last(),
        Some(&&json!(30)),
        "最后一份是最新的：{totals:?}"
    );
    let (last_at, last, _) = summaries.last().unwrap();
    assert!(*last_at < result_at, "最后一份摘要在结果之前");
    match &last.message.body {
        Some(agent_message::Body::ActionSummary(s)) => assert_eq!(s.attempt, 1),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn the_sdk_summary_of_nested_actions_arrives_as_written() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-summary-sdk"));
    cp.hello(0).await;

    // 桩节点：嵌套的「下单」和「风控检查」、一个标记、一次失败的「下单」，最后开始一个不结束的动作。
    cp.assign(stub_task(
        "task-summary-sdk",
        "actions",
        json!({ "unfinished": true }),
    ))
    .await;

    let (result, result_at) = cp.result_at("task-summary-sdk").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let summaries = summaries_of(&cp.received_with_session(), "task-summary-sdk");
    let (last_at, _, last) = summaries.last().expect("SDK 发出了摘要");
    assert!(*last_at < result_at, "最后一份摘要在结果之前");
    assert_eq!(last["total"], json!(5), "四个动作和一个标记：{last}");
    let running: Vec<&Value> = last["running"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| &a["name"])
        .collect();
    assert_eq!(running, [&json!("从不结束")]);
    assert_eq!(last["recent_failed"][0]["reason"], json!("拒单：余额不足"));
    assert!(
        last["running"][0]["mono"].as_i64().unwrap() > 0,
        "摘要里的单调时钟读数是 SDK 写的"
    );
}

#[tokio::test]
async fn the_longest_possible_summary_arrives_whole() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-summary-max"));
    cp.hello(0).await;

    // 正在做 50 个、最近结束 20 个、最近失败 5 个，名称、字段、失败原因都取上限，全是汉字。
    cp.assign(stub_task("task-summary-max", "actions_max", json!({})))
        .await;

    let (result, result_at) = cp.result_at("task-summary-max").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let all = cp.received_with_session();
    let (last_at, last, summary) = summaries_of(&all, "task-summary-max")
        .pop()
        .expect("SDK 发出了摘要");
    assert!(last_at < result_at, "最后一份摘要在结果之前");
    let bytes = match &last.message.body {
        Some(agent_message::Body::ActionSummary(s)) => s.event_json.len(),
        other => panic!("{other:?}"),
    };
    // 标准输出一行最多 64 KiB（再长就拆开）；事件管道的一行不拆，这一份远远超过它。
    assert!(bytes > 512 * 1024, "这一份摘要 {bytes} 字节");
    let count = |key: &str| summary[key].as_array().map(Vec::len);
    assert_eq!(
        (count("running"), count("recent"), count("recent_failed")),
        (Some(50), Some(20), Some(5))
    );
    let reason = summary["recent_failed"][0]["reason"].as_str().unwrap();
    assert_eq!(reason.chars().count(), 4096);
    assert!(reason.chars().all(|c| c == '因'), "失败原因原样到达");
    let field = summary["running"][49]["fields"]["字段7"].as_str().unwrap();
    assert_eq!(field.chars().count(), 256);
}

#[tokio::test]
async fn while_disconnected_only_the_latest_summary_of_a_task_is_queued() {
    let cp = FakeControlPlane::start().await;
    let port = cp.port;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-summary-queue"));
    cp.hello(0).await;
    let dir = tempfile::tempdir().unwrap();
    let done = dir.path().join("done");

    // 约 3 秒写出 30 份摘要，写完后创建 done。
    cp.assign(stub_task(
        "task-summary-queue",
        "summary_burst",
        json!({ "count": 30, "interval": 0.1, "done_file": done }),
    ))
    .await;
    cp.wait_for("first summary", |all| {
        (!summaries_of(all, "task-summary-queue").is_empty()).then_some(())
    })
    .await;
    // 控制面下线：之后的摘要都在 Agent 里排队，直到节点写完、任务结束。
    drop(cp);
    wait_until("the node to finish writing summaries", || done.exists()).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let cp = FakeControlPlane::start_on(port).await;

    let (result, result_at) = cp.result_at("task-summary-queue").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let queued = summaries_of(&cp.received_with_session(), "task-summary-queue");
    let totals: Vec<&Value> = queued.iter().map(|(_, _, s)| &s["total"]).collect();
    assert_eq!(totals, [&json!(30)], "断线期间只排着最新的一份");
    assert!(queued[0].0 < result_at, "排队的摘要在结果之前发出");
}
