//! 切入点 B（Agent 一侧）：版本与控制面不一致时的更新状态（ADR 0014）。
//!
//! - Welcome 的目标版本与自身版本不同时，Agent 在 Heartbeat 里上报更新状态；
//! - 不能自更新时（`--no-auto-update`、二进制不在 `SFLY_HOME/bin`、目录不可写）上报「需要手动升级」及原因；
//! - 隐藏参数 `--version-override` 覆盖上报的版本号，让同一个二进制扮演不同版本。

mod support;

use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;
use std::time::Duration;

use sfly_agent::proto::{AgentUpdate, AgentUpdateState};
use support::{FakeControlPlane, stub_venv};

/// 以 `program`（真实 Agent 二进制或它的副本）启动 Agent，SFLY_HOME 为 `home`，上报版本 1.0.0。
fn agent(program: &Path, home: &Path, cp: &FakeControlPlane) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    command
        .env("SFLY_HOME", home)
        .args(["--server", &cp.url, "--name", "agent-update", "--uv", "uv"])
        .arg("--venv")
        .arg(stub_venv())
        .arg("--work-dir")
        .arg(home.join("work"))
        .args(["--version-override", "1.0.0"])
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

/// 把 Agent 二进制复制到 `home/bin/sfly-agent`（install.sh 安装的位置）。
fn install_into(home: &Path) -> std::path::PathBuf {
    let bin = home.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let exe = bin.join("sfly-agent");
    std::fs::copy(env!("CARGO_BIN_EXE_sfly-agent"), &exe).unwrap();
    exe
}

#[tokio::test]
async fn version_override_is_reported_and_matching_version_needs_no_update() {
    let dir = tempfile::tempdir().unwrap();
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
    let dir = tempfile::tempdir().unwrap();
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
    let dir = tempfile::tempdir().unwrap();
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
    let dir = tempfile::tempdir().unwrap();
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
async fn installed_agent_that_could_update_still_reports_manual_upgrade_until_self_update_exists() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let exe = install_into(&home);
    let cp = control_plane("0.9.0").await;
    let _agent = agent(&exe, &home, &cp).spawn().unwrap();

    // 控制面版本更低（控制面回滚）同样算版本不一致。
    let update = manual_upgrade(&cp).await;
    assert!(update.reason.contains("还不支持自更新"), "{update:?}");
}

#[tokio::test]
async fn unwritable_bin_directory_reports_manual_upgrade_required() {
    if is_root() {
        eprintln!("skipped: root can write to any directory");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
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

fn is_root() -> bool {
    let output = std::process::Command::new("id").arg("-u").output().unwrap();
    String::from_utf8_lossy(&output.stdout).trim() == "0"
}
