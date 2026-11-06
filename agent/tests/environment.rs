//! 切入点 B（Agent 一侧）：Agent 从控制面下发的镜像准备运行环境（ADR 0012）。
//!
//! - 没有指定 `--uv` 时使用 `SFLY_HOME/bin/uv`，没有就从 GitHub Release 镜像的 `uv-installer.sh` 安装；
//!   指定了 `--uv` 时不管理 uv；
//! - 共享 venv 不存在时按 Python 3.13 创建，Python 从 GitHub Release 镜像下载；
//! - 节点包依赖从下发的 PyPI 镜像安装，`--index-url` 优先；
//! - 环境准备失败时以退出码 78 退出，标准错误给出失败的命令、输出、镜像地址和报告提示。

mod support;

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::json;
use sfly_agent::proto::TaskStatus;
use support::mirror::ReleaseMirror;
use support::packages::{
    HttpFixture, dependency_wheel, fresh_venv, package_task, publish, venv_of,
};
use support::{FakeControlPlane, WAIT, agent_command, stub_task, stub_venv};
use tokio::io::AsyncReadExt;

/// 环境准备失败时的退出码（EX_CONFIG）。
const ENV_FAILURE: i32 = 78;

/// 连接 `cp` 的 Agent 命令（默认用 PATH 上的 uv，见 [`agent_command`]），uv 缓存独立。
fn agent(home: &Path, cp: &FakeControlPlane, name: &str) -> tokio::process::Command {
    let mut command = agent_command(home);
    command
        .args(["--server", &cp.url, "--name", name])
        .env("UV_CACHE_DIR", home.join("uv-cache"));
    command
}

/// 派发一个桩节点任务并等它成功：说明环境已经准备好、Agent 开始接任务了。
async fn run_echo(cp: &FakeControlPlane, task_id: &str) {
    cp.assign(stub_task(task_id, "echo", json!({ "text": "hi" })))
        .await;
    let (result, _) = cp.result(task_id).await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
}

/// 等 Agent 退出，返回退出码和标准错误。
async fn exit_of(mut child: tokio::process::Child) -> (Option<i32>, String) {
    let mut stderr = String::new();
    let mut pipe = child.stderr.take().unwrap();
    let status = tokio::time::timeout(WAIT * 3, async {
        pipe.read_to_string(&mut stderr).await.unwrap();
        child.wait().await.unwrap()
    })
    .await
    .expect("agent exits");
    (status.code(), stderr)
}

/// 失败报告的最后一行是报告提示。
fn assert_report_hint(stderr: &str) {
    let last = stderr.trim_end().lines().last().unwrap_or_default();
    assert!(last.contains("报告给平台管理员"), "{stderr}");
}

#[tokio::test]
async fn without_uv_the_agent_installs_it_from_the_release_mirror_into_sfly_home_bin() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let mirror = ReleaseMirror::start().await;
    mirror.serve_uv();
    let cp = FakeControlPlane::start().await;
    cp.set_mirrors("", &mirror.url());

    let mut first = agent(&home, &cp, "agent-uv")
        .env_remove("SFLY_UV")
        .arg("--venv")
        .arg(stub_venv())
        .spawn()
        .unwrap();
    cp.hello(0).await;
    run_echo(&cp, "task-1").await;
    let uv = home.join("bin/uv");
    let version = std::process::Command::new(&uv)
        .arg("--version")
        .output()
        .unwrap();
    assert!(version.status.success(), "装好的 uv 可以运行");
    assert_eq!(mirror.http.count(mirror.installer_path()), 1);
    first.kill().await.unwrap();

    // 重启：SFLY_HOME/bin/uv 已经存在，不再安装。
    let _second = agent(&home, &cp, "agent-uv")
        .env_remove("SFLY_UV")
        .arg("--venv")
        .arg(stub_venv())
        .spawn()
        .unwrap();
    cp.hello(1).await;
    run_echo(&cp, "task-2").await;
    assert_eq!(mirror.http.count(mirror.installer_path()), 1);
}

#[tokio::test]
async fn with_uv_specified_the_agent_neither_installs_nor_modifies_it() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let custom = dir.path().join("tools/uv");
    std::fs::create_dir_all(custom.parent().unwrap()).unwrap();
    let output = std::process::Command::new("sh")
        .args(["-c", "command -v uv"])
        .output()
        .unwrap();
    std::fs::copy(String::from_utf8(output.stdout).unwrap().trim(), &custom).unwrap();
    let before = (
        std::fs::read(&custom).unwrap(),
        std::fs::metadata(&custom).unwrap().modified().unwrap(),
    );
    let mirror = ReleaseMirror::start().await;
    mirror.serve_uv();
    let cp = FakeControlPlane::start().await;
    cp.set_mirrors("", &mirror.url());

    let _agent = agent(&home, &cp, "agent-own-uv")
        .arg("--uv")
        .arg(&custom)
        .arg("--venv")
        .arg(stub_venv())
        .spawn()
        .unwrap();
    cp.hello(0).await;
    run_echo(&cp, "task-1").await;
    assert_eq!(mirror.http.requests(), Vec::<String>::new(), "没有访问镜像");
    assert!(!home.join("bin/uv").exists(), "没有安装 Agent 管理的 uv");
    let after = (
        std::fs::read(&custom).unwrap(),
        std::fs::metadata(&custom).unwrap().modified().unwrap(),
    );
    assert!(before == after, "指定的 uv 没有被修改");
}

#[tokio::test]
async fn shared_venv_is_created_with_python_3_13_downloaded_from_the_release_mirror() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let mirror = ReleaseMirror::start().await;
    let python = mirror.serve_python();
    let cp = FakeControlPlane::start().await;
    cp.set_mirrors("", &mirror.url());

    let _agent = agent(&home, &cp, "agent-python")
        .envs(mirror.python_env(&dir.path().join("pythons")))
        .spawn()
        .unwrap();
    cp.hello(0).await;
    let venv_python = home.join("venv/bin/python");
    let deadline = tokio::time::Instant::now() + WAIT * 3;
    while !venv_python.exists() {
        assert!(tokio::time::Instant::now() < deadline, "venv 没有创建");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let version = std::process::Command::new(&venv_python)
        .args(["-c", "import sys; print('%d.%d' % sys.version_info[:2])"])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&version.stdout).trim(), "3.13");
    assert_eq!(mirror.python_requests(), vec![python], "Python 从镜像下载");
}

/// 镜像里放一个依赖 sfly-dep 的节点包需要的 wheel。
fn add_dependency(fixture: &HttpFixture) -> String {
    let (filename, wheel) = dependency_wheel("sfly-dep", "1.0");
    fixture.add_to_index("sfly-dep", &filename, wheel, Duration::ZERO);
    format!("/files/{filename}")
}

#[tokio::test]
async fn node_package_dependencies_come_from_the_distributed_pypi_mirror_unless_index_url_overrides_it()
 {
    let packages = HttpFixture::start().await;
    let demo = publish(&packages, "sfly-demo", "1.0.0", &["sfly-dep==1.0"]);
    let distributed = HttpFixture::start().await;
    let dep_path = add_dependency(&distributed);
    let local = HttpFixture::start().await;
    add_dependency(&local);
    let cp = FakeControlPlane::start().await;
    cp.set_mirrors(&distributed.index_url(), "");
    let task =
        |id: &str| package_task(id, "sfly-demo", "1.0.0", "about", json!({}), demo.archive());

    // 没有 --index-url：用控制面下发的 PyPI 镜像。
    let venv = fresh_venv(true);
    let mut first = agent(venv.path(), &cp, "agent-pypi")
        .arg("--venv")
        .arg(venv_of(&venv))
        .spawn()
        .unwrap();
    cp.hello(0).await;
    cp.assign(task("task-1")).await;
    let (result, _) = cp.result("task-1").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let from_distributed = distributed.count(&dep_path);
    assert!(from_distributed >= 1, "依赖从下发的镜像下载");
    first.kill().await.unwrap();

    // --index-url 覆盖下发的镜像。
    let venv = fresh_venv(true);
    let _second = agent(venv.path(), &cp, "agent-pypi")
        .arg("--venv")
        .arg(venv_of(&venv))
        .args(["--index-url", &local.index_url()])
        .spawn()
        .unwrap();
    cp.hello(1).await;
    cp.assign(task("task-2")).await;
    let (result, _) = cp.result("task-2").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert!(local.count(&dep_path) >= 1, "依赖从 --index-url 下载");
    assert_eq!(
        distributed.count(&dep_path),
        from_distributed,
        "没有再访问下发的镜像"
    );
}

#[tokio::test]
async fn unavailable_uv_mirror_exits_with_78_and_reports_the_command_output_and_mirror() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let mirror = ReleaseMirror::start().await; // 空镜像：安装脚本 404。
    let cp = FakeControlPlane::start().await;
    cp.set_mirrors("", &mirror.url());

    let child = agent(&home, &cp, "agent-no-uv")
        .env_remove("SFLY_UV")
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let (code, stderr) = exit_of(child).await;
    assert_eq!(code, Some(ENV_FAILURE), "{stderr}");
    let installer = format!(
        "{}/astral-sh/uv/LatestRelease/uv-installer.sh",
        mirror.url()
    );
    assert!(stderr.contains(&installer), "失败的命令：{stderr}");
    assert!(stderr.contains("404"), "命令输出：{stderr}");
    assert!(stderr.contains(&mirror.url()), "镜像地址：{stderr}");
    assert_report_hint(&stderr);
    assert!(!home.join("venv").exists());
}

#[tokio::test]
async fn missing_uv_exits_with_78() {
    let dir = tempfile::tempdir().unwrap();
    let cp = FakeControlPlane::start().await;
    let missing = dir.path().join("nowhere/uv");
    let child = agent(&dir.path().join("home"), &cp, "agent-missing-uv")
        .arg("--uv")
        .arg(&missing)
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let (code, stderr) = exit_of(child).await;
    assert_eq!(code, Some(ENV_FAILURE), "{stderr}");
    assert!(stderr.contains(&missing.display().to_string()), "{stderr}");
    assert_report_hint(&stderr);
}

#[tokio::test]
async fn venv_creation_failure_exits_with_78_and_reports_the_command_output_and_mirror() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let mirror = ReleaseMirror::start().await; // 镜像上没有 Python。
    let cp = FakeControlPlane::start().await;
    cp.set_mirrors("", &mirror.url());

    let child = agent(&home, &cp, "agent-no-python")
        .envs(mirror.python_env(&dir.path().join("pythons")))
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let (code, stderr) = exit_of(child).await;
    assert_eq!(code, Some(ENV_FAILURE), "{stderr}");
    assert!(stderr.contains("venv"), "失败的命令：{stderr}");
    assert!(stderr.contains("--python 3.13"), "失败的命令：{stderr}");
    let python_mirror = format!("{}/astral-sh/python-build-standalone/", mirror.url());
    assert!(stderr.contains(&python_mirror), "镜像地址：{stderr}");
    assert!(stderr.contains("404"), "uv 的输出：{stderr}");
    assert!(
        !mirror.python_requests().is_empty(),
        "Python 下载请求打到了镜像"
    );
    assert_report_hint(&stderr);
}
