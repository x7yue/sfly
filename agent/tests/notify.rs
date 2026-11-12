//! 切入点 B（Agent 一侧）：节点用 ctx.notify 写进事件管道的通知（ADR 0020、ADR 0015）由 Agent 以 Notification 消息
//! 原样转发给控制面，排在节点之前写的日志之后、任务结果之前。

mod support;

use serde_json::{Value, json};
use sfly_agent::proto::{LogBatch, Notification, TaskStatus, agent_message};
use support::{AgentOptions, FakeControlPlane, spawn_agent, stub_task};

#[tokio::test]
async fn notify_events_are_forwarded_as_notification_messages_after_the_earlier_logs() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-notify"));
    cp.hello(0).await;

    cp.assign(stub_task(
        "task-notify",
        "notify",
        json!({ "bot": "ops", "text": "指标越界", "at_all": true, "unlisted": "dev" }),
    ))
    .await;

    let (result, result_at) = cp.result_at("task-notify").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let all = cp.received_with_session();
    let notifications: Vec<(usize, Notification)> = all
        .iter()
        .enumerate()
        .filter_map(|(i, r)| match &r.message.body {
            Some(agent_message::Body::Notification(n)) => Some((i, n.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(notifications.len(), 2, "{notifications:?}");
    assert!(
        notifications
            .iter()
            .all(|(i, n)| *i < result_at && n.task_id == "task-notify" && n.attempt == 1),
        "{notifications:?}"
    );
    let events: Vec<Value> = notifications
        .iter()
        .map(|(_, n)| serde_json::from_str(&n.event_json).expect("event_json 是 JSON"))
        .collect();
    let content = |e: &Value| {
        (
            e["type"].clone(),
            e["bot"].clone(),
            e["text"].clone(),
            e["at_all"].clone(),
        )
    };
    assert_eq!(
        events.iter().map(content).collect::<Vec<_>>(),
        [
            (
                json!("notify"),
                json!("ops"),
                json!("指标越界"),
                json!(true)
            ),
            (
                json!("notify"),
                json!("dev"),
                json!("指标越界"),
                json!(false)
            ),
        ]
    );

    let logged_at = all
        .iter()
        .position(|r| match &r.message.body {
            Some(agent_message::Body::Logs(LogBatch { task_id, lines, .. })) => {
                task_id == "task-notify" && lines.iter().any(|l| l.text == "发通知前")
            }
            _ => false,
        })
        .expect("节点写的日志转发给了控制面");
    assert!(logged_at < notifications[0].0, "通知之前写的日志先到");
}
