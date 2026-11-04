//! 测试支撑：节点包与 PyPI 镜像的桩。
//!
//! - [`HttpFixture`]：本地 HTTP 服务（随机端口），既充当控制面的节点包下载地址，
//!   也充当内网 PyPI 镜像（PEP 503 simple index，`<url>/simple/`）；可以给某个文件加延迟，并记录请求。
//! - [`build_node_package`]：用 `sfly build` 把桩节点源码（testdata/stub-package）按指定的包名、版本、依赖构建成 `.sflypkg`。
//! - [`dependency_wheel`]：手工生成一个只含空模块的纯 Python wheel，放进镜像当作第三方依赖。
//! - [`fresh_venv`]：每个测试独立的共享 venv（安装测试会修改 venv）。

use std::collections::HashMap;
use std::io::Write as _;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sfly_agent::proto::AssignTask;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::repo_root;

#[derive(Clone)]
struct File {
    body: Vec<u8>,
    content_type: &'static str,
    delay: Duration,
}

#[derive(Default)]
struct Files {
    by_path: HashMap<String, File>,
    /// 镜像中的项目（规范化名）→ wheel 文件名。
    projects: HashMap<String, Vec<String>>,
}

/// 本地 HTTP 桩服务：节点包归档下载 + PyPI simple index。
pub struct HttpFixture {
    pub url: String,
    files: Arc<Mutex<Files>>,
    requests: Arc<Mutex<Vec<String>>>,
}

impl HttpFixture {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let files = Arc::new(Mutex::new(Files::default()));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let (f, r) = (files.clone(), requests.clone());
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let (f, r) = (f.clone(), r.clone());
                tokio::spawn(async move {
                    let _ = serve(stream, f, r).await;
                });
            }
        });
        Self {
            url,
            files,
            requests,
        }
    }

    /// 在 `path` 上提供 `body`，返回完整 URL。
    pub fn put(&self, path: &str, body: Vec<u8>) -> String {
        self.put_with(path, body, "application/octet-stream", Duration::ZERO)
    }

    fn put_with(
        &self,
        path: &str,
        body: Vec<u8>,
        content_type: &'static str,
        delay: Duration,
    ) -> String {
        self.files.lock().unwrap().by_path.insert(
            path.to_string(),
            File {
                body,
                content_type,
                delay,
            },
        );
        format!("{}{path}", self.url)
    }

    /// 把 wheel 放进 PyPI 镜像；第一次下载这个文件时先等待 `delay`。
    pub fn add_to_index(&self, project: &str, filename: &str, body: Vec<u8>, delay: Duration) {
        self.put_with(
            &format!("/files/{filename}"),
            body,
            "application/octet-stream",
            delay,
        );
        let project = normalize(project);
        let mut files = self.files.lock().unwrap();
        files
            .projects
            .entry(project.clone())
            .or_default()
            .push(filename.to_string());
        let links: String = files.projects[&project]
            .iter()
            .map(|f| format!("<a href=\"/files/{f}\">{f}</a><br/>\n"))
            .collect();
        let page = format!("<!DOCTYPE html><html><body>\n{links}</body></html>\n");
        files.by_path.insert(
            format!("/simple/{project}/"),
            File {
                body: page.into_bytes(),
                content_type: "text/html",
                delay: Duration::ZERO,
            },
        );
    }

    /// 镜像地址（传给 Agent 的 `--index-url`）。
    pub fn index_url(&self) -> String {
        format!("{}/simple/", self.url)
    }

    /// 收到的请求路径（按到达顺序）。
    pub fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }

    pub fn count(&self, path: &str) -> usize {
        self.requests().iter().filter(|p| *p == path).count()
    }
}

fn normalize(name: &str) -> String {
    name.to_ascii_lowercase().replace(['_', '.'], "-")
}

async fn serve(
    mut stream: tokio::net::TcpStream,
    files: Arc<Mutex<Files>>,
    requests: Arc<Mutex<Vec<String>>>,
) -> std::io::Result<()> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let head = String::from_utf8_lossy(&buf).into_owned();
    let path = head
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .split(['?', '#'])
        .next()
        .unwrap_or("/")
        .to_string();
    requests.lock().unwrap().push(path.clone());
    // 延迟只作用于第一次请求（uv 可能为同一个文件发多次请求）。
    let file = files.lock().unwrap().by_path.get_mut(&path).map(|f| {
        let served = f.clone();
        f.delay = Duration::ZERO;
        served
    });
    match file {
        Some(file) => {
            tokio::time::sleep(file.delay).await;
            let header = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                file.content_type,
                file.body.len()
            );
            stream.write_all(header.as_bytes()).await?;
            stream.write_all(&file.body).await?;
        }
        None => {
            stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                )
                .await?;
        }
    }
    stream.shutdown().await
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 用 `sfly build` 构建一个节点包：源码取自 testdata/stub-package（节点 echo / sleep / about 等），
/// 包名、版本和依赖按参数生成。返回 `.sflypkg` 的内容。
pub fn build_node_package(name: &str, version: &str, dependencies: &[&str]) -> Vec<u8> {
    let dir = tempfile::tempdir().unwrap();
    let module = name.replace('-', "_");
    let src = dir.path().join("project/src").join(&module);
    std::fs::create_dir_all(&src).unwrap();
    std::fs::copy(
        repo_root().join("testdata/stub-package/src/sfly_stub/__init__.py"),
        src.join("__init__.py"),
    )
    .unwrap();
    let deps: Vec<String> = dependencies.iter().map(|d| format!("{d:?}")).collect();
    std::fs::write(
        dir.path().join("project/pyproject.toml"),
        format!(
            "[project]\nname = \"{name}\"\nversion = \"{version}\"\ndependencies = [{}]\n",
            deps.join(", ")
        ),
    )
    .unwrap();
    let out = dir.path().join("out");
    let status = std::process::Command::new("uv")
        .args(["run", "--locked", "--quiet", "sfly", "build"])
        .arg(dir.path().join("project"))
        .arg("--out")
        .arg(&out)
        .current_dir(repo_root())
        .stdout(std::process::Stdio::null())
        .status()
        .expect("run sfly build");
    assert!(status.success(), "sfly build failed");
    std::fs::read(out.join(format!("{name}-{version}.sflypkg"))).unwrap()
}

/// 一个只含空模块的纯 Python wheel（第三方依赖的桩），返回 (文件名, 内容)。
pub fn dependency_wheel(name: &str, version: &str) -> (String, Vec<u8>) {
    let dist = name.replace('-', "_");
    let filename = format!("{dist}-{version}-py3-none-any.whl");
    let info = format!("{dist}-{version}.dist-info");
    let files = [
        (
            format!("{dist}/__init__.py"),
            format!("VERSION = {version:?}\n"),
        ),
        (
            format!("{info}/METADATA"),
            format!("Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n"),
        ),
        (
            format!("{info}/WHEEL"),
            "Wheel-Version: 1.0\nGenerator: sfly-tests\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
                .to_string(),
        ),
    ];
    let mut record = String::new();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    for (path, content) in &files {
        zip.start_file(path.as_str(), options).unwrap();
        zip.write_all(content.as_bytes()).unwrap();
        record.push_str(&format!("{path},,\n"));
    }
    record.push_str(&format!("{info}/RECORD,,\n"));
    zip.start_file(format!("{info}/RECORD"), options).unwrap();
    zip.write_all(record.as_bytes()).unwrap();
    (filename, zip.finish().unwrap().into_inner())
}

/// 每个测试独立的共享 venv：`sdk_only` 时只装 SDK 运行时，否则同时装好 sfly-stub@0.1.0。
pub fn fresh_venv(sdk_only: bool) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let mut command = std::process::Command::new(repo_root().join("scripts/stub-venv.sh"));
    command.arg(dir.path().join("venv"));
    if sdk_only {
        command.arg("--sdk-only");
    }
    assert!(
        command.status().expect("run stub-venv.sh").success(),
        "stub-venv.sh failed"
    );
    dir
}

pub fn venv_of(dir: &tempfile::TempDir) -> std::path::PathBuf {
    dir.path().join("venv")
}

/// 派发给某个节点包版本的任务，带归档下载地址和 sha256。
pub fn package_task(
    task_id: &str,
    package: &str,
    version: &str,
    node: &str,
    inputs: serde_json::Value,
    archive: (&str, &str),
) -> AssignTask {
    let (url, sha256) = archive;
    AssignTask {
        task_id: task_id.to_string(),
        attempt: 1,
        package: package.into(),
        package_version: version.into(),
        node: node.into(),
        inputs_json: inputs.to_string(),
        timeout_seconds: 3600,
        run_id: "run-1".into(),
        node_id: format!("node-{node}"),
        package_sha256: sha256.into(),
        package_url: url.into(),
    }
}

/// 发布到桩服务上的节点包：(下载地址, sha256)。
pub struct Published {
    pub url: String,
    pub sha256: String,
}

impl Published {
    pub fn archive(&self) -> (&str, &str) {
        (&self.url, &self.sha256)
    }
}

/// 构建节点包并放到桩服务的 `/packages/<name>/versions/<version>/archive`。
pub fn publish(fixture: &HttpFixture, name: &str, version: &str, deps: &[&str]) -> Published {
    let bytes = build_node_package(name, version, deps);
    let sha256 = sha256_hex(&bytes);
    let url = fixture.put(
        &format!("/packages/{name}/versions/{version}/archive"),
        bytes,
    );
    Published { url, sha256 }
}
