//! 切入点 B（Agent 一侧）：真实的 Agent 二进制连接假控制面，在装好桩节点包的共享 venv 中执行节点。

mod support;

use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use sfly_agent::proto::{ErrorKind, InstalledPackage, TaskStatus, action_event, agent_message};
use support::{AgentOptions, FakeControlPlane, NUMBERS, spawn_agent, stub_task, stub_venv};

fn outputs(result: &sfly_agent::proto::TaskResult) -> Value {
    serde_json::from_str(&result.outputs_json).expect("outputs_json is JSON")
}

#[tokio::test]
async fn hello_reports_version_system_slots_and_installed_packages() {
    let cp = FakeControlPlane::start().await;
    let mut options = AgentOptions::new(&cp.url, "agent-hello");
    options.args = vec!["--slots".into(), "3".into(), "--token".into(), "t0k".into()];
    let _agent = spawn_agent(options);

    let hello = cp.hello(0).await;
    assert_eq!(hello.name, "agent-hello");
    assert_eq!(hello.token, "t0k");
    assert_eq!(hello.agent_version, env!("CARGO_PKG_VERSION"));
    assert_eq!(hello.os, std::env::consts::OS);
    assert_eq!(hello.arch, std::env::consts::ARCH);
    assert_eq!(hello.slots, 3);
    assert_eq!(
        hello.installed_packages,
        vec![InstalledPackage {
            name: "sfly-stub".into(),
            version: "0.1.0".into()
        }]
    );
}

#[tokio::test]
async fn runs_assigned_node_and_reports_its_return_value() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-echo"));
    cp.hello(0).await;

    cp.assign(stub_task("task-echo", "echo", json!({ "text": "你好" })))
        .await;

    let (result, _) = cp.result("task-echo").await;
    assert_eq!(result.attempt, 1);
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(outputs(&result), json!({ "text": "你好" }));
}

#[tokio::test]
async fn node_exception_fails_the_task_with_node_error_and_message() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-fail"));
    cp.hello(0).await;

    cp.assign(stub_task(
        "task-fail",
        "fail",
        json!({ "message": "磁盘满了" }),
    ))
    .await;

    let (result, _) = cp.result("task-fail").await;
    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.expect("error");
    assert_eq!(error.kind(), ErrorKind::NodeError);
    assert!(
        error.message.starts_with("RuntimeError: 磁盘满了"),
        "{}",
        error.message
    );
    assert!(error.message.contains("Traceback"), "{}", error.message);
}

#[tokio::test]
async fn an_input_the_node_does_not_declare_fails_with_config_error_without_a_traceback() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-undeclared"));
    cp.hello(0).await;

    cp.assign(stub_task(
        "task-undeclared",
        "echo",
        json!({ "text": "你好", "tex": "写错了的名字" }),
    ))
    .await;

    let (result, _) = cp.result("task-undeclared").await;
    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.expect("error");
    // 配置错误不按重试次数重试，错误信息里有多出来的名字和节点声明的输入，没有堆栈。
    assert_eq!(error.kind(), ErrorKind::ConfigError, "{error:?}");
    assert_eq!(
        error.message,
        "节点 echo 没有声明输入 tex，它声明的输入有：text"
    );
    assert!(
        cp.task_logs("task-undeclared").is_empty(),
        "{:?}",
        cp.task_logs("task-undeclared")
    );
}

#[tokio::test]
async fn package_not_installed_in_shared_venv_fails_with_env_error() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-missing"));
    cp.hello(0).await;

    let mut other_version = stub_task("task-v2", "echo", json!({ "text": "x" }));
    other_version.package_version = "9.9.9".into();
    cp.assign(other_version).await;
    let mut unknown = stub_task("task-unknown", "echo", json!({ "text": "x" }));
    unknown.package = "not-installed".into();
    cp.assign(unknown).await;

    for task in ["task-v2", "task-unknown"] {
        let (result, _) = cp.result(task).await;
        assert_eq!(result.status(), TaskStatus::Failed);
        let error = result.error.expect("error");
        assert_eq!(error.kind(), ErrorKind::EnvError, "{task}: {error:?}");
    }
}

#[tokio::test]
async fn each_task_runs_in_its_own_work_dir_with_the_shared_venv_isolated_from_agent_env() {
    let cp = FakeControlPlane::start().await;
    let mut options = AgentOptions::new(&cp.url, "agent-probe");
    // Agent 自身环境里的 Python 变量不能泄漏到执行器。
    options.env = vec![
        ("PYTHONPATH", "/nonexistent/agent-site"),
        ("PYTHONHOME", "/nonexistent/agent-home"),
        ("VIRTUAL_ENV", "/nonexistent/agent-venv"),
    ];
    let agent = spawn_agent(options);
    cp.hello(0).await;

    cp.assign(stub_task("task-probe-1", "probe", json!({})))
        .await;
    cp.assign(stub_task("task-probe-2", "probe", json!({})))
        .await;

    let venv = stub_venv().canonicalize().unwrap();
    let work_root = agent.work_dir.path().canonicalize().unwrap();
    for task in ["task-probe-1", "task-probe-2"] {
        let (result, _) = cp.result(task).await;
        assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
        let out = outputs(&result);
        let dir = work_root.join(task);
        let path = |p: &Path| Value::String(p.to_string_lossy().into_owned());

        assert_eq!(
            Path::new(out["prefix"].as_str().unwrap())
                .canonicalize()
                .unwrap(),
            venv
        );
        assert_eq!(out["cwd"], path(&dir));
        let env = &out["env"];
        assert_eq!(env["SFLY_TASK"], path(&dir.join("task.json")));
        assert_eq!(env["SFLY_OUTPUT"], path(&dir.join("output.json")));
        assert_eq!(env["SFLY_ARTIFACTS"], path(&dir.join("artifacts")));
        assert_eq!(env["SFLY_EVENTS"], path(&dir.join("events.fifo")));
        assert_eq!(env["SFLY_CANCEL"], path(&dir.join("cancel")));
        // 节点经 Agent 的本地 socket 调用 Agent 能力。
        assert_eq!(
            env["SFLY_AGENT_SOCKET"],
            path(&work_root.join("agent.sock"))
        );
        // 后台进程目录按运行分：`$SFLY_HOME/procs/<运行 ID>/`（stub_task 的运行 ID 是 run-1）。
        assert_eq!(
            env["SFLY_PROCS"],
            path(&work_root.join("sfly-home/procs/run-1"))
        );
        assert_eq!(env["PYTHONPATH"], Value::Null);
        assert_eq!(env["PYTHONHOME"], Value::Null);
        assert_eq!(env["VIRTUAL_ENV"], path(&venv));

        let task_json: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("task.json")).unwrap()).unwrap();
        assert_eq!(task_json["entry"], "sfly_stub:probe");
        assert_eq!(task_json["inputs"], json!({}));
        assert!(dir.join("artifacts").is_dir());
    }
}

#[tokio::test]
async fn reconnects_after_the_control_plane_ends_the_stream() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-reconnect"));
    cp.hello(0).await;

    cp.end_session();

    let hello = cp.hello(1).await;
    assert_eq!(hello.name, "agent-reconnect");
    // 新连接上可以继续接收任务。
    cp.assign(stub_task("task-after", "echo", json!({ "text": "again" })))
        .await;
    let (result, session) = cp.result("task-after").await;
    assert_eq!(session, 1);
    assert_eq!(result.status(), TaskStatus::Success);
}

#[tokio::test]
async fn connects_once_the_control_plane_becomes_reachable() {
    let port = {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        probe.local_addr().unwrap().port()
    };
    let _agent = spawn_agent(AgentOptions::new(
        &format!("http://127.0.0.1:{port}"),
        "agent-late",
    ));
    tokio::time::sleep(Duration::from_millis(1500)).await;

    let cp = FakeControlPlane::start_on(port).await;
    assert_eq!(cp.hello(0).await.name, "agent-late");
}

#[tokio::test]
async fn result_of_a_task_finishing_while_disconnected_is_reported_after_reconnecting() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-resume"));
    cp.hello(0).await;

    cp.assign(stub_task("task-slow", "sleep", json!({ "seconds": 1.0 })))
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    cp.end_session();

    let (result, session) = cp.result("task-slow").await;
    assert_eq!(session, 1);
    assert_eq!(result.status(), TaskStatus::Success);
    assert_eq!(outputs(&result), json!({ "slept": 1.0 }));
}

#[tokio::test]
async fn unacknowledged_result_is_reported_again_after_reconnecting() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-unacked"));
    cp.hello(0).await;
    cp.stop_acking();

    cp.assign(stub_task("task-unacked", "echo", json!({ "text": "x" })))
        .await;
    let (_, first) = cp.result("task-unacked").await;
    assert_eq!(first, 0);
    cp.end_session();

    cp.wait_for("result resent on session 1", |all| {
        all.iter().find(|r| {
            r.session == 1
                && matches!(&r.message.body,
                    Some(sfly_agent::proto::agent_message::Body::Result(res)) if res.task_id == "task-unacked")
        }).map(|_| ())
    })
    .await;
}

#[tokio::test]
async fn numbers_pass_through_the_agent_unchanged_in_both_directions() {
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(AgentOptions::new(&cp.url, "agent-numbers"));
    cp.hello(0).await;

    let inputs = json!({ "text": NUMBERS });
    cp.assign(stub_task("task-numbers", "echo", inputs.clone()))
        .await;
    let (result, _) = cp.result("task-numbers").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");

    // 派发给执行器的输入：task.json 里 inputs 的原文就是控制面发来的数。
    let task_json =
        std::fs::read_to_string(agent.work_dir.path().join("task-numbers/task.json")).unwrap();
    let expected_inputs = format!("\"inputs\":{inputs}");
    assert!(
        task_json.contains(&expected_inputs),
        "task.json 里的输入变了：\n{task_json}\n应包含 {expected_inputs}"
    );
    // 执行器原样返回（Python 的 float 往返是精确的），交回控制面的输出和它写出的是同一批数。
    assert_eq!(result.outputs_json, inputs.to_string());
}

/// 进度的当前值、总数（双精度数）和动作的字段（字符串）也是这样：事件管道里的这些数 Agent 也用 serde_json 读，
/// 数值和节点上报的是同一个。
#[tokio::test]
async fn numbers_in_progress_and_action_fields_reach_the_control_plane_unchanged() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-event-numbers"));
    cp.hello(0).await;

    // current、total 是读错就会差一个单位的两个数；price 作为动作的字段，Python 把它写成字符串。
    let (current, total, price) = (NUMBERS[0], NUMBERS[1], NUMBERS[3]);
    cp.assign(stub_task(
        "task-event-numbers",
        "report_numbers",
        // 用字符串传入：只测事件管道，不经过 Agent 读输入的那一步（那一步在上面的测试里）。
        json!({
            "current": format!("{current:?}"),
            "total": format!("{total:?}"),
            "price": format!("{price:?}"),
        }),
    ))
    .await;
    let (result, _) = cp.result("task-event-numbers").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");

    let progress: Vec<_> = cp
        .received()
        .into_iter()
        .filter_map(|m| match m.body {
            Some(agent_message::Body::Progress(p)) if p.task_id == "task-event-numbers" => Some(p),
            _ => None,
        })
        .collect();
    let [report] = progress.as_slice() else {
        panic!("应只有一次进度：{progress:?}");
    };
    assert_eq!(report.current, current);
    assert_eq!(report.total, Some(total));

    let fields: Vec<_> = cp
        .received()
        .into_iter()
        .filter_map(|m| match m.body {
            Some(agent_message::Body::Actions(batch)) if batch.task_id == "task-event-numbers" => {
                Some(batch.events)
            }
            _ => None,
        })
        .flatten()
        .filter_map(|event| match event.kind {
            Some(action_event::Kind::Start(start)) => Some(start.fields),
            _ => None,
        })
        .flatten()
        .map(|field| (field.key, field.value))
        .collect();
    assert_eq!(fields, [("价格".to_string(), format!("{price:?}"))]);
}
