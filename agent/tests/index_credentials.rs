//! 索引、镜像的地址里带用户名和密码（#733）：私有的索引常这样配，uv 认。Agent 把装依赖的整条命令行、安装工具的输出、
//! 失败原因写进安装日志和报告：这些文字里的地址，用户名和密码换成固定的掩码（`***`），主机和路径留着。
//!
//! 真实的 uv 和 Agent，索引和镜像是本地桩。带密码的地址只写在本文件的常量里，断言里逐个检查用户名和密码都没有出现在：
//! 任务上报的安装状态（成功和失败各一次）、任务失败原因、Agent 的标准错误、环境准备失败的报告。

mod support;

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::json;
use sfly_agent::proto::{ErrorKind, InstallState, TaskStatus};
use support::mirror::ReleaseMirror;
use support::packages::{
    HttpFixture, dependency_wheel, fresh_venv, package_task, publish, venv_of,
};
use support::{
    AgentChild, AgentOptions, FakeControlPlane, SpawnAgent, WAIT, agent_command, capture_stderr,
    spawn_agent,
};
use tokio::io::AsyncReadExt;

const INDEX_USER: &str = "idxuser";
const INDEX_PASSWORD: &str = "idxpass-7a2d";
const MIRROR_USER: &str = "ghuser";
const MIRROR_PASSWORD: &str = "ghpass-1c3e";
const PYTHON_USER: &str = "pyuser";
const PYTHON_PASSWORD: &str = "pypass-5c4f";

/// 把 `http://主机…` 写成 `http://用户名:密码@主机…`。
fn with_credentials(address: &str, user: &str, password: &str) -> String {
    address.replacen("://", &format!("://{user}:{password}@"), 1)
}

fn assert_no_credentials(text: &str, what: &str, secrets: &[&str]) {
    for secret in secrets {
        assert!(
            !text.contains(secret),
            "{what}：{secret} 在输出里：\n{text}"
        );
    }
}

/// 启动用这个带密码的索引地址（`--index-url`）的 Agent，标准错误接成管道；uv 缓存每个测试独立。
fn agent(
    cp: &FakeControlPlane,
    name: &str,
    venv: &tempfile::TempDir,
    index: &str,
) -> support::AgentProcess {
    let cache = venv.path().join("uv-cache").to_string_lossy().into_owned();
    let venv = venv_of(venv);
    let mut options = AgentOptions::new(&cp.url, name);
    options.venv = &venv;
    options.args = vec!["--index-url".into(), index.to_string()];
    options.env = vec![("UV_CACHE_DIR", &cache)];
    options.pipe_stderr = true;
    spawn_agent(options)
}

#[tokio::test]
async fn an_index_address_with_a_username_and_password_is_masked_in_the_install_log() {
    let index = HttpFixture::start().await;
    let (filename, wheel) = dependency_wheel("sfly-dep", "1.0");
    index.add_to_index("sfly-dep", &filename, wheel, Duration::ZERO);
    let demo = publish(&index, "sfly-demo", "1.0.0", &["sfly-dep==1.0"]);
    let credentialed = with_credentials(&index.index_url(), INDEX_USER, INDEX_PASSWORD);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let mut agent = agent(&cp, "agent-index-credentials", &venv, &credentialed);
    let stderr = capture_stderr(&mut agent);
    cp.hello(0).await;

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
    // 索引真的收到了请求：uv 用的是带凭据的地址。
    assert!(index.count("/simple/sfly-dep/") >= 1);
    let (installed, _) = cp
        .install_status("sfly-demo", "1.0.0", InstallState::Installed)
        .await;
    assert_no_credentials(
        &installed.output,
        "安装状态里的输出",
        &[INDEX_USER, INDEX_PASSWORD],
    );
    // 命令行还在，索引地址里主机和路径留着，用户名和密码是掩码。
    let masked = index.index_url().replacen("://", "://***@", 1);
    assert!(
        installed
            .output
            .contains(&format!("\"--default-index\" \"{masked}\"")),
        "{}",
        installed.output
    );
    assert_no_credentials(
        &stderr.lock().unwrap().join("\n"),
        "Agent 的标准错误",
        &[INDEX_USER, INDEX_PASSWORD],
    );
}

#[tokio::test]
async fn a_failed_install_with_a_credentialed_index_has_no_username_or_password_in_the_reason() {
    // 索引上没有节点包要的依赖：uv 解析失败，输出里有它查过的索引。
    let index = HttpFixture::start().await;
    let needy = publish(&index, "sfly-needy", "1.0.0", &["sfly-absent==1.0"]);
    let credentialed = with_credentials(&index.index_url(), INDEX_USER, INDEX_PASSWORD);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let mut agent = agent(&cp, "agent-index-credentials-missing", &venv, &credentialed);
    let stderr = capture_stderr(&mut agent);
    cp.hello(0).await;

    cp.assign(package_task(
        "task-1",
        "sfly-needy",
        "1.0.0",
        "about",
        json!({}),
        needy.archive(),
    ))
    .await;
    let (result, _) = cp.result("task-1").await;
    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.expect("error");
    assert_eq!(error.kind(), ErrorKind::EnvError);
    let (failed, _) = cp
        .install_status("sfly-needy", "1.0.0", InstallState::Failed)
        .await;
    for (what, text) in [
        ("任务的失败原因", error.message.as_str()),
        ("安装状态里的输出", failed.output.as_str()),
    ] {
        assert_no_credentials(text, what, &[INDEX_USER, INDEX_PASSWORD]);
        assert!(text.contains("sfly-absent"), "{what}：{text}");
    }
    assert!(
        failed.output.contains("***@"),
        "命令行里索引地址的位置是掩码：{}",
        failed.output
    );
    assert_no_credentials(
        &stderr.lock().unwrap().join("\n"),
        "Agent 的标准错误",
        &[INDEX_USER, INDEX_PASSWORD],
    );
}

#[tokio::test]
async fn an_unreachable_credentialed_index_is_reported_without_the_username_and_password() {
    // 连不上的索引：uv 的报错里回显它要取的地址（用户名在里面，密码 uv 自己换成 ****）。
    let index = HttpFixture::start().await;
    let demo = publish(&index, "sfly-demo", "1.0.0", &["sfly-dep==1.0"]);
    let credentialed = with_credentials("http://127.0.0.1:1/simple/", INDEX_USER, INDEX_PASSWORD);
    let venv = fresh_venv(true);
    let cp = FakeControlPlane::start().await;
    let mut agent = agent(&cp, "agent-index-credentials-down", &venv, &credentialed);
    let stderr = capture_stderr(&mut agent);
    cp.hello(0).await;

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
    assert_eq!(result.status(), TaskStatus::Failed);
    let error = result.error.expect("error");
    assert_eq!(error.kind(), ErrorKind::EnvError);
    let (failed, _) = cp
        .install_status("sfly-demo", "1.0.0", InstallState::Failed)
        .await;
    for (what, text) in [
        ("任务的失败原因", error.message.as_str()),
        ("安装状态里的输出", failed.output.as_str()),
    ] {
        assert_no_credentials(text, what, &[INDEX_USER, INDEX_PASSWORD]);
        // 主机和端口留着，方便排查连的是哪。
        assert!(text.contains("127.0.0.1:1"), "{what}：{text}");
    }
    assert_no_credentials(
        &stderr.lock().unwrap().join("\n"),
        "Agent 的标准错误",
        &[INDEX_USER, INDEX_PASSWORD],
    );
}

/// 环境准备失败时（退出码 78）的标准错误：失败的命令、输出、用到的镜像，里面没有用户名和密码。
async fn exit_report(mut child: AgentChild) -> (Option<i32>, String) {
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

fn agent_with_home(home: &Path, cp: &FakeControlPlane, name: &str) -> tokio::process::Command {
    let mut command = agent_command(home);
    command
        .args(["--server", &cp.url, "--name", name])
        .env("UV_CACHE_DIR", home.join("uv-cache"));
    command
}

#[tokio::test]
async fn the_failure_report_of_a_credentialed_release_mirror_shows_only_masks() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let mirror = ReleaseMirror::start().await; // 空镜像：安装脚本 404。
    let credentialed = with_credentials(&mirror.url(), MIRROR_USER, MIRROR_PASSWORD);
    let cp = FakeControlPlane::start().await;
    cp.set_mirrors("", &credentialed);

    let child = agent_with_home(&home, &cp, "agent-mirror-credentials")
        .env_remove("SFLY_UV")
        .stderr(Stdio::piped())
        .spawn_agent();
    let (code, report) = exit_report(child).await;
    assert_eq!(code, Some(78), "{report}");
    assert_no_credentials(&report, "失败报告", &[MIRROR_USER, MIRROR_PASSWORD]);
    // 失败的命令里镜像地址的位置、「用到的镜像」那一节里：主机和路径留着，用户名和密码是掩码。
    let masked = mirror.url().replacen("://", "://***@", 1);
    let installer = format!("{masked}/astral-sh/uv/LatestRelease/uv-installer.sh");
    assert!(report.contains(&installer), "失败的命令：{report}");
    assert!(
        report.contains(&format!("GitHub Release 镜像：{masked}（控制面下发）")),
        "用到的镜像：{report}"
    );
    assert!(
        report.contains(&format!(
            "Python 下载镜像：{masked}/astral-sh/python-build-standalone/（由控制面下发的 GitHub Release 镜像推导）"
        )),
        "推导的 Python 下载镜像：{report}"
    );
    assert!(report.contains("报告给平台管理员"), "{report}");
}

#[tokio::test]
async fn the_failure_report_of_a_credentialed_python_mirror_shows_only_masks() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let mirror = ReleaseMirror::start().await; // 镜像上没有 Python。
    let python = with_credentials(
        &format!("{}/astral-sh/python-build-standalone/", mirror.url()),
        PYTHON_USER,
        PYTHON_PASSWORD,
    );
    let cp = FakeControlPlane::start().await;
    cp.set_mirrors("", &mirror.url());

    let child = agent_with_home(&home, &cp, "agent-python-credentials")
        .envs(mirror.python_env(&dir.path().join("pythons")))
        // 本机覆盖（和 agent.env 里写的一样）：Python 下载镜像带用户名和密码。
        .env("SFLY_PYTHON_INSTALL_MIRROR", &python)
        .stderr(Stdio::piped())
        .spawn_agent();
    let (code, report) = exit_report(child).await;
    assert_eq!(code, Some(78), "{report}");
    assert_no_credentials(&report, "失败报告", &[PYTHON_USER, PYTHON_PASSWORD]);
    let masked = format!(
        "{}/astral-sh/python-build-standalone/",
        mirror.url().replacen("://", "://***@", 1)
    );
    assert!(
        report.contains(&format!("UV_PYTHON_INSTALL_MIRROR={masked}")),
        "失败的命令：{report}"
    );
    assert!(
        report.contains(&format!("Python 下载镜像：{masked}（本地覆盖）")),
        "用到的镜像：{report}"
    );
    assert!(report.contains("报告给平台管理员"), "{report}");
}
