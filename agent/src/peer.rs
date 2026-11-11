//! 供其它 Agent 连接的端口（ADR 0019）：Agent 在这个端口上提供 gRPC 服务 `AgentPeer`（`proto/sfly/agent/v1/peer.proto`），
//! 别的 Agent 直接连过来调用它的能力（[`crate::capabilities`]），数据不经过控制面。没有认证，只应在内网使用。
//!
//! - [`serve`] 在所有网卡上监听（默认端口 [`DEFAULT_LISTEN_PORT`]），返回随 Hello 上报的 [`proto::PeerEndpoint`]。
//!   端口被占用等原因监听不了时不退出：Agent 照常执行任务，只是能力不能被其它 Agent 调用，原因随 Hello 上报。
//! - 对外地址：安装时显式配置的（[`parse_public_address`]）随 Hello 上报；没有配置时控制面用它看到的连接来源地址。
//! - [`routes`] 是这个端口上的全部 gRPC 服务：`AgentPeer` 加上每项能力的服务（[`capabilities::add_services`]）。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use tokio::net::TcpListener;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::{Request, Response, Status};

use crate::capabilities;
use crate::proto;
use crate::proto::agent_peer_server::{AgentPeer, AgentPeerServer};

/// 默认监听的端口：紧挨着控制面 Agent 网关的默认端口 50051。
pub const DEFAULT_LISTEN_PORT: u16 = 50052;

/// 这台 Agent 是谁（`AgentPeer.Describe` 的回答）。
#[derive(Debug, Clone)]
pub struct Identity {
    /// Agent 名称。
    pub name: String,
    /// 上报的 Agent 版本（[`crate::Config::version`]）。
    pub version: String,
}

/// 在 `port`（0 为系统分配）上监听并在后台提供 [`routes`]，返回随 Hello 上报的端口信息。
/// 监听不了时 `listen_error` 写明原因，`port` 是配置的端口。
pub async fn serve(
    port: u16,
    public_address: Option<String>,
    identity: Identity,
) -> proto::PeerEndpoint {
    let endpoint = |port: u16, listen_error: String| proto::PeerEndpoint {
        port: port.into(),
        public_address: public_address.clone().unwrap_or_default(),
        listen_error,
    };
    let listener = match bind(port).await {
        Ok(listener) => listener,
        Err(error) => {
            let reason = listen_error(port, &error);
            eprintln!("{reason}: other agents cannot call this agent's capabilities");
            return endpoint(port, reason);
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(error) => return endpoint(port, listen_error(port, &error)),
    };
    eprintln!("listening for other agents on port {port}");
    tokio::spawn(async move {
        let result = tonic::transport::Server::builder()
            .add_routes(routes(identity))
            .serve_with_incoming(TcpListenerStream::new(listener))
            .await;
        if let Err(error) = result {
            eprintln!("peer server on port {port} stopped: {error}");
        }
    });
    endpoint(port, String::new())
}

/// 这个端口上的全部 gRPC 服务。
pub fn routes(identity: Identity) -> tonic::service::Routes {
    let mut routes = tonic::service::Routes::builder();
    let host = capabilities::Host {
        name: identity.name.clone(),
    };
    routes.add_service(AgentPeerServer::new(Peer { identity }));
    capabilities::add_services(&mut routes, &host);
    routes.routes()
}

/// 在所有网卡上监听：先试 IPv6 的 `[::]`（Linux 上同时接受 IPv4），本机不支持 IPv6 时退回 `0.0.0.0`。
async fn bind(port: u16) -> std::io::Result<TcpListener> {
    match TcpListener::bind((Ipv6Addr::UNSPECIFIED, port)).await {
        Err(error) if error.kind() != std::io::ErrorKind::AddrInUse => {
            TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).await
        }
        result => result,
    }
}

/// 监听失败的原因（给人看的一句话，Agent 页显示）。
fn listen_error(port: u16, error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::AddrInUse => format!("端口 {port} 已被占用"),
        std::io::ErrorKind::PermissionDenied => format!("没有权限监听端口 {port}"),
        _ => format!("监听端口 {port} 失败：{error}"),
    }
}

/// 解析安装时配置的对外地址：IP 地址或主机名，不带协议和端口（端口用 `--listen-port`）。
pub fn parse_public_address(value: &str) -> Result<String, String> {
    let value = value.trim();
    let invalid = || format!("对外地址只能是 IP 地址或主机名（不带协议和端口）：{value}");
    if let Ok(ip) = value.parse::<IpAddr>() {
        return Ok(ip.to_string());
    }
    let label_ok = |label: &str| {
        !label.is_empty()
            && label.len() <= 63
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    };
    if value.is_empty() || value.len() > 253 || !value.split('.').all(label_ok) {
        return Err(invalid());
    }
    Ok(value.to_string())
}

/// `AgentPeer` 服务。
struct Peer {
    identity: Identity,
}

#[tonic::async_trait]
impl AgentPeer for Peer {
    async fn describe(
        &self,
        _request: Request<proto::DescribeRequest>,
    ) -> Result<Response<proto::DescribeResponse>, Status> {
        Ok(Response::new(proto::DescribeResponse {
            name: self.identity.name.clone(),
            agent_version: self.identity.version.clone(),
            capabilities: capabilities::reported(),
        }))
    }
}
