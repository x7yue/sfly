//! 供其它 Agent 连接的端口（ADR 0019）：Agent 监听端口，在 Hello 里上报端口、显式配置的对外地址和能力；
//! 端口被占用时照常执行任务。

mod support;

use serde_json::json;
use sfly_agent::proto::agent_peer_client::AgentPeerClient;
use sfly_agent::proto::{DescribeRequest, TaskStatus};
use support::{
    AgentOptions, FakeControlPlane, SpawnAgent, agent_command, spawn_agent, stub_task, stub_venv,
};

/// 系统分配一个当前空闲的端口（马上释放，交给 Agent 去监听）。
fn free_port() -> u16 {
    std::net::TcpListener::bind("0.0.0.0:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

#[tokio::test]
async fn listens_on_the_configured_port_and_reports_it_with_the_capabilities() {
    let cp = FakeControlPlane::start().await;
    let port = free_port();
    let mut options = AgentOptions::new(&cp.url, "agent-peer");
    options.args = vec!["--listen-port".into(), port.to_string()];
    let _agent = spawn_agent(options);

    let hello = cp.hello(0).await;
    let peer = hello.peer.expect("Hello.peer");
    assert_eq!(peer.port, u32::from(port));
    assert_eq!(peer.listen_error, "");
    // 没有显式配置对外地址：由控制面取连接来源地址。
    assert_eq!(peer.public_address, "");

    // 另一台 Agent 连到这个端口，看到的是同一台 Agent、同一份能力。
    let mut client = AgentPeerClient::connect(format!("http://127.0.0.1:{port}"))
        .await
        .expect("connect to the peer port");
    let described = client
        .describe(DescribeRequest {})
        .await
        .expect("describe")
        .into_inner();
    assert_eq!(described.name, "agent-peer");
    assert_eq!(described.agent_version, hello.agent_version);
    assert_eq!(described.capabilities, hello.capabilities);
}

#[tokio::test]
async fn listens_on_port_50052_by_default() {
    let cp = FakeControlPlane::start().await;
    let work_dir = tempfile::tempdir().unwrap();
    // 测试默认让系统分配端口（support::agent_command），这里去掉它，看不配置时的端口。
    let _agent = agent_command(&work_dir.path().join("sfly-home"))
        .env_remove("SFLY_LISTEN_PORT")
        .args(["--server", &cp.url, "--name", "agent-default-port"])
        .arg("--venv")
        .arg(stub_venv())
        .arg("--work-dir")
        .arg(work_dir.path())
        .spawn_agent();

    // 本机的 50052 可能正被别的程序占用：不管监听成功与否，上报的都是这个端口。
    let peer = cp.hello(0).await.peer.expect("Hello.peer");
    assert_eq!(peer.port, 50052);
}

#[tokio::test]
async fn reports_the_configured_public_address() {
    let cp = FakeControlPlane::start().await;
    let mut options = AgentOptions::new(&cp.url, "agent-addressed");
    options.args = vec!["--public-address".into(), "10.20.30.40".into()];
    let _agent = spawn_agent(options);

    let peer = cp.hello(0).await.peer.expect("Hello.peer");
    assert_eq!(peer.public_address, "10.20.30.40");
}

#[tokio::test]
async fn refuses_to_start_with_a_public_address_that_has_a_scheme_or_port() {
    let home = tempfile::tempdir().unwrap();
    for bad in ["http://10.0.0.5", "10.0.0.5:50052", "two words"] {
        let output = agent_command(home.path())
            .args(["--name", "agent-bad", "--public-address", bad])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .await
            .unwrap();
        assert!(!output.status.success(), "{bad} should be rejected");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("对外地址只能是 IP 地址或主机名"),
            "{bad}: {stderr}"
        );
    }
}

#[tokio::test]
async fn still_runs_tasks_when_the_port_is_taken_and_reports_why_it_is_not_listening() {
    let cp = FakeControlPlane::start().await;
    let taken = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
    let port = taken.local_addr().unwrap().port();
    let mut options = AgentOptions::new(&cp.url, "agent-port-taken");
    options.args = vec!["--listen-port".into(), port.to_string()];
    let _agent = spawn_agent(options);

    let peer = cp.hello(0).await.peer.expect("Hello.peer");
    assert_eq!(peer.port, u32::from(port));
    assert_eq!(peer.listen_error, format!("端口 {port} 已被占用"));

    cp.assign(stub_task(
        "task-echo",
        "echo",
        json!({ "text": "照常执行" }),
    ))
    .await;
    let (result, _) = cp.result("task-echo").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    drop(taken);
}
