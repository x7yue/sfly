// 从仓库根目录 proto/ 生成 Rust 代码（prost 消息 + tonic 客户端/服务端）到 OUT_DIR。
// 服务端代码用于 Agent 之间的服务 AgentPeer（src/peer.rs）和测试里的假控制面。需要 protoc（或设置 PROTOC 环境变量）。
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto_root = "../proto";
    let files = [
        "../proto/sfly/agent/v1/agent.proto",
        "../proto/sfly/agent/v1/peer.proto",
    ];
    println!("cargo:rerun-if-changed={proto_root}");
    tonic_prost_build::configure()
        .build_client(true)
        .build_server(true)
        .compile_protos(&files, &[proto_root])?;
    Ok(())
}
