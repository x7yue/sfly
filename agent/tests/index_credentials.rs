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

// ---- 凭据里有特殊字符的地址（#757）----
//
// 文字规则（`mask_userinfo`）在一段文字里找地址，主机段遇到空白、`"`、反引号、`<`、`>`、`\` 就停：凭据里有这些字符时认不出，
// 而 URL 解析器和 uv 都接受大部分（`\` 除外，见下）。已知的地址（Agent 自己配置的、控制面下发的）要在写日志之前按值换成掩码
// （`secret::register_address`）。下面用真实的 uv 和 Agent 验证：成功和失败的安装日志、失败原因、环境准备失败的报告、
// Agent 的标准错误里都没有用户名和密码。

/// 一个凭据：用户名、密码，和输出里不许出现的几段（整个密码、用户名、密码里特殊字符前后两段的记号：
/// 百分号编码、`Debug` 转义之后记号仍然在）。
struct Awkward {
    label: &'static str,
    user: String,
    password: String,
    /// 能不能装上包：`\` 在用户名位置或密码里时 URL 解析器在 `\` 处结束主机段（主机变成 `\` 之前的），连不到桩索引。
    reachable: bool,
    secrets: Vec<String>,
}

fn awkward_credentials() -> Vec<Awkward> {
    let mut all = Vec::new();
    for (label, middle, reachable) in [
        ("双引号", "\"", true),
        ("空格", " ", true),
        ("反引号", "`", true),
        ("小于号", "<", true),
        ("大于号", ">", true),
        ("反斜杠", "\\", false),
    ] {
        let (head, tail) = ("Zq7x", "k9Xt-pw");
        all.push(Awkward {
            label,
            user: INDEX_USER.to_string(),
            password: format!("{head}{middle}{tail}"),
            reachable,
            secrets: vec![format!("{head}{middle}{tail}"), head.into(), tail.into()],
        });
    }
    // 百分号编码写的密码：uv、reqwest 打印的地址保留编码，curl 发请求时才解码；解码之后的写法也不许出现。
    all.push(Awkward {
        label: "百分号编码的密码",
        user: INDEX_USER.to_string(),
        password: "Zq7x%22k9Xt%20pw".to_string(),
        reachable: true,
        secrets: vec![
            "Zq7x%22k9Xt%20pw".into(),
            "Zq7x\"k9Xt pw".into(),
            "Zq7x".into(),
            "k9Xt".into(),
        ],
    });
    // 用户名里有空格和双引号：文字规则在空格处停下，认不出；命令行里用户名原样（`Debug` 写法里 `"` 写成 `\"`），按值那一层认；
    // uv 回显地址时用户名是百分号编码的、密码换成 `****`，文字规则认得出。
    all.push(Awkward {
        label: "用户名里有空格和双引号",
        user: "Zq7x Us\"er7".to_string(),
        password: "Pw7-k9Xt".to_string(),
        reachable: true,
        secrets: vec![
            "Zq7x Us\"er7".into(),
            "Zq7x".into(),
            "er7".into(),
            "Pw7-k9Xt".into(),
        ],
    });
    // 用户名里有 `\`（AD 风格的 `域\用户名`，#756）：URL 解析器读不出凭据（`\` 之后落进路径），curl 读成用户名和密码。
    all.push(Awkward {
        label: "用户名里有反斜杠",
        user: "CORP7\\jdoe7".to_string(),
        password: "Sec7-k9Xt".to_string(),
        reachable: false,
        secrets: vec!["CORP7".into(), "jdoe7".into(), "Sec7-k9Xt".into()],
    });
    all
}

fn refs(secrets: &[String]) -> Vec<&str> {
    secrets.iter().map(String::as_str).collect()
}

#[tokio::test]
async fn an_index_with_awkward_password_characters_installs_and_leaves_no_password_in_the_log() {
    for awkward in awkward_credentials().iter().filter(|a| a.reachable) {
        let label = awkward.label;
        let index = HttpFixture::start().await;
        let (filename, wheel) = dependency_wheel("sfly-dep", "1.0");
        index.add_to_index("sfly-dep", &filename, wheel, Duration::ZERO);
        let demo = publish(&index, "sfly-demo", "1.0.0", &["sfly-dep==1.0"]);
        let credentialed = with_credentials(&index.index_url(), &awkward.user, &awkward.password);
        let venv = fresh_venv(true);
        let cp = FakeControlPlane::start().await;
        let mut agent = agent(&cp, "agent-awkward-index", &venv, &credentialed);
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
        assert_eq!(result.status(), TaskStatus::Success, "{label}：{result:?}");
        assert!(
            index.count("/simple/sfly-dep/") >= 1,
            "{label}：uv 没有访问索引"
        );
        let (installed, _) = cp
            .install_status("sfly-demo", "1.0.0", InstallState::Installed)
            .await;
        let secrets = refs(&awkward.secrets);
        assert_no_credentials(
            &installed.output,
            &format!("{label}：安装状态里的输出"),
            &secrets,
        );
        // 命令行还在，主机和路径留着，用户名和密码是掩码。
        let masked = index.index_url().replacen("://", "://***@", 1);
        assert!(
            installed
                .output
                .contains(&format!("\"--default-index\" \"{masked}\"")),
            "{label}：{}",
            installed.output
        );
        assert_no_credentials(
            &stderr.lock().unwrap().join("\n"),
            &format!("{label}：Agent 的标准错误"),
            &secrets,
        );
    }
}

#[tokio::test]
async fn a_failed_install_with_awkward_credentials_has_no_username_or_password_in_the_reason() {
    for awkward in awkward_credentials() {
        let label = awkward.label;
        let index = HttpFixture::start().await;
        let needy = publish(&index, "sfly-needy", "1.0.0", &["sfly-absent==1.0"]);
        let credentialed = with_credentials(&index.index_url(), &awkward.user, &awkward.password);
        let venv = fresh_venv(true);
        let cp = FakeControlPlane::start().await;
        let mut agent = agent(&cp, "agent-awkward-index-missing", &venv, &credentialed);
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
        assert_eq!(result.status(), TaskStatus::Failed, "{label}");
        let error = result.error.expect("error");
        let (failed, _) = cp
            .install_status("sfly-needy", "1.0.0", InstallState::Failed)
            .await;
        let secrets = refs(&awkward.secrets);
        for (what, text) in [
            ("任务的失败原因", error.message.as_str()),
            ("安装状态里的输出", failed.output.as_str()),
        ] {
            assert_no_credentials(text, &format!("{label}：{what}"), &secrets);
        }
        assert_no_credentials(
            &stderr.lock().unwrap().join("\n"),
            &format!("{label}：Agent 的标准错误"),
            &secrets,
        );
    }
}

#[tokio::test]
async fn an_unreachable_index_with_awkward_credentials_is_reported_without_them() {
    // 连不上的索引：uv 的报错里回显它要取的地址（用户名在里面，密码 uv 自己换成 `****`）。
    // uv 对连不上的索引会重试几次，每个写法要几秒：挑三个有代表性的（密码里的引号、空格，用户名里的空格和引号）。
    const SAMPLES: [&str; 3] = ["双引号", "空格", "用户名里有空格和双引号"];
    for awkward in awkward_credentials()
        .iter()
        .filter(|a| SAMPLES.contains(&a.label))
    {
        let label = awkward.label;
        let index = HttpFixture::start().await;
        let demo = publish(&index, "sfly-demo", "1.0.0", &["sfly-dep==1.0"]);
        let credentialed = with_credentials(
            "http://127.0.0.1:1/simple/",
            &awkward.user,
            &awkward.password,
        );
        let venv = fresh_venv(true);
        let cp = FakeControlPlane::start().await;
        let mut agent = agent(&cp, "agent-awkward-index-down", &venv, &credentialed);
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
        assert_eq!(result.status(), TaskStatus::Failed, "{label}");
        let error = result.error.expect("error");
        let (failed, _) = cp
            .install_status("sfly-demo", "1.0.0", InstallState::Failed)
            .await;
        let secrets = refs(&awkward.secrets);
        for (what, text) in [
            ("任务的失败原因", error.message.as_str()),
            ("安装状态里的输出", failed.output.as_str()),
        ] {
            assert_no_credentials(text, &format!("{label}：{what}"), &secrets);
            // 主机和端口留着，方便排查连的是哪。
            assert!(text.contains("127.0.0.1:1"), "{label}：{what}：{text}");
        }
        assert_no_credentials(
            &stderr.lock().unwrap().join("\n"),
            &format!("{label}：Agent 的标准错误"),
            &secrets,
        );
    }
}

#[tokio::test]
async fn the_failure_report_of_a_release_mirror_with_awkward_credentials_shows_only_masks() {
    for awkward in awkward_credentials() {
        let label = awkward.label;
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let mirror = ReleaseMirror::start().await; // 空镜像：安装脚本 404。
        let credentialed = with_credentials(&mirror.url(), &awkward.user, &awkward.password);
        let cp = FakeControlPlane::start().await;
        cp.set_mirrors("", &credentialed);

        let child = agent_with_home(&home, &cp, "agent-awkward-mirror")
            .env_remove("SFLY_UV")
            .stderr(Stdio::piped())
            .spawn_agent();
        let (code, report) = exit_report(child).await;
        assert_eq!(code, Some(78), "{label}：{report}");
        assert_no_credentials(
            &report,
            &format!("{label}：失败报告"),
            &refs(&awkward.secrets),
        );
        assert!(report.contains("***"), "{label}：{report}");
        assert!(report.contains("报告给平台管理员"), "{label}：{report}");
        if awkward.reachable {
            // 读法一致的地址：主机和路径留着，排查时看得出连的是哪个镜像。
            assert!(
                report.contains(&format!(
                    "***@{}/astral-sh/uv/LatestRelease/uv-installer.sh",
                    mirror.url().replacen("http://", "", 1)
                )),
                "{label}：{report}"
            );
        }
    }
}

#[tokio::test]
async fn a_local_python_mirror_with_awkward_credentials_shows_only_masks_in_the_report() {
    for awkward in awkward_credentials() {
        let label = awkward.label;
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let mirror = ReleaseMirror::start().await; // 镜像上没有 Python。
        let python = with_credentials(
            &format!("{}/astral-sh/python-build-standalone/", mirror.url()),
            &awkward.user,
            &awkward.password,
        );
        let cp = FakeControlPlane::start().await;
        cp.set_mirrors("", &mirror.url());

        let child = agent_with_home(&home, &cp, "agent-awkward-python")
            .envs(mirror.python_env(&dir.path().join("pythons")))
            .env("SFLY_PYTHON_INSTALL_MIRROR", &python)
            .stderr(Stdio::piped())
            .spawn_agent();
        let (code, report) = exit_report(child).await;
        assert_eq!(code, Some(78), "{label}：{report}");
        assert_no_credentials(
            &report,
            &format!("{label}：失败报告"),
            &refs(&awkward.secrets),
        );
        assert!(report.contains("***"), "{label}：{report}");
    }
}
