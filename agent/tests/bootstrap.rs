//! 切入点 B（Agent 一侧）：Agent 只依赖 uv——共享 venv 不存在时自动创建，
//! 从控制面（Welcome 给出的地址）下载与 Agent 版本一致的 SDK 运行时 wheel 装进去，然后就能执行节点；
//! venv 已存在且 SDK 版本一致时不重装。

mod support;

use std::path::{Path, PathBuf};

use serde_json::json;
use sfly_agent::AGENT_VERSION;
use sfly_agent::proto::TaskStatus;
use support::packages::{HttpFixture, package_task, publish, sha256_hex};
use support::{AgentOptions, AgentProcess, FakeControlPlane, repo_root, spawn_agent};

/// 构建 SDK 运行时 wheel（sdk/python），返回 (文件名, 内容)。
fn sdk_wheel(out: &Path) -> (String, Vec<u8>) {
    let status = std::process::Command::new("uv")
        .args(["build", "--wheel", "--quiet", "--out-dir"])
        .arg(out)
        .arg(repo_root().join("sdk/python"))
        .status()
        .expect("run uv build");
    assert!(status.success(), "uv build sdk/python failed");
    let name = format!("sfly-{AGENT_VERSION}-py3-none-any.whl");
    let bytes = std::fs::read(out.join(&name)).expect("SDK wheel named after the agent version");
    (name, bytes)
}

fn python_version() -> String {
    std::fs::read_to_string(repo_root().join(".python-version"))
        .unwrap()
        .trim()
        .to_string()
}

fn agent(cp: &FakeControlPlane, venv: &Path, fixture: &HttpFixture, cache: &str) -> AgentProcess {
    let mut options = AgentOptions::new(&cp.url, "agent-bootstrap");
    options.venv = venv;
    options.args = vec![
        "--index-url".into(),
        fixture.index_url(),
        "--python".into(),
        python_version(),
    ];
    options.env = vec![("UV_CACHE_DIR", cache)];
    spawn_agent(options)
}

#[tokio::test]
async fn agent_creates_the_shared_venv_installs_the_matching_sdk_and_runs_nodes() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("uv-cache").to_string_lossy().into_owned();
    let fixture = HttpFixture::start().await;
    let (name, wheel) = sdk_wheel(&dir.path().join("sdk"));
    let wheel_path = format!("/sdk/python/{AGENT_VERSION}/{name}");
    let url = fixture.put(&wheel_path, wheel.clone());
    let stub = publish(&fixture, "sfly-stub", "0.1.0", &[]);
    let cp = FakeControlPlane::start().await;
    cp.set_sdk_wheel(&url, &sha256_hex(&wheel));

    // 空目录：venv 还不存在。
    let venv: PathBuf = dir.path().join("empty/venv");
    let mut first = agent(&cp, &venv, &fixture, &cache);
    cp.hello(0).await;
    cp.assign(package_task(
        "task-1",
        "sfly-stub",
        "0.1.0",
        "echo",
        json!({ "text": "hi" }),
        stub.archive(),
    ))
    .await;
    let (result, _) = cp.result("task-1").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let outputs: serde_json::Value = serde_json::from_str(&result.outputs_json).unwrap();
    assert_eq!(outputs, json!({ "text": "hi" }));
    assert!(venv.join("bin/python").exists(), "共享 venv 已创建");
    assert_eq!(fixture.count(&wheel_path), 1);

    // 重启 Agent：venv 已存在且 SDK 版本一致，不再下载 SDK。
    first.child.kill().await.unwrap();
    let _second = agent(&cp, &venv, &fixture, &cache);
    cp.hello(1).await;
    cp.assign(package_task(
        "task-2",
        "sfly-stub",
        "0.1.0",
        "echo",
        json!({ "text": "again" }),
        stub.archive(),
    ))
    .await;
    let (result, _) = cp.result("task-2").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(fixture.count(&wheel_path), 1, "SDK 版本一致时不重装");
}

#[tokio::test]
async fn sdk_wheel_with_a_wrong_sha256_is_not_installed() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("uv-cache").to_string_lossy().into_owned();
    let fixture = HttpFixture::start().await;
    let (name, wheel) = sdk_wheel(&dir.path().join("sdk"));
    let url = fixture.put(&format!("/sdk/python/{AGENT_VERSION}/{name}"), wheel);
    let cp = FakeControlPlane::start().await;
    cp.set_sdk_wheel(&url, &"0".repeat(64));

    let venv = dir.path().join("venv");
    let _agent = agent(&cp, &venv, &fixture, &cache);
    cp.hello(0).await;
    cp.assign(support::stub_task("task-x", "echo", json!({ "text": "x" })))
        .await;
    let (result, _) = cp.result("task-x").await;
    // 没有 SDK：列不出已安装的包，也没有下载地址，任务以 env_error 失败。
    assert_eq!(result.status(), TaskStatus::Failed, "{result:?}");
    assert!(venv.join("bin/python").exists(), "venv 仍然创建了");
}
