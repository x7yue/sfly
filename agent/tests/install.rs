//! 切入点 B（Agent 一侧）：任务需要的节点包版本没有安装时，Agent 从控制面下载归档、校验 sha256，
//! 用真实的 uv 从（本地桩）PyPI 镜像安装到共享 venv，或就地切换版本，然后执行任务。

mod support;

use std::time::Duration;

use serde_json::{Value, json};
use sfly_agent::proto::{ErrorKind, InstallState, InstalledPackage, TaskResult, TaskStatus};
use support::packages::{
    HttpFixture, dependency_wheel, fresh_venv, package_task, publish, venv_of,
};
use support::{AgentOptions, AgentProcess, FakeControlPlane, spawn_agent, stub_task};

fn outputs(result: &TaskResult) -> Value {
    serde_json::from_str(&result.outputs_json).expect("outputs_json is JSON")
}

fn installed(list: &[(&str, &str)]) -> Vec<InstalledPackage> {
    list.iter()
        .map(|(name, version)| InstalledPackage {
            name: (*name).into(),
            version: (*version).into(),
        })
        .collect()
}

/// 启动连接假控制面、使用给定共享 venv 和桩镜像的 Agent；uv 缓存每个测试独立。
fn agent(
    cp: &FakeControlPlane,
    name: &str,
    venv: &tempfile::TempDir,
    fixture: &HttpFixture,
) -> AgentProcess {
    let cache = venv.path().join("uv-cache").to_string_lossy().into_owned();
    let venv = venv_of(venv);
    let mut options = AgentOptions::new(&cp.url, name);
    options.venv = &venv;
    options.args = vec!["--index-url".into(), fixture.index_url()];
    options.env = vec![("UV_CACHE_DIR", &cache)];
    spawn_agent(options)
}

fn add_dependency(fixture: &HttpFixture, version: &str, delay: Duration) -> String {
    let (filename, wheel) = dependency_wheel("sfly-dep", version);
    fixture.add_to_index("sfly-dep", &filename, wheel, delay);
    format!("/files/{filename}")
}

#[tokio::test]
async fn first_install_downloads_verifies_and_installs_the_package_with_its_dependencies() {
    let fixture = HttpFixture::start().await;
    add_dependency(&fixture, "1.0", Duration::ZERO);
    let demo = publish(&fixture, "sfly-demo", "1.0.0", &["sfly-dep==1.0"]);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let _agent = agent(&cp, "agent-first", &venv, &fixture);
    assert_eq!(cp.hello(0).await.installed_packages, vec![]);

    cp.assign(package_task(
        "task-1",
        "sfly-demo",
        "1.0.0",
        "about",
        json!({}),
        demo.archive(),
    ))
    .await;

    let (result, _) = cp.result("task-1").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(
        outputs(&result),
        json!({ "package": "sfly-demo", "version": "1.0.0" })
    );
    let (installing, _) = cp
        .install_status("sfly-demo", "1.0.0", InstallState::Installing)
        .await;
    assert_eq!(installing.task_id, "task-1");
    assert_eq!(installing.installed_packages, vec![]);
    let (done, _) = cp
        .install_status("sfly-demo", "1.0.0", InstallState::Installed)
        .await;
    assert_eq!(done.task_id, "task-1");
    assert_eq!(
        done.installed_packages,
        installed(&[("sfly-demo", "1.0.0")])
    );
    assert!(done.output.contains("sfly-dep"), "{}", done.output);
    assert!(fixture.count("/files/sfly_dep-1.0-py3-none-any.whl") >= 1);

    // 已经安装的版本直接执行，不再下载。
    cp.assign(package_task(
        "task-2",
        "sfly-demo",
        "1.0.0",
        "echo",
        json!({ "text": "again" }),
        demo.archive(),
    ))
    .await;
    let (result, _) = cp.result("task-2").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(
        fixture.count("/packages/sfly-demo/versions/1.0.0/archive"),
        1
    );
    assert_eq!(cp.installs().len(), 2);
}

#[tokio::test]
async fn archive_with_wrong_sha256_fails_the_task_with_env_error_and_installs_nothing() {
    let fixture = HttpFixture::start().await;
    let demo = publish(&fixture, "sfly-demo", "1.0.0", &[]);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let _agent = agent(&cp, "agent-sha", &venv, &fixture);
    cp.hello(0).await;

    let wrong = "0".repeat(64);
    cp.assign(package_task(
        "task-sha",
        "sfly-demo",
        "1.0.0",
        "about",
        json!({}),
        (&demo.url, &wrong),
    ))
    .await;

    let (result, _) = cp.result("task-sha").await;
    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.expect("error");
    assert_eq!(error.kind(), ErrorKind::EnvError);
    assert!(error.message.contains("sha256"), "{}", error.message);
    assert!(error.message.contains(&demo.sha256), "{}", error.message);
    let (failed, _) = cp
        .install_status("sfly-demo", "1.0.0", InstallState::Failed)
        .await;
    assert_eq!(failed.installed_packages, vec![]);
}

#[tokio::test]
async fn switches_the_installed_version_in_place_when_a_task_needs_another_version() {
    let fixture = HttpFixture::start().await;
    let v1 = publish(&fixture, "sfly-stub", "0.1.0", &[]);
    let v2 = publish(&fixture, "sfly-stub", "0.2.0", &[]);
    // 共享 venv 里已经装着 sfly-stub@0.1.0。
    let venv = fresh_venv(false);
    let cp = FakeControlPlane::start().await;
    let _agent = agent(&cp, "agent-switch", &venv, &fixture);
    assert_eq!(
        cp.hello(0).await.installed_packages,
        installed(&[("sfly-stub", "0.1.0")])
    );

    cp.assign(package_task(
        "task-v2",
        "sfly-stub",
        "0.2.0",
        "about",
        json!({}),
        v2.archive(),
    ))
    .await;
    let (result, _) = cp.result("task-v2").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(outputs(&result)["version"], "0.2.0");
    let (done, _) = cp
        .install_status("sfly-stub", "0.2.0", InstallState::Installed)
        .await;
    // 同一个包的不同版本不能同时存在。
    assert_eq!(
        done.installed_packages,
        installed(&[("sfly-stub", "0.2.0")])
    );

    cp.assign(package_task(
        "task-v1",
        "sfly-stub",
        "0.1.0",
        "about",
        json!({}),
        v1.archive(),
    ))
    .await;
    let (result, _) = cp.result("task-v1").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(outputs(&result)["version"], "0.1.0");
    let (done, _) = cp
        .install_status("sfly-stub", "0.1.0", InstallState::Installed)
        .await;
    assert_eq!(
        done.installed_packages,
        installed(&[("sfly-stub", "0.1.0")])
    );
}

#[tokio::test]
async fn dependency_conflict_fails_with_env_error_and_full_uv_output_leaving_the_venv_unchanged() {
    let fixture = HttpFixture::start().await;
    add_dependency(&fixture, "1.0", Duration::ZERO);
    add_dependency(&fixture, "2.0", Duration::ZERO);
    let a = publish(&fixture, "sfly-a", "1.0.0", &["sfly-dep==1.0"]);
    let b = publish(&fixture, "sfly-b", "1.0.0", &["sfly-dep==2.0"]);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let _agent = agent(&cp, "agent-conflict", &venv, &fixture);
    cp.hello(0).await;

    cp.assign(package_task(
        "task-a",
        "sfly-a",
        "1.0.0",
        "about",
        json!({}),
        a.archive(),
    ))
    .await;
    let (result, _) = cp.result("task-a").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");

    cp.assign(package_task(
        "task-b",
        "sfly-b",
        "1.0.0",
        "about",
        json!({}),
        b.archive(),
    ))
    .await;
    let (result, _) = cp.result("task-b").await;
    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.expect("error");
    assert_eq!(error.kind(), ErrorKind::EnvError);
    let (failed, _) = cp
        .install_status("sfly-b", "1.0.0", InstallState::Failed)
        .await;
    // 任务错误里带着完整的 uv 输出（与 InstallStatus 上报的一致），能看出是哪个依赖冲突了。
    assert!(failed.output.contains("sfly-dep"), "{}", failed.output);
    assert!(
        error.message.contains(failed.output.trim()),
        "{}",
        error.message
    );
    assert_eq!(failed.installed_packages, installed(&[("sfly-a", "1.0.0")]));

    // 已安装的包不受影响。
    cp.assign(package_task(
        "task-a2",
        "sfly-a",
        "1.0.0",
        "about",
        json!({}),
        a.archive(),
    ))
    .await;
    let (result, _) = cp.result("task-a2").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
}

#[tokio::test]
async fn no_new_task_starts_while_installing_but_running_tasks_keep_running() {
    let fixture = HttpFixture::start().await;
    // 依赖下载很慢，安装会持续一段时间。
    let slow_file = add_dependency(&fixture, "1.0", Duration::from_secs(2));
    let slow = publish(&fixture, "sfly-slow", "1.0.0", &["sfly-dep==1.0"]);
    let venv = fresh_venv(false);
    let cp = FakeControlPlane::start().await;
    let _agent = agent(&cp, "agent-mutex", &venv, &fixture);
    cp.hello(0).await;

    cp.assign(stub_task(
        "task-running",
        "sleep",
        json!({ "seconds": 6.0 }),
    ))
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    cp.assign(package_task(
        "task-install",
        "sfly-slow",
        "1.0.0",
        "about",
        json!({}),
        slow.archive(),
    ))
    .await;
    cp.wait_for("slow dependency download", |_| {
        (fixture.count(&slow_file) > 0).then_some(())
    })
    .await;
    cp.assign(stub_task("task-new", "echo", json!({ "text": "later" })))
        .await;

    let (_, installed_at) = cp
        .install_status("sfly-slow", "1.0.0", InstallState::Installed)
        .await;
    let (new, new_at) = cp.result_at("task-new").await;
    assert_eq!(new.status(), TaskStatus::Success, "{new:?}");
    assert!(
        new_at > installed_at,
        "task-new 在安装完成前就结束了：{:#?}",
        cp.received()
    );
    let (install, _) = cp.result_at("task-install").await;
    assert_eq!(install.status(), TaskStatus::Success, "{install:?}");
    // 安装不等待正在运行的任务，也不打断它。
    let (running, running_at) = cp.result_at("task-running").await;
    assert_eq!(running.status(), TaskStatus::Success, "{running:?}");
    assert!(running_at > installed_at, "{:#?}", cp.received());
}
