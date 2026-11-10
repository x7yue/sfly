//! 产物上传（docs/ARCHITECTURE.md §5.3，#18）：任务结束后、上报结果之前，把工作目录下 `artifacts/`
//! 里的每个普通文件 `PUT <artifact_upload_url><按路径段百分号编码的相对路径>` 上传到控制面
//! （配置了注册令牌时带 `Authorization: Bearer <token>`）。符号链接和其他特殊文件被跳过。
//! 每个请求用 `x-sfly-agent-modified-ms` 头带上文件的修改时间（Agent 时间，Unix 毫秒；#171），
//! 取不到修改时间时不带这个头。
//!
//! 上传失败时（网络错误重试几次；控制面拒绝时不重试）：成功的任务改为 `node_error` 失败，
//! 失败的任务保留原来的错误、在消息后附上上传失败的原因。`artifact_upload_url` 为空时不上传。

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::clock;
use crate::executor;
use crate::proto::{AssignTask, ErrorKind, TaskResult, TaskStatus};

/// 网络错误 / 5xx 时的上传尝试次数。
const ATTEMPTS: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_millis(500);
/// 文件在 Agent 上的修改时间（Agent 时间，Unix 毫秒）。
const MODIFIED_MS_HEADER: &str = "x-sfly-agent-modified-ms";

pub struct Uploader {
    pub http: reqwest::Client,
    pub token: Option<String>,
}

impl Uploader {
    /// 上传任务的产物目录，返回最终要上报的结果。
    pub async fn finish(&self, task: &AssignTask, dir: &Path, result: TaskResult) -> TaskResult {
        if task.artifact_upload_url.is_empty() {
            return result;
        }
        let Err(error) = self.upload_all(task, dir).await else {
            return result;
        };
        let error = format!("上传产物失败：{error}");
        eprintln!("task {}: {error}", task.task_id);
        if result.status() == TaskStatus::Success {
            return executor::failure(task, ErrorKind::NodeError, error);
        }
        let mut result = result;
        if let Some(e) = result.error.as_mut() {
            e.message = format!("{}\n\n{error}", e.message);
        }
        result
    }

    async fn upload_all(&self, task: &AssignTask, dir: &Path) -> Result<(), String> {
        let files = tokio::task::spawn_blocking({
            let dir = dir.to_path_buf();
            move || collect(&dir)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("读取产物目录 {} 失败：{e}", dir.display()))?;
        for (name, path) in files {
            self.upload(task, &name, &path).await?;
        }
        Ok(())
    }

    async fn upload(&self, task: &AssignTask, name: &str, path: &Path) -> Result<(), String> {
        let mut url = reqwest::Url::parse(&task.artifact_upload_url)
            .map_err(|e| format!("上传地址 {} 无效：{e}", task.artifact_upload_url))?;
        url.path_segments_mut()
            .map_err(|_| format!("上传地址 {} 无效", task.artifact_upload_url))?
            .pop_if_empty()
            .extend(name.split('/'));
        let mut attempt = 1;
        loop {
            match self.put(&url, path).await {
                Ok(()) => return Ok(()),
                Err((retry, error)) if !retry || attempt >= ATTEMPTS => {
                    return Err(format!("{name}：{error}"));
                }
                Err(_) => {
                    attempt += 1;
                    tokio::time::sleep(RETRY_DELAY).await;
                }
            }
        }
    }

    /// 上传一个文件；失败时给出（是否值得重试, 原因）。
    async fn put(&self, url: &reqwest::Url, path: &Path) -> Result<(), (bool, String)> {
        let file = tokio::fs::File::open(path)
            .await
            .map_err(|e| (false, format!("打开 {} 失败：{e}", path.display())))?;
        let metadata = file
            .metadata()
            .await
            .map_err(|e| (false, format!("读取 {} 失败：{e}", path.display())))?;
        let len = metadata.len();
        let mut request = self
            .http
            .put(url.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .header(reqwest::header::CONTENT_LENGTH, len)
            .body(reqwest::Body::from(file));
        // 文件的修改时间是按系统时钟记的：换成 Agent 时间（测试用的偏移选项生效时加上偏移量）。
        let modified = metadata.modified().ok().map(clock::system_time_ms);
        if let Some(modified) = modified.map(clock::to_agent_time_ms) {
            request = request.header(MODIFIED_MS_HEADER, modified);
        }
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        let response = request
            .send()
            .await
            .map_err(|e| (true, format!("{url} ({e})")))?;
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let body = response.text().await.unwrap_or_default();
        Err((
            status.is_server_error(),
            format!("控制面返回 {status} {}", body.trim()),
        ))
    }
}

/// 产物目录里的普通文件：(以 `/` 分隔的相对路径, 绝对路径)，按名称排序。目录不存在时为空。
fn collect(dir: &Path) -> std::io::Result<Vec<(String, PathBuf)>> {
    let mut found = Vec::new();
    if !dir.is_dir() {
        return Ok(found);
    }
    let mut stack = vec![(dir.to_path_buf(), String::new())];
    while let Some((current, prefix)) = stack.pop() {
        for entry in std::fs::read_dir(&current)? {
            let entry = entry?;
            let Some(file_name) = entry.file_name().to_str().map(str::to_string) else {
                return Err(std::io::Error::other(format!(
                    "文件名不是 UTF-8：{}",
                    entry.path().display()
                )));
            };
            let name = format!("{prefix}{file_name}");
            // 不跟随符号链接：只上传产物目录里真正的文件。
            let kind = entry.file_type()?;
            if kind.is_dir() {
                stack.push((entry.path(), format!("{name}/")));
            } else if kind.is_file() {
                found.push((name, entry.path()));
            }
        }
    }
    found.sort();
    Ok(found)
}
