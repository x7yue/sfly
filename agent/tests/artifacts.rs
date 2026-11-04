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
