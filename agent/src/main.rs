use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context as _;
use clap::{CommandFactory, Parser};
use sfly_agent::environment::{self, EnvironmentError};
use sfly_agent::home;
use sfly_agent::logs::DEFAULT_TELEMETRY_QUEUE_BYTES;
use sfly_agent::metrics::DEFAULT_METRIC_QUEUE_POINTS;
use sfly_agent::retention;
use sfly_agent::update::{self, SelfUpdate, Trial, TrialFailed};
use sfly_agent::{AGENT_VERSION, Config, DEFAULT_SLOTS, DEFAULT_TERMINATE_GRACE, run};

/// sfly Agent。
///
/// 标准输出每行一个 JSON 事件（例如每次连上控制面时的 `{"event":"welcome","name":"..."}`），
/// 日志写到标准错误。
///
/// 共享 venv、工作目录和 dev socket 默认都在 `SFLY_HOME`（默认 `~/.sfly`）下；
/// 启动时读取 `$SFLY_HOME/agent.env`（每行 `SFLY_*=值`），命令行参数和环境变量优先。
///
/// 镜像：默认用控制面下发的 PyPI 镜像和 GitHub Release 镜像；`--index-url`、`--github-release-mirror`、
/// `--python-install-mirror` 在本机覆盖它们。优先级：命令行参数 > 环境变量 > `agent.env` > 控制面下发；
/// Python 下载镜像没有覆盖时从（覆盖后的）GitHub Release 镜像推导。
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
    /// 后台进程目录的根目录（每次运行一个子目录，节点启动的后台进程的日志放在这里，和任务目录按同一个保留期清理）；
    /// 默认 `$SFLY_HOME/procs`。
    #[arg(long, env = "SFLY_PROCS_DIR")]
    procs_dir: Option<PathBuf>,
    /// 任务目录在结果被控制面确认后保留多久，例如 `30m`、`24h`、`7d`；`0` 表示立即删除。
    /// Agent 启动时和之后每小时删除超过保留期的任务目录（上次运行留下的按目录的修改时间算）。
    #[arg(long, env = "SFLY_TASK_DIR_RETENTION", default_value = "7d", value_parser = retention::parse_retention)]
    task_dir_retention: Duration,
    /// 两次扫描工作目录的间隔秒数。
    #[arg(long, env = "SFLY_TASK_DIR_SWEEP_INTERVAL", default_value_t = retention::SWEEP_INTERVAL.as_secs(), hide = true)]
    task_dir_sweep_interval: u64,
    /// PyPI 镜像地址（简单索引），覆盖控制面下发的 PyPI 镜像：Agent 所有访问 PyPI 的 uv 调用
    /// （安装节点包依赖）都用它。
    #[arg(long, env = "SFLY_INDEX_URL")]
    index_url: Option<String>,
    /// GitHub Release 镜像地址（例如 https://mirrors.ustc.edu.cn/github-release），覆盖控制面下发的：
    /// 安装和更新 uv 用它；没有 `--python-install-mirror` 时 Python 也从它下载。
    #[arg(long, env = "SFLY_GITHUB_RELEASE_MIRROR")]
    github_release_mirror: Option<String>,
    /// Python 下载镜像（直接作为 `UV_PYTHON_INSTALL_MIRROR`，
    /// 例如 https://mirror.nju.edu.cn/github-release/astral-sh/python-build-standalone/），
    /// 优先于从 GitHub Release 镜像推导的地址。
    #[arg(long, env = "SFLY_PYTHON_INSTALL_MIRROR")]
    python_install_mirror: Option<String>,
    /// uv 可执行文件（创建共享 venv、安装节点包用）；指定时 Agent 不管理 uv。
    /// 默认 `$SFLY_HOME/bin/uv`，不存在时从 GitHub Release 镜像安装（见 `--github-release-mirror`）。
    #[arg(long, env = "SFLY_UV")]
    uv: Option<PathBuf>,
    /// `sfly dev` 连接的本地 socket（Unix domain socket，只有本机同一用户可以连接）；默认 `<work_dir>/agent.sock`。
    #[arg(long, env = "SFLY_DEV_SOCKET")]
    dev_socket: Option<PathBuf>,
    /// 任务超时或被取消时，从优雅终止（SIGTERM）到强制杀掉进程树的宽限秒数。
    #[arg(long, env = "SFLY_TERMINATE_GRACE", default_value_t = DEFAULT_TERMINATE_GRACE.as_secs())]
    terminate_grace: u64,
    /// 共享 venv 不存在时用 `uv venv --python <PYTHON>` 创建（版本号或解释器路径）；默认 3.13，
    /// Python 从 Python 下载镜像下载（见 `--python-install-mirror`）。
    #[arg(long, env = "SFLY_PYTHON")]
    python: Option<String>,
    /// 与控制面断开期间最多排队的日志字节数，超出后丢弃新的日志。
    #[arg(long, env = "SFLY_LOG_QUEUE_BYTES", default_value_t = DEFAULT_TELEMETRY_QUEUE_BYTES, hide = true)]
    log_queue_bytes: usize,
    /// 与控制面断开期间最多排队的指标点数，超出后丢弃最早的点。
    #[arg(long, env = "SFLY_METRIC_QUEUE_POINTS", default_value_t = DEFAULT_METRIC_QUEUE_POINTS, hide = true)]
    metric_queue_points: usize,
    /// 只在测试中使用：转发器每秒最多处理这么多字节的标准输出 / 标准错误（0 = 不限制），模拟转发跟不上节点的输出。
    #[arg(long, env = "SFLY_LOG_FORWARD_RATE", default_value_t = 0, hide = true)]
    log_forward_rate: u64,
    /// 自更新下载新二进制时，连接建立后等待数据的超时秒数（每次读取）；超时算「更新失败」，下一次握手后重试。
    #[arg(long, env = "SFLY_UPDATE_READ_TIMEOUT", default_value_t = sfly_agent::update::DEFAULT_READ_TIMEOUT.as_secs(), hide = true)]
    update_read_timeout: u64,
    /// 不自动更新：版本与控制面不一致时只连接、不接新任务，Agents 页提示需要手动升级。
    /// 环境变量和 `agent.env` 接受 1/0、true/false、yes/no（大小写不敏感）。
    #[arg(long, env = "SFLY_NO_AUTO_UPDATE", value_parser = clap::builder::BoolishValueParser::new())]
    no_auto_update: bool,
    /// 只在测试中使用：覆盖上报给控制面的 Agent 版本号，让同一个二进制扮演不同版本。只影响上报的版本
    /// （新版本的试用按二进制的 sha256 判断）；execve（自更新或回滚）时不传下去（命令行参数和环境变量都去掉）。
    #[arg(long, env = "SFLY_VERSION_OVERRIDE", hide = true)]
    version_override: Option<String>,
}

/// 把 `agent.env` 里的配置转成命令行参数，放在真正的命令行参数之前（`args_override_self`：后出现的生效），
/// 环境变量里已经有的键跳过：优先级为命令行参数 > 环境变量 > `agent.env`。
/// 不带值的开关（如 `--no-auto-update`）在 `agent.env` 里的值与环境变量的写法相同：1/0、true/false、yes/no
/// （以及 y/n、t/f、on/off，大小写不敏感）；为真时注入这个开关，其他值报错。
fn env_file_args(
    entries: Vec<(String, String)>,
    file: &std::path::Path,
) -> anyhow::Result<Vec<OsString>> {
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
        } else {
            match home::boolish(&value) {
                Some(true) => args.push(OsString::from(format!("--{long}"))),
                Some(false) => {}
                None => anyhow::bail!(
                    "invalid value '{value}' for {key} in {}: use 1/0, true/false or yes/no",
                    file.display()
                ),
            }
        }
    }
    Ok(args)
}

/// 只看版本或帮助的调用（安装脚本、自更新的试运行、用户手动查看）：不是一次启动，不参与新版本的试用。
fn info_only() -> bool {
    std::env::args_os()
        .skip(1)
        .any(|a| matches!(a.to_str(), Some("--version" | "-V" | "--help" | "-h")))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 刚自更新上来的新版本：在读取配置、解析参数等任何可能失败的步骤之前计一次尝试，连续失败时回滚（ADR 0014）。
    let exe = update::current_exe();
    let trial = if info_only() {
        Trial::off()
    } else {
        Trial::start(exe.clone())
    };
    let sfly_home = home::resolve();
    let mut argv = std::env::args_os();
    let program = argv.next();
    let from_file = match &sfly_home {
        Some(dir) => env_file_args(home::read_env_file(dir)?, &dir.join(home::ENV_FILE))?,
        None => Vec::new(),
    };
    let args = Args::parse_from(program.into_iter().chain(from_file).chain(argv));
    let under_home = |name: &str| {
        sfly_home.as_ref().map(|dir| dir.join(name)).context(
            "cannot locate SFLY_HOME: set SFLY_HOME or HOME, or pass --venv, --work-dir, --procs-dir and --uv",
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
    let procs_dir = match args.procs_dir {
        Some(procs_dir) => procs_dir,
        None => under_home("procs")?,
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
        procs_dir,
        task_dir_retention: args.task_dir_retention,
        task_dir_sweep_interval: Duration::from_secs(args.task_dir_sweep_interval.max(1)),
        mirrors: environment::LocalMirrors {
            pypi: args.index_url,
            github_release: args.github_release_mirror,
            python_install: args.python_install_mirror,
        },
        uv,
        manage_uv,
        dev_socket: args.dev_socket,
        terminate_grace: Duration::from_secs(args.terminate_grace),
        python: args.python,
        telemetry_queue_bytes: args.log_queue_bytes,
        metric_queue_points: args.metric_queue_points,
        log_forward_rate: args.log_forward_rate,
        update_read_timeout: Duration::from_secs(args.update_read_timeout),
        version: args
            .version_override
            .unwrap_or_else(|| AGENT_VERSION.to_string()),
        self_update: SelfUpdate {
            enabled: !args.no_auto_update,
            exe,
            home: sfly_home.clone(),
        },
        trial: std::sync::Arc::new(trial),
    };

    let result = tokio::select! {
        result = run(config) => result,
        _ = tokio::signal::ctrl_c() => Ok(()),
    };
    if let Err(error) = &result {
        // 试用中的新版本环境准备失败：systemd 会重启它，连续失败后回滚（ADR 0014）。
        if let Some(failure) = error.downcast_ref::<TrialFailed>() {
            eprintln!("{failure}");
            std::process::exit(update::trial::TRIAL_FAILURE_EXIT_CODE);
        }
        // 环境准备失败：打印完整报告，以固定退出码退出（systemd 不再重启，ADR 0012）。
        if let Some(failure) = error.downcast_ref::<EnvironmentError>() {
            eprintln!("{failure}");
            std::process::exit(environment::EXIT_CODE);
        }
    }
    result
}
