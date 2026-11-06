//! 切入点 B（Agent 一侧）：版本与控制面不一致时的更新状态与自更新（ADR 0014）。
//!
//! - Welcome 的目标版本与自身版本不同时，Agent 在 Heartbeat 里上报更新状态；
//! - 不能自更新时（`--no-auto-update`、二进制不在 `SFLY_HOME/bin`、目录不可写）上报「需要手动升级」及原因；
//! - 能自更新时：下载、校验 sha256、试运行 `--version`，等手上的任务结束且结果被 Ack，替换二进制并 execve；
//! - 隐藏参数 `--version-override` 覆盖上报的版本号，让同一个二进制扮演旧版本；它不会传给替换后的新二进制，
//!   所以新进程以真实版本（[`AGENT_VERSION`]）握手。「新版本」的二进制是真实二进制末尾追加几个字节
//!   （ELF 不在意文件末尾多出的数据），sha256 与安装的旧文件不同。

mod support;

use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::json;
use sfly_agent::AGENT_VERSION;
use sfly_agent::proto::{
    AgentUpdate, AgentUpdateState, Hello, InstallState, TaskStatus, agent_message,
};
use support::packages::{HttpFixture, fresh_venv, sha256_hex, venv_of};
use support::{FakeControlPlane, Received, repo_root, stub_task, stub_venv};

/// 以 `program`（真实 Agent 二进制或它的副本）启动 Agent，SFLY_HOME 为 `home`，上报版本 1.0.0。
fn agent(program: &Path, home: &Path, cp: &FakeControlPlane) -> tokio::process::Command {
    agent_as(program, home, cp, "1.0.0")
}

/// 同 [`agent`]，上报版本 `version`。
fn agent_as(
    program: &Path,
    home: &Path,
    cp: &FakeControlPlane,
    version: &str,
) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    command
        .env("SFLY_HOME", home)
        .args(["--server", &cp.url, "--name", "agent-update", "--uv", "uv"])
        .arg("--venv")
        .arg(stub_venv())
        .arg("--work-dir")
        .arg(home.join("work"))
        .args(["--version-override", version])
        .stdout(std::process::Stdio::null())
        .kill_on_drop(true);
    command
}

async fn control_plane(target: &str) -> FakeControlPlane {
    let cp = FakeControlPlane::start().await;
    cp.set_target_version(target);
    cp.set_heartbeat_interval(Duration::from_millis(100));
    cp
}

async fn manual_upgrade(cp: &FakeControlPlane) -> AgentUpdate {
    cp.update_status("manual upgrade required", |u| {
        u.state() == AgentUpdateState::ManualUpgradeRequired
    })
    .await
}

/// 测试目录：放在构建目录下而不是 /tmp（每个测试要复制几份约 100 MB 的调试版二进制，/tmp 常是很小的 tmpfs）。
fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap()
}

/// 把 Agent 二进制复制到 `home/bin/sfly-agent`（install.sh 安装的位置）。
fn install_into(home: &Path) -> PathBuf {
    let bin = home.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let exe = bin.join("sfly-agent");
    std::fs::copy(env!("CARGO_BIN_EXE_sfly-agent"), &exe).unwrap();
    exe
}

fn original_binary() -> Vec<u8> {
    std::fs::read(env!("CARGO_BIN_EXE_sfly-agent")).unwrap()
}

/// 「新版本」的 Agent 二进制：真实二进制末尾追加几个字节，能照常运行，sha256 不同。
fn new_binary() -> Vec<u8> {
    let mut bytes = original_binary();
    bytes.extend_from_slice(b"\nsfly-agent-test-new-version\n");
    bytes
}

const BINARY_PATH: &str = "/agent/binaries/new/sfly-agent";

/// 控制面提供二进制下载：在 `http` 上放 `body`（第一次下载前等待 `delay`），Welcome 给出地址和 `sha256`。
fn offer_binary(
    cp: &FakeControlPlane,
    http: &HttpFixture,
    body: Vec<u8>,
    sha256: &str,
    delay: Duration,
) {
    let url = http.put_with(BINARY_PATH, body, "application/octet-stream", delay);
    cp.set_agent_binary(&url, sha256);
}

/// 第 `session` 个会话（从 0 开始）里，在全部已收消息的 `after` 位置之后、满足 `pick` 的更新状态。
async fn update_after(
    cp: &FakeControlPlane,
    what: &str,
    after: usize,
    pick: impl Fn(&AgentUpdate) -> bool,
) -> (AgentUpdate, usize) {
    cp.wait_for(what, |all: &[Received]| {
        all.iter()
            .enumerate()
            .skip(after)
            .find_map(|(i, r)| match &r.message.body {
                Some(agent_message::Body::Heartbeat(h)) => {
                    h.update.clone().filter(|u| pick(u)).map(|u| (u, i))
                }
                _ => None,
            })
    })
    .await
}

/// 等到名为 `name`、上报版本 `version` 的 Hello。
async fn hello_as(cp: &FakeControlPlane, name: &str, version: &str) -> Hello {
    cp.wait_for(&format!("hello from {name} as {version}"), |all| {
        all.iter().find_map(|r| match &r.message.body {
            Some(agent_message::Body::Hello(h)) if h.name == name && h.agent_version == version => {
                Some(h.clone())
            }
            _ => None,
        })
    })
    .await
}

/// `home/bin` 下的文件名（排序）。
fn bin_entries(home: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(home.join("bin"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// 等文件出现。
async fn wait_for_file(path: &Path) {
    let deadline = tokio::time::Instant::now() + support::WAIT;
    while !path.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "{} 没有出现",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn version_override_is_reported_and_matching_version_needs_no_update() {
    let dir = scratch();
    let cp = control_plane("1.0.0").await;
    let _agent = agent(Path::new(env!("CARGO_BIN_EXE_sfly-agent")), dir.path(), &cp)
        .spawn()
        .unwrap();

    assert_eq!(cp.hello(0).await.agent_version, "1.0.0");
    let update = cp.update_status("update status", |_| true).await;
    assert_eq!(update.state(), AgentUpdateState::None);
}

#[tokio::test]
async fn no_auto_update_reports_manual_upgrade_required() {
    let dir = scratch();
    let home = dir.path().join("home");
    let exe = install_into(&home);
    let cp = control_plane("2.0.0").await;
    let _agent = agent(&exe, &home, &cp)
        .arg("--no-auto-update")
        .spawn()
        .unwrap();

    let update = manual_upgrade(&cp).await;
    assert!(update.reason.contains("--no-auto-update"), "{update:?}");
}

#[tokio::test]
async fn no_auto_update_can_come_from_agent_env() {
    let dir = scratch();
    let home = dir.path().join("home");
    let exe = install_into(&home);
    std::fs::write(home.join("agent.env"), "SFLY_NO_AUTO_UPDATE=1\n").unwrap();
    let cp = control_plane("2.0.0").await;
    let _agent = agent(&exe, &home, &cp).spawn().unwrap();

    let update = manual_upgrade(&cp).await;
    assert!(update.reason.contains("--no-auto-update"), "{update:?}");
}

#[tokio::test]
async fn binary_outside_sfly_home_bin_reports_manual_upgrade_required() {
    let dir = scratch();
    let cp = control_plane("2.0.0").await;
    // cargo 构建产物不在 SFLY_HOME/bin 下。
    let _agent = agent(Path::new(env!("CARGO_BIN_EXE_sfly-agent")), dir.path(), &cp)
        .spawn()
        .unwrap();

    let update = manual_upgrade(&cp).await;
    assert!(update.reason.contains("不在"), "{update:?}");
    assert!(
        update
            .reason
            .contains(&dir.path().join("bin").display().to_string()),
        "{update:?}"
    );
}

#[tokio::test]
async fn unwritable_bin_directory_reports_manual_upgrade_required() {
    if is_root() {
        eprintln!("skipped: root can write to any directory");
        return;
    }
    let dir = scratch();
    let home = dir.path().join("home");
    let exe = install_into(&home);
    let bin = home.join("bin");
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o555)).unwrap();
    let cp = control_plane("2.0.0").await;
    let mut agent = agent(&exe, &home, &cp).spawn().unwrap();

    let update = manual_upgrade(&cp).await;
    agent.kill().await.unwrap();
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(update.reason.contains("不可写"), "{update:?}");
    assert!(
        update.reason.contains(&bin.display().to_string()),
        "{update:?}"
    );
}

#[tokio::test]
async fn self_update_downloads_first_then_drains_until_results_are_acked_then_replaces_and_execs() {
    let dir = scratch();
    let home = dir.path().join("home");
    let exe = install_into(&home);
    let http = HttpFixture::start().await;
    // 一开始版本一致：先让 Agent 接下一个任务。
    let cp = control_plane("").await;
    let mut child = agent_as(&exe, &home, &cp, "0.0.0").spawn().unwrap();
    let pid = child.id();
    cp.hello(0).await;
    let (ready, release) = (dir.path().join("ready"), dir.path().join("release"));
    cp.assign(stub_task(
        "task-gate",
        "gate",
        json!({ "ready_file": ready, "release_file": release }),
    ))
    .await;
    wait_for_file(&ready).await;

    // 控制面升级：重连后 Welcome 给出新的目标版本；下载先慢一点，能看到「下载中」。
    let new = new_binary();
    offer_binary(
        &cp,
        &http,
        new.clone(),
        &sha256_hex(&new),
        Duration::from_millis(500),
    );
    cp.set_target_version(AGENT_VERSION);
    cp.stop_acking();
    cp.end_session();
    let hello = cp.hello(1).await;
    assert_eq!(hello.agent_version, "0.0.0");
    assert_eq!(hello.running_tasks.len(), 1, "{hello:?}");

    let (_, downloading) = update_after(&cp, "downloading", 0, |u| {
        u.state() == AgentUpdateState::Downloading
    })
    .await;
    let (waiting, at) = update_after(&cp, "waiting for tasks", downloading, |u| {
        u.state() == AgentUpdateState::WaitingForTasks
    })
    .await;
    assert_eq!(waiting.remaining_tasks, 1, "{waiting:?}");

    // 排空期间不接新任务：派来的任务既不执行也不在心跳里续约（控制面会按 agent_lost 处理）。
    cp.assign(stub_task("task-rejected", "echo", json!({ "text": "hi" })))
        .await;

    // 任务结束、结果还没被 Ack：继续等。
    std::fs::write(&release, "").unwrap();
    let (result, result_at) = cp.result_at("task-gate").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert!(result_at > at);
    let (still, _) = update_after(&cp, "still waiting for the ack", result_at, |u| {
        u.state() == AgentUpdateState::WaitingForTasks
    })
    .await;
    assert_eq!(still.remaining_tasks, 1, "{still:?}");
    assert_eq!(std::fs::read(&exe).unwrap(), original_binary(), "还没替换");

    // 断线重连后继续排空：重新上报结果，收到 Ack 后替换并 execve。
    cp.start_acking();
    cp.end_session();
    let hello = cp.hello(2).await;
    assert_eq!(hello.agent_version, "0.0.0");
    assert_eq!(hello.running_tasks.len(), 1, "{hello:?}");
    update_after(&cp, "replacing", 0, |u| {
        u.state() == AgentUpdateState::Replacing
    })
    .await;

    // 新进程（同一个 PID）以目标版本握手，手上没有任务。
    let hello = cp.hello(3).await;
    assert_eq!(hello.agent_version, AGENT_VERSION);
    assert!(hello.running_tasks.is_empty(), "{hello:?}");
    assert!(child.try_wait().unwrap().is_none(), "Agent 没有退出");
    assert_eq!(child.id(), pid);
    assert_eq!(std::fs::read(&exe).unwrap(), new, "二进制已替换");
    assert_eq!(
        std::fs::read(home.join("bin/sfly-agent.prev")).unwrap(),
        original_binary(),
        "旧二进制保存为 .prev"
    );
    // 没有留下下载的临时文件；锁文件留着给下一次替换用。
    assert_eq!(
        bin_entries(&home),
        [".sfly-agent.lock", "sfly-agent", "sfly-agent.prev"]
    );
    assert_eq!(http.count(BINARY_PATH), 1, "重连后没有重新下载");
    let update = update_after(&cp, "no update needed", 0, |u| {
        u.state() == AgentUpdateState::None
    })
    .await;
    assert_eq!(update.0.state(), AgentUpdateState::None);

    let rejected = cp.received().into_iter().any(|m| match m.body {
        Some(agent_message::Body::Result(r)) => r.task_id == "task-rejected",
        Some(agent_message::Body::Started(s)) => s.task_id == "task-rejected",
        Some(agent_message::Body::Heartbeat(h)) => {
            h.running_tasks.iter().any(|t| t.task_id == "task-rejected")
        }
        _ => false,
    });
    assert!(!rejected, "排空期间派来的任务没有被接下");
}

#[tokio::test]
async fn self_update_also_downgrades_when_the_control_plane_is_older() {
    let dir = scratch();
    let home = dir.path().join("home");
    let exe = install_into(&home);
    let http = HttpFixture::start().await;
    let cp = control_plane(AGENT_VERSION).await;
    let new = new_binary();
    offer_binary(&cp, &http, new.clone(), &sha256_hex(&new), Duration::ZERO);
    let _agent = agent_as(&exe, &home, &cp, "9.9.9").spawn().unwrap();

    assert_eq!(cp.hello(0).await.agent_version, "9.9.9");
    assert_eq!(cp.hello(1).await.agent_version, AGENT_VERSION);
    assert_eq!(std::fs::read(&exe).unwrap(), new);
}

#[tokio::test]
async fn sha256_mismatch_keeps_the_old_version_and_reports_failure() {
    let dir = scratch();
    let home = dir.path().join("home");
    let exe = install_into(&home);
    let http = HttpFixture::start().await;
    let cp = control_plane(AGENT_VERSION).await;
    offer_binary(&cp, &http, new_binary(), &"0".repeat(64), Duration::ZERO);
    let _agent = agent_as(&exe, &home, &cp, "0.0.0").spawn().unwrap();

    let (failed, _) = update_after(&cp, "update failed", 0, |u| {
        u.state() == AgentUpdateState::Failed
    })
    .await;
    assert!(failed.reason.contains("sha256"), "{failed:?}");
    assert_old_version_keeps_running(&cp, &home, &exe).await;
}

#[tokio::test]
async fn a_binary_that_fails_its_trial_run_is_not_installed() {
    let dir = scratch();
    let home = dir.path().join("home");
    let exe = install_into(&home);
    let http = HttpFixture::start().await;
    let cp = control_plane(AGENT_VERSION).await;
    let broken = b"#!/bin/sh\necho 'cannot start' >&2\nexit 3\n".to_vec();
    let sha256 = sha256_hex(&broken);
    offer_binary(&cp, &http, broken, &sha256, Duration::ZERO);
    let _agent = agent_as(&exe, &home, &cp, "0.0.0").spawn().unwrap();

    let (failed, _) = update_after(&cp, "update failed", 0, |u| {
        u.state() == AgentUpdateState::Failed
    })
    .await;
    assert!(failed.reason.contains("--version"), "{failed:?}");
    assert!(failed.reason.contains("cannot start"), "{failed:?}");
    assert_old_version_keeps_running(&cp, &home, &exe).await;
}

/// 更新失败后：二进制没动、没有留下临时文件，旧版本照常连着控制面执行任务。
async fn assert_old_version_keeps_running(cp: &FakeControlPlane, home: &Path, exe: &Path) {
    assert_eq!(std::fs::read(exe).unwrap(), original_binary());
    assert_eq!(bin_entries(home), ["sfly-agent"]);
    cp.assign(stub_task("task-after", "echo", json!({ "text": "hi" })))
        .await;
    let (result, session) = cp.result("task-after").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(session, 0, "没有重新启动");
}

#[tokio::test]
async fn two_agents_sharing_sfly_home_replace_the_binary_only_once() {
    let dir = scratch();
    let home = dir.path().join("home");
    let exe = install_into(&home);
    let http = HttpFixture::start().await;
    let cp = control_plane(AGENT_VERSION).await;
    let new = new_binary();
    offer_binary(&cp, &http, new.clone(), &sha256_hex(&new), Duration::ZERO);
    let spawn = |name: &str| {
        let mut command = agent_as(&exe, &home, &cp, "0.0.0");
        command
            .args(["--name", name, "--work-dir"])
            .arg(home.join(format!("work-{name}")));
        command.spawn().unwrap()
    };
    let _a = spawn("agent-a");
    let _b = spawn("agent-b");

    hello_as(&cp, "agent-a", AGENT_VERSION).await;
    hello_as(&cp, "agent-b", AGENT_VERSION).await;
    assert_eq!(std::fs::read(&exe).unwrap(), new);
    // 第二个替换的话，.prev 会变成第一个装上的新版本。
    assert_eq!(
        std::fs::read(home.join("bin/sfly-agent.prev")).unwrap(),
        original_binary(),
        "只替换了一次"
    );
}

/// 记录参数的 uv：每次调用把参数写进 `log` 一行；`self update` 直接成功，其余转给测试机的 uv。
fn recording_uv(path: &Path, log: &Path) {
    let output = std::process::Command::new("sh")
        .args(["-c", "command -v uv"])
        .output()
        .unwrap();
    let uv = String::from_utf8(output.stdout).unwrap();
    std::fs::write(
        path,
        format!(
            "#!/bin/sh\necho \"$*\" >> '{}'\n[ \"$1 $2\" = 'self update' ] && exit 0\nexec '{}' \"$@\"\n",
            log.display(),
            uv.trim()
        ),
    )
    .unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[tokio::test]
async fn after_self_update_uv_is_updated_once_and_dev_packages_are_still_loaded() {
    let dir = scratch();
    let home = dir.path().join("home");
    let exe = install_into(&home);
    // Agent 管理的 uv（不指定 --uv）：SFLY_HOME/bin/uv。
    let log = dir.path().join("uv.log");
    recording_uv(&home.join("bin/uv"), &log);
    let self_updates = || {
        std::fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .filter(|l| l.starts_with("self update"))
            .count()
    };
    let http = HttpFixture::start().await;
    let venv = fresh_venv(true);
    let cp = control_plane("").await;
    let mut command = tokio::process::Command::new(&exe);
    command
        .env("SFLY_HOME", &home)
        .env("UV_CACHE_DIR", venv.path().join("uv-cache"))
        .args(["--server", &cp.url, "--name", "agent-dev-update"])
        .arg("--venv")
        .arg(venv_of(&venv))
        .args(["--index-url", &http.index_url()])
        .args(["--version-override", "0.0.0"])
        .stdout(std::process::Stdio::null())
        .kill_on_drop(true);
    let _agent = command.spawn().unwrap();
    cp.hello(0).await;

    // 用 sfly dev 加载开发版本。
    let project = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(project.path().join("src/sfly_devup")).unwrap();
    std::fs::write(
        project.path().join("pyproject.toml"),
        "[project]\nname = \"sfly-devup\"\nversion = \"0.9.0\"\ndependencies = []\n",
    )
    .unwrap();
    std::fs::write(
        project.path().join("src/sfly_devup/__init__.py"),
        "from sfly import node\n\n\n@node\ndef about() -> dict:\n    return {\"source\": \"dev\"}\n",
    )
    .unwrap();
    let output = std::process::Command::new("uv")
        .args(["run", "--locked", "--quiet", "sfly", "dev"])
        .arg(project.path())
        .arg("--socket")
        .arg(home.join("work/agent.sock"))
        .current_dir(repo_root())
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    cp.install_status("sfly-devup", "dev", InstallState::Installed)
        .await;
    assert_eq!(self_updates(), 0);

    let new = new_binary();
    offer_binary(&cp, &http, new.clone(), &sha256_hex(&new), Duration::ZERO);
    cp.set_target_version(AGENT_VERSION);
    cp.end_session();

    let hello = hello_as(&cp, "agent-dev-update", AGENT_VERSION).await;
    let dev: Vec<&str> = hello.dev_packages.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(dev, ["sfly-devup"]);
    let mut task = stub_task("task-dev", "about", json!({}));
    task.package = "sfly-devup".into();
    task.package_version = "dev".into();
    cp.assign(task).await;
    let (result, _) = cp.result("task-dev").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let outputs: serde_json::Value = serde_json::from_str(&result.outputs_json).unwrap();
    assert_eq!(outputs, json!({ "source": "dev" }));

    assert_eq!(self_updates(), 1, "自更新后首次启动执行了 uv self update");
    assert!(!home.join("bin/.uv-update").exists(), "标记已清除");
    assert!(home.join("bin/sfly-agent.prev").exists());
}

fn is_root() -> bool {
    let output = std::process::Command::new("id").arg("-u").output().unwrap();
    String::from_utf8_lossy(&output.stdout).trim() == "0"
}
