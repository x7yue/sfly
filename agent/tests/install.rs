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

/// 同 [`agent`]，另外配了 Agent 凭据（经环境变量 `SFLY_TOKEN`，和 `agent.env` 里写的一样）。
fn agent_with_credential(
    cp: &FakeControlPlane,
    name: &str,
    venv: &tempfile::TempDir,
    fixture: &HttpFixture,
    credential: &str,
) -> AgentProcess {
    let cache = venv.path().join("uv-cache").to_string_lossy().into_owned();
    let venv = venv_of(venv);
    let mut options = AgentOptions::new(&cp.url, name);
    options.venv = &venv;
    options.args = vec!["--index-url".into(), fixture.index_url()];
    options.env = vec![("UV_CACHE_DIR", &cache), ("SFLY_TOKEN", credential)];
    spawn_agent(options)
}

const ARCHIVE_PATH: &str = "/packages/sfly-demo/versions/1.0.0/archive";

/// 下载节点包归档带 Agent 凭据（#492）：控制面按它检查归档属于这台 Agent 的项目或公共项目。
#[tokio::test]
async fn the_archive_download_carries_the_agent_credential_when_one_is_configured() {
    let fixture = HttpFixture::start().await;
    let demo = publish(&fixture, "sfly-demo", "1.0.0", &[]);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let _agent = agent_with_credential(&cp, "agent-cred", &venv, &fixture, "sfly_agt_c0ffee");
    cp.hello(0).await;

    cp.assign(package_task(
        "task-cred",
        "sfly-demo",
        "1.0.0",
        "about",
        json!({}),
        demo.archive(),
    ))
    .await;
    let (result, _) = cp.result("task-cred").await;

    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(
        fixture.authorizations(ARCHIVE_PATH),
        vec![Some("Bearer sfly_agt_c0ffee".to_string())]
    );
}

#[tokio::test]
async fn without_a_credential_the_archive_is_downloaded_without_authorization() {
    let fixture = HttpFixture::start().await;
    let demo = publish(&fixture, "sfly-demo", "1.0.0", &[]);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let _agent = agent(&cp, "agent-nocred", &venv, &fixture);
    cp.hello(0).await;

    cp.assign(package_task(
        "task-nocred",
        "sfly-demo",
        "1.0.0",
        "about",
        json!({}),
        demo.archive(),
    ))
    .await;
    let (result, _) = cp.result("task-nocred").await;

    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(fixture.authorizations(ARCHIVE_PATH), vec![None]);
}

/// 控制面的归档地址重定向到别的主机（这里是同一台机器上的另一个端口）时，跟着去的请求里没有凭据：
/// reqwest 的重定向策略在换了主机或端口时去掉 `Authorization`，这条用例钉住它（换版本升级 reqwest 时不会悄悄变）。
#[tokio::test]
async fn a_redirect_to_another_host_does_not_carry_the_agent_credential() {
    let control_plane = HttpFixture::start().await;
    let elsewhere = HttpFixture::start().await;
    let demo = publish(&elsewhere, "sfly-demo", "1.0.0", &[]);
    control_plane.redirect(ARCHIVE_PATH, &demo.url);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let _agent = agent_with_credential(
        &cp,
        "agent-redirect",
        &venv,
        &control_plane,
        "sfly_agt_c0ffee",
    );
    cp.hello(0).await;

    let archive_url = format!("{}{ARCHIVE_PATH}", control_plane.url);
    cp.assign(package_task(
        "task-redirect",
        "sfly-demo",
        "1.0.0",
        "about",
        json!({}),
        (&archive_url, &demo.sha256),
    ))
    .await;
    let (result, _) = cp.result("task-redirect").await;

    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(
        control_plane.authorizations(ARCHIVE_PATH),
        vec![Some("Bearer sfly_agt_c0ffee".to_string())],
        "控制面自己的地址带凭据"
    );
    assert_eq!(
        elsewhere.authorizations(ARCHIVE_PATH),
        vec![None],
        "重定向到别的地方的请求里不带凭据"
    );
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
async fn a_conflict_with_the_package_being_installed_names_the_package_that_requires_the_other_version()
 {
    // #637、#653：另一个节点包依赖 sfly-base>=2，共享环境里已经是 2.0；现在要装 sfly-base 自己的 1.0.0
    // （锁定旧版本的场景，和标准节点包 sfly-std 0.3.0 遇到依赖 sfly-std>=0.4 的节点包是同一种情形）。
    // uv 只写「你要求 sfly-base==1.0.0 和 sfly-base>=2」，不知道后者是哪个包要的：Agent 补的说明写出来。
    let fixture = HttpFixture::start().await;
    let (filename, wheel) = dependency_wheel("sfly-base", "2.0");
    fixture.add_to_index("sfly-base", &filename, wheel, Duration::ZERO);
    let user = publish(&fixture, "sfly-user", "1.0.0", &["sfly-base>=2"]);
    let base = publish(&fixture, "sfly-base", "1.0.0", &[]);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let _agent = agent(&cp, "agent-self-conflict", &venv, &fixture);
    cp.hello(0).await;

    cp.assign(package_task(
        "task-user",
        "sfly-user",
        "1.0.0",
        "about",
        json!({}),
        user.archive(),
    ))
    .await;
    let (result, _) = cp.result("task-user").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");

    cp.assign(package_task(
        "task-base",
        "sfly-base",
        "1.0.0",
        "about",
        json!({}),
        base.archive(),
    ))
    .await;
    let (result, _) = cp.result("task-base").await;

    assert_eq!(result.status(), TaskStatus::Failed, "{result:?}");
    let error = result.error.expect("error");
    assert_eq!(error.kind(), ErrorKind::EnvError);
    assert!(
        error.message.contains("No solution found"),
        "{}",
        error.message
    );
    assert!(error.message.contains("依赖冲突："), "{}", error.message);
    assert!(
        error
            .message
            .contains("sfly-base@1.0.0（正在装） 要求 sfly-base==1.0.0"),
        "{}",
        error.message
    );
    assert!(
        error
            .message
            .contains("sfly-user（已安装） 要求 sfly-base>=2"),
        "{}",
        error.message
    );
    assert!(error.message.contains("怎么办"), "{}", error.message);
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
