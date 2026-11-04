//! 共享 venv（ADR 0002）：节点包和 SDK 运行时都装在里面，与 Agent 自身的运行环境完全隔离。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context as _, bail};
use serde::Deserialize;
use tokio::process::Command;

/// `python -m sfly.installed` 输出的一个节点包（sfly-package.json 中 Agent 用到的部分）。
#[derive(Debug, Clone, Deserialize)]
pub struct PackageMetadata {
    pub name: String,
    pub version: String,
    pub nodes: Vec<NodeMetadata>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NodeMetadata {
    pub name: String,
    /// `模块:函数`。
    pub entry: String,
}

#[derive(Deserialize)]
struct Installed {
    packages: Vec<PackageMetadata>,
}

#[derive(Debug, Clone)]
pub struct SharedVenv {
    root: PathBuf,
}

impl SharedVenv {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn bin_dir(&self) -> PathBuf {
        if cfg!(windows) {
            self.root.join("Scripts")
        } else {
            self.root.join("bin")
        }
    }

    pub fn python(&self) -> PathBuf {
        self.bin_dir().join(if cfg!(windows) {
            "python.exe"
        } else {
            "python"
        })
    }

    /// 在共享 venv 中运行 Python 的命令：
    /// `-I`（隔离模式，忽略 PYTHON* 环境变量和用户 site-packages），
    /// 去掉 Agent 环境中的 PYTHON* 变量，`VIRTUAL_ENV` 指向共享 venv，`PATH` 以 venv 的 bin 目录开头。
    pub fn python_command(&self) -> Command {
        let mut command = Command::new(self.python());
        command.arg("-I");
        for (key, _) in std::env::vars_os() {
            if key
                .to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("PYTHON")
            {
                command.env_remove(key);
            }
        }
        command.env("VIRTUAL_ENV", &self.root);
        let mut path = vec![self.bin_dir()];
        if let Some(existing) = std::env::var_os("PATH") {
            path.extend(std::env::split_paths(&existing));
        }
        command.env(
            "PATH",
            std::env::join_paths(path).unwrap_or_else(|_| OsString::from(self.bin_dir())),
        );
        command
    }

    /// 共享 venv 中已安装的节点包（`python -m sfly.installed`）。
    pub async fn installed(&self) -> anyhow::Result<Vec<PackageMetadata>> {
        let output = self
            .python_command()
            .args(["-m", "sfly.installed"])
            .stdin(Stdio::null())
            .output()
            .await
            .with_context(|| format!("run {}", self.python().display()))?;
        if !output.status.success() {
            bail!(
                "sfly.installed failed ({}): {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        let installed: Installed =
            serde_json::from_slice(&output.stdout).context("parse sfly.installed output")?;
        Ok(installed.packages)
    }
}
