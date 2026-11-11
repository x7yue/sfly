//! 节点调用 Agent 能力的通道（ADR 0019，`sfly_agent::calls`）：SDK → 自己所在的 Agent → 目标 Agent。
//! 只能访问任务名单（referenced_agents）里的 Agent 和自己；错误区分连不通、对方不支持、超时；
//! 任务被取消时调用立即结束。具体能力的行为见 files.rs。
#![cfg(unix)]

mod support;

use std::time::Duration;

use serde_json::json;
use sfly_agent::proto::agent_peer_server::{AgentPeer, AgentPeerServer};
use sfly_agent::proto::{
    CancelTask, DescribeRequest, DescribeResponse, ReferencedAgent, TaskStatus, server_message,
};
use support::calls::{
    AgentPair, call, hold_task, open_call, read_reply, referenced, request, socket_of,
};
use support::{AgentOptions, FakeControlPlane, spawn_agent};
use tokio::net::TcpListener;
use tokio_stream::wrappers::TcpListenerStream;

fn stat_of(task: &str, agent: &str) -> serde_json::Value {
    request(task, agent, "files.stat", json!({ "path": "/" }))
}

#[tokio::test]
async fn only_agents_referenced_by_the_task_and_the_own_agent_can_be_called() {
    let pair = AgentPair::start("runner-list-only", "source-list-only").await;
    // 第二个任务没有引用 source：同一台 Agent、同一个 socket，只是名单不同。
    hold_task(
        &pair.runner_cp,
        "task-with",
        vec![pair.source_ref("source-list-only")],
    )
    .await;
    hold_task(&pair.runner_cp, "task-without", Vec::new()).await;

    let allowed = call(&pair.socket(), stat_of("task-with", "source-list-only")).await;
    assert_eq!(allowed.result()["path"], "/");

    let refused = call(&pair.socket(), stat_of("task-without", "source-list-only")).await;
    let (kind, message) = refused.error();
    assert_eq!(kind, "not_referenced");
    assert_eq!(refused.end["error"]["agent"], "source-list-only");
    assert!(
        message.contains("Agent source-list-only 不是")
            && message.contains("通过「Agent」类型的参数拿到的 Agent"),
        "{message}"
    );
    // 自己所在的 Agent 总能调用。
    let own = call(&pair.socket(), stat_of("task-without", "")).await;
    assert_eq!(own.result()["path"], "/");
}

#[tokio::test]
async fn calls_from_a_task_that_is_not_running_on_the_agent_are_rejected() {
    let pair = AgentPair::start("runner-stranger", "source-stranger").await;
    let (kind, message) = call(&pair.socket(), stat_of("no-such-task", ""))
        .await
        .error();
    assert_eq!(kind, "invalid");
    assert_eq!(
        message,
        "任务 no-such-task 的第 1 次尝试不在 Agent runner-stranger 上执行"
    );
}

#[tokio::test]
async fn an_unreachable_agent_is_reported_with_both_agents_the_address_and_the_port() {
    let cp = FakeControlPlane::start().await;
    let runner = spawn_agent(AgentOptions::new(&cp.url, "runner-unreachable"));
    cp.hello(0).await;
    // 一个刚刚释放、没人监听的端口。
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    hold_task(
        &cp,
        "task-unreachable",
        vec![referenced("gone", "127.0.0.1", port)],
    )
    .await;

    let (kind, message) = call(&socket_of(&runner), stat_of("task-unreachable", "gone"))
        .await
        .error();
    assert_eq!(kind, "unreachable");
    assert!(
        message.starts_with(&format!(
            "从 Agent runner-unreachable 连不上 Agent gone（地址 127.0.0.1，端口 {port}）："
        )),
        "{message}"
    );
}

#[tokio::test]
async fn agents_whose_capabilities_cannot_be_called_fail_before_connecting() {
    let cp = FakeControlPlane::start().await;
    let runner = spawn_agent(AgentOptions::new(&cp.url, "runner-unavailable"));
    cp.hello(0).await;
    let old = ReferencedAgent {
        name: "old".into(),
        address: "10.0.0.9".into(),
        port: 0,
        unavailable_reason: "Agent 版本过旧，不监听供其它 Agent 连接的端口".into(),
    };
    let taken = ReferencedAgent {
        name: "taken".into(),
        address: "10.0.0.8".into(),
        port: 50052,
        unavailable_reason: "端口 50052 已被占用".into(),
    };
    hold_task(&cp, "task-unavailable", vec![old, taken]).await;
    let socket = socket_of(&runner);

    let (kind, message) = call(&socket, stat_of("task-unavailable", "old"))
        .await
        .error();
    assert_eq!(kind, "unsupported");
    assert_eq!(
        message,
        "Agent old 的能力不能被其它 Agent 调用：Agent 版本过旧，不监听供其它 Agent 连接的端口"
    );
    let (kind, message) = call(&socket, stat_of("task-unavailable", "taken"))
        .await
        .error();
    assert_eq!(kind, "unreachable");
    assert_eq!(
        message,
        "Agent taken 的能力不能被其它 Agent 调用：端口 50052 已被占用"
    );
}

/// 只提供 Describe 的「另一台 Agent」：能力列表由测试给出。
struct DescribeOnly {
    name: String,
    capabilities: Vec<sfly_agent::proto::Capability>,
}

#[tonic::async_trait]
impl AgentPeer for DescribeOnly {
    async fn describe(
        &self,
        _request: tonic::Request<DescribeRequest>,
    ) -> Result<tonic::Response<DescribeResponse>, tonic::Status> {
        Ok(tonic::Response::new(DescribeResponse {
            name: self.name.clone(),
            agent_version: "0.1.9".into(),
            capabilities: self.capabilities.clone(),
        }))
    }
}

async fn serve_describe_only(name: &str) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let service = DescribeOnly {
        name: name.into(),
        capabilities: Vec::new(),
    };
    tokio::spawn(
        tonic::transport::Server::builder()
            .add_service(AgentPeerServer::new(service))
            .serve_with_incoming(TcpListenerStream::new(listener)),
    );
    port
}

#[tokio::test]
async fn an_agent_without_the_capability_or_the_method_is_unsupported() {
    let cp = FakeControlPlane::start().await;
    let runner = spawn_agent(AgentOptions::new(&cp.url, "runner-unsupported"));
    cp.hello(0).await;
    let older = serve_describe_only("older").await;
    let stranger = serve_describe_only("someone-else").await;
    hold_task(
        &cp,
        "task-unsupported",
        vec![
            referenced("older", "127.0.0.1", older),
            referenced("moved", "127.0.0.1", stranger),
        ],
    )
    .await;
    let socket = socket_of(&runner);

    let (kind, message) = call(&socket, stat_of("task-unsupported", "older"))
        .await
        .error();
    assert_eq!(kind, "unsupported");
    assert_eq!(
        message,
        "Agent older（版本 0.1.9）不支持能力 files（需要版本 1）：升级这台 Agent"
    );

    // 地址上的是另一台 Agent（换了地址）：按连不通处理。
    let (kind, message) = call(&socket, stat_of("task-unsupported", "moved"))
        .await
        .error();
    assert_eq!(kind, "unreachable");
    assert!(
        message.contains("这个地址上的是 Agent someone-else"),
        "{message}"
    );

    let (kind, message) = call(
        &socket,
        request("task-unsupported", "", "files.teleport", json!({})),
    )
    .await
    .error();
    assert_eq!(kind, "unsupported");
    assert_eq!(
        message,
        "Agent runner-unsupported 不支持 files.teleport：这台 Agent 的版本没有这个方法"
    );
}

/// 接受连接但从不回应的「另一台 Agent」。
async fn silent_peer() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((stream, _)) = listener.accept().await {
            held.push(stream);
        }
    });
    (port, handle)
}

#[tokio::test]
async fn a_call_times_out_when_the_other_agent_does_not_answer() {
    let cp = FakeControlPlane::start().await;
    let runner = spawn_agent(AgentOptions::new(&cp.url, "runner-timeout"));
    cp.hello(0).await;
    let (port, _peer) = silent_peer().await;
    hold_task(
        &cp,
        "task-timeout",
        vec![referenced("silent", "127.0.0.1", port)],
    )
    .await;

    let mut ask = stat_of("task-timeout", "silent");
    ask["timeout_ms"] = json!(300);
    let (kind, message) = call(&socket_of(&runner), ask).await.error();
    assert_eq!(kind, "timeout");
    assert!(message.contains("没有回应"), "{message}");
}

#[tokio::test]
async fn cancelling_the_task_ends_its_calls_at_once() {
    let cp = FakeControlPlane::start().await;
    let runner = spawn_agent(AgentOptions::new(&cp.url, "runner-cancel"));
    cp.hello(0).await;
    let (port, _peer) = silent_peer().await;
    hold_task(
        &cp,
        "task-cancel",
        vec![referenced("silent", "127.0.0.1", port)],
    )
    .await;

    // 不限超时：只有取消能结束它。
    let mut ask = stat_of("task-cancel", "silent");
    ask["timeout_ms"] = json!(0);
    let mut open = open_call(&socket_of(&runner), &ask).await;
    let reply = tokio::spawn(async move { read_reply(&mut open).await });
    cp.send(server_message::Body::Cancel(CancelTask {
        task_id: "task-cancel".into(),
        attempt: 1,
        force: false,
    }))
    .await;

    let reply = tokio::time::timeout(Duration::from_secs(10), reply)
        .await
        .expect("the call did not end when the task was cancelled")
        .unwrap();
    assert_eq!(reply.error().0, "cancelled");
    let (result, _) = cp.result("task-cancel").await;
    assert_eq!(result.status(), TaskStatus::Cancelled);
}
