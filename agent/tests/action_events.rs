//! 切入点 B（Agent 一侧）：节点用 ctx.action、ctx.mark 写进事件管道的四种事件（`action_start`、`action_end`、
//! `mark`、`action_summary`，规格 #345，格式见 sdk/python/src/sfly/context.py）。
//! Agent 认得它们，不会当成不认识的内容原样记成一行 SDK 日志：摘要转发给控制面（action_summary.rs），
//! 另外三种目前丢弃。

mod support;

use serde_json::json;
use sfly_agent::proto::{LogBatch, LogSource, TaskStatus, agent_message};
use support::{AgentOptions, FakeControlPlane, spawn_agent, stub_task};

#[tokio::test]
async fn action_events_do_not_show_up_in_the_task_log() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-actions"));
    cp.hello(0).await;

    // 桩节点：嵌套的动作、一个标记、一次失败，最后一个动作不结束；SDK 另外发出摘要。
    cp.assign(stub_task(
        "task-actions",
        "actions",
        json!({ "unfinished": true }),
    ))
    .await;

    let (result, result_at) = cp.result_at("task-actions").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let logs: Vec<(LogSource, String)> = cp.received_with_session()[..result_at]
        .iter()
        .filter_map(|r| match &r.message.body {
            Some(agent_message::Body::Logs(LogBatch { task_id, lines, .. }))
                if task_id == "task-actions" =>
            {
                Some(lines.iter().map(|l| (l.source(), l.text.clone())))
            }
            _ => None,
        })
        .flatten()
        .collect();
    assert_eq!(
        logs,
        [
            (LogSource::Sdk, "动作前".to_string()),
            (LogSource::Sdk, "动作后".to_string()),
        ]
    );
}
