//! 切入点 B（Agent 一侧）：Agent 的统一目录 `SFLY_HOME`（默认 `~/.sfly`）。
//!
//! - 不指定 `--venv`、`--work-dir` 时，共享 venv、工作目录和 dev socket 都在 `SFLY_HOME` 下，与启动目录无关；
//! - Agent 启动时读取 `SFLY_HOME/agent.env`，命令行参数和环境变量优先；
//! - 共享 venv 在收到 Welcome 之后才创建：控制面不可达时不创建。

mod support;

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use support::{FakeControlPlane, WAIT, agent_command, python_interpreter, stub_venv};
use tokio::io::{AsyncBufReadExt, BufReader};

/// 等到路径出现。
async fn wait_exists(path: &Path) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while !path.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {}",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 在 `cwd` 下启动 Agent，只给控制面地址、名称和 Python，venv 与工作目录用默认值。
fn agent_in(
    home: &Path,
    cwd: &Path,
    cp: &FakeControlPlane,
    cache: &Path,
) -> tokio::process::Command {
    let mut command = agent_command(home);
    command
        .args(["--server", &cp.url, "--name", "agent-home"])
        .args(["--python", &python_interpreter()])
        .env("UV_CACHE_DIR", cache)
        .current_dir(cwd);
    command
}

#[tokio::test]
async fn venv_work_dir_and_dev_socket_default_to_sfly_home_wherever_the_agent_starts() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("custom-home");
    let cwd = dir.path().join("elsewhere");
    std::fs::create_dir_all(&cwd).unwrap();
    let cp = FakeControlPlane::start().await;

    let _agent = agent_in(&home, &cwd, &cp, &dir.path().join("uv-cache"))
        .spawn()
        .unwrap();
    cp.hello(0).await;
    wait_exists(&home.join("venv/bin/python")).await;
    wait_exists(&home.join("work/agent.sock")).await;
    assert!(!cwd.join("venv").exists() && !cwd.join("work").exists());
}

#[tokio::test]
async fn sfly_home_defaults_to_dot_sfly_in_the_home_directory() {
    let dir = tempfile::tempdir().unwrap();
    let user = dir.path().join("user");
    let cwd = dir.path().join("elsewhere");
    std::fs::create_dir_all(&cwd).unwrap();
    let cp = FakeControlPlane::start().await;

    let mut command = agent_in(Path::new(""), &cwd, &cp, &dir.path().join("uv-cache"));
    let _agent = command
        .env_remove("SFLY_HOME")
        .env("HOME", &user)
        .spawn()
        .unwrap();
    cp.hello(0).await;
    wait_exists(&user.join(".sfly/venv/bin/python")).await;
    wait_exists(&user.join(".sfly/work/agent.sock")).await;
}

#[tokio::test]
async fn agent_env_provides_settings_and_command_line_and_environment_override_it() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let cp = FakeControlPlane::start().await;
    std::fs::write(
        home.join("agent.env"),
        format!(
            "# install.sh 写入的配置\n\nSFLY_SERVER={}\nSFLY_AGENT_NAME=\"from-file\"\nSFLY_SLOTS=3\nSFLY_VENV='{}'\n\
             SFLY_CONTROL_PLANE_URL=http://127.0.0.1:1\n",
            cp.url,
            stub_venv().display()
        ),
    )
    .unwrap();

    // 只有 agent.env：控制面地址、名称、槽位和 venv 都来自它。
    let mut first = agent_command(&home).spawn().unwrap();
    let hello = cp.hello(0).await;
    assert_eq!((hello.name.as_str(), hello.slots), ("from-file", 3));
    assert!(
        hello
            .installed_packages
            .iter()
            .any(|p| p.name == "sfly-stub"),
        "SFLY_VENV 指向装好桩节点包的 venv：{hello:?}"
    );
    first.kill().await.unwrap();

    // 命令行参数和环境变量覆盖 agent.env。
    let _second = agent_command(&home)
        .args(["--name", "from-cli"])
        .env("SFLY_SLOTS", "5")
        .spawn()
        .unwrap();
    let hello = cp.hello(1).await;
    assert_eq!((hello.name.as_str(), hello.slots), ("from-cli", 5));
}

#[tokio::test]
async fn shared_venv_is_created_only_after_welcome() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    // 先占一个端口再释放：Agent 启动时控制面还不在这个端口上。
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut agent = agent_command(&home)
        .args(["--server", &format!("http://127.0.0.1:{port}")])
        .args(["--name", "agent-late", "--python", &python_interpreter()])
        .env("UV_CACHE_DIR", dir.path().join("uv-cache"))
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    // 控制面不可达：Agent 重试了两次连接，venv 仍未创建。
    let mut stderr = BufReader::new(agent.stderr.take().unwrap()).lines();
    let mut failures = 0;
    while failures < 2 {
        let line = tokio::time::timeout(WAIT, stderr.next_line())
            .await
            .expect("agent keeps retrying")
            .unwrap()
            .expect("agent is running");
        if line.contains("cannot connect") {
            failures += 1;
        }
    }
    assert!(!home.join("venv").exists(), "控制面不可达时不创建 venv");
    tokio::spawn(async move { while let Ok(Some(_)) = stderr.next_line().await {} });

    // 控制面上线：收到 Welcome 后创建 venv。
    let cp = FakeControlPlane::start_on(port).await;
    cp.hello(0).await;
    wait_exists(&home.join("venv/bin/python")).await;
}
