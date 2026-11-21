//! 本地协议（docs/ARCHITECTURE.md §5.4）的两个读取端之一：Agent。
//!
//! 另一个读取端是本地调试（sdk/python/tests/test_local_protocol.py）。两端各有一份读取实现，跑同一份用例表
//! testdata/local-protocol-cases.json：事件管道的一行读成什么、退出码和 output.json 怎么判成结果、
//! 两边各抄一份的常量，以及两端认识的事件类型集合。用例让假执行器（testdata/local-protocol-executor.sh）
//! 做执行器那一端的事，这里用真的 [`executor::start`] 启动它，读 Agent 发往控制面的消息和任务结果。

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tokio::sync::watch;

use super::{DEFAULT_TELEMETRY_QUEUE_BYTES, DRAIN_TIMEOUT, Event, MAX_LINE_BYTES};
use crate::executor::{self, Settings};
use crate::metrics::DEFAULT_METRIC_QUEUE_POINTS;
use crate::proto::{
    ActionField, ActionResult, AgentMessage, AssignTask, ErrorKind, LogSource, TaskResult,
    TaskStatus, action_event, agent_message,
};
use crate::venv::SharedVenv;
use crate::{DEFAULT_TERMINATE_GRACE, logs};

const CASES: &str = include_str!("../../testdata/local-protocol-cases.json");
const EXECUTOR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../testdata/local-protocol-executor.sh"
);

const SECTIONS: [&str; 6] = [
    "logs",
    "progress",
    "metrics",
    "notifications",
    "actions",
    "action_summary",
];
const DEFAULT_OUTPUT: &str = r#"{"status":"success","outputs":{}}"#;
/// 执行器异常退出的上报文字：「<前缀><退出状态><分隔>标准错误尾部」，退出状态两端的写法不同。
const ABNORMAL_EXIT: (&str, &str) = ("执行器异常退出（", "），没有写出结果\n\n");

/// 用例里的字符串可以写成 `{"$repeat": 单元, "times": 次数, ...}`（见用例表的说明），先展开。
fn expand(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(expand).collect()),
        Value::Object(map) if map.contains_key("$repeat") => {
            let text = |key: &str| map.get(key).and_then(Value::as_str).unwrap_or("");
            let times = map["times"].as_u64().expect("times") as usize;
            let unit = map["$repeat"].as_str().expect("$repeat");
            Value::String(format!(
                "{}{}{}",
                text("prefix"),
                unit.repeat(times),
                text("suffix")
            ))
        }
        Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, expand(v))).collect()),
        other => other,
    }
}

fn cases() -> Value {
    expand(serde_json::from_str(CASES).expect("用例表是 JSON"))
}

fn now_ms() -> i64 {
    let since = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    i64::try_from(since.as_millis()).unwrap()
}

// ---- 跑一个用例 ----

/// 假执行器做完一遍之后，Agent 发出的消息和任务结果。
struct Observed {
    messages: Vec<AgentMessage>,
    result: TaskResult,
    /// 写进事件管道的各行（通知、动作摘要要原文转发）。
    lines: Vec<String>,
    /// 这次执行前后的时间（Unix 毫秒）。
    window: (i64, i64),
}

async fn run(case: &Value) -> Observed {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("executor");
    std::fs::create_dir_all(root.join("bin")).unwrap();
    std::fs::create_dir_all(root.join("case")).unwrap();
    std::os::unix::fs::symlink(EXECUTOR, root.join("bin/python")).unwrap();

    let lines: Vec<String> = case["events"]
        .as_array()
        .map(|events| {
            events
                .iter()
                .map(|line| line.as_str().unwrap().to_string())
                .collect()
        })
        .unwrap_or_default();
    let text = |key: &str| case.get(key).and_then(Value::as_str).map(str::to_string);
    let files = [
        (
            "events.jsonl",
            case.get("events").map(|_| {
                lines
                    .iter()
                    .map(|line| format!("{line}\n"))
                    .collect::<String>()
            }),
        ),
        ("stdout", text("stdout")),
        ("stderr", text("stderr")),
        (
            "output.json",
            match case.get("output") {
                None => Some(DEFAULT_OUTPUT.to_string()),
                Some(output) => output.as_str().map(str::to_string),
            },
        ),
        (
            "exit-code",
            case.get("exit_code").map(|code| code.to_string()),
        ),
    ];
    for (name, content) in files {
        if let Some(content) = content {
            std::fs::write(root.join("case").join(name), content).unwrap();
        }
    }

    let (work, procs, socket) = (
        dir.path().join("work"),
        dir.path().join("procs"),
        dir.path().join("agent.sock"),
    );
    let settings = Settings {
        work_root: &work,
        procs_root: &procs,
        grace: DEFAULT_TERMINATE_GRACE,
        log_forward_rate: 0,
        agent_socket: &socket,
    };
    let task = AssignTask {
        task_id: "case".into(),
        attempt: 1,
        run_id: "run".into(),
        inputs_json: "{}".into(),
        ..Default::default()
    };
    let (telemetry, mut receiver) =
        logs::telemetry(DEFAULT_TELEMETRY_QUEUE_BYTES, DEFAULT_METRIC_QUEUE_POINTS);
    let (_cancel, signal) = watch::channel::<Option<bool>>(None);

    let before = now_ms();
    let running = executor::start(
        &SharedVenv::new(&root),
        &settings,
        &task,
        "case:run",
        &telemetry,
    )
    .await
    .unwrap_or_else(|result| panic!("执行器没有启动：{result:?}"));
    let result = running.wait(signal).await;
    let after = now_ms();

    // 转发器已经结束，丢掉自己手上的发送端之后，通道读完就关闭。
    drop(telemetry);
    let mut messages = Vec::new();
    while let Some(message) = receiver.recv().await {
        messages.push(message);
    }
    Observed {
        messages,
        result,
        lines,
        window: (before, after),
    }
}

// ---- 把 Agent 发出的东西整理成用例表里 expect 的形状 ----

fn pairs(fields: &[ActionField]) -> Value {
    fields.iter().map(|f| json!([f.key, f.value])).collect()
}

/// 原文整行转发的消息（通知、动作摘要）：原文必须是写进管道的某一行，再解析一次读出用例表里的键。
fn forwarded(event_json: &str, lines: &[String]) -> Value {
    assert!(
        lines.iter().any(|line| line == event_json),
        "转发的原文不是写进管道的某一行：{event_json}"
    );
    serde_json::from_str(event_json).expect("转发的原文是 JSON")
}

fn sections(observed: &Observed) -> BTreeMap<&'static str, Value> {
    let mut logs = Vec::new();
    let mut progress = Vec::new();
    let mut metrics = Vec::new();
    let mut notifications = Vec::new();
    let mut actions = Vec::new();
    let mut summary = Value::Null;
    for message in &observed.messages {
        match message.body.as_ref() {
            Some(agent_message::Body::Logs(batch)) => {
                for line in &batch.lines {
                    let source = match line.source() {
                        LogSource::Stdout => "stdout",
                        LogSource::Stderr => "stderr",
                        LogSource::Sdk => "sdk",
                        LogSource::Agent => "agent",
                        LogSource::Unspecified => "unspecified",
                    };
                    logs.push(json!({
                        "source": source,
                        "level": line.level().as_str_name()
                            .trim_start_matches("LOG_LEVEL_").to_lowercase(),
                        "message": line.text,
                        "ts": line.time_unix_ms,
                    }));
                }
            }
            Some(agent_message::Body::Progress(p)) => progress.push(json!({
                "type": "progress",
                "current": p.current,
                "total": p.total,
                "message": p.message,
                "ts": p.time_unix_ms,
            })),
            Some(agent_message::Body::Metrics(batch)) => {
                for point in &batch.points {
                    let labels: BTreeMap<_, _> = point.labels.iter().collect();
                    metrics.push(json!({
                        "type": "metric",
                        "name": point.name,
                        "value": point.value,
                        "labels": labels.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
                        "ts_s": point.time_unix_s,
                    }));
                }
            }
            Some(agent_message::Body::Notification(n)) => {
                let event = forwarded(&n.event_json, &observed.lines);
                notifications.push(json!({
                    "type": "notify",
                    "bot": event["bot"],
                    "ts": event["ts"],
                }));
            }
            Some(agent_message::Body::Actions(batch)) => {
                for event in &batch.events {
                    actions.push(action_item(event));
                }
            }
            Some(agent_message::Body::ActionSummary(s)) => {
                let event = forwarded(&s.event_json, &observed.lines);
                summary = json!({
                    "type": "action_summary",
                    "total": event["total"],
                    "marks": event["marks"],
                    "reported": event["reported"],
                    "ts": event["ts"],
                });
            }
            _ => {}
        }
    }
    BTreeMap::from([
        ("logs", Value::Array(logs)),
        ("progress", Value::Array(progress)),
        ("metrics", Value::Array(metrics)),
        ("notifications", Value::Array(notifications)),
        ("actions", Value::Array(actions)),
        ("action_summary", summary),
    ])
}

fn action_item(event: &crate::proto::ActionEvent) -> Value {
    let result = |result: ActionResult| match result {
        ActionResult::Success => "success",
        ActionResult::Failed => "failed",
        ActionResult::Unfinished => "unfinished",
        ActionResult::Unspecified => "unspecified",
    };
    let (ts, mono) = (event.time_unix_ms, event.monotonic_ms);
    match event.kind.as_ref().expect("动作事件有类型") {
        action_event::Kind::Start(s) => json!({
            "type": "action_start", "id": s.id, "parent": s.parent, "depth": s.depth,
            "name": s.name, "fields": pairs(&s.fields), "late": s.late, "ts": ts, "mono": mono,
        }),
        action_event::Kind::End(e) => json!({
            "type": "action_end", "id": e.id, "result": result(e.result()), "reason": e.reason,
            "fields": pairs(&e.fields), "ts": ts, "mono": mono,
        }),
        action_event::Kind::Mark(m) => json!({
            "type": "mark", "id": m.id, "parent": m.parent, "depth": m.depth,
            "name": m.name, "fields": pairs(&m.fields), "ts": ts, "mono": mono,
        }),
    }
}

fn result_value(result: &TaskResult) -> Value {
    if result.status() == TaskStatus::Success {
        let outputs: Value =
            serde_json::from_str(&result.outputs_json).expect("outputs_json 是 JSON");
        return json!({ "status": "success", "outputs": outputs });
    }
    let error = result.error.as_ref().expect("失败的结果有 error");
    let kind = match error.kind() {
        ErrorKind::NodeError => "node_error",
        ErrorKind::Timeout => "timeout",
        ErrorKind::AgentLost => "agent_lost",
        ErrorKind::EnvError => "env_error",
        ErrorKind::ConfigError => "config_error",
        ErrorKind::Unspecified => "unspecified",
    };
    let (prefix, separator) = ABNORMAL_EXIT;
    match error
        .message
        .strip_prefix(prefix)
        .and_then(|rest| rest.split_once(separator))
    {
        Some((_, tail)) => {
            json!({ "status": "failed", "kind": kind, "abnormal_exit": { "stderr_tail": tail } })
        }
        None => json!({
            "status": "failed",
            "kind": kind,
            "report": error.message,
            // 空串表示没有位置，和本地调试的 None 对应。
            "location": (!error.location.is_empty()).then_some(&error.location),
        }),
    }
}

// ---- 比较 ----

/// 去掉 expect 里本端读不出的键（`not_shown`，写法：类型.键）。
fn without_not_shown(expected: &Value, hidden: &[String]) -> Value {
    match expected {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| without_not_shown(item, hidden))
                .collect(),
        ),
        Value::Object(map) => match map.get("type").and_then(Value::as_str) {
            Some(kind) => Value::Object(
                map.iter()
                    .filter(|(key, _)| !hidden.contains(&format!("{kind}.{key}")))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
            ),
            None => Value::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), without_not_shown(v, hidden)))
                    .collect(),
            ),
        },
        other => other.clone(),
    }
}

/// JSON 相等，数字按 f64 比（`1` 与 `1.0` 相等）。
fn same(want: &Value, got: &Value) -> bool {
    match (want, got) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| same(a, b)))
        }
        _ => want == got,
    }
}

/// 条目里写了的键才比较；ts 是 "now"（ts_s 同理，单位秒）时看是否落在这次执行的前后之间。
fn entry_problems(want: &Value, got: &Value, window: (i64, i64)) -> Vec<String> {
    let Some(want) = want.as_object() else {
        return vec![format!("应为 {want}，实际是 {got}")];
    };
    let mut problems = Vec::new();
    for (key, want) in want {
        let Some(got) = got.get(key) else {
            problems.push(format!("{key}: 读不出这个键，实际是 {got}"));
            continue;
        };
        if want == "now" {
            let (low, high) = if key == "ts" {
                window
            } else {
                (window.0 / 1000, window.1 / 1000)
            };
            if !got.as_i64().is_some_and(|got| (low..=high).contains(&got)) {
                problems.push(format!("{key}: 应在 {low}..{high} 之间，实际是 {got}"));
            }
        } else if !same(want, got) {
            problems.push(format!("{key}: 应为 {want}，实际是 {got}"));
        }
    }
    problems
}

fn section_problems(name: &str, want: &Value, got: &Value, window: (i64, i64)) -> Vec<String> {
    match (want, got) {
        (Value::Array(want), Value::Array(got)) => {
            if want.len() != got.len() {
                return vec![format!(
                    "{name}: 应有 {} 条，实际 {} 条：{}",
                    want.len(),
                    got.len(),
                    Value::Array(got.clone())
                )];
            }
            want.iter()
                .zip(got)
                .enumerate()
                .flat_map(|(i, (want, got))| {
                    entry_problems(want, got, window)
                        .into_iter()
                        .map(move |problem| format!("{name}[{i}] {problem}"))
                })
                .collect()
        }
        (Value::Object(_), Value::Object(_)) => entry_problems(want, got, window)
            .into_iter()
            .map(|problem| format!("{name} {problem}"))
            .collect(),
        _ if same(want, got) => Vec::new(),
        _ => vec![format!("{name}: 应为 {want}，实际是 {got}")],
    }
}

fn hidden(file: &Value) -> Vec<String> {
    file["not_shown"]["agent"]
        .as_array()
        .unwrap()
        .iter()
        .map(|key| key.as_str().unwrap().to_string())
        .collect()
}

fn event_problems(file: &Value, expect: &Value, observed: &Observed) -> Vec<String> {
    let expected = without_not_shown(expect, &hidden(file));
    let actual = sections(observed);
    let mut problems = Vec::new();
    for section in SECTIONS {
        let default = if section == "action_summary" {
            Value::Null
        } else {
            json!([])
        };
        let want = expected.get(section).unwrap_or(&default);
        problems.extend(section_problems(
            section,
            want,
            &actual[section],
            observed.window,
        ));
    }
    let success = json!({ "status": "success", "outputs": {} });
    problems.extend(section_problems(
        "result",
        &success,
        &result_value(&observed.result),
        observed.window,
    ));
    problems
}

fn result_problems(expect: &Value, observed: &Observed) -> Vec<String> {
    section_problems(
        "result",
        expect,
        &result_value(&observed.result),
        observed.window,
    )
}

/// 跑一组用例，返回每个不一致的地方（用例名 + 说明）。
async fn problems_of(
    cases: &Value,
    expect_key: &str,
    check: impl Fn(&Value, &Observed) -> Vec<String>,
) -> Vec<String> {
    let mut all = Vec::new();
    for case in cases.as_array().expect("用例是数组") {
        let observed = run(case).await;
        for problem in check(&case[expect_key], &observed) {
            all.push(format!("{}：{problem}", case["name"].as_str().unwrap()));
        }
    }
    all
}

fn report(problems: Vec<String>) {
    assert!(problems.is_empty(), "\n{}", problems.join("\n"));
}

// ---- 用例 ----

#[tokio::test(flavor = "multi_thread")]
async fn event_pipe_and_output_streams_are_read_as_the_shared_cases_say() {
    let file = cases();
    let problems = problems_of(&file["event_cases"], "expect", |expect, observed| {
        event_problems(&file, expect, observed)
    })
    .await;
    report(problems);
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_code_and_output_json_are_judged_as_the_shared_cases_say() {
    let file = cases();
    let problems = problems_of(&file["result_cases"], "expect", result_problems).await;
    report(problems);
}

#[tokio::test(flavor = "multi_thread")]
async fn known_differences_stay_as_the_case_file_pins_them() {
    let file = cases();
    let known = &file["known_differences"];
    let mut problems = problems_of(&known["event_cases"], "agent", |expect, observed| {
        event_problems(&file, expect, observed)
    })
    .await;
    problems.extend(problems_of(&known["result_cases"], "agent", result_problems).await);
    report(problems);
}

/// serde 对不认识的 `type` 报「expected one of `log`, `progress`, …」，从里面读出 Agent 认识的类型。
fn event_types_this_end_reads() -> BTreeSet<String> {
    let error = serde_json::from_str::<Event>(r#"{"type":"?"}"#)
        .err()
        .expect("`?` 不是事件类型")
        .to_string();
    let (_, listed) = error.split_once("expected one of ").expect(&error);
    listed
        .split('`')
        .skip(1)
        .step_by(2)
        .map(str::to_string)
        .collect()
}

#[test]
fn the_event_types_this_end_reads_are_the_ones_in_the_case_file() {
    let file = cases();
    let in_file: BTreeSet<String> = file["event_types"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_str().unwrap().to_string())
        .collect();
    assert_eq!(event_types_this_end_reads(), in_file);
}

#[test]
fn every_event_type_has_a_case() {
    let file = cases();
    let mut covered = BTreeSet::new();
    for case in file["event_cases"].as_array().unwrap() {
        for (name, section) in case["expect"].as_object().unwrap() {
            let items = section
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![section.clone()]);
            for item in items {
                match item.get("type").and_then(Value::as_str) {
                    Some(kind) => {
                        covered.insert(kind.to_string());
                    }
                    // 日志条目没有 type：来源是 sdk 且带着事件里的时间的，是 log 事件。
                    None if name == "logs" && item["source"] == "sdk" && item["ts"] != "now" => {
                        covered.insert("log".to_string());
                    }
                    None => {}
                }
            }
        }
    }
    let in_file: BTreeSet<String> = file["event_types"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_str().unwrap().to_string())
        .collect();
    assert_eq!(covered, in_file);
}

#[test]
fn constants_shared_with_the_local_debugging_end_are_the_ones_in_the_case_file() {
    let file = cases();
    let millis = |d: Duration| u64::try_from(d.as_millis()).unwrap();
    assert_eq!(
        json!({
            "max_line_bytes": MAX_LINE_BYTES,
            "drain_timeout_ms": millis(DRAIN_TIMEOUT),
            "stderr_tail_bytes": logs::STDERR_TAIL_BYTES,
            "terminate_grace_ms": millis(DEFAULT_TERMINATE_GRACE),
        }),
        file["constants"]
    );
}

/// 数值经过 Agent 保持不变（#450）：执行器写的 output.json 里的小数，Agent 交给控制面的是同一个双精度数。
/// 前几个数用默认配置的 serde_json 解析会差最后一位（例如 29491.727857142858 读成 29491.727857142854），
/// 后几个没有这个问题，放进来看没有被误伤。output.json 的原文由 f64 的最短表示写出，期望值也由 f64 直接写出，
/// 都不经过 serde_json 的解析，所以解析错了就对不上。
#[tokio::test(flavor = "multi_thread")]
async fn numbers_in_output_json_reach_the_control_plane_unchanged() {
    let numbers = [
        29491.727857142858,
        7.038531e-26,
        123456789.12345679,
        60.157000000000004,
        1.0715660391465826e-75,
        -1.81996730402717e-179,
        -1.603964615428183e143,
        0.1,
        60.157,
        1e-7,
        5e-324,
        1.7976931348623157e308,
    ];
    let text: Vec<String> = numbers.iter().map(|n| format!("{n:?}")).collect();
    let output = format!(
        r#"{{"status":"success","outputs":{{"x":[{}]}}}}"#,
        text.join(",")
    );
    let observed = run(&json!({ "output": output })).await;
    assert_eq!(
        observed.result.status(),
        TaskStatus::Success,
        "{:?}",
        observed.result
    );
    assert_eq!(
        observed.result.outputs_json,
        json!({ "x": numbers }).to_string()
    );
}
