//! 开发模式（`sfly dev`）：把本地源码目录以可编辑方式装进共享 venv，注册为 `包名@dev`。
//!
//! - `sfly dev` 通过 Agent 的本地 socket（[`crate::socket`]）发来一行 JSON 请求（[`DevRequest`]），
//!   Agent 回复一行 JSON（[`DevReply`]）后关闭连接。
//! - 开发版本登记在 `<work_dir>/.dev/<包名>/`（`dev.json` + 可编辑 wheel 的副本），Agent 重启后仍然有效。
//!   共享 venv 中同一个包只能有一个版本（ADR 0002）：锁定已发布版本的任务会把它切换成已发布版本，
//!   之后的 `@dev` 任务再用登记的 wheel 装回来。
//! - 可编辑 wheel 只有一个指向源码目录的 `.pth`，所以修改源码后下一次运行（新的执行器进程）就会生效；
//!   节点的增删和签名变化要重新运行 `sfly dev` 才会更新元信息。

use std::path::{Path, PathBuf};

use anyhow::{Context as _, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::proto::DevPackage;

/// 开发版本的版本号。
pub const DEV_VERSION: &str = "dev";

/// 一个已登记的开发版本。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevEntry {
    pub package: String,
    /// 本地源码目录。
    pub source: String,
    /// `sfly dev` 扫描出的元信息（version 为 `dev`）。
    pub metadata: Value,
    /// 登记目录中可编辑 wheel 的文件名。
    pub wheel: String,
}

impl DevEntry {
    pub fn to_proto(&self) -> DevPackage {
        DevPackage {
            name: self.package.clone(),
            source: self.source.clone(),
            metadata_json: self.metadata.to_string(),
        }
    }
}

/// 开发版本登记表（`<work_dir>/.dev/`）。
pub struct DevRegistry {
    dir: PathBuf,
}

/// 包名按 PEP 503 规范化，用作登记目录名。
fn normalize(name: &str) -> String {
    name.to_ascii_lowercase().replace(['_', '.'], "-")
}

/// 包名只允许 PEP 508 的名字字符（同时保证可以安全地用作目录名）。
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
}

impl DevRegistry {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn entry_dir(&self, package: &str) -> PathBuf {
        self.dir.join(normalize(package))
    }

    /// 某个包的开发版本登记；没有登记时为 None。
    pub fn get(&self, package: &str) -> Option<(DevEntry, PathBuf)> {
        if !valid_name(package) {
            return None;
        }
        let dir = self.entry_dir(package);
        let text = std::fs::read_to_string(dir.join("dev.json")).ok()?;
        let entry: DevEntry = serde_json::from_str(&text).ok()?;
        let wheel = dir.join(&entry.wheel);
        Some((entry, wheel))
    }

    /// 全部开发版本，按包名排序。
    pub fn list(&self) -> Vec<DevEntry> {
        let Ok(dirs) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut entries: Vec<DevEntry> = dirs
            .flatten()
            .filter_map(|d| {
                let text = std::fs::read_to_string(d.path().join("dev.json")).ok()?;
                serde_json::from_str(&text).ok()
            })
            .collect();
        entries.sort_by(|a, b| a.package.cmp(&b.package));
        entries
    }

    /// 取消登记。
    pub fn remove(&self, package: &str) {
        if valid_name(package) {
            let _ = std::fs::remove_dir_all(self.entry_dir(package));
        }
    }

    /// 登记（或更新）一个开发版本：复制可编辑 wheel 到登记目录，返回登记和 wheel 的路径。
    pub fn register(&self, request: &DevRequest) -> anyhow::Result<(DevEntry, PathBuf)> {
        if !valid_name(&request.package) {
            bail!("无效的包名 {:?}", request.package);
        }
        let source = Path::new(&request.wheel);
        let wheel = source
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|n| n.ends_with(".whl"))
            .with_context(|| format!("不是 wheel 文件：{}", request.wheel))?
            .to_string();
        let dir = self.entry_dir(&request.package);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).with_context(|| format!("创建 {}", dir.display()))?;
        std::fs::copy(source, dir.join(&wheel))
            .with_context(|| format!("复制 {}", source.display()))?;
        let entry = DevEntry {
            package: request.package.clone(),
            source: request.source.clone(),
            metadata: request.metadata.clone(),
            wheel,
        };
        let tmp = dir.join("dev.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&entry)?)?;
        std::fs::rename(&tmp, dir.join("dev.json"))?;
        let path = dir.join(&entry.wheel);
        Ok((entry, path))
    }
}

/// `sfly dev` 的请求（本地 socket 上的一行 JSON）。
#[derive(Debug, Clone, Deserialize)]
pub struct DevRequest {
    pub command: String,
    pub package: String,
    pub source: String,
    /// `sfly dev` 构建的可编辑 wheel（客户端的临时文件）。
    pub wheel: String,
    pub metadata: Value,
}

/// 对请求的回复。
#[derive(Debug, Clone, Serialize)]
pub struct DevReply {
    pub ok: bool,
    pub message: String,
    pub output: String,
}

impl DevReply {
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: message.into(),
            output: String::new(),
        }
    }
}
