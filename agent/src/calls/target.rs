//! 调用的目标：自己所在的 Agent，或任务名单里的另一台 Agent（连接复用、确认对方支持所需的能力、把 gRPC 状态转成调用错误）。

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tonic::transport::{Channel, Endpoint};
use tonic::{Code, Status};

use super::{CallError, ErrorKind};
use crate::capabilities::Capability;
use crate::proto::agent_peer_client::AgentPeerClient;
use crate::proto::{DescribeRequest, DescribeResponse, ReferencedAgent};

/// 建立到另一台 Agent 的连接最多等多久；连不上按「连不通」失败（调用的超时更短时先按超时失败）。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// 另一台 Agent 的 Describe 结果复用多久：它升级、换了能力后最迟这么久之后看到。
const DESCRIBE_TTL: Duration = Duration::from_secs(10);

/// 调用的目标。
pub enum Target {
    /// 自己所在的 Agent：直接调用本机服务的实现，不往外连。
    Local { name: String },
    /// 另一台 Agent。
    Remote(Remote),
}

/// 另一台 Agent：名称、地址、端口，以及到它的连接。
pub struct Remote {
    /// 发起调用的（自己所在的）Agent。
    pub from: String,
    pub name: String,
    pub address: String,
    pub port: u16,
    channel: Channel,
}

impl Remote {
    /// 到它的 gRPC 连接（按需建立、断开后自动重连）。
    pub fn channel(&self) -> Channel {
        self.channel.clone()
    }

    fn unreachable(&self, detail: &str) -> CallError {
        unreachable(&self.from, &self.name, &self.address, self.port, detail)
    }
}

/// 连不通：写明从哪台到哪台、地址和端口，便于直接去查防火墙。
fn unreachable(from: &str, to: &str, address: &str, port: u16, detail: &str) -> CallError {
    CallError::new(
        ErrorKind::Unreachable,
        format!("从 Agent {from} 连不上 Agent {to}（地址 {address}，端口 {port}）：{detail}"),
    )
}

impl Target {
    /// 目标 Agent 的名称。
    pub fn name(&self) -> &str {
        match self {
            Self::Local { name } => name,
            Self::Remote(remote) => &remote.name,
        }
    }

    /// 发起调用的（自己所在的）Agent 的名称。
    pub fn own(&self) -> &str {
        match self {
            Self::Local { name } => name,
            Self::Remote(remote) => &remote.from,
        }
    }

    /// 把服务（本机的实现或目标 Agent）返回的 gRPC 状态转成调用错误，消息前面写明是哪台 Agent。
    pub fn error(&self, status: Status) -> CallError {
        let kind = match status.code() {
            Code::NotFound => ErrorKind::NotFound,
            Code::PermissionDenied => ErrorKind::PermissionDenied,
            Code::InvalidArgument | Code::FailedPrecondition | Code::OutOfRange => {
                ErrorKind::Invalid
            }
            Code::DeadlineExceeded => ErrorKind::Timeout,
            Code::Unimplemented => ErrorKind::Unsupported,
            Code::Unavailable => {
                if let Self::Remote(remote) = self {
                    return remote.unreachable(&describe_status(&status));
                }
                ErrorKind::Failed
            }
            _ => ErrorKind::Failed,
        };
        let message = match kind {
            ErrorKind::Unsupported => format!(
                "Agent {} 不支持这个调用（{}）：升级这台 Agent",
                self.name(),
                status.message()
            ),
            _ => format!("Agent {}：{}", self.name(), status.message()),
        };
        CallError::new(kind, message)
    }
}

/// gRPC 状态和它的底层原因（连接失败时原因在 source 里）。
fn describe_status(status: &Status) -> String {
    let mut text = status.message().to_string();
    let mut source = std::error::Error::source(status);
    while let Some(error) = source {
        let part = error.to_string();
        if !text.contains(&part) {
            if !text.is_empty() {
                text.push('：');
            }
            text.push_str(&part);
        }
        source = error.source();
    }
    text
}

/// 按请求里的名称确定目标：空串或自己的名称是自己；否则必须在任务的名单里。
pub(super) fn resolve(
    agent: &str,
    own: &str,
    referenced: &[ReferencedAgent],
    peers: &Peers,
) -> Result<Target, CallError> {
    if agent.is_empty() || agent == own {
        return Ok(Target::Local {
            name: own.to_string(),
        });
    }
    let Some(peer) = referenced.iter().find(|r| r.name == agent) else {
        return Err(CallError::new(
            ErrorKind::NotReferenced,
            format!(
                "节点只能访问通过「Agent」类型的参数拿到的 Agent 和自己所在的 Agent（{own}），\
                 Agent {agent} 不是：把它声明成节点的 AgentName 类型参数，在场景里选它"
            ),
        ));
    };
    let port = u16::try_from(peer.port).unwrap_or(0);
    if !peer.unavailable_reason.is_empty() || port == 0 || peer.address.is_empty() {
        let reason = if peer.unavailable_reason.is_empty() {
            "控制面不知道它的地址和端口"
        } else {
            &peer.unavailable_reason
        };
        // 端口为 0：它不监听端口（版本过旧），能力不能被调用。
        let kind = if port == 0 {
            ErrorKind::Unsupported
        } else {
            ErrorKind::Unreachable
        };
        return Err(CallError::new(
            kind,
            format!("Agent {agent} 的能力不能被其它 Agent 调用：{reason}"),
        ));
    }
    let channel = peers
        .channel(&peer.address, port)
        .map_err(|detail| unreachable(own, agent, &peer.address, port, &detail))?;
    Ok(Target::Remote(Remote {
        from: own.to_string(),
        name: agent.to_string(),
        address: peer.address.clone(),
        port,
        channel,
    }))
}

/// 到其它 Agent 的连接（按地址和端口复用）和它们的 Describe 结果。
#[derive(Default)]
pub struct Peers {
    channels: Mutex<HashMap<(String, u16), Channel>>,
    described: Mutex<HashMap<(String, u16), (Instant, DescribeResponse)>>,
}

impl Peers {
    fn channel(&self, address: &str, port: u16) -> Result<Channel, String> {
        let key = (address.to_string(), port);
        if let Some(channel) = self.channels.lock().unwrap().get(&key) {
            return Ok(channel.clone());
        }
        let host = match address.parse::<IpAddr>() {
            Ok(IpAddr::V6(ip)) => format!("[{ip}]"),
            _ => address.to_string(),
        };
        let channel = Endpoint::from_shared(format!("http://{host}:{port}"))
            .map_err(|error| format!("地址无效：{error}"))?
            .connect_timeout(CONNECT_TIMEOUT)
            .tcp_nodelay(true)
            .connect_lazy();
        self.channels.lock().unwrap().insert(key, channel.clone());
        Ok(channel)
    }

    /// 确认连到的是要找的 Agent，并且它支持这项能力（版本不低于需要的）。
    pub(super) async fn require(
        &self,
        remote: &Remote,
        capability: Capability,
        timeout: Option<Duration>,
    ) -> Result<(), CallError> {
        let key = (remote.address.clone(), remote.port);
        let cached = self
            .described
            .lock()
            .unwrap()
            .get(&key)
            .filter(|(at, _)| at.elapsed() < DESCRIBE_TTL)
            .map(|(_, described)| described.clone());
        let described = match cached {
            Some(described) => described,
            None => {
                let mut client = AgentPeerClient::new(remote.channel());
                let call = client.describe(DescribeRequest {});
                let response = match timeout {
                    Some(limit) => tokio::time::timeout(limit, call).await.map_err(|_| {
                        CallError::new(
                            ErrorKind::Timeout,
                            format!(
                                "连接 Agent {}（地址 {}，端口 {}）超过 {} 秒没有回应",
                                remote.name,
                                remote.address,
                                remote.port,
                                super::format_seconds(limit)
                            ),
                        )
                    })?,
                    None => call.await,
                };
                let described = response
                    .map_err(|status| remote.unreachable(&describe_status(&status)))?
                    .into_inner();
                self.described
                    .lock()
                    .unwrap()
                    .insert(key, (Instant::now(), described.clone()));
                described
            }
        };
        if described.name != remote.name {
            self.described
                .lock()
                .unwrap()
                .remove(&(remote.address.clone(), remote.port));
            return Err(remote.unreachable(&format!(
                "这个地址上的是 Agent {}（它可能换了地址，重新运行一次）",
                described.name
            )));
        }
        let supported = described
            .capabilities
            .iter()
            .any(|c| c.name == capability.name && c.version >= capability.version);
        if !supported {
            return Err(CallError::new(
                ErrorKind::Unsupported,
                format!(
                    "Agent {}（版本 {}）不支持能力 {}（需要版本 {}）：升级这台 Agent",
                    remote.name, described.agent_version, capability.name, capability.version
                ),
            ));
        }
        Ok(())
    }
}
