//! 切入点 B（Agent 一侧）：任务结束后、上报结果之前，真实 Agent 把产物目录里的文件
//! 逐个 PUT 到 AssignTask 的产物上传地址；SDK 拿到的产物引用就是同一地址下的下载地址。

mod support;

use serde_json::{Value, json};
use sfly_agent::proto::{AssignTask, ErrorKind, TaskStatus};
use support::packages::HttpFixture;
use support::{AgentOptions, FakeControlPlane, spawn_agent, stub_task};

fn artifact_task(id: &str, fixture: &HttpFixture, inputs: Value) -> AssignTask {
    let mut task = stub_task(id, "artifacts", inputs);
    task.artifact_upload_url = format!("{}/tasks/{id}/artifacts/", fixture.url);
    task
}

#[tokio::test]
async fn artifacts_are_uploaded_before_the_result_and_outputs_reference_their_download_urls() {
    let fixture = HttpFixture::start().await;
    let cp = FakeControlPlane::start().await;
    let mut options = AgentOptions::new(&cp.url, "agent-artifacts");
    options.args = vec!["--token".into(), "t0ken".into()];
    let _agent = spawn_agent(options);
    cp.hello(0).await;

    let task = artifact_task(
        "task-art",
        &fixture,
        json!({ "files": { "report.txt": "报告内容", "截图/a b.txt": "x" } }),
    );
    let base = task.artifact_upload_url.clone();
    cp.assign(task).await;
    let (result, _) = cp.result("task-art").await;
    let result_at = cp
        .received_with_session()
        .into_iter()
        .find(|r| {
            matches!(&r.message.body, Some(sfly_agent::proto::agent_message::Body::Result(res)) if res.task_id == "task-art")
        })
        .unwrap()
        .at;

    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let mut uploads = fixture.uploads();
    uploads.sort_by(|a, b| a.path.cmp(&b.path));
    let got: Vec<(String, Vec<u8>, Option<String>)> = uploads
        .iter()
        .map(|u| (u.path.clone(), u.body.clone(), u.authorization.clone()))
        .collect();
    let bearer = Some("Bearer t0ken".to_string());
    assert_eq!(
        got,
        vec![
            (
                "/tasks/task-art/artifacts/%E6%88%AA%E5%9B%BE/a%20b.txt".to_string(),
                b"x".to_vec(),
                bearer.clone()
            ),
            (
                "/tasks/task-art/artifacts/report.txt".to_string(),
                "报告内容".as_bytes().to_vec(),
                bearer
            ),
        ]
    );
    assert!(
        uploads.iter().all(|u| u.at < result_at),
        "产物在结果之前上传完"
    );

    let outputs: Value = serde_json::from_str(&result.outputs_json).unwrap();
    assert_eq!(
        outputs["refs"],
        json!({
            "report.txt": format!("{base}report.txt"),
            "截图/a b.txt": format!("{base}%E6%88%AA%E5%9B%BE/a%20b.txt"),
        })
    );
}

#[tokio::test]
async fn a_rejected_upload_fails_the_task_with_node_error() {
    let fixture = HttpFixture::start().await;
    fixture.reject_uploads(413);
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-art-413"));
    cp.hello(0).await;

    cp.assign(artifact_task(
        "task-413",
        &fixture,
        json!({ "files": { "big.bin": "x" } }),
    ))
    .await;
    let (result, _) = cp.result("task-413").await;

    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.unwrap();
    assert_eq!(error.kind(), ErrorKind::NodeError);
    assert!(
        error.message.contains("上传产物") && error.message.contains("big.bin"),
        "{}",
        error.message
    );
    assert!(error.message.contains("413"), "{}", error.message);
}

#[tokio::test]
async fn artifacts_of_a_failed_task_are_uploaded_too_and_the_failure_is_kept() {
    let fixture = HttpFixture::start().await;
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-art-fail"));
    cp.hello(0).await;

    cp.assign(artifact_task(
        "task-art-fail",
        &fixture,
        json!({ "files": { "debug.txt": "现场" }, "fail": true }),
    ))
    .await;
    let (result, _) = cp.result("task-art-fail").await;

    let error = result.error.unwrap();
    assert_eq!(error.kind(), ErrorKind::NodeError);
    assert!(
        error.message.contains("保存产物后失败"),
        "{}",
        error.message
    );
    let uploads = fixture.uploads();
    assert_eq!(uploads.len(), 1);
    assert_eq!(uploads[0].path, "/tasks/task-art-fail/artifacts/debug.txt");
    assert_eq!(uploads[0].body, "现场".as_bytes());
    assert_eq!(
        uploads[0].authorization, None,
        "没有配置令牌时不带 Authorization"
    );
}

#[tokio::test]
async fn without_an_upload_url_nothing_is_uploaded_and_refs_are_local_paths() {
    let fixture = HttpFixture::start().await;
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-art-none"));
    cp.hello(0).await;

    cp.assign(stub_task(
        "task-art-none",
        "artifacts",
        json!({ "files": { "a.txt": "x" } }),
    ))
    .await;
    let (result, _) = cp.result("task-art-none").await;

    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let outputs: Value = serde_json::from_str(&result.outputs_json).unwrap();
    let path = outputs["refs"]["a.txt"].as_str().unwrap();
    assert!(path.ends_with("/task-art-none/artifacts/a.txt"), "{path}");
    assert!(fixture.uploads().is_empty());
}

#[tokio::test]
async fn each_upload_carries_the_modification_time_of_the_file_on_the_agent() {
    let fixture = HttpFixture::start().await;
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-art-mtime"));
    cp.hello(0).await;

    // 修改时间是被测机器上的事实：2099 年、1970 年以前都原样带上（Unix 毫秒）。
    cp.assign(artifact_task(
        "task-art-mtime",
        &fixture,
        json!({
            "files": { "future.txt": "x", "old.txt": "x", "past.txt": "x" },
            "mtimes": { "future.txt": 4070908800.25, "old.txt": 1700000000, "past.txt": -86400 },
        }),
    ))
    .await;
    let (result, _) = cp.result("task-art-mtime").await;

    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let mut got: Vec<(String, Option<String>)> = fixture
        .uploads()
        .into_iter()
        .map(|u| (u.path, u.agent_modified_ms))
        .collect();
    got.sort();
    let at = |name: &str, ms: &str| {
        (
            format!("/tasks/task-art-mtime/artifacts/{name}"),
            Some(ms.to_string()),
        )
    };
    assert_eq!(
        got,
        vec![
            at("future.txt", "4070908800250"),
            at("old.txt", "1700000000000"),
            at("past.txt", "-86400000"),
        ]
    );
}

// ---- 产物上限随任务下发（#477）----

/// 带产物上限（字节，每个任务的产物合计）的任务；`0` 等于没带这个字段（旧版本控制面）。
fn limited_task(id: &str, fixture: &HttpFixture, limit: u64, inputs: Value) -> AssignTask {
    let mut task = stub_task(id, "artifact_limit", inputs);
    task.artifact_upload_url = format!("{}/tasks/{id}/artifacts/", fixture.url);
    task.artifact_limit_bytes = limit;
    task
}

fn uploaded_names(fixture: &HttpFixture, id: &str) -> Vec<String> {
    let prefix = format!("/tasks/{id}/artifacts/");
    let mut names: Vec<String> = fixture
        .uploads()
        .into_iter()
        .map(|u| u.path.strip_prefix(&prefix).unwrap().to_string())
        .collect();
    names.sort();
    names
}

#[tokio::test]
async fn the_node_reads_the_limit_the_control_plane_sent_and_none_when_it_sent_nothing() {
    let fixture = HttpFixture::start().await;
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-art-limit-env"));
    cp.hello(0).await;

    cp.assign(limited_task(
        "task-limit-env",
        &fixture,
        1_500,
        json!({ "files": { "a.txt": "x" } }),
    ))
    .await;
    let (with_limit, _) = cp.result("task-limit-env").await;
    // 旧版本控制面：任务里没有这个字段（0），节点读到的是没有上限。
    cp.assign(limited_task(
        "task-limit-none",
        &fixture,
        0,
        json!({ "files": { "a.txt": "x" } }),
    ))
    .await;
    let (without, _) = cp.result("task-limit-none").await;

    let limit_of = |result: &sfly_agent::proto::TaskResult| {
        assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
        serde_json::from_str::<Value>(&result.outputs_json).unwrap()["limit"].clone()
    };
    assert_eq!(limit_of(&with_limit), json!(1500));
    assert_eq!(limit_of(&without), Value::Null);
}

#[tokio::test]
async fn saving_a_file_over_the_limit_raises_in_the_node_which_can_carry_on_and_the_rest_is_uploaded()
 {
    let fixture = HttpFixture::start().await;
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-art-limit-save"));
    cp.hello(0).await;

    // 上限 1000：a 600 + b 600 超过，b 保存时抛出，节点接住后照常成功；c 300 放得下。
    cp.assign(limited_task(
        "task-limit-save",
        &fixture,
        1_000,
        json!({
            "files": { "a.bin": "a".repeat(600), "b.bin": "b".repeat(600), "c.bin": "c".repeat(300) },
            "catch_limit": true,
        }),
    ))
    .await;
    let (result, _) = cp.result("task-limit-save").await;

    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let outputs: Value = serde_json::from_str(&result.outputs_json).unwrap();
    assert_eq!(outputs["refused"], json!(["b.bin"]));
    assert_eq!(
        uploaded_names(&fixture, "task-limit-save"),
        vec!["a.bin", "c.bin"],
        "之前保存的产物都上传了，没保存的没有上传"
    );
}

#[tokio::test]
async fn a_node_that_does_not_catch_the_limit_fails_on_the_line_that_saves_as_env_error() {
    let fixture = HttpFixture::start().await;
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-art-limit-raise"));
    cp.hello(0).await;

    cp.assign(limited_task(
        "task-limit-raise",
        &fixture,
        500,
        json!({ "files": { "big.bin": "x".repeat(600) } }),
    ))
    .await;
    let (result, _) = cp.result("task-limit-raise").await;

    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.unwrap();
    // env_error：和上传前发现超限同一个类型，重试一遍产物还是这么大，不按重试配置重试（#477）。
    assert_eq!(error.kind(), ErrorKind::EnvError);
    assert!(
        error.message.contains("ArtifactLimitExceeded"),
        "{}",
        error.message
    );
    assert!(error.message.contains("big.bin"), "{}", error.message);
    assert!(error.message.contains("600 字节"), "{}", error.message);
    assert!(error.message.contains("500 字节"), "{}", error.message);
    assert!(
        error.location.contains("第"),
        "失败的位置在保存的那一行：{}",
        error.location
    );
    assert!(fixture.uploads().is_empty());
}

#[tokio::test]
async fn files_over_the_total_are_not_uploaded_smallest_first_and_a_successful_task_fails_without_retry()
 {
    let fixture = HttpFixture::start().await;
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-art-limit-direct"));
    cp.hello(0).await;

    // 不经过 save、直接写进产物目录：a 300 + b 500 放得下，c 900 放不下。
    cp.assign(limited_task(
        "task-limit-direct",
        &fixture,
        1_000,
        json!({ "direct": { "c.bin": 900, "a.bin": 300, "sub/b.bin": 500 } }),
    ))
    .await;
    let (result, _) = cp.result("task-limit-direct").await;

    // 为放不下的文件没有发起上传（假的控制面数请求：只有放得下的两个）。
    assert_eq!(
        uploaded_names(&fixture, "task-limit-direct"),
        vec!["a.bin", "sub/b.bin"]
    );
    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.unwrap();
    // env_error：重试一遍还是超限，不按重试配置重试（docs/SEMANTICS.md §3.3）。
    assert_eq!(error.kind(), ErrorKind::EnvError);
    let message = &error.message;
    assert!(message.contains("合计 1700 字节"), "{message}");
    assert!(message.contains("上限 1000 字节"), "{message}");
    assert!(message.contains("c.bin（900 字节）"), "{message}");
    assert!(!message.contains("a.bin"), "上传了的文件不列：{message}");
    assert!(message.contains("SFLY_ARTIFACT_LIMIT_MB"), "{message}");
    assert!(message.contains("留在这台机器上"), "{message}");
}

#[tokio::test]
async fn a_failed_task_keeps_its_own_error_first_and_the_files_not_uploaded_come_after() {
    let fixture = HttpFixture::start().await;
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-art-limit-failed"));
    cp.hello(0).await;

    cp.assign(limited_task(
        "task-limit-failed",
        &fixture,
        1_000,
        json!({ "direct": { "a.bin": 300, "huge.bin": 2000 }, "fail": true }),
    ))
    .await;
    let (result, _) = cp.result("task-limit-failed").await;

    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.unwrap();
    // 本来就失败的任务保留原来的错误类型和位置，信息在前。
    assert_eq!(error.kind(), ErrorKind::NodeError);
    let own = error.message.find("保存产物后失败").expect(&error.message);
    let note = error
        .message
        .find("huge.bin（2000 字节）")
        .expect(&error.message);
    assert!(own < note, "{}", error.message);
    assert!(
        error.message.contains("合计 2300 字节"),
        "{}",
        error.message
    );
    assert_eq!(uploaded_names(&fixture, "task-limit-failed"), vec!["a.bin"]);
}

#[tokio::test]
async fn a_total_exactly_at_the_limit_uploads_everything_and_succeeds() {
    let fixture = HttpFixture::start().await;
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-art-limit-exact"));
    cp.hello(0).await;

    cp.assign(limited_task(
        "task-limit-exact",
        &fixture,
        800,
        json!({ "direct": { "a.bin": 300, "b.bin": 500 } }),
    ))
    .await;
    let (result, _) = cp.result("task-limit-exact").await;

    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(
        uploaded_names(&fixture, "task-limit-exact"),
        vec!["a.bin", "b.bin"]
    );
}

#[tokio::test]
async fn without_the_field_everything_is_uploaded_as_before_and_the_control_plane_decides() {
    let fixture = HttpFixture::start().await;
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-art-limit-legacy"));
    cp.hello(0).await;

    // 旧版本控制面不带上限（0）：Agent 不预先检查，大文件照常去上传，被控制面拒绝时和以前一样是 node_error。
    fixture.reject_uploads(413);
    cp.assign(limited_task(
        "task-limit-legacy",
        &fixture,
        0,
        json!({ "direct": { "big.bin": 5_000 } }),
    ))
    .await;
    let (result, _) = cp.result("task-limit-legacy").await;

    assert_eq!(
        uploaded_names(&fixture, "task-limit-legacy"),
        vec!["big.bin"]
    );
    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.unwrap();
    assert_eq!(error.kind(), ErrorKind::NodeError);
    assert!(error.message.contains("上传产物失败"), "{}", error.message);
    assert!(error.message.contains("413"), "{}", error.message);
}

#[tokio::test]
async fn many_files_that_do_not_fit_are_listed_up_to_a_cap_with_the_count_of_the_rest() {
    let fixture = HttpFixture::start().await;
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-art-limit-many"));
    cp.hello(0).await;

    // 30 个 100 字节的文件，上限 1000：放得下 10 个，20 个没传，列出最大的 10 个，写明还有 10 个。
    let direct: serde_json::Map<String, Value> = (0..30)
        .map(|i| (format!("f{i:02}.bin"), json!(100)))
        .collect();
    cp.assign(limited_task(
        "task-limit-many",
        &fixture,
        1_000,
        json!({ "direct": direct }),
    ))
    .await;
    let (result, _) = cp.result("task-limit-many").await;

    assert_eq!(uploaded_names(&fixture, "task-limit-many").len(), 10);
    let error = result.error.unwrap();
    assert_eq!(error.kind(), ErrorKind::EnvError);
    assert!(
        error.message.contains("合计 3000 字节"),
        "{}",
        error.message
    );
    assert!(
        error.message.contains("另有 20 个超限的文件没有上传"),
        "{}",
        error.message
    );
    assert!(error.message.contains("另有 10 个"), "{}", error.message);
}

/// `retries` 设了也只跑一次：没接住的超限是 env_error，不在可重试的类型里；这里看 Agent 上报的类型，
/// 全栈的 `full-stack-artifact-limit.test.ts` 用真实的控制面看尝试次数。
#[tokio::test]
async fn an_uncaught_limit_is_the_same_kind_as_the_agents_own_check_so_neither_is_retried() {
    let fixture = HttpFixture::start().await;
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-art-limit-kinds"));
    cp.hello(0).await;

    cp.assign(limited_task(
        "task-kind-save",
        &fixture,
        500,
        json!({ "files": { "big.bin": "x".repeat(600) } }),
    ))
    .await;
    cp.assign(limited_task(
        "task-kind-direct",
        &fixture,
        500,
        json!({ "direct": { "big.bin": 600 } }),
    ))
    .await;
    let (by_save, _) = cp.result("task-kind-save").await;
    let (by_agent, _) = cp.result("task-kind-direct").await;

    assert_eq!(by_save.error.unwrap().kind(), ErrorKind::EnvError);
    assert_eq!(by_agent.error.unwrap().kind(), ErrorKind::EnvError);
}

#[tokio::test]
async fn the_environment_variable_is_set_only_when_the_control_plane_sent_a_limit() {
    let fixture = HttpFixture::start().await;
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-art-limit-envvar"));
    cp.hello(0).await;

    cp.assign(limited_task("task-env-set", &fixture, 1_500, json!({})))
        .await;
    cp.assign(limited_task("task-env-unset", &fixture, 0, json!({})))
        .await;
    let (with_limit, _) = cp.result("task-env-set").await;
    let (without, _) = cp.result("task-env-unset").await;

    let env_of = |result: &sfly_agent::proto::TaskResult| {
        assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
        serde_json::from_str::<Value>(&result.outputs_json).unwrap()["limit_env"].clone()
    };
    assert_eq!(env_of(&with_limit), json!("1500"));
    // 字段是 0（旧版本控制面没带）：不设置，不是设成 "0"。
    assert_eq!(env_of(&without), Value::Null);
}

#[tokio::test]
async fn the_message_does_not_say_uploaded_when_the_upload_failed_part_way() {
    let fixture = HttpFixture::start().await;
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-art-limit-midway"));
    cp.hello(0).await;

    // 放得下的两个（a、b），c 放不下；控制面拒绝上传：a 就没传上。
    fixture.reject_uploads(400);
    cp.assign(limited_task(
        "task-limit-midway",
        &fixture,
        1_000,
        json!({ "direct": { "a.bin": 300, "b.bin": 500, "c.bin": 900 } }),
    ))
    .await;
    let (result, _) = cp.result("task-limit-midway").await;

    let message = result.error.unwrap().message;
    assert!(message.contains("只上传了 0 个"), "{message}");
    assert!(!message.contains("已上传"), "{message}");
    assert!(message.contains("上传产物失败：a.bin"), "{message}");
    assert!(message.contains("c.bin（900 字节）"), "{message}");
}

#[tokio::test]
async fn the_message_says_uploaded_when_everything_that_fits_was_uploaded() {
    let fixture = HttpFixture::start().await;
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-art-limit-done"));
    cp.hello(0).await;

    cp.assign(limited_task(
        "task-limit-done",
        &fixture,
        1_000,
        json!({ "direct": { "a.bin": 300, "b.bin": 500, "c.bin": 900 } }),
    ))
    .await;
    let (result, _) = cp.result("task-limit-done").await;

    let message = result.error.unwrap().message;
    assert!(message.contains("放得下的 2 个文件已上传"), "{message}");
    assert!(message.contains("另有 1 个超限的文件没有上传"), "{message}");
    assert!(!message.contains("上传产物失败"), "{message}");
}

#[tokio::test]
async fn when_not_a_single_file_fits_the_message_says_so_instead_of_zero_files_uploaded() {
    let fixture = HttpFixture::start().await;
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-art-limit-none-fit"));
    cp.hello(0).await;

    // 上限 1000，两个文件各自都比上限大：一个都放不下，一个都不上传。
    cp.assign(limited_task(
        "task-limit-none-fit",
        &fixture,
        1_000,
        json!({ "direct": { "a.bin": 1_500, "b.bin": 2_000 } }),
    ))
    .await;
    let (result, _) = cp.result("task-limit-none-fit").await;

    assert!(fixture.uploads().is_empty(), "一个都放不下：不发起任何上传");
    let error = result.error.unwrap();
    assert_eq!(error.kind(), ErrorKind::EnvError);
    let message = &error.message;
    assert!(message.contains("没有放得下的文件"), "{message}");
    assert!(!message.contains("放得下的 0 个"), "{message}");
    assert!(!message.contains("已上传"), "{message}");
    assert!(
        message.contains("另有 2 个超限的文件没有上传：b.bin（2000 字节）、a.bin（1500 字节）"),
        "{message}"
    );
}
