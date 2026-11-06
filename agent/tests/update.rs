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
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::json;
use sfly_agent::AGENT_VERSION;
use sfly_agent::proto::{
    AgentUpdate, AgentUpdateState, Hello, InstallState, TaskStatus, UpdateNow, agent_message,
    server_message,
};
use support::packages::{HttpFixture, fresh_venv, sha256_hex, venv_of};
use support::{FakeControlPlane, Received, repo_root, stub_task, stub_venv};

/// 只在测试中使用：上报的版本等于它时，Agent 记下这次启动后立即以非零码退出（模拟启动即崩溃的新版本）。
const CRASH_ON_START: &str = "SFLY_TEST_CRASH_ON_START";

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
    agent_at(program, home, &cp.url, Some(version))
}

/// 连接 `server` 的 Agent；`version` 为 None 时上报真实版本（[`AGENT_VERSION`]）。
fn agent_at(
    program: &Path,
    home: &Path,
    server: &str,
    version: Option<&str>,
) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    command
        .env("SFLY_HOME", home)
        .args(["--server", server, "--name", "agent-update", "--uv", "uv"])
        .arg("--venv")
        .arg(stub_venv())
        .arg("--work-dir")
        .arg(home.join("work"))
        .stdout(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(version) = version {
        command.args(["--version-override", version]);
    }
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

/// 启动刚复制出来的二进制：并发的测试在 fork 时可能还继承着复制时的写句柄（ETXTBSY），稍后重试。
trait Start {
    fn start(&mut self) -> tokio::process::Child;
}

impl Start for tokio::process::Command {
    fn start(&mut self) -> tokio::process::Child {
        for _ in 0..50 {
            match self.spawn() {
                Err(error) if error.raw_os_error() == Some(26) => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                spawned => return spawned.unwrap(),
            }
        }
        panic!("text file busy");
    }
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
    let _agent = agent(Path::new(env!("CARGO_BIN_EXE_sfly-agent")), dir.path(), &cp).start();

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
    let _agent = agent(&exe, &home, &cp).arg("--no-auto-update").start();

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
    let _agent = agent(&exe, &home, &cp).start();

    let update = manual_upgrade(&cp).await;
    assert!(update.reason.contains("--no-auto-update"), "{update:?}");
}

#[tokio::test]
async fn no_auto_update_accepts_boolish_values_from_the_environment_and_agent_env() {
    let dir = scratch();
    let home = dir.path().join("home");
    let exe = install_into(&home);
    let cp = control_plane("2.0.0").await;
    for (n, value) in ["1", "YES", "true"].into_iter().enumerate() {
        let at = cp.received().len();
        let mut agent = agent(&exe, &home, &cp)
            .env("SFLY_NO_AUTO_UPDATE", value)
            .start();
        let (update, _) = update_after(&cp, "update status", at, |_| true).await;
        agent.kill().await.unwrap();
        assert_eq!(
            update.state(),
            AgentUpdateState::ManualUpgradeRequired,
            "SFLY_NO_AUTO_UPDATE={value} ({n}): {update:?}"
        );
    }
    // 0 / no / false 与没有设置一样：照常自更新（这里控制面没有提供二进制，上报「更新失败」）。
    for (key, value) in [("env", "0"), ("file", "No"), ("env", "false")] {
        let at = cp.received().len();
        let mut command = agent(&exe, &home, &cp);
        if key == "env" {
            command.env("SFLY_NO_AUTO_UPDATE", value);
        } else {
            std::fs::write(
                home.join("agent.env"),
                format!("SFLY_NO_AUTO_UPDATE={value}\n"),
            )
            .unwrap();
        }
        let mut agent = command.start();
        let (update, _) = update_after(&cp, "update status", at, |_| true).await;
        agent.kill().await.unwrap();
        let _ = std::fs::remove_file(home.join("agent.env"));
        assert_eq!(
            update.state(),
            AgentUpdateState::Failed,
            "SFLY_NO_AUTO_UPDATE={value} ({key}): {update:?}"
        );
    }
}

#[tokio::test]
async fn binary_outside_sfly_home_bin_reports_manual_upgrade_required() {
    let dir = scratch();
    let cp = control_plane("2.0.0").await;
    // cargo 构建产物不在 SFLY_HOME/bin 下。
    let _agent = agent(Path::new(env!("CARGO_BIN_EXE_sfly-agent")), dir.path(), &cp).start();

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
    /// 测试结束时（包括失败时）恢复写权限，否则临时目录删不掉。
    struct Writable<'a>(&'a Path);
    impl Drop for Writable<'_> {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(self.0, std::fs::Permissions::from_mode(0o755));
        }
    }
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o555)).unwrap();
    let _writable = Writable(&bin);
    let cp = control_plane("2.0.0").await;
    let mut agent = agent(&exe, &home, &cp).start();

    let update = manual_upgrade(&cp).await;
    agent.kill().await.unwrap();
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
    let mut child = agent_as(&exe, &home, &cp, "0.0.0").start();
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
    // 新进程处理完 Welcome 后心跳上报「不需要更新」。
    cp.wait_for("no update needed", |all| {
        all.iter()
            .any(|r| {
                r.session == 3
                    && matches!(&r.message.body, Some(agent_message::Body::Heartbeat(h))
                    if h.update.as_ref().is_some_and(|u| u.state() == AgentUpdateState::None))
            })
            .then_some(())
    })
    .await;
    // 没有留下下载的临时文件；新版本握手成功后删掉了状态文件；锁文件留着给下一次替换用。
    assert_eq!(
        bin_entries(&home),
        [".sfly-agent.lock", "sfly-agent", "sfly-agent.prev"]
    );
    assert_eq!(http.count(BINARY_PATH), 1, "重连后没有重新下载");

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
    let _agent = agent_as(&exe, &home, &cp, "9.9.9").start();

    assert_eq!(cp.hello(0).await.agent_version, "9.9.9");
    assert_eq!(cp.hello(1).await.agent_version, AGENT_VERSION);
    assert_eq!(std::fs::read(&exe).unwrap(), new);
}

/// 以旧版本启动、版本一致时接下一个等取消的任务（wait_cancel：启动后写 ready_file，被取消时在清理代码里写 report_file），
/// 然后控制面升级：重连后的 Welcome 给出新的目标版本和二进制（第一次下载前等 `delay`）。
async fn holding_a_task_when_the_control_plane_upgrades(
    dir: &Path,
    delay: Duration,
) -> (
    FakeControlPlane,
    HttpFixture,
    tokio::process::Child,
    PathBuf,
    Vec<u8>,
) {
    let home = dir.join("home");
    let exe = install_into(&home);
    let http = HttpFixture::start().await;
    let cp = control_plane("").await;
    let child = agent_as(&exe, &home, &cp, "0.0.0").start();
    cp.hello(0).await;
    cp.assign(stub_task(
        "task-long",
        "wait_cancel",
        json!({ "ready_file": dir.join("ready"), "report_file": dir.join("report") }),
    ))
    .await;
    wait_for_file(&dir.join("ready")).await;

    let new = new_binary();
    offer_binary(&cp, &http, new.clone(), &sha256_hex(&new), delay);
    cp.set_target_version(AGENT_VERSION);
    cp.end_session();
    assert_eq!(cp.hello(1).await.running_tasks.len(), 1);
    (cp, http, child, exe, new)
}

async fn update_now(cp: &FakeControlPlane) {
    cp.send(server_message::Body::UpdateNow(UpdateNow {})).await;
}

#[tokio::test]
async fn update_now_terminates_tasks_through_the_cancel_flow_then_replaces_and_execs() {
    let dir = scratch();
    let (cp, _http, mut child, exe, new) =
        holding_a_task_when_the_control_plane_upgrades(dir.path(), Duration::ZERO).await;
    let pid = child.id();
    let (waiting, _) = update_after(&cp, "waiting for tasks", 0, |u| {
        u.state() == AgentUpdateState::WaitingForTasks
    })
    .await;
    assert_eq!(waiting.remaining_tasks, 1, "{waiting:?}");

    update_now(&cp).await;

    // 按取消流程终止：节点的清理代码执行了，结果照常上报。
    let (result, session) = cp.result("task-long").await;
    assert_eq!(session, 1);
    assert_eq!(result.status(), TaskStatus::Cancelled, "{result:?}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("report")).unwrap(),
        "cancelled"
    );
    assert!(dir.path().join("home/work/task-long/cancel").exists());

    // 结果被 Ack 后替换并 execve，新进程（同一个 PID）以目标版本握手。
    let hello = cp.hello(2).await;
    assert_eq!(hello.agent_version, AGENT_VERSION);
    assert!(hello.running_tasks.is_empty(), "{hello:?}");
    assert!(child.try_wait().unwrap().is_none(), "Agent 没有退出");
    assert_eq!(child.id(), pid);
    assert_eq!(std::fs::read(&exe).unwrap(), new, "二进制已替换");
}

#[tokio::test]
async fn update_now_while_downloading_terminates_tasks_at_once_and_takes_no_new_ones() {
    let dir = scratch();
    let (cp, _http, _child, exe, new) =
        holding_a_task_when_the_control_plane_upgrades(dir.path(), Duration::from_secs(2)).await;
    update_after(&cp, "downloading", 0, |u| {
        u.state() == AgentUpdateState::Downloading
    })
    .await;

    update_now(&cp).await;
    cp.assign(stub_task("task-rejected", "echo", json!({ "text": "hi" })))
        .await;

    // 不等下载完成就终止手上的任务。
    let (result, at) = cp.result_at("task-long").await;
    assert_eq!(result.status(), TaskStatus::Cancelled, "{result:?}");
    let downloaded = cp.received().into_iter().take(at).any(|m| match m.body {
        Some(agent_message::Body::Heartbeat(h)) => h.update.is_some_and(|u| {
            matches!(
                u.state(),
                AgentUpdateState::WaitingForTasks | AgentUpdateState::Replacing
            )
        }),
        _ => false,
    });
    assert!(!downloaded, "还在下载时就终止了任务");

    // 下载好之后立即替换。
    assert_eq!(cp.hello(2).await.agent_version, AGENT_VERSION);
    assert_eq!(std::fs::read(&exe).unwrap(), new);
    let rejected = cp.received().into_iter().any(|m| match m.body {
        Some(agent_message::Body::Result(r)) => r.task_id == "task-rejected",
        Some(agent_message::Body::Started(s)) => s.task_id == "task-rejected",
        _ => false,
    });
    assert!(!rejected, "收到立即更新后派来的任务没有被接下");
}

#[tokio::test]
async fn sha256_mismatch_keeps_the_old_version_and_reports_failure() {
    let dir = scratch();
    let home = dir.path().join("home");
    let exe = install_into(&home);
    let http = HttpFixture::start().await;
    let cp = control_plane(AGENT_VERSION).await;
    offer_binary(&cp, &http, new_binary(), &"0".repeat(64), Duration::ZERO);
    let _agent = agent_as(&exe, &home, &cp, "0.0.0").start();

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
    let _agent = agent_as(&exe, &home, &cp, "0.0.0").start();

    let (failed, _) = update_after(&cp, "update failed", 0, |u| {
        u.state() == AgentUpdateState::Failed
    })
    .await;
    assert!(failed.reason.contains("--version"), "{failed:?}");
    assert!(failed.reason.contains("cannot start"), "{failed:?}");
    assert_old_version_keeps_running(&cp, &home, &exe).await;
}

#[tokio::test]
async fn a_target_binary_that_is_the_running_binary_is_not_reexecuted_in_a_loop() {
    let dir = scratch();
    let home = dir.path().join("home");
    let exe = install_into(&home);
    let http = HttpFixture::start().await;
    // 控制面提供的就是正在运行的二进制，而它的版本不是目标版本：execve 后还会不一致。
    let cp = control_plane("2.0.0").await;
    let running = original_binary();
    offer_binary(
        &cp,
        &http,
        running.clone(),
        &sha256_hex(&running),
        Duration::ZERO,
    );
    let _agent = agent(&exe, &home, &cp).start();

    let (failed, _) = update_after(&cp, "update failed", 0, |u| {
        u.state() == AgentUpdateState::Failed
    })
    .await;
    assert!(failed.reason.contains("2.0.0"), "{failed:?}");
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
        command.start()
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
    let _agent = command.start();
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

/// 模拟 systemd 的 `Restart=on-failure`：Agent 退出后（稍等片刻）重新启动，`start` 给出每次启动的命令。
struct Supervisor {
    task: tokio::task::JoinHandle<()>,
    exits: Arc<AtomicUsize>,
}

impl Supervisor {
    fn new(start: impl Fn() -> tokio::process::Command + Send + 'static) -> Self {
        let exits = Arc::new(AtomicUsize::new(0));
        let counter = exits.clone();
        let task = tokio::spawn(async move {
            loop {
                let mut child = start().start();
                let _ = child.wait().await;
                counter.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });
        Self { task, exits }
    }

    /// Agent 退出（崩溃）过几次。
    fn exits(&self) -> usize {
        self.exits.load(Ordering::SeqCst)
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// 由 systemd 管理、安装在 `home` 下的 Agent：装的是原来的二进制时扮演旧版本 0.0.0，
/// 装的是新版本时上报真实版本；新版本（[`AGENT_VERSION`]）启动即崩溃。
fn supervise_crashing_new_version(exe: &Path, home: &Path, cp: &FakeControlPlane) -> Supervisor {
    let (exe, home, url) = (exe.to_path_buf(), home.to_path_buf(), cp.url.clone());
    let original = original_binary().len() as u64;
    Supervisor::new(move || {
        let old = std::fs::metadata(&exe).unwrap().len() == original;
        let mut command = agent_at(&exe, &home, &url, old.then_some("0.0.0"));
        command.env(CRASH_ON_START, AGENT_VERSION);
        command
    })
}

/// 控制面提供一个启动即崩溃的新版本：Agent 更新过去，新版本崩溃 3 次后恢复旧版本。
/// 返回「更新失败」的状态和它在已收消息中的位置。
async fn roll_back_a_crashing_new_version(
    cp: &FakeControlPlane,
    http: &HttpFixture,
    home: &Path,
) -> (Supervisor, AgentUpdate, usize) {
    let exe = install_into(home);
    let new = new_binary();
    offer_binary(cp, http, new.clone(), &sha256_hex(&new), Duration::ZERO);
    let systemd = supervise_crashing_new_version(&exe, home, cp);
    assert_eq!(cp.hello(0).await.agent_version, "0.0.0");
    let (failed, at) = update_after(cp, "update failed", 0, |u| {
        u.state() == AgentUpdateState::Failed
    })
    .await;
    (systemd, failed, at)
}

#[tokio::test]
async fn a_new_version_that_crashes_on_start_is_rolled_back_after_three_failures() {
    let dir = scratch();
    let home = dir.path().join("home");
    let http = HttpFixture::start().await;
    let cp = control_plane(AGENT_VERSION).await;

    let (systemd, failed, _) = roll_back_a_crashing_new_version(&cp, &http, &home).await;

    assert!(failed.reason.contains(AGENT_VERSION), "{failed:?}");
    assert!(failed.reason.contains("3 次"), "{failed:?}");
    assert!(failed.reason.contains("0.0.0"), "{failed:?}");
    assert_eq!(systemd.exits(), 3, "新版本崩溃了 3 次");
    assert_eq!(
        std::fs::read(home.join("bin/sfly-agent")).unwrap(),
        original_binary(),
        "恢复了旧版本"
    );
    // 恢复后的旧版本连着控制面（版本不一致，控制面不派任务）；新版本从没握手成功。
    let hellos: Vec<String> = cp
        .received()
        .into_iter()
        .filter_map(|m| match m.body {
            Some(agent_message::Body::Hello(h)) => Some(h.agent_version),
            _ => None,
        })
        .collect();
    assert_eq!(hellos, ["0.0.0", "0.0.0"]);
}

#[tokio::test]
async fn a_bad_version_is_not_retried_until_the_target_version_changes() {
    let dir = scratch();
    let home = dir.path().join("home");
    let http = HttpFixture::start().await;
    let cp = control_plane(AGENT_VERSION).await;
    let (systemd, _, _) = roll_back_a_crashing_new_version(&cp, &http, &home).await;

    // 重连后目标仍是坏版本：只上报「更新失败」，不再下载、不再替换。
    let sessions = cp.received_with_session().last().unwrap().session;
    cp.end_session();
    let after = cp
        .wait_for("reconnect", |all| {
            all.iter().position(|r| r.session > sessions)
        })
        .await;
    let (failed, _) = update_after(&cp, "still failed", after, |u| {
        u.state() == AgentUpdateState::Failed
    })
    .await;
    assert!(failed.reason.contains(AGENT_VERSION), "{failed:?}");
    assert_eq!(http.count(BINARY_PATH), 1, "没有再下载坏版本");
    assert_eq!(
        std::fs::read(home.join("bin/sfly-agent")).unwrap(),
        original_binary()
    );
    assert_eq!(systemd.exits(), 3);

    // 控制面换了目标版本：重新尝试（这个二进制的 sha256 不对，下载校验后失败）。
    let other = "/agent/binaries/other/sfly-agent";
    let url = http.put_with(
        other,
        new_binary(),
        "application/octet-stream",
        Duration::ZERO,
    );
    cp.set_agent_binary(&url, &"0".repeat(64));
    cp.set_target_version("7.7.7");
    let at = cp.received().len();
    cp.end_session();
    let (retried, _) = update_after(&cp, "retry the new target", at, |u| {
        u.state() == AgentUpdateState::Failed && u.reason.contains("sha256")
    })
    .await;
    assert!(!retried.reason.contains("连续"), "{retried:?}");
    assert_eq!(http.count(other), 1, "下载了新的目标版本");
}

#[tokio::test]
async fn a_new_version_that_connects_but_fails_the_handshake_three_times_is_rolled_back() {
    let dir = scratch();
    let home = dir.path().join("home");
    let exe = install_into(&home);
    let http = HttpFixture::start().await;
    let cp = control_plane(AGENT_VERSION).await;
    cp.reject_hello_from(AGENT_VERSION);
    let new = new_binary();
    offer_binary(&cp, &http, new.clone(), &sha256_hex(&new), Duration::ZERO);
    let mut child = agent_as(&exe, &home, &cp, "0.0.0").start();
    let pid = child.id();

    // 新版本连得上控制面，但握手失败 3 次后在同一个进程里恢复旧版本。
    let (failed, _) = update_after(&cp, "update failed", 0, |u| {
        u.state() == AgentUpdateState::Failed
    })
    .await;
    assert!(failed.reason.contains("3 次"), "{failed:?}");
    let hellos: Vec<String> = cp
        .received()
        .into_iter()
        .filter_map(|m| match m.body {
            Some(agent_message::Body::Hello(h)) => Some(h.agent_version),
            _ => None,
        })
        .collect();
    assert_eq!(
        hellos,
        [
            "0.0.0",
            AGENT_VERSION,
            AGENT_VERSION,
            AGENT_VERSION,
            "0.0.0"
        ]
    );
    assert!(child.try_wait().unwrap().is_none(), "Agent 没有退出");
    assert_eq!(child.id(), pid);
    assert_eq!(std::fs::read(&exe).unwrap(), original_binary());
}

#[tokio::test]
async fn when_execve_fails_the_old_version_is_restored_and_the_agent_exits_with_manual_steps() {
    let dir = scratch();
    let home = dir.path().join("home");
    let exe = install_into(&home);
    let http = HttpFixture::start().await;
    let cp = control_plane("").await;
    let mut child = agent_as(&exe, &home, &cp, "0.0.0")
        .stderr(std::process::Stdio::piped())
        .start();
    cp.hello(0).await;
    let (ready, release) = (dir.path().join("ready"), dir.path().join("release"));
    cp.assign(stub_task(
        "task-gate",
        "gate",
        json!({ "ready_file": ready, "release_file": release }),
    ))
    .await;
    wait_for_file(&ready).await;

    // 「新版本」是一个脚本：试运行时解释器还在，等任务期间被删掉，于是 execve 失败（ENOENT）。
    let interpreter = dir.path().join("interpreter");
    std::fs::copy("/bin/sh", &interpreter).unwrap();
    let script = format!("#!{}\necho sfly-agent 9.9.9\n", interpreter.display()).into_bytes();
    offer_binary(
        &cp,
        &http,
        script.clone(),
        &sha256_hex(&script),
        Duration::ZERO,
    );
    cp.set_target_version(AGENT_VERSION);
    cp.end_session();
    update_after(&cp, "waiting for tasks", 0, |u| {
        u.state() == AgentUpdateState::WaitingForTasks
    })
    .await;
    std::fs::remove_file(&interpreter).unwrap();
    std::fs::write(&release, "").unwrap();

    // 标准错误不多（放得进管道缓冲区），退出后再读。
    let (status, stderr) = tokio::time::timeout(support::WAIT, async {
        let status = child.wait().await.unwrap();
        let mut stderr = String::new();
        tokio::io::AsyncReadExt::read_to_string(child.stderr.as_mut().unwrap(), &mut stderr)
            .await
            .unwrap();
        (status, stderr)
    })
    .await
    .expect("Agent 退出");
    assert!(!status.success(), "{status:?}");
    assert!(stderr.contains("执行新版本"), "{stderr}");
    assert!(stderr.contains("手动处理"), "{stderr}");
    assert_eq!(
        std::fs::read(&exe).unwrap(),
        original_binary(),
        "恢复了旧版本"
    );

    // systemd 拉起恢复的旧版本：上报「更新失败」，不再尝试这个版本。
    let at = cp.received().len();
    let _agent = agent_as(&exe, &home, &cp, "0.0.0").start();
    let (failed, _) = update_after(&cp, "update failed", at, |u| {
        u.state() == AgentUpdateState::Failed
    })
    .await;
    assert!(failed.reason.contains("执行新版本"), "{failed:?}");
    assert_eq!(http.count(BINARY_PATH), 1, "没有再下载");
}

/// 等 Agent 的标准错误里出现包含 `text` 的一行。
async fn stderr_line(child: &mut tokio::process::Child, text: &str) {
    use tokio::io::AsyncBufReadExt as _;

    let mut lines = tokio::io::BufReader::new(child.stderr.take().unwrap()).lines();
    let found = tokio::time::timeout(support::WAIT, async {
        while let Some(line) = lines.next_line().await.unwrap() {
            if line.contains(text) {
                return;
            }
        }
        panic!("Agent 退出了，没有输出「{text}」");
    })
    .await;
    assert!(found.is_ok(), "等「{text}」超时");
}

#[tokio::test]
async fn starts_failing_because_the_control_plane_is_unreachable_are_not_counted() {
    let dir = scratch();
    let home = dir.path().join("home");
    let exe = install_into(&home);
    let http = HttpFixture::start().await;
    let cp = control_plane(AGENT_VERSION).await;
    let new = new_binary();
    offer_binary(&cp, &http, new.clone(), &sha256_hex(&new), Duration::ZERO);

    // 旧版本更新到新版本，新版本第一次启动就崩溃：计 1 次。
    let status = agent_as(&exe, &home, &cp, "0.0.0")
        .env(CRASH_ON_START, AGENT_VERSION)
        .start()
        .wait()
        .await
        .unwrap();
    assert!(!status.success(), "{status:?}");
    assert_eq!(std::fs::read(&exe).unwrap(), new);

    // 控制面不可达：新版本反复启动（每次连接失败后被杀掉、重新启动），都不计入失败次数。
    let unreachable = {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", probe.local_addr().unwrap())
    };
    for _ in 0..4 {
        let mut child = agent_at(&exe, &home, &unreachable, None)
            .stderr(std::process::Stdio::piped())
            .start();
        stderr_line(&mut child, "cannot connect").await;
        child.kill().await.unwrap();
    }

    // 控制面恢复：新版本握手成功，没有回滚。
    let _agent = agent_at(&exe, &home, &cp.url, None).start();
    hello_as(&cp, "agent-update", AGENT_VERSION).await;
    cp.update_status("no update needed", |u| u.state() == AgentUpdateState::None)
        .await;
    assert_eq!(std::fs::read(&exe).unwrap(), new, "没有回滚");
}

fn is_root() -> bool {
    let output = std::process::Command::new("id").arg("-u").output().unwrap();
    String::from_utf8_lossy(&output.stdout).trim() == "0"
}
