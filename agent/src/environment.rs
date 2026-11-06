//! 运行环境的准备（ADR 0012）：收到控制面的 Welcome 之后，按下发的镜像准备 uv 和共享 venv。
//!
//! - uv：指定了 `--uv` 时不管理它，只检查它能运行；否则使用 `SFLY_HOME/bin/uv`，不存在时下载 GitHub Release 镜像上
//!   `astral-sh/uv/LatestRelease/uv-installer.sh` 并运行（`UV_DOWNLOAD_URL` 指向镜像上的同一目录，
//!   `UV_INSTALL_DIR` 为 `SFLY_HOME/bin`，`UV_NO_MODIFY_PATH=1`）。没有配置镜像时用 uv 官方的安装脚本。
//!   安装脚本本身需要 curl 或 wget，Agent 也用它们下载安装脚本（Agent 的 HTTP 客户端不带 TLS）。
//! - 共享 venv：不存在时用 `uv venv --python 3.13` 创建（`--python` 可以覆盖），
//!   `UV_PYTHON_INSTALL_MIRROR` 指向镜像上的 `astral-sh/python-build-standalone/`；已存在时什么也不做，不升级 Python。
//!
//! - 更新 uv：只在 Agent 安装后（以及自更新后，ADR 0014）的首次启动执行一次，由 uv 旁边的标记文件
//!   [`UV_UPDATE_MARKER`] 触发（install.sh 写入；执行后删除，失败也不重试，之后由用户决定）。
//!   没有配置镜像时运行 `uv self update`；配置了 GitHub Release 镜像时重新运行镜像上的安装脚本（同上）：
//!   `uv self update` 认的 `UV_INSTALLER_GITHUB_BASE_URL` 是 GitHub 实例的地址（它去 `api.<主机>` 调 GitHub API），
//!   中科大这类只镜像发布文件的镜像站用不了；而 `uv self update` 本身也是下载并运行同一个安装脚本。
//!   更新失败但旧 uv 仍能运行时只告警。
//!
//! 本机可以覆盖控制面下发的镜像（[`Mirrors`]，命令行 > 环境变量 > `agent.env` > 控制面下发）：
//! `--index-url`（PyPI）、`--github-release-mirror`（安装和更新 uv，也用来推导 Python 下载镜像）、
//! `--python-install-mirror`（直接作为 `UV_PYTHON_INSTALL_MIRROR`，优先于推导的地址）。
//!
//! 失败时返回 [`EnvironmentError`]：Agent 以退出码 [`EXIT_CODE`] 退出，标准错误打印失败的命令、完整输出、
//! 用到的镜像地址及其来源，最后一行提示把输出报告给平台管理员。

use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use crate::proto::Welcome;
use crate::venv::SharedVenv;

/// 平台约定的 Python 版本：共享 venv 和 `sfly init` 生成的项目都用它。
pub const PYTHON_VERSION: &str = "3.13";

/// 环境准备失败时的退出码（sysexits 的 EX_CONFIG）；systemd 服务用 `RestartPreventExitStatus=78` 不再重启。
pub const EXIT_CODE: i32 = 78;

/// 没有配置 GitHub Release 镜像时使用的 uv 官方安装脚本。
pub const OFFICIAL_UV_INSTALLER: &str = "https://astral.sh/uv/install.sh";

/// 「首次启动时更新 uv」的标记文件，放在 Agent 管理的 uv 所在目录（`SFLY_HOME/bin/.uv-update`）。
pub const UV_UPDATE_MARKER: &str = ".uv-update";

/// 本机对镜像的覆盖（`--index-url`、`--github-release-mirror`、`--python-install-mirror`，
/// 也可以写在环境变量或 `agent.env` 里）；没有覆盖的为 None。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LocalMirrors {
    /// PyPI 镜像（简单索引地址）。
    pub pypi: Option<String>,
    /// GitHub Release 镜像。
    pub github_release: Option<String>,
    /// Python 下载镜像（`UV_PYTHON_INSTALL_MIRROR`）。
    pub python_install: Option<String>,
}

/// 镜像地址的来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// 控制面在 Welcome 里下发。
    ControlPlane,
    /// 本机覆盖。
    Local,
}

/// 准备环境用的镜像（ADR 0012）：控制面在 Welcome 里下发的，加上本机的覆盖（本地优先）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Mirrors {
    /// 控制面下发的 PyPI 镜像；未配置为 None。
    pub distributed_pypi: Option<String>,
    /// 控制面下发的 GitHub Release 镜像，例如 `https://mirrors.ustc.edu.cn/github-release`。
    pub distributed_github_release: Option<String>,
    pub local: LocalMirrors,
}

fn non_empty(s: &str) -> Option<String> {
    (!s.trim().is_empty()).then(|| s.trim().to_string())
}

impl Mirrors {
    pub fn new(welcome: &Welcome, local: &LocalMirrors) -> Self {
        let clean = |v: &Option<String>| v.as_deref().and_then(non_empty);
        Self {
            distributed_pypi: non_empty(&welcome.pypi_mirror),
            distributed_github_release: non_empty(&welcome.github_release_mirror),
            local: LocalMirrors {
                pypi: clean(&local.pypi),
                github_release: clean(&local.github_release),
                python_install: clean(&local.python_install),
            },
        }
    }

    /// 安装节点包依赖用的 PyPI 镜像：本地覆盖 > 下发。
    pub fn pypi(&self) -> Option<(&str, Source)> {
        pick(&self.local.pypi, &self.distributed_pypi)
    }

    /// GitHub Release 镜像：本地覆盖 > 下发。
    pub fn github_release(&self) -> Option<(&str, Source)> {
        pick(&self.local.github_release, &self.distributed_github_release)
    }

    fn github_release_base(&self) -> Option<&str> {
        self.github_release()
            .map(|(url, _)| url.trim_end_matches('/'))
    }

    /// 镜像上 uv 最新发布的目录（不带末尾 `/`，即安装脚本的 `UV_DOWNLOAD_URL`）。
    pub fn uv_download_url(&self) -> Option<String> {
        self.github_release_base()
            .map(|base| format!("{base}/astral-sh/uv/LatestRelease"))
    }

    /// uv 安装脚本的下载地址。
    pub fn uv_installer_url(&self) -> String {
        match self.uv_download_url() {
            Some(dir) => format!("{dir}/uv-installer.sh"),
            None => OFFICIAL_UV_INSTALLER.to_string(),
        }
    }

    /// Python 下载镜像（`UV_PYTHON_INSTALL_MIRROR`）：本地覆盖 > 从 GitHub Release 镜像推导。
    pub fn python_install_mirror(&self) -> Option<String> {
        self.local.python_install.clone().or_else(|| {
            self.github_release_base()
                .map(|base| format!("{base}/astral-sh/python-build-standalone/"))
        })
    }

    /// 失败报告里的镜像一节：每个地址标明来源（覆盖时也列出控制面下发的值）。
    fn describe(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fn line(
            f: &mut fmt::Formatter<'_>,
            label: &str,
            local: &Option<String>,
            distributed: &Option<String>,
        ) -> fmt::Result {
            match (local, distributed) {
                (Some(local), Some(distributed)) => writeln!(
                    f,
                    "  {label}：{local}（本地覆盖；控制面下发的是 {distributed}）"
                ),
                (Some(local), None) => writeln!(f, "  {label}：{local}（本地覆盖）"),
                (None, Some(distributed)) => writeln!(f, "  {label}：{distributed}（控制面下发）"),
                (None, None) => writeln!(f, "  {label}：未配置"),
            }
        }
        writeln!(f, "用到的镜像：")?;
        line(
            f,
            "GitHub Release 镜像",
            &self.local.github_release,
            &self.distributed_github_release,
        )?;
        match (&self.local.python_install, self.github_release()) {
            (Some(local), _) => writeln!(f, "  Python 下载镜像：{local}（本地覆盖）")?,
            (None, Some((_, source))) => writeln!(
                f,
                "  Python 下载镜像：{}（由{} GitHub Release 镜像推导）",
                self.python_install_mirror().unwrap_or_default(),
                match source {
                    Source::ControlPlane => "控制面下发的",
                    Source::Local => "本地覆盖的",
                }
            )?,
            (None, None) => writeln!(f, "  Python 下载镜像：未配置")?,
        }
        line(f, "PyPI 镜像", &self.local.pypi, &self.distributed_pypi)
    }
}

fn pick<'a>(
    local: &'a Option<String>,
    distributed: &'a Option<String>,
) -> Option<(&'a str, Source)> {
    match (local, distributed) {
        (Some(url), _) => Some((url, Source::Local)),
        (None, Some(url)) => Some((url, Source::ControlPlane)),
        (None, None) => None,
    }
}

/// 环境准备失败。`Display` 输出完整的失败报告（多行，最后一行是报告提示）。
#[derive(Debug)]
pub struct EnvironmentError {
    /// 哪一步失败了。
    pub what: String,
    /// 失败的命令（shell 写法，带上设置的环境变量）。
    pub command: String,
    /// 命令的完整输出（标准输出 + 标准错误），或无法运行的原因。
    pub output: String,
    /// 用到的镜像（装箱：让 `Result<_, EnvironmentError>` 保持小巧）。
    pub mirrors: Box<Mirrors>,
}

impl fmt::Display for EnvironmentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        writeln!(f, "sfly Agent 环境准备失败：{}", self.what)?;
        writeln!(f, "失败的命令：{}", self.command)?;
        writeln!(f, "命令输出：")?;
        writeln!(f, "{}", self.output.trim_end())?;
        self.mirrors.describe(f)?;
        write!(f, "请把以上输出报告给平台管理员。")
    }
}

impl std::error::Error for EnvironmentError {}

/// 准备环境用到的配置。
pub struct Setup<'a> {
    /// uv 可执行文件。
    pub uv: &'a Path,
    /// uv 由 Agent 管理（没有指定 `--uv`，`uv` 是 `SFLY_HOME/bin/uv`）。
    pub manage_uv: bool,
    pub mirrors: &'a Mirrors,
    /// 下载安装脚本用的临时目录。
    pub scratch: &'a Path,
}

impl Setup<'_> {
    fn error(&self, what: impl Into<String>, command: String, output: String) -> EnvironmentError {
        EnvironmentError {
            what: what.into(),
            command,
            output,
            mirrors: Box::new(self.mirrors.clone()),
        }
    }

    /// 运行命令，失败（无法启动或退出码非 0）时返回 [`EnvironmentError`]；成功时返回输出。
    async fn run(
        &self,
        what: &str,
        mut command: tokio::process::Command,
    ) -> Result<String, EnvironmentError> {
        let line = command_line(command.as_std());
        let output = command
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(|e| self.error(what, line.clone(), format!("无法运行：{e}")))?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if output.status.success() {
            Ok(text)
        } else {
            Err(self.error(what, line, format!("{text}（{}）", output.status)))
        }
    }

    /// 准备 uv：Agent 管理的 uv 不存在时从镜像安装；然后检查 uv 能运行。返回是否新装了 uv。
    pub async fn ensure_uv(&self) -> Result<bool, EnvironmentError> {
        let installed = if self.manage_uv && !self.uv.exists() {
            self.install_uv().await?;
            true
        } else {
            false
        };
        self.check_uv().await?;
        Ok(installed)
    }

    /// 更新 Agent 管理的 uv（见模块说明）：没有镜像时 `uv self update`，有镜像时重新运行镜像上的安装脚本；
    /// 然后检查 uv 仍能运行。
    pub async fn update_uv(&self) -> Result<(), EnvironmentError> {
        const WHAT: &str = "更新 uv 失败";
        if self.mirrors.uv_download_url().is_some() {
            self.run_installer(WHAT).await?;
        } else {
            let mut update = tokio::process::Command::new(self.uv);
            update
                .args(["self", "update", "--no-progress", "--color", "never"])
                .env("UV_NO_MODIFY_PATH", "1");
            self.run(WHAT, update).await?;
        }
        Ok(())
    }

    /// 检查 uv 能运行。
    pub async fn check_uv(&self) -> Result<(), EnvironmentError> {
        let mut check = tokio::process::Command::new(self.uv);
        check.arg("--version");
        self.run("没有可用的 uv", check).await.map(drop)
    }

    async fn install_uv(&self) -> Result<(), EnvironmentError> {
        self.run_installer("安装 uv 失败").await
    }

    /// 下载并运行 uv 安装脚本，装到 uv 所在目录。
    async fn run_installer(&self, what: &str) -> Result<(), EnvironmentError> {
        let bin = self.uv.parent().unwrap_or(Path::new("."));
        let url = self.mirrors.uv_installer_url();
        let script: PathBuf = self
            .scratch
            .join(format!("uv-installer-{}.sh", std::process::id()));
        if let Err(e) = tokio::fs::create_dir_all(self.scratch).await {
            return Err(self.error(
                what,
                format!("mkdir -p {}", self.scratch.display()),
                e.to_string(),
            ));
        }
        let download = if in_path("curl") {
            let mut curl = tokio::process::Command::new("curl");
            curl.args(["-fsSL", "-o"]).arg(&script).arg(&url);
            curl
        } else if in_path("wget") {
            let mut wget = tokio::process::Command::new("wget");
            wget.args(["-q", "-O"]).arg(&script).arg(&url);
            wget
        } else {
            return Err(self.error(
                what,
                format!("curl -fsSL {url}"),
                "PATH 里没有 curl 或 wget（下载并运行 uv 安装脚本需要其中一个）".to_string(),
            ));
        };
        let result = async {
            self.run(what, download).await?;
            let mut install = tokio::process::Command::new("sh");
            install
                .arg(&script)
                .env("UV_INSTALL_DIR", bin)
                .env("UV_NO_MODIFY_PATH", "1");
            if let Some(dir) = self.mirrors.uv_download_url() {
                install.env("UV_DOWNLOAD_URL", dir);
            }
            let line = command_line(install.as_std());
            let output = self.run(what, install).await?;
            if !self.uv.exists() {
                return Err(self.error(
                    format!("{what}：安装脚本没有生成 {}", self.uv.display()),
                    line,
                    output,
                ));
            }
            Ok(())
        }
        .await;
        let _ = tokio::fs::remove_file(&script).await;
        result
    }

    /// 共享 venv 不存在时用 uv 创建；已经存在时什么也不做。返回是否新建了。
    pub async fn ensure_venv(
        &self,
        venv: &SharedVenv,
        python: Option<&str>,
    ) -> Result<bool, EnvironmentError> {
        if venv.python().exists() {
            return Ok(false);
        }
        let mut command = tokio::process::Command::new(self.uv);
        command
            .args(["venv", "--no-progress", "--color", "never", "--no-project"])
            .args(["--python", python.unwrap_or(PYTHON_VERSION)])
            .arg(venv.root())
            .env_remove("VIRTUAL_ENV");
        if let Some(mirror) = self.mirrors.python_install_mirror() {
            command.env("UV_PYTHON_INSTALL_MIRROR", mirror);
        }
        self.run("创建共享 venv 失败", command).await?;
        Ok(true)
    }
}

/// PATH 里有没有这个可执行文件。
fn in_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(name).is_file()))
}

/// 命令的 shell 写法：显式设置的环境变量 + 程序 + 参数。
fn command_line(command: &std::process::Command) -> String {
    let quote = |s: &std::ffi::OsStr| {
        let s = s.to_string_lossy();
        if !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_./:=+@%,".contains(c))
        {
            s.into_owned()
        } else {
            format!("'{}'", s.replace('\'', r"'\''"))
        }
    };
    let mut parts: Vec<String> = command
        .get_envs()
        .filter_map(|(key, value)| value.map(|v| format!("{}={}", key.to_string_lossy(), quote(v))))
        .collect();
    parts.push(quote(command.get_program()));
    parts.extend(command.get_args().map(quote));
    parts.join(" ")
}
