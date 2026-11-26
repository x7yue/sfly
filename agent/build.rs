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
    // TaskResult 作为 Err 在函数间传递（`Result<_, TaskResult>`）：加上出错位置之后它超过了 clippy 的
    // `result_large_err` 门槛（128 字节），所以把 error 放进 Box，TaskResult 回到几十字节。
    let mut config = tonic_prost_build::Config::new();
    config.boxed("TaskResult.error");
    // 带凭据的消息（任务凭据、Agent 凭据）不用 prost 生成的 `Debug`（它会把凭据原样打出来）：src/proto_debug.rs 手写，
    // 凭据的位置写 `<redacted>`。Welcome 里的镜像地址可以带用户名和密码（#733）：同样手写，地址里写掩码。
    config.skip_debug([
        ".sfly.agent.v1.AssignTask",
        ".sfly.agent.v1.Hello",
        ".sfly.agent.v1.Welcome",
    ]);
    tonic_prost_build::configure()
        .build_client(true)
        .build_server(true)
        .compile_with_config(config, &files, &[proto_root])?;
    Ok(())
}
