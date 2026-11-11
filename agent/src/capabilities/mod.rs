//! Agent 能力（ADR 0019）：Agent 自身提供、节点在执行中通过 SDK 调用的一组操作。
//!
//! 每项能力有名称和版本（新增操作或改变行为时加 1）：随 Hello 上报给控制面（控制面据此在 Agent 页显示），
//! 也由 `AgentPeer.Describe` 告诉连过来的其它 Agent（[`crate::peer`]）；调用另一台 Agent 之前据此判断它支不支持。
//!
//! 一项能力是一个 [`Module`]，各在自己的文件里：
//!
//! - 协议：`proto/sfly/agent/v1/<能力>.proto` 里的一个 gRPC 服务（`agent/build.rs` 编译这个目录下的全部 proto），
//!   在供其它 Agent 连接的端口上提供（[`Module::add_service`]）；
//! - 节点可调用的方法（[`Module::methods`]，例如 `files.list`）：SDK 经本地 socket 交给自己所在的 Agent，
//!   由 [`crate::calls`] 按方法名找到这里的实现，对自己所在的 Agent 直接调用服务的实现，对另一台 Agent 用 gRPC 客户端连过去。
//!
//! 加一项能力：新建 `capabilities/<能力>.rs` 导出一个 `MODULE`，在下面加 `pub mod` 和 [`MODULES`] 里的一项。

pub mod files;

use crate::calls::Method;
use crate::proto;

/// 一项 Agent 能力的名称和版本。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capability {
    /// 能力名，例如 `files`。
    pub name: &'static str,
    /// 能力的版本，从 1 开始。
    pub version: u32,
}

/// 能力的服务端需要的 Agent 信息。后续能力需要 Agent 运行时的其它东西时往这里加字段。
#[derive(Debug, Clone)]
pub struct Host {
    /// Agent 名称。
    pub name: String,
}

/// 一项能力的全部组成部分。
pub struct Module {
    pub capability: Capability,
    /// 节点可调用的方法；名称以能力名开头，例如 `files.list`。
    pub methods: &'static [Method],
    /// 把这项能力的 gRPC 服务加到供其它 Agent 连接的端口上（[`crate::peer::routes`]）。
    pub add_service: fn(&mut tonic::service::RoutesBuilder, &Host),
}

/// 这个版本的 Agent 提供的能力。
pub const MODULES: &[Module] = &[files::MODULE];

/// 上报用的能力列表（Hello.capabilities、DescribeResponse.capabilities）。
pub fn reported() -> Vec<proto::Capability> {
    MODULES
        .iter()
        .map(|m| proto::Capability {
            name: m.capability.name.to_string(),
            version: m.capability.version,
        })
        .collect()
}

/// 按方法名找节点可调用的方法，以及它属于哪项能力。
pub fn method(name: &str) -> Option<(Capability, &'static Method)> {
    MODULES.iter().find_map(|m| {
        m.methods
            .iter()
            .find(|method| method.name == name)
            .map(|method| (m.capability, method))
    })
}

/// 全部能力的 gRPC 服务。
pub fn add_services(routes: &mut tonic::service::RoutesBuilder, host: &Host) {
    for module in MODULES {
        (module.add_service)(routes, host);
    }
}
