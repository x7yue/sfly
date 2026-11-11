// 从仓库根目录 proto/ 生成 Rust 代码（prost 消息 + tonic 客户端/服务端）到 OUT_DIR。
// 服务端代码用于 Agent 之间的服务（AgentPeer 与各项 Agent 能力，src/peer.rs、src/capabilities/）和测试里的假控制面。
// 编译 proto/sfly/agent/v1/ 下的全部 .proto：新的能力加一个 proto 文件即可，不用改这里。
// 需要 protoc（或设置 PROTOC 环境变量）。
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto_root = std::path::PathBuf::from("../proto");
    let mut files: Vec<_> = std::fs::read_dir("../proto/sfly/agent/v1")?
        .map(|entry| entry.map(|e| e.path()))
        .collect::<Result<_, _>>()?;
    files.retain(|path| path.extension().is_some_and(|ext| ext == "proto"));
    files.sort();
    println!("cargo:rerun-if-changed={}", proto_root.display());
    tonic_prost_build::configure()
        .build_client(true)
        .build_server(true)
        .compile_protos(&files, &[proto_root])?;
    Ok(())
}
