use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context as _;
use clap::{CommandFactory, Parser};
use sfly_agent::environment::{self, EnvironmentError};
use sfly_agent::home;
use sfly_agent::logs::DEFAULT_TELEMETRY_QUEUE_BYTES;
use sfly_agent::metrics::DEFAULT_METRIC_QUEUE_POINTS;
use sfly_agent::update::SelfUpdate;
use sfly_agent::{AGENT_VERSION, Config, DEFAULT_SLOTS, DEFAULT_TERMINATE_GRACE, run};

/// sfly Agent。
///
/// 标准输出每行一个 JSON 事件（例如每次连上控制面时的 `{"event":"welcome","name":"..."}`），
/// 日志写到标准错误。
///
/// 共享 venv、工作目录和 dev socket 默认都在 `SFLY_HOME`（默认 `~/.sfly`）下；
/// 启动时读取 `$SFLY_HOME/agent.env`（每行 `SFLY_*=值`），命令行参数和环境变量优先。
#[derive(Debug, Parser)]
#[command(version, args_override_self = true)]
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
    /// 共享 venv 路径（节点包和 SDK 运行时都装在这里，与 Agent 自身隔离）；默认 `$SFLY_HOME/venv`。
    #[arg(long, env = "SFLY_VENV")]
    venv: Option<PathBuf>,
    /// 任务工作目录的根目录（每个任务一个子目录）；默认 `$SFLY_HOME/work`。
    #[arg(long, env = "SFLY_WORK_DIR")]
    work_dir: Option<PathBuf>,
    /// 安装节点包依赖用的 PyPI 镜像地址；默认用控制面下发的 PyPI 镜像。
    #[arg(long, env = "SFLY_INDEX_URL")]
    index_url: Option<String>,
    /// uv 可执行文件（创建共享 venv、安装节点包用）；指定时 Agent 不管理 uv。
    /// 默认 `$SFLY_HOME/bin/uv`，不存在时从控制面下发的 GitHub Release 镜像安装。
    #[arg(long, env = "SFLY_UV")]
    uv: Option<PathBuf>,
    /// `sfly dev` 连接的本地 socket（Unix domain socket，只有本机同一用户可以连接）；默认 `<work_dir>/agent.sock`。
    #[arg(long, env = "SFLY_DEV_SOCKET")]
    dev_socket: Option<PathBuf>,
    /// 任务超时或被取消时，从优雅终止（SIGTERM）到强制杀掉进程树的宽限秒数。
    #[arg(long, env = "SFLY_TERMINATE_GRACE", default_value_t = DEFAULT_TERMINATE_GRACE.as_secs())]
    terminate_grace: u64,
    /// 共享 venv 不存在时用 `uv venv --python <PYTHON>` 创建（版本号或解释器路径）；默认 3.13，
    /// Python 从控制面下发的 GitHub Release 镜像下载。
    #[arg(long, env = "SFLY_PYTHON")]
    python: Option<String>,
    /// 与控制面断开期间最多排队的日志字节数，超出后丢弃新的日志。
    #[arg(long, env = "SFLY_LOG_QUEUE_BYTES", default_value_t = DEFAULT_TELEMETRY_QUEUE_BYTES, hide = true)]
    log_queue_bytes: usize,
    /// 与控制面断开期间最多排队的指标点数，超出后丢弃最早的点。
    #[arg(long, env = "SFLY_METRIC_QUEUE_POINTS", default_value_t = DEFAULT_METRIC_QUEUE_POINTS, hide = true)]
    metric_queue_points: usize,
    /// 不自动更新：版本与控制面不一致时只连接、不接新任务，Agents 页提示需要手动升级。
    #[arg(long, env = "SFLY_NO_AUTO_UPDATE")]
    no_auto_update: bool,
    /// 只在测试中使用：覆盖上报给控制面的 Agent 版本号，让同一个二进制扮演不同版本。
    /// 自更新 execve 新二进制时不传下去（命令行参数和环境变量都去掉），新进程上报真实版本。
    #[arg(long, env = "SFLY_VERSION_OVERRIDE", hide = true)]
    version_override: Option<String>,
}

/// 把 `agent.env` 里的配置转成命令行参数，放在真正的命令行参数之前（`args_override_self`：后出现的生效），
/// 环境变量里已经有的键跳过：优先级为命令行参数 > 环境变量 > `agent.env`。
fn env_file_args(entries: Vec<(String, String)>, file: &std::path::Path) -> Vec<OsString> {
    let command = Args::command();
    let mut args = Vec::new();
    for (key, value) in entries {
        if std::env::var_os(&key).is_some_and(|v| !v.is_empty()) {
            continue;
        }
        let Some(arg) = command
            .get_arguments()
            .find(|a| a.get_env() == Some(OsStr::new(&key)))
        else {
            if !home::CLI_ONLY_KEYS.contains(&key.as_str()) {
                eprintln!("ignored unknown key {key} in {}", file.display());
            }
            continue;
        };
        let long = arg.get_long().expect("env-backed args have a long flag");
        if arg.get_action().takes_values() {
            args.push(OsString::from(format!("--{long}={value}")));
        } else if matches!(value.as_str(), "1" | "true" | "yes" | "on") {
            args.push(OsString::from(format!("--{long}")));
        }
    }
    args
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let sfly_home = home::resolve();
    let mut argv = std::env::args_os();
    let program = argv.next();
    let from_file = match &sfly_home {
        Some(dir) => env_file_args(home::read_env_file(dir)?, &dir.join(home::ENV_FILE)),
        None => Vec::new(),
    };
    let args = Args::parse_from(program.into_iter().chain(from_file).chain(argv));
    let under_home = |name: &str| {
        sfly_home.as_ref().map(|dir| dir.join(name)).context(
            "cannot locate SFLY_HOME: set SFLY_HOME or HOME, or pass --venv, --work-dir and --uv",
        )
    };
    let venv = match args.venv {
        Some(venv) => venv,
        None => under_home("venv")?,
    };
    let work_dir = match args.work_dir {
        Some(work_dir) => work_dir,
        None => under_home("work")?,
    };
    let (uv, manage_uv) = match args.uv {
        Some(uv) => (uv, false),
        None => (under_home("bin/uv")?, true),
    };
    let config = Config {
        server: args.server,
        name: args.name,
        token: args.token,
        slots: args.slots,
        venv,
        work_dir,
        index_url: args.index_url,
        uv,
        manage_uv,
        dev_socket: args.dev_socket,
        terminate_grace: Duration::from_secs(args.terminate_grace),
        python: args.python,
        telemetry_queue_bytes: args.log_queue_bytes,
        metric_queue_points: args.metric_queue_points,
        version: args
            .version_override
            .unwrap_or_else(|| AGENT_VERSION.to_string()),
        self_update: SelfUpdate::detect(!args.no_auto_update, sfly_home.clone()),
    };

    let result = tokio::select! {
        result = run(config) => result,
        _ = tokio::signal::ctrl_c() => Ok(()),
    };
    // 环境准备失败：打印完整报告，以固定退出码退出（systemd 不再重启，ADR 0012）。
    if let Err(error) = &result
        && let Some(failure) = error.downcast_ref::<EnvironmentError>()
    {
        eprintln!("{failure}");
        std::process::exit(environment::EXIT_CODE);
    }
    result
}
