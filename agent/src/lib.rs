//! sfly Agent：主动连接控制面的 Agent 网关（gRPC 双向流），接收并执行任务。
//!
//! 当前只有骨架：建立连接并完成 Hello → Welcome 握手。

use anyhow::{Context as _, bail};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::Streaming;

/// 由 `proto/sfly/agent/v1/agent.proto` 生成（见 build.rs）。
pub mod proto {
    tonic::include_proto!("sfly.agent.v1");
}

use proto::agent_gateway_client::AgentGatewayClient;
use proto::{AgentMessage, Hello, ServerMessage, Welcome, agent_message, server_message};

/// Agent 程序版本（随 Hello 上报）。
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Agent 配置。
#[derive(Debug, Clone)]
pub struct Config {
    /// 控制面 Agent 网关地址，例如 `http://127.0.0.1:50051`。
    pub server: String,
    /// Agent 名称，全局唯一。
    pub name: String,
    /// 可选的共享注册令牌。
    pub token: Option<String>,
}

/// 已完成握手的连接。
pub struct Connection {
    pub welcome: Welcome,
    /// 发往控制面的消息。
    pub outbound: mpsc::Sender<AgentMessage>,
    /// 控制面推送的消息。
    pub inbound: Streaming<ServerMessage>,
}

/// 连接控制面，发送 Hello 并等待 Welcome。
pub async fn connect(config: &Config) -> anyhow::Result<Connection> {
    let mut client = AgentGatewayClient::connect(config.server.clone())
        .await
        .with_context(|| format!("connect to control plane at {}", config.server))?;

    let (outbound, rx) = mpsc::channel(64);
    outbound
        .send(AgentMessage {
            body: Some(agent_message::Body::Hello(Hello {
                name: config.name.clone(),
                token: config.token.clone().unwrap_or_default(),
                agent_version: AGENT_VERSION.to_string(),
                os: std::env::consts::OS.to_string(),
                arch: std::env::consts::ARCH.to_string(),
                ..Default::default()
            })),
        })
        .await
        .context("queue hello")?;

    let mut inbound = client
        .session(ReceiverStream::new(rx))
        .await
        .context("open agent stream")?
        .into_inner();

    match inbound.message().await.context("wait for welcome")? {
        Some(ServerMessage {
            body: Some(server_message::Body::Welcome(welcome)),
        }) => Ok(Connection {
            welcome,
            outbound,
            inbound,
        }),
        Some(other) => bail!("expected Welcome, got {other:?}"),
        None => bail!("control plane closed the stream before Welcome"),
    }
}
