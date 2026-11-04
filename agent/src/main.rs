use clap::Parser;
use sfly_agent::{Config, connect};

/// sfly Agent。
///
/// 标准输出每行一个 JSON 事件（例如 `{"event":"welcome","name":"..."}`），日志写到标准错误。
#[derive(Debug, Parser)]
#[command(version)]
struct Args {
    /// 控制面 Agent 网关地址。
    #[arg(long, env = "SFLY_SERVER", default_value = "http://127.0.0.1:50051")]
    server: String,
    /// Agent 名称，全局唯一。
    #[arg(long, env = "SFLY_AGENT_NAME")]
    name: String,
    /// 共享注册令牌。
    #[arg(long, env = "SFLY_TOKEN")]
    token: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let config = Config {
        server: args.server,
        name: args.name,
        token: args.token,
    };

    let mut connection = connect(&config).await?;
    println!(
        "{}",
        serde_json::json!({ "event": "welcome", "name": config.name })
    );

    loop {
        tokio::select! {
            message = connection.inbound.message() => match message? {
                Some(message) => eprintln!("received: {message:?}"),
                None => {
                    eprintln!("control plane closed the stream");
                    return Ok(());
                }
            },
            _ = tokio::signal::ctrl_c() => return Ok(()),
        }
    }
}
