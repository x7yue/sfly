//! 共享 venv 的准备（ADR 0002，规格“Agent 运行时只依赖 uv”）：
//!
//! - 收到控制面的 Welcome 后，共享 venv 不存在就用 `uv venv` 创建（`--python` 指定解释器，默认由 uv 选择）；
//! - 连上控制面后，共享 venv 里的 SDK 运行时（Python 包 `sfly`）版本与 Agent 版本不一致或还没安装时，
//!   从 Welcome 给出的地址下载 SDK 运行时 wheel、校验 sha256，用 `uv pip install` 装进共享 venv；
//!   版本一致时什么也不做。
//!
//! SDK 运行时只用标准库，安装时不解析依赖（`--no-deps`），不需要访问 PyPI。

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context as _, bail};
use sha2::{Digest, Sha256};

use crate::venv::SharedVenv;

/// 共享 venv 不存在时用 uv 创建；已经存在时什么也不做。返回是否新建了。
pub async fn create_venv(
    uv: &Path,
    venv: &SharedVenv,
    python: Option<&str>,
) -> anyhow::Result<bool> {
    if venv.python().exists() {
        return Ok(false);
    }
    let mut command = tokio::process::Command::new(uv);
    command.args(["venv", "--quiet", "--no-project"]);
    if let Some(python) = python {
        command.args(["--python", python]);
    }
    let output = command
        .arg(venv.root())
        .env_remove("VIRTUAL_ENV")
        .stdin(Stdio::null())
        .output()
        .await
        .with_context(|| format!("run {}", uv.display()))?;
    if !output.status.success() {
        bail!(
            "uv venv {} failed ({}): {}",
            venv.root().display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(true)
}

/// 共享 venv 中 SDK 运行时的版本；没有安装（或 venv 不可用）时为 None。
pub async fn installed_version(venv: &SharedVenv) -> Option<String> {
    let output = venv
        .python_command()
        .args([
            "-c",
            "import importlib.metadata as m; print(m.version('sfly'))",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// 下载 SDK 运行时 wheel（校验 sha256）并装进共享 venv；成功时返回 uv 输出。
pub async fn install(
    http: &reqwest::Client,
    uv: &Path,
    venv: &SharedVenv,
    scratch: &Path,
    url: &str,
    sha256: &str,
) -> anyhow::Result<String> {
    let response = http
        .get(url)
        .send()
        .await
        .with_context(|| format!("download {url}"))?;
    if !response.status().is_success() {
        bail!("download {url}: {}", response.status());
    }
    let bytes = response.bytes().await.context("read SDK wheel")?;
    let actual: String = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if !actual.eq_ignore_ascii_case(sha256) {
        bail!("SDK wheel sha256 mismatch: expected {sha256}, got {actual}");
    }
    // uv 按文件名识别 wheel：取下载地址的最后一段（形如 sfly-0.1.0-py3-none-any.whl）。
    let name = url
        .rsplit('/')
        .next()
        .filter(|n| n.ends_with(".whl") && !n.contains(['\\', '?', '#']))
        .context("SDK wheel URL must end with the wheel file name")?;
    let dir: PathBuf = scratch.join(format!("sdk-{}", std::process::id()));
    let _ = tokio::fs::remove_dir_all(&dir).await;
    tokio::fs::create_dir_all(&dir).await?;
    let wheel = dir.join(name);
    tokio::fs::write(&wheel, &bytes).await?;
    let output = tokio::process::Command::new(uv)
        .args([
            "pip",
            "install",
            "--no-progress",
            "--color",
            "never",
            "--no-deps",
        ])
        .arg("--python")
        .arg(venv.python())
        .args(["--reinstall-package", "sfly"])
        .arg(&wheel)
        .env_remove("VIRTUAL_ENV")
        .stdin(Stdio::null())
        .output()
        .await
        .with_context(|| format!("run {}", uv.display()));
    let _ = tokio::fs::remove_dir_all(&dir).await;
    let output = output?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !output.status.success() {
        bail!(
            "uv pip install {name} failed ({}): {}",
            output.status,
            text.trim()
        );
    }
    Ok(text)
}
