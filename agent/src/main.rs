use std::path::PathBuf;
use std::time::Duration;

use clap::Parser;
use sfly_agent::logs::DEFAULT_TELEMETRY_QUEUE_BYTES;
use sfly_agent::{Config, DEFAULT_SLOTS, DEFAULT_TERMINATE_GRACE, run};

/// sfly Agent。
///
/// 标准输出每行一个 JSON 事件（例如每次连上控制面时的 `{"event":"welcome","name":"..."}`），
/// 日志写到标准错误。
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
    /// 并发槽位数：同时执行的任务上限。
    #[arg(long, env = "SFLY_SLOTS", default_value_t = DEFAULT_SLOTS, value_parser = clap::value_parser!(u32).range(1..))]
    slots: u32,
    /// 共享 venv 路径（节点包和 SDK 运行时都装在这里，与 Agent 自身隔离）。
    #[arg(long, env = "SFLY_VENV", default_value = "venv")]
    venv: PathBuf,
    /// 任务工作目录的根目录（每个任务一个子目录）。
    #[arg(long, env = "SFLY_WORK_DIR", default_value = "work")]
    work_dir: PathBuf,
    /// 安装节点包依赖用的 PyPI 镜像地址。
    #[arg(long, env = "SFLY_INDEX_URL")]
    index_url: Option<String>,
    /// uv 可执行文件（安装节点包用）。
    #[arg(long, env = "SFLY_UV", default_value = "uv")]
    uv: PathBuf,
    /// `sfly dev` 连接的本地 socket（Unix domain socket，只有本机同一用户可以连接）；默认 `<work_dir>/agent.sock`。
    #[arg(long, env = "SFLY_DEV_SOCKET")]
    dev_socket: Option<PathBuf>,
    /// 任务超时或被取消时，从优雅终止（SIGTERM）到强制杀掉进程树的宽限秒数。
    #[arg(long, env = "SFLY_TERMINATE_GRACE", default_value_t = DEFAULT_TERMINATE_GRACE.as_secs())]
    terminate_grace: u64,
    /// 共享 venv 不存在时用 `uv venv --python <PYTHON>` 创建（版本号如 3.13，或解释器路径）；默认由 uv 选择。
    #[arg(long, env = "SFLY_PYTHON")]
    python: Option<String>,
    /// 与控制面断开期间最多排队的日志字节数，超出后丢弃新的日志。
    #[arg(long, env = "SFLY_LOG_QUEUE_BYTES", default_value_t = DEFAULT_TELEMETRY_QUEUE_BYTES, hide = true)]
    log_queue_bytes: usize,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    let config = Config {
        server: args.server,
        name: args.name,
        token: args.token,
        slots: args.slots,
        venv: args.venv,
        work_dir: args.work_dir,
        index_url: args.index_url,
        uv: args.uv,
        dev_socket: args.dev_socket,
        terminate_grace: Duration::from_secs(args.terminate_grace),
        python: args.python,
        telemetry_queue_bytes: args.log_queue_bytes,
    };

    tokio::select! {
        result = run(config) => result,
        _ = tokio::signal::ctrl_c() => Ok(()),
    }
}
