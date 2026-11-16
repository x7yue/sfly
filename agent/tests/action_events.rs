//! 切入点 B（Agent 一侧）：节点用 ctx.action、ctx.mark 写进事件管道的四种事件（`action_start`、`action_end`、
//! `mark`、`action_summary`，规格 #345，格式见 sdk/python/src/sfly/context.py）。
//! Agent 认得它们，不会当成不认识的内容原样记成一行 SDK 日志：摘要转发给控制面（action_summary.rs），
//! 另外三种解析后以 ActionBatch 转发（SDK 真实写出的事件在这里，细节和边界情况在 action_details.rs）。

mod support;

use serde_json::json;
use sfly_agent::clock;
use sfly_agent::proto::{
    ActionBatch, ActionEvent, ActionField, LogBatch, LogSource, TaskStatus, action_event,
    agent_message,
};
use support::{AgentOptions, FakeControlPlane, spawn_agent, stub_task, system_time_ms};

fn fields(fields: &[ActionField]) -> String {
    let pairs: Vec<String> = fields
        .iter()
        .map(|f| format!("{}={}", f.key, f.value))
        .collect();
    format!("[{}]", pairs.join(","))
}

/// 一个事件的一行说明：种类、ID、父动作、层级、名称或结果、字段。
fn describe(event: &ActionEvent) -> String {
    match &event.kind {
        Some(action_event::Kind::Start(s)) => format!(
            "start #{} {} parent={:?} depth={} late={} {}",
            s.id,
            s.name,
            s.parent,
            s.depth,
            s.late,
            fields(&s.fields)
        ),
        Some(action_event::Kind::End(e)) => format!(
            "end #{} {:?} reason={:?} {}",
            e.id,
            e.result(),
            e.reason,
            fields(&e.fields)
        ),
        Some(action_event::Kind::Mark(m)) => format!(
            "mark #{} {} parent={:?} depth={} {}",
            m.id,
            m.name,
            m.parent,
            m.depth,
            fields(&m.fields)
        ),
        None => "没有内容".into(),
    }
}

#[tokio::test]
async fn action_events_are_forwarded_as_action_batches_before_the_result_and_not_logged() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-actions"));
    cp.hello(0).await;
    let (before, before_system) = (clock::monotonic_ms(), system_time_ms());

    // 桩节点：嵌套的动作、一个标记、一次失败，最后一个动作不结束；SDK 另外发出摘要。
    cp.assign(stub_task(
        "task-actions",
        "actions",
        json!({ "unfinished": true }),
    ))
    .await;

    let (result, result_at) = cp.result_at("task-actions").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let (after, after_system) = (clock::monotonic_ms(), system_time_ms());
    let received = cp.received_with_session();

    // 不记成日志。
    let logs: Vec<(LogSource, String)> = received[..result_at]
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

    // 转发成 ActionBatch，都在结果之前，先后是 SDK 写的先后。
    let batches: Vec<(usize, &ActionBatch)> = received
        .iter()
        .enumerate()
        .filter_map(|(i, r)| match &r.message.body {
            Some(agent_message::Body::Actions(b)) if b.task_id == "task-actions" => Some((i, b)),
            _ => None,
        })
        .collect();
    assert!(
        batches.iter().all(|(i, _)| *i < result_at),
        "所有动作批次都在结果之前到达"
    );
    assert!(batches.iter().all(|(_, b)| b.attempt == 1));
    let events: Vec<&ActionEvent> = batches.iter().flat_map(|(_, b)| &b.events).collect();
    let lines: Vec<String> = events.iter().map(|e| describe(e)).collect();
    assert_eq!(
        lines,
        [
            "start #1 下单 parent=None depth=0 late=false [订单=1001]",
            "mark #2 收到第一笔成交 parent=Some(1) depth=1 [订单=1001]",
            "start #3 风控检查 parent=Some(1) depth=1 late=false []",
            "end #3 Success reason=None []",
            "end #1 Success reason=None [回报=已成交]",
            "start #4 下单 parent=None depth=0 late=false [订单=1002]",
            "end #4 Failed reason=Some(\"拒单：余额不足\") []",
            "start #5 从不结束 parent=None depth=0 late=false [订单=1003]",
        ]
    );
    // SDK 写的时间：Agent 时间在测试期间的系统时间之内，单调时钟读数在测试进程读的两个读数之内并随写的先后增加。
    assert!(
        events
            .iter()
            .all(|e| before_system <= e.time_unix_ms && e.time_unix_ms <= after_system),
        "{:?}",
        events.iter().map(|e| e.time_unix_ms).collect::<Vec<_>>()
    );
    let monos: Vec<i64> = events.iter().map(|e| e.monotonic_ms).collect();
    assert!(
        monos.iter().all(|m| before <= *m && *m <= after) && monos.is_sorted(),
        "{before} <= {monos:?} <= {after}"
    );
}
