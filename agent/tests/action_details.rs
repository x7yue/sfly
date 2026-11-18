//! 切入点 B（Agent 一侧）：节点写进事件管道的动作明细（`action_start`、`action_end`、`mark`，规格 #345，
//! 格式见 sdk/python/src/sfly/context.py）由 Agent 解析后以 ActionBatch 消息转发：和日志一样约每 100 毫秒一批，
//! 一批最多 1000 个事件，同一批内按事件管道里的先后排列，任务结束前发完再发结果。
//! 转发跟不上时暂停读取事件管道，节点的写入等待，不丢事件；断线期间排队的批次有字节数上限。
//!
//! 节点用桩节点 `raw_events`、`action_flood` 直接写事件管道（SDK 自己最多上报 10 万个明细，也写不出没有 `mono` 的事件）；
//! SDK 真实写出的事件见 action_events.rs。时间只用事件里写的值和测试进程读的单调时钟，不量耗时。

mod support;

use std::time::Duration;

use serde_json::{Value, json};
use sfly_agent::clock;
use sfly_agent::proto::{
    ActionBatch, ActionEnd, ActionEvent, ActionField, ActionMark, ActionResult, ActionStart,
    LogBatch, LogLevel, LogSource, TaskStatus, action_event, agent_message,
};
use support::{
    AgentOptions, DAYS_613_MS, FakeControlPlane, Received, peak_rss_bytes, spawn_agent, stub_task,
    system_time_ms,
};
use tokio::io::{AsyncBufReadExt, BufReader};

const MIB: u64 = 1024 * 1024;
/// 一批最多的事件个数（与日志一样）。
const MAX_BATCH_EVENTS: usize = 1000;
/// 桩节点 `action_flood` 写的 ts、mono 的基数。
const FLOOD_TS: i64 = 1_700_000_000_000;
const FLOOD_MONO: i64 = 1_000_000;
const TS: i64 = 1_700_000_000_000;

/// 某个任务收到的动作批次：在全部已收消息中的位置、批次。
fn batches_of(all: &[Received], task_id: &str) -> Vec<(usize, ActionBatch)> {
    all.iter()
        .enumerate()
        .filter_map(|(i, r)| match &r.message.body {
            Some(agent_message::Body::Actions(batch)) if batch.task_id == task_id => {
                Some((i, batch.clone()))
            }
            _ => None,
        })
        .collect()
}

/// 批次里的全部事件，按到达的先后。
fn events_of(batches: &[(usize, ActionBatch)]) -> Vec<ActionEvent> {
    batches
        .iter()
        .flat_map(|(_, batch)| batch.events.clone())
        .collect()
}

/// 等到任务的结果，返回它收到的全部动作批次；批次都必须在结果之前到达。
async fn batches_before_the_result(
    cp: &FakeControlPlane,
    task_id: &str,
) -> Vec<(usize, ActionBatch)> {
    let (result, result_at) = cp.result_at(task_id).await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let batches = batches_of(&cp.received_with_session(), task_id);
    assert!(
        batches.iter().all(|(i, _)| *i < result_at),
        "所有动作批次都在结果之前到达"
    );
    batches
}

fn fields(pairs: &[(&str, &str)]) -> Vec<ActionField> {
    pairs
        .iter()
        .map(|(key, value)| ActionField {
            key: key.to_string(),
            value: value.to_string(),
        })
        .collect()
}

fn event(time_unix_ms: i64, monotonic_ms: i64, kind: action_event::Kind) -> ActionEvent {
    ActionEvent {
        time_unix_ms,
        monotonic_ms,
        kind: Some(kind),
    }
}

/// 派发桩节点 `raw_events`：它把这些行写进事件管道，然后退出。
async fn assign_raw_events(cp: &FakeControlPlane, task_id: &str, lines: Value) {
    cp.assign(stub_task(task_id, "raw_events", json!({ "lines": lines })))
        .await;
}

/// 事件管道里写了这些行：一个动作和它的子动作、一个标记、一个失败的动作、一个补发的动作……
/// 写成字符串原样交给桩节点：`json!` 的对象按键排序，会改掉 `fields` 里键的先后。
fn every_kind_of_line() -> Value {
    json!([
        r#"{"type":"action_start","ts":1700000000001,"mono":101,"id":1,"parent":null,"depth":0,"name":"下单","fields":{"订单":"1001","a":"x","品种":"IF2412"}}"#,
        r#"{"type":"action_start","ts":1700000000002,"mono":102,"id":2,"parent":1,"depth":1,"name":"风控检查","fields":{}}"#,
        r#"{"type":"mark","ts":1700000000003,"mono":103,"id":3,"parent":2,"depth":2,"name":"命中白名单","fields":{"规则":"R7","z":"1"}}"#,
        r#"{"type":"action_end","ts":1700000000004,"mono":104,"id":2,"result":"success","reason":null,"fields":{}}"#,
        r#"{"type":"action_end","ts":1700000000005,"mono":105,"id":1,"result":"failed","reason":"ValueError: 拒单","fields":{"回报":"rejected","订单":"1001"}}"#,
        r#"{"type":"action_start","ts":1699999995000,"mono":90,"id":4,"parent":null,"depth":0,"name":"撤单","fields":{"订单":"1002"},"late":true}"#,
        r#"{"type":"action_end","ts":1700000000006,"mono":106,"id":4,"result":"failed","reason":"拒单：余额不足","fields":{}}"#,
        r#"{"type":"mark","ts":1700000000007,"mono":107,"id":5,"depth":0,"name":"收盘","fields":{}}"#,
        r#"{"type":"action_start","ts":1700000000008,"mono":108,"id":6,"parent":null,"depth":0,"name":"等待","fields":{}}"#,
        r#"{"type":"action_end","ts":1700000000009,"mono":109,"id":6,"result":"unfinished","reason":null,"fields":{}}"#,
    ])
}

#[tokio::test]
async fn events_written_together_arrive_in_one_batch_in_pipe_order_with_every_field_as_written() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-actions-batch"));
    cp.hello(0).await;

    assign_raw_events(&cp, "task-batch", every_kind_of_line()).await;

    let batches = batches_before_the_result(&cp, "task-batch").await;
    let [(_, batch)] = batches.as_slice() else {
        panic!("一次写完的十个事件在同一批里：{batches:#?}");
    };
    assert_eq!((batch.task_id.as_str(), batch.attempt), ("task-batch", 1));
    // 排列的先后就是写的先后，不按单调时钟重排：补发的 action_start（mono 90）时间最早，仍然紧挨着它的 action_end。
    // 字段的先后也是写的先后（不按键排序）。
    let want = vec![
        event(
            TS + 1,
            101,
            action_event::Kind::Start(ActionStart {
                id: 1,
                parent: None,
                depth: 0,
                name: "下单".into(),
                fields: fields(&[("订单", "1001"), ("a", "x"), ("品种", "IF2412")]),
                late: false,
            }),
        ),
        event(
            TS + 2,
            102,
            action_event::Kind::Start(ActionStart {
                id: 2,
                parent: Some(1),
                depth: 1,
                name: "风控检查".into(),
                fields: vec![],
                late: false,
            }),
        ),
        event(
            TS + 3,
            103,
            action_event::Kind::Mark(ActionMark {
                id: 3,
                parent: Some(2),
                depth: 2,
                name: "命中白名单".into(),
                fields: fields(&[("规则", "R7"), ("z", "1")]),
            }),
        ),
        event(
            TS + 4,
            104,
            action_event::Kind::End(ActionEnd {
                id: 2,
                result: ActionResult::Success.into(),
                reason: None,
                fields: vec![],
            }),
        ),
        event(
            TS + 5,
            105,
            action_event::Kind::End(ActionEnd {
                id: 1,
                result: ActionResult::Failed.into(),
                reason: Some("ValueError: 拒单".into()),
                fields: fields(&[("回报", "rejected"), ("订单", "1001")]),
            }),
        ),
        event(
            TS - 5_000,
            90,
            action_event::Kind::Start(ActionStart {
                id: 4,
                parent: None,
                depth: 0,
                name: "撤单".into(),
                fields: fields(&[("订单", "1002")]),
                late: true,
            }),
        ),
        event(
            TS + 6,
            106,
            action_event::Kind::End(ActionEnd {
                id: 4,
                result: ActionResult::Failed.into(),
                reason: Some("拒单：余额不足".into()),
                fields: vec![],
            }),
        ),
        event(
            TS + 7,
            107,
            action_event::Kind::Mark(ActionMark {
                id: 5,
                parent: None,
                depth: 0,
                name: "收盘".into(),
                fields: vec![],
            }),
        ),
        event(
            TS + 8,
            108,
            action_event::Kind::Start(ActionStart {
                id: 6,
                parent: None,
                depth: 0,
                name: "等待".into(),
                fields: vec![],
                late: false,
            }),
        ),
        event(
            TS + 9,
            109,
            action_event::Kind::End(ActionEnd {
                id: 6,
                result: ActionResult::Unfinished.into(),
                reason: None,
                fields: vec![],
            }),
        ),
    ];
    assert_eq!(batch.events, want);
}

#[tokio::test]
async fn a_line_with_an_unknown_result_or_a_missing_required_field_is_logged_like_any_unrecognized_content()
 {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-actions-bad"));
    cp.hello(0).await;

    let unknown_result = r#"{"type":"action_end","ts":1,"mono":2,"id":7,"result":"exploded","reason":null,"fields":{}}"#;
    let no_id = r#"{"type":"action_start","ts":1,"mono":2,"parent":null,"depth":0,"name":"缺 id","fields":{}}"#;
    let no_name = r#"{"type":"mark","ts":1,"mono":2,"id":8,"parent":null,"depth":0,"fields":{}}"#;
    let no_result = r#"{"type":"action_end","ts":1,"mono":2,"id":9,"reason":null,"fields":{}}"#;
    let good = json!({"type": "mark", "ts": TS, "mono": 5, "id": 10, "parent": null, "depth": 0,
                      "name": "正常", "fields": {}});
    assign_raw_events(
        &cp,
        "task-bad",
        json!([unknown_result, no_id, no_name, no_result, good]),
    )
    .await;

    let batches = batches_before_the_result(&cp, "task-bad").await;
    let marks: Vec<(u64, String)> = events_of(&batches)
        .iter()
        .map(|e| match &e.kind {
            Some(action_event::Kind::Mark(m)) => (m.id, m.name.clone()),
            other => panic!("只有正常的那个标记被转发：{other:?}"),
        })
        .collect();
    assert_eq!(marks, [(10, "正常".to_string())]);

    // 其余四行原文记成 SDK 日志，和别的不认识的内容一样。
    let logs: Vec<(LogSource, LogLevel, String)> = cp
        .received_with_session()
        .iter()
        .filter_map(|r| match &r.message.body {
            Some(agent_message::Body::Logs(LogBatch { task_id, lines, .. }))
                if task_id == "task-bad" =>
            {
                Some(
                    lines
                        .iter()
                        .map(|l| (l.source(), l.level(), l.text.clone()))
                        .collect::<Vec<_>>(),
                )
            }
            _ => None,
        })
        .flatten()
        .collect();
    let want: Vec<(LogSource, LogLevel, String)> = [unknown_result, no_id, no_name, no_result]
        .iter()
        .map(|line| (LogSource::Sdk, LogLevel::Info, line.to_string()))
        .collect();
    assert_eq!(logs, want);
}

#[tokio::test]
async fn the_monotonic_reading_is_the_one_the_sdk_wrote_and_the_time_follows_the_sdk_timestamp() {
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(AgentOptions::new(&cp.url, "agent-actions-mono"));
    cp.hello(0).await;
    // Agent 时间快 613 天：单调时钟读数不受影响。
    agent.set_agent_time_offset_ms(DAYS_613_MS);
    let before = clock::monotonic_ms();
    let before_system = system_time_ms();

    // SDK 写的 mono 故意和读到时的读数差得很远；没有 mono、mono 是 0 的两行用 Agent 读到时的读数；没有 ts 的一行取 Agent 时间。
    assign_raw_events(
        &cp,
        "task-mono",
        json!([
            {"type": "action_start", "ts": TS, "mono": 7, "id": 1, "parent": null, "depth": 0,
             "name": "有 mono", "fields": {}},
            {"type": "mark", "ts": TS + 1, "id": 2, "parent": null, "depth": 0,
             "name": "没有 mono", "fields": {}},
            {"type": "action_end", "ts": TS + 2, "mono": 0, "id": 1, "result": "success",
             "reason": null, "fields": {}},
            {"type": "mark", "mono": 1234, "id": 3, "parent": null, "depth": 0,
             "name": "没有 ts", "fields": {}},
        ]),
    )
    .await;

    let batches = batches_before_the_result(&cp, "task-mono").await;
    let after = clock::monotonic_ms();
    let after_system = system_time_ms();
    let got: Vec<(i64, i64)> = events_of(&batches)
        .iter()
        .map(|e| (e.time_unix_ms, e.monotonic_ms))
        .collect();
    assert_eq!(got.len(), 4, "{got:?}");
    assert_eq!(got[0], (TS + DAYS_613_MS, 7), "SDK 写的 mono 原样到达");
    assert_eq!(got[1].0, TS + 1 + DAYS_613_MS);
    assert_eq!(got[2].0, TS + 2 + DAYS_613_MS);
    for (_, mono) in [got[1], got[2]] {
        assert!(
            before <= mono && mono <= after,
            "没有 mono（或 mono 不大于 0）时取读到的读数：{before} <= {mono} <= {after}"
        );
    }
    assert_eq!(got[3].1, 1234);
    assert!(
        before_system + DAYS_613_MS <= got[3].0 && got[3].0 <= after_system + DAYS_613_MS,
        "没有 ts 时取读到时的 Agent 时间：{}",
        got[3].0
    );
}

#[tokio::test]
async fn more_than_a_thousand_events_are_split_into_batches_of_at_most_a_thousand_in_order() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-actions-split"));
    cp.hello(0).await;

    let total = 2500;
    let marks: Vec<Value> = (1..=total)
        .map(|id| {
            json!({"type": "mark", "ts": TS + id, "mono": 1000 + id, "id": id, "parent": null,
                   "depth": 0, "name": "成交", "fields": {}})
        })
        .collect();
    assign_raw_events(&cp, "task-split", Value::Array(marks)).await;

    let batches = batches_before_the_result(&cp, "task-split").await;
    let sizes: Vec<usize> = batches.iter().map(|(_, b)| b.events.len()).collect();
    assert!(
        sizes.iter().all(|n| (1..=MAX_BATCH_EVENTS).contains(n)),
        "每批 1 到 {MAX_BATCH_EVENTS} 个：{sizes:?}"
    );
    assert!(batches.len() >= 3, "{sizes:?}");
    let ids: Vec<u64> = events_of(&batches)
        .iter()
        .map(|e| match &e.kind {
            Some(action_event::Kind::Mark(m)) => m.id,
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(ids, (1..=total as u64).collect::<Vec<_>>(), "{sizes:?}");
}

/// 桩节点 `action_flood` 写出的事件，按写的先后：(种类, id, Agent 时间, 单调时钟读数)。
/// 奇数 id 是动作（开始紧跟着结束），偶数 id 是标记。
fn flood_written(count: u64) -> Vec<(char, u64, i64, i64)> {
    let mut written = Vec::new();
    for id in 1..=count {
        let (ts, mono) = (FLOOD_TS + id as i64, FLOOD_MONO + id as i64);
        if id % 2 == 1 {
            written.push(('s', id, ts, mono));
            written.push(('e', id, ts, mono));
        } else {
            written.push(('m', id, ts, mono));
        }
    }
    written
}

fn flood_delivered(batches: &[(usize, ActionBatch)]) -> Vec<(char, u64, i64, i64)> {
    events_of(batches)
        .iter()
        .map(|e| {
            let (kind, id) = match &e.kind {
                Some(action_event::Kind::Start(s)) => ('s', s.id),
                Some(action_event::Kind::End(end)) => ('e', end.id),
                Some(action_event::Kind::Mark(m)) => ('m', m.id),
                None => panic!("没有内容的事件"),
            };
            (kind, id, e.time_unix_ms, e.monotonic_ms)
        })
        .collect()
}

/// 事件一个不少、一个不多、先后不变（ID 连续不缺），每批不超过上限。
fn assert_flood_arrived_whole(batches: &[(usize, ActionBatch)], count: u64) {
    let want = flood_written(count);
    let got = flood_delivered(batches);
    let first_difference = got.iter().zip(&want).position(|(g, w)| g != w);
    assert!(
        got == want,
        "写了 {} 个事件，收到 {} 个，第一处不同在 {first_difference:?}：{:?} / {:?}",
        want.len(),
        got.len(),
        first_difference.map(|i| got[i]),
        first_difference.map(|i| want[i]),
    );
    assert!(
        batches
            .iter()
            .all(|(_, b)| b.events.len() <= MAX_BATCH_EVENTS),
        "每批不超过 {MAX_BATCH_EVENTS} 个"
    );
}

#[tokio::test]
async fn a_node_that_exits_right_after_writing_many_events_has_all_of_them_delivered_before_the_result()
 {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-actions-exit"));
    cp.hello(0).await;

    // 写完立即退出：事件还在管道和 Agent 的缓冲里，结束之前必须发完。
    let count = 30_000;
    cp.assign(stub_task(
        "task-exit",
        "action_flood",
        json!({ "count": count }),
    ))
    .await;

    let batches = batches_before_the_result(&cp, "task-exit").await;
    assert_flood_arrived_whole(&batches, count);
}

#[tokio::test]
async fn events_written_far_faster_than_they_are_forwarded_make_the_node_wait_instead_of_dropping_any()
 {
    let cp = FakeControlPlane::start().await;
    let mut options = AgentOptions::new(&cp.url, "agent-actions-backpressure");
    // 转发器每秒只处理 16 MiB：节点不受限地写，远快于转发，写的总量（约 30 MiB）远超管道的容量。
    options.args = vec!["--log-forward-rate".into(), (16 * MIB).to_string()];
    let agent = spawn_agent(options);
    let pid = agent.child.id().unwrap();
    cp.hello(0).await;
    let before = peak_rss_bytes(pid);

    let count = 200_000;
    cp.assign(stub_task(
        "task-pressure",
        "action_flood",
        json!({ "count": count }),
    ))
    .await;

    let batches = batches_before_the_result(&cp, "task-pressure").await;
    let growth = peak_rss_bytes(pid).saturating_sub(before);
    assert_flood_arrived_whole(&batches, count);
    // 节点等待，Agent 不在内存里攒下没转发的事件（攒下的话至少增长二十几 MiB）。
    assert!(
        growth < 10 * MIB,
        "Agent 峰值内存增长了 {} MiB",
        growth / MIB
    );
}

#[tokio::test]
async fn batches_queued_while_disconnected_are_capped_and_the_result_still_arrives() {
    let cp = FakeControlPlane::start().await;
    let port = cp.port;
    let mut options = AgentOptions::new(&cp.url, "agent-actions-cap");
    // 一批 1000 个事件约 50 KB：断线期间只排得下两批左右。
    options.args = vec!["--log-queue-bytes".into(), "100000".into()];
    options.pipe_stderr = true;
    let mut agent = spawn_agent(options);
    let mut stderr = BufReader::new(agent.child.stderr.take().unwrap()).lines();
    cp.hello(0).await;

    // 桩节点等到放行文件出现才写，保证事件都是控制面下线之后写的。
    let release = agent.work_dir.path().join("release-flood");
    let count = 3000;
    cp.assign(stub_task(
        "task-cap",
        "action_flood",
        json!({ "count": count, "release_file": release }),
    ))
    .await;
    cp.wait_for("task started", |all| {
        all.iter().find_map(|r| match &r.message.body {
            Some(agent_message::Body::Started(s)) if s.task_id == "task-cap" => Some(()),
            _ => None,
        })
    })
    .await;
    drop(cp);
    std::fs::write(&release, "").unwrap();
    // 等 Agent 在标准错误里说结果已经交出：最后一批事件也已经排进队了（转发器发完才交出结果）。
    let finished = "task task-cap attempt 1 finished";
    loop {
        let line = tokio::time::timeout(Duration::from_secs(30), stderr.next_line())
            .await
            .expect("the agent never handed over the result")
            .unwrap()
            .expect("the agent exited");
        if line.contains(finished) {
            break;
        }
    }
    tokio::spawn(async move { while let Ok(Some(_)) = stderr.next_line().await {} });
    let cp = FakeControlPlane::start_on(port).await;

    let (result, _) = cp.result("task-cap").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    // 重连后 Agent 先重发没被 Ack 的结果，排队的批次随后才发出：看到结果时它们可能还在路上。
    // 排队的消息按顺序发出，所以第二个任务的 TaskStarted 到达时，排在它前面的批次都已经到了。
    cp.assign(stub_task("task-after", "echo", json!({ "text": "x" })))
        .await;
    cp.wait_for("the queued batches to be delivered", |all| {
        all.iter().find_map(|r| match &r.message.body {
            Some(agent_message::Body::Started(s)) if s.task_id == "task-after" => Some(()),
            _ => None,
        })
    })
    .await;
    let delivered = events_of(&batches_of(&cp.received_with_session(), "task-cap"));
    let written = flood_written(count).len();
    assert!(
        !delivered.is_empty() && delivered.len() < written,
        "断线期间排得下的批次留下，超出上限的被丢弃：写了 {written} 个事件，收到 {} 个",
        delivered.len()
    );
    // 留下的批次仍按写的先后到达。
    let ids: Vec<u64> = delivered
        .iter()
        .map(|e| match &e.kind {
            Some(action_event::Kind::Start(s)) => s.id,
            Some(action_event::Kind::End(end)) => end.id,
            Some(action_event::Kind::Mark(m)) => m.id,
            None => panic!("没有内容的事件"),
        })
        .collect();
    assert!(ids.is_sorted(), "{ids:?}");
}
