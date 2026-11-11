//! 调用的目标：自己所在的 Agent，或任务名单里的另一台 Agent（连接复用、确认对方支持所需的能力、把 gRPC 状态转成调用错误）。

use std::collections::HashMap;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio_stream::Stream;
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

/// 流式方法的回复：本机服务的实现和 gRPC 客户端给出的都装成这个类型（[`on_target!`]）。
pub type BoxStream<T> = Pin<Box<dyn Stream<Item = Result<T, Status>> + Send>>;

/// 在调用的目标上调用一个 gRPC 方法，取出回复：自己所在的 Agent 直接调用本机服务的实现 `$service`，
/// 另一台 Agent 用 gRPC 客户端 `$client` 连过去调用同名的方法。回复是流的方法前面加 `stream`，
/// 两边的流都装成 [`BoxStream`]。结果是 `Result<回复, Status>`，错误交给 [`Target::error`]（或 [`super::Call::rpc`]）。
///
/// ```ignore
/// let file = call.rpc(async { on_target!(call.target, Files, AgentFilesClient::stat(request)) }).await?;
/// ```
macro_rules! on_target {
    ($target:expr, $service:expr, $client:ident :: $method:ident($request:expr)) => {
        match $target {
            $crate::calls::Target::Local { .. } => $service
                .$method(::tonic::Request::new($request))
                .await
                .map(::tonic::Response::into_inner),
            $crate::calls::Target::Remote(remote) => $client::new(remote.channel())
                .$method(::tonic::Request::new($request))
                .await
                .map(::tonic::Response::into_inner),
        }
    };
    (stream $target:expr, $service:expr, $client:ident :: $method:ident($request:expr)) => {
        match $target {
            $crate::calls::Target::Local { .. } => $service
                .$method(::tonic::Request::new($request))
                .await
                .map(::tonic::Response::into_inner),
            $crate::calls::Target::Remote(remote) => $client::new(remote.channel())
                .$method(::tonic::Request::new($request))
                .await
                .map(|response| Box::pin(response.into_inner()) as $crate::calls::BoxStream<_>),
        }
    };
}
pub(crate) use on_target;

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

/// 另一台 Agent 的地址和端口：到它的连接和它的 Describe 结果按这个复用。
type PeerAddress = (String, u16);

impl Remote {
    /// 到它的 gRPC 连接（按需建立、断开后自动重连）。
    pub fn channel(&self) -> Channel {
        self.channel.clone()
    }

    fn address(&self) -> PeerAddress {
        (self.address.clone(), self.port)
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
    /// 两台 Agent 之间的连接出了问题（[`Target::interrupted`]）时是「连不通」，写明两端、地址和端口。
    pub fn error(&self, status: Status) -> CallError {
        if let Self::Remote(remote) = self
            && self.interrupted(&status)
        {
            return remote.unreachable(&describe_status(&status));
        }
        status_error(self.name(), &status)
    }

    /// 自己所在的 Agent 上出的错（例如下载、上传时本机这一侧的路径）：消息写明是自己。
    pub fn local_error(&self, status: Status) -> CallError {
        status_error(self.own(), &status)
    }

    /// 两台 Agent 之间的连接出了问题（连不上、调用中途连接断开、对方重启），而不是对方处理请求时回复的错误：
    /// 重连之后可能就好了（下载续传、监听重连据此判断）。对方回复的错误（例如读文件时的 I/O 错误）重连也一样，不算。
    ///
    /// 判断依据：对方回复的状态只有状态码和消息；传输层的错误由本机的 gRPC 客户端生成，带着底层的原因
    /// （`source`，状态码可能是 UNKNOWN、INTERNAL、CANCELLED 等），连接建立不了时是 UNAVAILABLE。
    /// 目标是自己时不经过网络，不会中断。
    pub fn interrupted(&self, status: &Status) -> bool {
        matches!(self, Self::Remote(_))
            && (status.code() == Code::Unavailable || std::error::Error::source(status).is_some())
    }
}

/// 对方回复的 gRPC 状态转成调用错误：状态码决定原因，消息前面写明是哪台 Agent。
fn status_error(agent: &str, status: &Status) -> CallError {
    let kind = match status.code() {
        Code::NotFound => ErrorKind::NotFound,
        Code::PermissionDenied => ErrorKind::PermissionDenied,
        Code::InvalidArgument | Code::FailedPrecondition | Code::OutOfRange => ErrorKind::Invalid,
        Code::DeadlineExceeded => ErrorKind::Timeout,
        Code::Unimplemented => ErrorKind::Unsupported,
        _ => ErrorKind::Failed,
    };
    let message = match kind {
        ErrorKind::Unsupported => format!(
            "Agent {agent} 不支持这个调用（{}）：升级这台 Agent",
            status.message()
        ),
        _ => format!("Agent {agent}：{}", status.message()),
    };
    CallError::new(kind, message)
}

/// 重连之前等多久：0.2 秒起每次加倍，最多 4 秒；有了进展（重新连上并收到回复）后从头算起。
#[derive(Debug, Clone)]
pub struct Backoff {
    next: Duration,
}

impl Backoff {
    const FIRST: Duration = Duration::from_millis(200);
    const MAX: Duration = Duration::from_secs(4);

    pub fn new() -> Self {
        Self { next: Self::FIRST }
    }

    /// 这一次等多久（下一次加倍）。
    pub fn wait(&mut self) -> Duration {
        let wait = self.next;
        self.next = (self.next * 2).min(Self::MAX);
        wait
    }

    pub fn reset(&mut self) {
        self.next = Self::FIRST;
    }
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new()
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
    channels: Mutex<HashMap<PeerAddress, Channel>>,
    described: Mutex<HashMap<PeerAddress, (Instant, DescribeResponse)>>,
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
        let key = remote.address();
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
            self.described.lock().unwrap().remove(&remote.address());
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

#[cfg(test)]
mod tests {
    use tonic::Status;

    use super::{Peers, Target, resolve};
    use crate::calls::ErrorKind;
    use crate::proto::ReferencedAgent;

    fn remote() -> Target {
        let peer = ReferencedAgent {
            name: "b".into(),
            address: "127.0.0.1".into(),
            port: 1,
            unavailable_reason: String::new(),
        };
        resolve("b", "a", &[peer], &Peers::default()).unwrap_or_else(|e| panic!("{e:?}"))
    }

    /// 传输层的错误：本机的 gRPC 客户端生成，带着底层的原因（这里是一个 I/O 错误）。
    fn transport(mut status: Status) -> Status {
        status.set_source(std::sync::Arc::new(std::io::Error::other(
            "connection reset",
        )));
        status
    }

    #[tokio::test]
    async fn only_connection_problems_between_two_agents_are_interruptions() {
        let target = remote();
        // 对方处理请求时回复的错误：重连也一样，不算中断。读文件时的 I/O 错误（EIO）就是 INTERNAL。
        for status in [
            Status::internal("访问 /var/log/app.log 失败：Input/output error"),
            Status::unknown("对方出错"),
            Status::not_found("/x 不存在"),
            Status::failed_precondition("已经不是原来的文件"),
            Status::cancelled("对方取消"),
        ] {
            assert!(!target.interrupted(&status), "{status:?}");
        }
        // 连接本身的问题：连不上，或调用中途连接断开（客户端生成的状态带着底层原因，状态码各种都有）。
        for status in [
            Status::unavailable("tcp connect error"),
            transport(Status::unknown("error reading a body from connection")),
            transport(Status::internal("h2 protocol error")),
            transport(Status::cancelled("operation was canceled")),
        ] {
            assert!(target.interrupted(&status), "{status:?}");
            assert_eq!(target.error(status).kind, ErrorKind::Unreachable);
        }
        assert_eq!(
            target.error(Status::internal("I/O 错误")).kind,
            ErrorKind::Failed
        );
    }

    #[test]
    fn calls_to_the_own_agent_are_never_interrupted() {
        let target = Target::Local { name: "a".into() };
        assert!(!target.interrupted(&Status::unavailable("x")));
        assert_eq!(
            target.error(Status::unavailable("x")).kind,
            ErrorKind::Failed
        );
    }
}
