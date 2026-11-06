//! 运行环境的准备（ADR 0012）：收到控制面的 Welcome 之后，按下发的镜像准备 uv 和共享 venv。
//!
//! - uv：指定了 `--uv` 时不管理它，只检查它能运行；否则使用 `SFLY_HOME/bin/uv`，不存在时下载 GitHub Release 镜像上
//!   `astral-sh/uv/LatestRelease/uv-installer.sh` 并运行（`UV_DOWNLOAD_URL` 指向镜像上的同一目录，
//!   `UV_INSTALL_DIR` 为 `SFLY_HOME/bin`，`UV_NO_MODIFY_PATH=1`）。没有配置镜像时用 uv 官方的安装脚本。
//!   安装脚本本身需要 curl 或 wget，Agent 也用它们下载安装脚本（Agent 的 HTTP 客户端不带 TLS）。
//! - 共享 venv：不存在时用 `uv venv --python 3.13` 创建（`--python` 可以覆盖），
//!   `UV_PYTHON_INSTALL_MIRROR` 指向镜像上的 `astral-sh/python-build-standalone/`；已存在时什么也不做，不升级 Python。
//!
//! 失败时返回 [`EnvironmentError`]：Agent 以退出码 [`EXIT_CODE`] 退出，标准错误打印失败的命令、完整输出、
//! 用到的镜像地址，最后一行提示把输出报告给平台管理员。

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

/// 控制面在 Welcome 里下发的镜像（ADR 0012）；未配置的为 None。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Mirrors {
    /// PyPI 镜像（简单索引地址）。
    pub pypi: Option<String>,
    /// GitHub Release 镜像，例如 `https://mirrors.ustc.edu.cn/github-release`。
    pub github_release: Option<String>,
}

impl Mirrors {
    pub fn from_welcome(welcome: &Welcome) -> Self {
        let non_empty = |s: &str| (!s.trim().is_empty()).then(|| s.trim().to_string());
        Self {
            pypi: non_empty(&welcome.pypi_mirror),
            github_release: non_empty(&welcome.github_release_mirror),
        }
    }

    fn github_release_base(&self) -> Option<&str> {
        self.github_release
            .as_deref()
            .map(|url| url.trim_end_matches('/'))
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

    /// Python 下载镜像（`UV_PYTHON_INSTALL_MIRROR`）。
    pub fn python_install_mirror(&self) -> Option<String> {
        self.github_release_base()
            .map(|base| format!("{base}/astral-sh/python-build-standalone/"))
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
    /// 本地 `--index-url`（覆盖下发的 PyPI 镜像）。
    pub index_url: Option<String>,
}

impl fmt::Display for EnvironmentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let or_none = |v: &Option<String>| v.clone().unwrap_or_else(|| "未配置".to_string());
        writeln!(f, "sfly Agent 环境准备失败：{}", self.what)?;
        writeln!(f, "失败的命令：{}", self.command)?;
        writeln!(f, "命令输出：")?;
        writeln!(f, "{}", self.output.trim_end())?;
        writeln!(f, "镜像（由控制面下发）：")?;
        writeln!(
            f,
            "  GitHub Release 镜像：{}",
            or_none(&self.mirrors.github_release)
        )?;
        match &self.index_url {
            Some(local) => writeln!(
                f,
                "  PyPI 镜像：{}（本地 --index-url 覆盖为 {local}）",
                or_none(&self.mirrors.pypi)
            )?,
            None => writeln!(f, "  PyPI 镜像：{}", or_none(&self.mirrors.pypi))?,
        }
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
    pub index_url: Option<&'a str>,
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
            index_url: self.index_url.map(str::to_string),
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
        let mut check = tokio::process::Command::new(self.uv);
        check.arg("--version");
        self.run("没有可用的 uv", check).await?;
        Ok(installed)
    }

    async fn install_uv(&self) -> Result<(), EnvironmentError> {
        const WHAT: &str = "安装 uv 失败";
        let bin = self.uv.parent().unwrap_or(Path::new("."));
        let url = self.mirrors.uv_installer_url();
        let script: PathBuf = self
            .scratch
            .join(format!("uv-installer-{}.sh", std::process::id()));
        if let Err(e) = tokio::fs::create_dir_all(self.scratch).await {
            return Err(self.error(
                WHAT,
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
                WHAT,
                format!("curl -fsSL {url}"),
                "PATH 里没有 curl 或 wget（下载并运行 uv 安装脚本需要其中一个）".to_string(),
            ));
        };
        let result = async {
            self.run(WHAT, download).await?;
            let mut install = tokio::process::Command::new("sh");
            install
                .arg(&script)
                .env("UV_INSTALL_DIR", bin)
                .env("UV_NO_MODIFY_PATH", "1");
            if let Some(dir) = self.mirrors.uv_download_url() {
                install.env("UV_DOWNLOAD_URL", dir);
            }
            let line = command_line(install.as_std());
            let output = self.run(WHAT, install).await?;
            if !self.uv.exists() {
                return Err(self.error(
                    format!("安装 uv 失败：安装脚本没有生成 {}", self.uv.display()),
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
