//! Agent 能力（ADR 0019）：Agent 自身提供、节点在执行中通过 SDK 调用的一组操作。
//!
//! 每项能力有名称和版本（新增操作或改变行为时加 1）：随 Hello 上报给控制面（控制面据此做预检、在 Agent 页显示），
//! 也由 `AgentPeer.Describe` 告诉连过来的其它 Agent（[`crate::peer`]）。
//!
//! 加一项能力：在 [`CAPABILITIES`] 里登记名称和版本，在 [`crate::peer::routes`] 里加上它的 gRPC 服务。

use crate::proto;

/// 一项 Agent 能力。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capability {
    /// 能力名，例如 `files`。
    pub name: &'static str,
    /// 能力的版本，从 1 开始。
    pub version: u32,
}

/// 这个版本的 Agent 提供的能力。现在还没有：先建好端口、地址和能力的上报（#196），文件能力随后加入。
pub const CAPABILITIES: &[Capability] = &[];

/// 上报用的能力列表（Hello.capabilities、DescribeResponse.capabilities）。
pub fn reported() -> Vec<proto::Capability> {
    CAPABILITIES
        .iter()
        .map(|c| proto::Capability {
            name: c.name.to_string(),
            version: c.version,
        })
        .collect()
}
