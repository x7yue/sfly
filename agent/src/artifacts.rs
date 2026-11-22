//! 产物上传（docs/ARCHITECTURE.md §5.3，#18）：任务结束后、上报结果之前，把工作目录下 `artifacts/`
//! 里的每个普通文件 `PUT <artifact_upload_url><按路径段百分号编码的相对路径>` 上传到控制面
//! （配置了注册令牌时带 `Authorization: Bearer <token>`）。符号链接和其他特殊文件被跳过。
//! 每个请求用 `x-sfly-agent-modified-ms` 头带上文件的修改时间（Agent 时间，Unix 毫秒；#171），
//! 取不到修改时间时不带这个头。
//!
//! 上传失败时（网络错误重试几次；控制面拒绝时不重试）：成功的任务改为 `node_error` 失败，
//! 失败的任务保留原来的错误、在消息后附上上传失败的原因。`artifact_upload_url` 为空时不上传。
//!
//! 产物合计的上限（`AssignTask.artifact_limit_bytes`，每个任务的合计，#477）：上传前先把产物目录加一遍
//! （兜住不经过 SDK 的 `save`、直接写进产物目录的文件，和旧版本 SDK）。合计没超限照常上传；超限时按文件从小到大
//! 上传放得下的，放不下的不传（不为它们发起请求）：成功的任务改为 `env_error` 失败（重试一遍还是超限，不按重试配置重试），
//! 失败的任务保留原来的错误类型和位置、信息在前，没上传的文件列在后面。上限是 0（旧版本控制面不带）时不预先检查，
//! 由控制面的上传接口拒绝。

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
/// 超限时错误信息里最多列出多少个没上传的文件（最大的优先），其余写个数。
const LISTED_FILES: usize = 10;

/// 合计超过上限：放得下的文件已经上传，这些没有上传。
struct OverLimit {
    total: u64,
    limit: u64,
    uploaded: usize,
    /// 没上传的文件（名称, 字节数），最大的在前，大小相同的按名称。
    skipped: Vec<(String, u64)>,
}

impl OverLimit {
    fn message(&self) -> String {
        let listed: Vec<String> = self
            .skipped
            .iter()
            .take(LISTED_FILES)
            .map(|(name, size)| format!("{name}（{size} 字节）"))
            .collect();
        let rest = self.skipped.len().saturating_sub(LISTED_FILES);
        let more = if rest > 0 {
            format!("，另有 {rest} 个")
        } else {
            String::new()
        };
        format!(
            "产物合计 {total} 字节，超过每个任务的产物合计上限 {limit} 字节（控制面的 SFLY_ARTIFACT_LIMIT_MB）。\
             放得下的 {uploaded} 个文件已上传，共 {skipped} 个文件没有上传：{listed}{more}。\n\
             办法：大文件留在这台机器上，在节点的输出里给出它在哪台 Agent 的哪个路径，\
             要用它的节点用 Agent 的文件能力直接读；或者让部署者调大 SFLY_ARTIFACT_LIMIT_MB",
            total = self.total,
            limit = self.limit,
            uploaded = self.uploaded,
            skipped = self.skipped.len(),
            listed = listed.join("、"),
        )
    }
}

/// 产物目录里的一个文件。
struct Found {
    /// 以 `/` 分隔的相对路径。
    name: String,
    path: PathBuf,
    size: u64,
}

/// 按上限安排上传：合计放得下时全部上传；放不下时从小到大上传放得下的，其余不传。
fn plan(files: Vec<Found>, limit: u64) -> (Vec<Found>, Option<OverLimit>) {
    let total: u64 = files.iter().map(|f| f.size).sum();
    if limit == 0 || total <= limit {
        return (files, None);
    }
    let mut by_size = files;
    by_size.sort_by(|a, b| (a.size, &a.name).cmp(&(b.size, &b.name)));
    let mut used = 0u64;
    let mut fits = 0;
    for file in &by_size {
        if used + file.size > limit {
            break;
        }
        used += file.size;
        fits += 1;
    }
    let skipped_files = by_size.split_off(fits);
    let mut skipped: Vec<(String, u64)> = skipped_files
        .into_iter()
        .map(|f| (f.name, f.size))
        .collect();
    skipped.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let over = OverLimit {
        total,
        limit,
        uploaded: by_size.len(),
        skipped,
    };
    (by_size, Some(over))
}

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
        let (over, upload) = self.upload_all(task, dir).await;
        // 要上报的原因：超限的说明在前（重试没用的那个），上传失败的原因在后。
        let mut reasons = Vec::new();
        if let Some(over) = &over {
            reasons.push(over.message());
        }
        if let Err(error) = upload {
            reasons.push(format!("上传产物失败：{error}"));
        }
        if reasons.is_empty() {
            return result;
        }
        let message = reasons.join("\n\n");
        eprintln!("task {}: {message}", task.task_id);
        if result.status() == TaskStatus::Success {
            // 超限用 env_error：重试一遍产物还是这么大，不按 retries 重试；上传被拒绝等仍是 node_error。
            let kind = if over.is_some() {
                ErrorKind::EnvError
            } else {
                ErrorKind::NodeError
            };
            return executor::failure(task, kind, message);
        }
        let mut result = result;
        if let Some(e) = result.error.as_mut() {
            e.message = format!("{}\n\n{message}", e.message);
        }
        result
    }

    /// 上传产物目录：返回（超限时放不下的文件的说明, 上传的结果）。
    async fn upload_all(
        &self,
        task: &AssignTask,
        dir: &Path,
    ) -> (Option<OverLimit>, Result<(), String>) {
        let files = match tokio::task::spawn_blocking({
            let dir = dir.to_path_buf();
            move || collect(&dir)
        })
        .await
        {
            Ok(Ok(files)) => files,
            Ok(Err(e)) => {
                return (
                    None,
                    Err(format!("读取产物目录 {} 失败：{e}", dir.display())),
                );
            }
            Err(e) => return (None, Err(e.to_string())),
        };
        let (to_upload, over) = plan(files, task.artifact_limit_bytes);
        for file in to_upload {
            if let Err(e) = self.upload(task, &file.name, &file.path).await {
                return (over, Err(e));
            }
        }
        (over, Ok(()))
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

/// 产物目录里的普通文件（以 `/` 分隔的相对路径、绝对路径、字节数），按名称排序。目录不存在时为空。
fn collect(dir: &Path) -> std::io::Result<Vec<Found>> {
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
                let size = entry.metadata()?.len();
                found.push(Found {
                    name,
                    path: entry.path(),
                    size,
                });
            }
        }
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(found)
}
