//! 节点包安装（docs/ARCHITECTURE.md §4.4、ADR 0002）：从控制面下载 `.sflypkg` 归档、校验 sha256，
//! 取出其中的 wheel，用 `uv pip install` 装进共享 venv（同名的其他版本被就地替换），
//! 依赖从配置的 PyPI 镜像安装。
//!
//! 共享 venv 里其他节点包声明的依赖（Requires-Dist）会和新 wheel 一起交给 uv 解析：
//! 新包的依赖与它们冲突时 uv 解析失败、venv 保持原样，任务以 `env_error` 失败并带上完整的 uv 输出。
//! 安装与启动新任务的互斥由调用方（`Runtime`）负责。

use std::collections::BTreeMap;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use sha2::{Digest, Sha256};

use crate::proto::AssignTask;
use crate::venv::SharedVenv;

/// 安装失败；`message` 是给任务详情看的完整说明（包含 uv 输出），`output` 是 uv 输出本身。
#[derive(Debug)]
pub struct InstallError {
    pub message: String,
    pub output: String,
}

impl InstallError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            output: String::new(),
        }
    }
}

pub struct Installer {
    pub venv: SharedVenv,
    /// 下载、解包用的临时目录的父目录。
    pub scratch: PathBuf,
    /// 生效的 PyPI 镜像：本地 `--index-url`，否则控制面在 Welcome 里下发的镜像（每次连上控制面时更新）。
    pub index_url: std::sync::Mutex<Option<String>>,
    pub uv: PathBuf,
    pub http: reqwest::Client,
}

impl Installer {
    /// 安装任务需要的节点包版本；`others` 是共享 venv 中其他节点包的依赖（包名 → Requires-Dist）。
    /// 成功时返回 uv 输出。
    pub async fn install(
        &self,
        task: &AssignTask,
        others: &BTreeMap<String, Vec<String>>,
    ) -> Result<String, InstallError> {
        let label = format!("{}@{}", task.package, task.package_version);
        if task.package_url.is_empty() {
            return Err(InstallError::new(format!(
                "节点包 {label} 没有安装在共享 venv 中，控制面也没有提供下载地址"
            )));
        }
        let archive = self.download(task, &label).await?;
        let dir = self.scratch.join(format!(
            "{}-{}-{}",
            task.package,
            task.package_version,
            std::process::id()
        ));
        let result = self
            .install_archive(&dir, archive, task, &label, others)
            .await;
        let _ = tokio::fs::remove_dir_all(&dir).await;
        result
    }

    async fn download(&self, task: &AssignTask, label: &str) -> Result<Vec<u8>, InstallError> {
        let fail = |e: String| InstallError::new(format!("下载节点包 {label} 失败：{e}"));
        let response = self
            .http
            .get(&task.package_url)
            .send()
            .await
            .map_err(|e| fail(format!("{} ({e})", task.package_url)))?;
        if !response.status().is_success() {
            return Err(fail(format!(
                "{} 返回 {}",
                task.package_url,
                response.status()
            )));
        }
        let bytes = response.bytes().await.map_err(|e| fail(e.to_string()))?;
        let actual = sha256_hex(&bytes);
        if !actual.eq_ignore_ascii_case(&task.package_sha256) {
            return Err(InstallError::new(format!(
                "节点包 {label} 的 sha256 校验失败：期望 {}，实际 {actual}",
                task.package_sha256
            )));
        }
        Ok(bytes.to_vec())
    }

    async fn install_archive(
        &self,
        dir: &Path,
        archive: Vec<u8>,
        task: &AssignTask,
        label: &str,
        others: &BTreeMap<String, Vec<String>>,
    ) -> Result<String, InstallError> {
        let _ = tokio::fs::remove_dir_all(dir).await;
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| InstallError::new(format!("创建目录 {} 失败：{e}", dir.display())))?;
        let (wheel_name, wheel) = extract_wheel(archive)
            .map_err(|e| InstallError::new(format!("节点包 {label} 的归档无效：{e}")))?;
        let wheel_path = dir.join(&wheel_name);
        tokio::fs::write(&wheel_path, wheel)
            .await
            .map_err(|e| InstallError::new(format!("写入 {} 失败：{e}", dir.display())))?;
        self.uv_install(dir, label, &task.package, &wheel_path, others, false)
            .await
    }

    /// 安装 `sfly dev` 构建的可编辑 wheel（开发版本 `包名@dev`）。即使 venv 里已经是同一个 wheel，
    /// 也强制重新安装，让重新运行 `sfly dev` 时元信息和依赖得到更新。成功时返回 uv 输出。
    pub async fn install_dev(
        &self,
        package: &str,
        wheel: &Path,
        others: &BTreeMap<String, Vec<String>>,
    ) -> Result<String, InstallError> {
        let label = format!("{package}@{}", crate::dev::DEV_VERSION);
        let dir = self
            .scratch
            .join(format!("{package}-dev-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        let result = match tokio::fs::create_dir_all(&dir).await {
            Ok(()) => {
                self.uv_install(&dir, &label, package, wheel, others, true)
                    .await
            }
            Err(e) => Err(InstallError::new(format!(
                "创建目录 {} 失败：{e}",
                dir.display()
            ))),
        };
        let _ = tokio::fs::remove_dir_all(&dir).await;
        result
    }

    /// 用 uv 把 wheel 装进共享 venv；共享 venv 中其他节点包的依赖一起交给 uv 解析。
    async fn uv_install(
        &self,
        dir: &Path,
        label: &str,
        package: &str,
        wheel_path: &Path,
        others: &BTreeMap<String, Vec<String>>,
        reinstall: bool,
    ) -> Result<String, InstallError> {
        let mut requirements = vec![wheel_path.to_string_lossy().into_owned()];
        for (name, requires) in others {
            if !same_name(name, package) {
                requirements.extend(requires.iter().cloned());
            }
        }
        let requirements_path = dir.join("requirements.txt");
        tokio::fs::write(&requirements_path, requirements.join("\n") + "\n")
            .await
            .map_err(|e| InstallError::new(format!("写入 {} 失败：{e}", dir.display())))?;

        let mut command = tokio::process::Command::new(&self.uv);
        command
            .args(["pip", "install", "--no-progress", "--color", "never"])
            .arg("--python")
            .arg(self.venv.python());
        if let Some(index) = self.index_url.lock().unwrap().clone() {
            command.args(["--index-url", &index]);
        }
        if reinstall {
            command
                .args(["--reinstall-package", package])
                .args(["--refresh-package", package]);
        }
        command
            .arg("-r")
            .arg(&requirements_path)
            .env_remove("VIRTUAL_ENV")
            .stdin(Stdio::null());
        let line = format!("$ {:?}", command.as_std());
        let output = command.output().await.map_err(|e| {
            InstallError::new(format!(
                "安装节点包 {label} 失败：无法运行 uv（{}）：{e}",
                self.uv.display()
            ))
        })?;
        let mut text = format!("{line}\n");
        text.push_str(&String::from_utf8_lossy(&output.stdout));
        text.push_str(&String::from_utf8_lossy(&output.stderr));
        if output.status.success() {
            Ok(text)
        } else {
            Err(InstallError {
                message: format!(
                    "安装节点包 {label} 失败（uv {}）\n\n{}",
                    output.status,
                    text.trim_end()
                ),
                output: text,
            })
        }
    }
}

/// 包名按 PEP 503 规范化后比较。
fn same_name(a: &str, b: &str) -> bool {
    let normalize = |s: &str| s.to_ascii_lowercase().replace(['_', '.'], "-");
    normalize(a) == normalize(b)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 归档根目录里唯一的 `*.whl`。
fn extract_wheel(archive: Vec<u8>) -> Result<(String, Vec<u8>), String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(archive)).map_err(|e| e.to_string())?;
    let wheels: Vec<String> = zip
        .file_names()
        .filter_map(Result::ok)
        .filter(|n| !n.contains(['/', '\\']) && n.ends_with(".whl"))
        .map(|n| n.into_owned())
        .collect();
    let [name] = wheels.as_slice() else {
        return Err(format!("根目录应恰好有一个 wheel，实际 {}", wheels.len()));
    };
    let mut file = zip.by_name(name).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok((name.clone(), bytes))
}
