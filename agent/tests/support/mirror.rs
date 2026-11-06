//! 测试支撑：本地 GitHub Release 镜像桩（类似 [`super::packages::HttpFixture`] 的 PyPI 镜像桩），不访问外网。
//!
//! 目录结构与中科大 `github-release` 镜像相同（镜像地址 = `<桩>/github-release`）：
//!
//! ```text
//! astral-sh/uv/LatestRelease/uv-installer.sh                 安装脚本的桩
//! astral-sh/uv/LatestRelease/uv-<arch>-unknown-linux-gnu.tar.gz   测试机上的 uv 打成的发布包
//! astral-sh/python-build-standalone/<build>/cpython-<版本>+<build>-<arch>-unknown-linux-gnu-install_only_stripped.tar.gz
//! ```
//!
//! - 安装脚本的桩遵守真实 `uv-installer.sh` 的约定：从 `$UV_DOWNLOAD_URL/uv-<target>.tar.gz` 下载（curl），
//!   装到 `$UV_INSTALL_DIR/uv`（flat 布局）；没有 `UV_NO_MODIFY_PATH=1` 时拒绝安装（真实脚本会改 shell 配置）。
//! - Python：uv 内置的下载列表里每个构建都有 sha256，桩伪造不了官方的包，所以用测试机上 uv 管理的 Python
//!   重新打包，再写一份下载列表（`UV_PYTHON_DOWNLOADS_JSON_URL`），其中的地址仍是官方的 GitHub 地址；
//!   Agent 设置的 `UV_PYTHON_INSTALL_MIRROR` 把它改写到桩上。[`ReleaseMirror::python_env`] 给出
//!   让 uv 必须下载 Python 的环境变量（独立的安装目录，只用 uv 管理的 Python）。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use super::packages::{HttpFixture, sha256_hex};
use super::python_interpreter;

/// 桩里伪造的 python-build-standalone 构建号。
const PYTHON_BUILD: &str = "20990101";

pub struct ReleaseMirror {
    pub http: HttpFixture,
    /// 写下载列表的临时目录。
    dir: tempfile::TempDir,
}

/// 测试机上的 uv 打成的发布包（每个测试进程一次）。
fn uv_release() -> &'static (String, Vec<u8>) {
    static RELEASE: OnceLock<(String, Vec<u8>)> = OnceLock::new();
    RELEASE.get_or_init(|| {
        let output = std::process::Command::new("sh")
            .args(["-c", "command -v uv"])
            .output()
            .expect("locate uv");
        let uv = PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
        let target = format!("uv-{}-unknown-linux-gnu", std::env::consts::ARCH);
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(&target)).unwrap();
        std::fs::copy(&uv, dir.path().join(&target).join("uv")).unwrap();
        let archive = dir.path().join("uv.tar.gz");
        let status = std::process::Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(dir.path())
            .arg(&target)
            .status()
            .unwrap();
        assert!(status.success(), "tar uv");
        (format!("{target}.tar.gz"), std::fs::read(&archive).unwrap())
    })
}

/// 测试机上 uv 管理的 Python（仓库约定的版本）重新打成的 install_only 包：(完整版本号, 文件名, 内容)。
fn python_release() -> &'static (String, String, Vec<u8>) {
    static RELEASE: OnceLock<(String, String, Vec<u8>)> = OnceLock::new();
    RELEASE.get_or_init(|| {
        let output = std::process::Command::new(python_interpreter())
            .args([
                "-c",
                "import sys, platform; print(sys.base_prefix); print(platform.python_version())",
            ])
            .output()
            .expect("run python");
        let text = String::from_utf8(output.stdout).unwrap();
        let mut lines = text.lines();
        let prefix = PathBuf::from(lines.next().unwrap());
        let version = lines.next().unwrap().to_string();
        let name = prefix.file_name().unwrap().to_string_lossy().into_owned();
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("python.tar.gz");
        // install_only 包的根目录是 python/。
        let status = std::process::Command::new("sh")
            .arg("-c")
            .arg(r#"tar -C "$1" --transform "s,^$2,python," -cf - "$2" | gzip -1 > "$3""#)
            .arg("sh")
            .arg(prefix.parent().unwrap())
            .arg(&name)
            .arg(&archive)
            .status()
            .unwrap();
        assert!(status.success(), "tar python");
        let file = format!(
            "cpython-{version}+{PYTHON_BUILD}-{}-unknown-linux-gnu-install_only_stripped.tar.gz",
            std::env::consts::ARCH
        );
        (version, file, std::fs::read(&archive).unwrap())
    })
}

impl ReleaseMirror {
    /// 空镜像：什么文件都没有（所有请求 404）。
    pub async fn start() -> Self {
        Self {
            http: HttpFixture::start().await,
            dir: tempfile::tempdir().unwrap(),
        }
    }

    /// 镜像地址（控制面配置的 GitHub Release 镜像）。
    pub fn url(&self) -> String {
        format!("{}/github-release", self.http.url)
    }

    /// 提供 `astral-sh/uv/LatestRelease/` 下的安装脚本和 uv 发布包。
    pub fn serve_uv(&self) {
        let base = "/github-release/astral-sh/uv/LatestRelease";
        self.http.put(
            &format!("{base}/uv-installer.sh"),
            INSTALLER_STUB.as_bytes().to_vec(),
        );
        let (name, bytes) = uv_release();
        self.http.put(&format!("{base}/{name}"), bytes.clone());
    }

    /// 安装脚本的请求路径。
    pub fn installer_path(&self) -> &'static str {
        "/github-release/astral-sh/uv/LatestRelease/uv-installer.sh"
    }

    /// 提供 python-build-standalone 的 Python 包，返回它的请求路径。
    pub fn serve_python(&self) -> String {
        let (_, file, bytes) = python_release();
        let path =
            format!("/github-release/astral-sh/python-build-standalone/{PYTHON_BUILD}/{file}");
        self.http.put(&path, bytes.clone());
        path
    }

    /// 镜像上 python-build-standalone 目录下的请求。
    pub fn python_requests(&self) -> Vec<String> {
        self.http
            .requests()
            .into_iter()
            .filter(|p| p.starts_with("/github-release/astral-sh/python-build-standalone/"))
            .collect()
    }

    /// 让 uv 必须下载 Python 的环境变量：独立的 Python 安装目录 `install_dir`、只用 uv 管理的 Python，
    /// 下载列表只有桩里的那个构建（地址是官方地址，由 Agent 设置的镜像改写到桩上）。
    pub fn python_env(&self, install_dir: &Path) -> Vec<(String, String)> {
        let (version, file, bytes) = python_release();
        let mut parts = version.split('.');
        let [major, minor, patch] = [(); 3].map(|_| parts.next().unwrap().parse::<u32>().unwrap());
        let arch = std::env::consts::ARCH;
        let key = format!("cpython-{version}-linux-{arch}-gnu");
        let downloads = serde_json::json!({
            key: {
                "name": "cpython",
                "arch": { "family": arch, "variant": null },
                "os": "linux",
                "libc": "gnu",
                "major": major,
                "minor": minor,
                "patch": patch,
                "prerelease": "",
                "url": format!(
                    "https://github.com/astral-sh/python-build-standalone/releases/download/{PYTHON_BUILD}/{file}"
                ),
                "sha256": sha256_hex(bytes),
                "variant": null,
                "build": PYTHON_BUILD,
            }
        });
        let json = self.dir.path().join("python-downloads.json");
        std::fs::write(&json, downloads.to_string()).unwrap();
        vec![
            (
                "UV_PYTHON_DOWNLOADS_JSON_URL".into(),
                json.to_string_lossy().into_owned(),
            ),
            (
                "UV_PYTHON_INSTALL_DIR".into(),
                install_dir.to_string_lossy().into_owned(),
            ),
            ("UV_PYTHON_PREFERENCE".into(), "only-managed".into()),
        ]
    }
}

/// `uv-installer.sh` 的桩。
const INSTALLER_STUB: &str = r#"#!/bin/sh
# uv-installer.sh 的测试桩：按真实安装脚本的约定从 $UV_DOWNLOAD_URL 下载 uv，装到 $UV_INSTALL_DIR。
set -eu
if [ "${UV_NO_MODIFY_PATH:-0}" != 1 ]; then
    echo "stub installer: UV_NO_MODIFY_PATH=1 is required (would modify PATH)" >&2
    exit 1
fi
target="uv-$(uname -m)-unknown-linux-gnu"
tmp="$(mktemp -d)"
echo "downloading uv from $UV_DOWNLOAD_URL/$target.tar.gz"
curl -fsSL "$UV_DOWNLOAD_URL/$target.tar.gz" -o "$tmp/uv.tar.gz"
tar -xzf "$tmp/uv.tar.gz" -C "$tmp"
mkdir -p "$UV_INSTALL_DIR"
cp "$tmp/$target/uv" "$UV_INSTALL_DIR/uv"
rm -rf "$tmp"
echo "everything's installed!"
"#;
