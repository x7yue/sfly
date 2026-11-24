//! 产物上传（docs/ARCHITECTURE.md §5.3，#18）：任务结束后、上报结果之前，把工作目录下 `artifacts/`
//! 里的每个普通文件 `PUT <artifact_upload_url><按路径段百分号编码的相对路径>` 上传到控制面
//! （配置了注册令牌时带 `Authorization: Bearer <token>`）。符号链接和其他特殊文件被跳过。
//! 每个请求用 `x-sfly-agent-modified-ms` 头带上文件的修改时间（Agent 时间，Unix 毫秒；#171），
//! 取不到修改时间时不带这个头。
//!
//! 上传失败时（网络错误、卡住、5xx 和 408 重试几次；控制面拒绝时不重试）：成功的任务改为 `node_error` 失败，
//! 失败的任务保留原来的错误、在消息后附上上传失败的原因。`artifact_upload_url` 为空时不上传。
//!
//! 每个请求有「多久没有进展」的上限（`--upload-idle-timeout`，默认 60 秒，#648）：连接建立、请求体被对方收下的每一块、
//! 发完之后等响应，各自这么久没有动静就算这次请求失败（照上面的规矩重试）。控制面接了连接却不回应、
//! 不读请求体时，任务不会一直卡在上传、占着槽位；大文件只要还在被收下就不会超时。
//! 上传期间任务收到新的取消请求（开始上传之后才到的取消，或者优雅取消之后又来的强制取消）时放弃上传，
//! 以失败的上传上报；开始上传之前已经有的取消（取消、超时进入收尾时间、控制面放弃）不打断上传。
//!
//! 产物合计的上限（`AssignTask.artifact_limit_bytes`，每个任务的合计，#477）：上传前先把产物目录加一遍
//! （兜住不经过 SDK 的 `save`、直接写进产物目录的文件，和旧版本 SDK）。合计没超限照常上传；超限时按文件从小到大
//! 上传放得下的，放不下的不传（不为它们发起请求）：成功的任务改为 `env_error` 失败（重试一遍还是超限，不按重试配置重试），
//! 失败的任务保留原来的错误类型和位置、信息在前，没上传的文件列在后面。上限是 0（旧版本控制面不带）时不预先检查，
//! 由控制面的上传接口拒绝。

use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, ReadBuf};
use tokio::time::Instant;
use tokio_stream::Stream;

use crate::clock;
use crate::executor;
use crate::proto::{AssignTask, ErrorKind, TaskResult, TaskStatus};

/// 网络错误、卡住、5xx、408 时的上传尝试次数。
const ATTEMPTS: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_millis(500);
/// 一次上传请求没有任何进展这么久就算卡住（`--upload-idle-timeout` 改）。控制面一侧读请求体 60 秒没有数据就回 408
/// （apps/server 的 `upload_idle_timeout`）：Agent 这一侧取同样的值，是对方不回应时自己的保证。
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// 每次从文件读多少字节交给请求体。
const CHUNK_BYTES: usize = 64 * 1024;
/// 文件在 Agent 上的修改时间（Agent 时间，Unix 毫秒）。
const MODIFIED_MS_HEADER: &str = "x-sfly-agent-modified-ms";
/// 超限时错误信息里最多列出多少个没上传的文件（最大的优先），其余写个数。
const LISTED_FILES: usize = 10;

/// 合计超过上限：放得下的文件上传，这些放不下的不上传。
struct OverLimit {
    total: u64,
    limit: u64,
    /// 放得下、打算上传的文件个数（实际上传了几个以上传的结果为准，见 `message`）。
    fitting: usize,
    /// 没上传的文件（名称, 字节数），最大的在前，大小相同的按名称。
    skipped: Vec<(String, u64)>,
}

impl OverLimit {
    /// 写给人看的说明；`sent` 是放得下的文件里实际上传成功的个数：上传中途失败时不说「已上传」。
    fn message(&self, sent: usize) -> String {
        let uploaded = if self.fitting == 0 {
            // 每个文件都比上限大：没有放得下的，不说「放得下的 0 个已上传」。
            "没有放得下的文件".to_string()
        } else if sent == self.fitting {
            format!("放得下的 {} 个文件已上传", self.fitting)
        } else {
            format!(
                "放得下的 {} 个文件里只上传了 {sent} 个（上传中途失败，原因在后面）",
                self.fitting
            )
        };
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
             {uploaded}，另有 {skipped} 个超限的文件没有上传：{listed}{more}。\n\
             办法：大文件留在这台机器上，在节点的输出里给出它在哪台 Agent 的哪个路径，\
             要用它的节点用 Agent 的文件能力直接读；或者让部署者调大 SFLY_ARTIFACT_LIMIT_MB",
            total = self.total,
            limit = self.limit,
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
    // 加法都用饱和加：上限接近 u64 的最大值时也不会溢出（控制面已经把上限限制在 2^53 − 1 以内，这是第二道）。
    let total: u64 = files.iter().fold(0, |sum, f| sum.saturating_add(f.size));
    if limit == 0 || total <= limit {
        return (files, None);
    }
    let mut by_size = files;
    by_size.sort_by(|a, b| (a.size, &a.name).cmp(&(b.size, &b.name)));
    let mut used = 0u64;
    let mut fits = 0;
    for file in &by_size {
        if used.saturating_add(file.size) > limit {
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
        fitting: by_size.len(),
        skipped,
    };
    (by_size, Some(over))
}

pub struct Uploader {
    pub http: reqwest::Client,
    pub token: Option<String>,
    /// 一次上传请求没有进展多久算卡住（[`DEFAULT_IDLE_TIMEOUT`]）。
    pub idle_timeout: Duration,
}

/// 一次请求的进展：请求开始、请求体每被取走一块、请求体读完时记一下时间；`stalled` 在这么久没有进展时返回。
/// 请求体停止被取走说明对方不再读（TCP 的发送缓冲满了），读完之后等响应也算在内。
struct Progress {
    last: Mutex<Instant>,
}

impl Progress {
    fn start() -> Arc<Self> {
        Arc::new(Self {
            last: Mutex::new(Instant::now()),
        })
    }

    fn touch(&self) {
        *self.last.lock().unwrap() = Instant::now();
    }

    async fn stalled(&self, idle: Duration) {
        loop {
            let deadline = *self.last.lock().unwrap() + idle;
            if Instant::now() >= deadline {
                return;
            }
            tokio::time::sleep_until(deadline).await;
        }
    }
}

/// 文件的请求体：每读出一块记一次进度，读完（文件结束）也记一次。
struct FileBody {
    file: tokio::fs::File,
    progress: Arc<Progress>,
    done: bool,
}

impl Stream for FileBody {
    type Item = std::io::Result<Vec<u8>>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.done {
            return Poll::Ready(None);
        }
        let mut chunk = vec![0u8; CHUNK_BYTES];
        let mut buf = ReadBuf::new(&mut chunk);
        match Pin::new(&mut self.file).poll_read(cx, &mut buf) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(error)) => Poll::Ready(Some(Err(error))),
            Poll::Ready(Ok(())) => {
                let read = buf.filled().len();
                self.progress.touch();
                if read == 0 {
                    self.done = true;
                    return Poll::Ready(None);
                }
                chunk.truncate(read);
                Poll::Ready(Some(Ok(chunk)))
            }
        }
    }
}

/// 开始上传之后才到的取消请求（见模块文档）；任务的取消信号的发送端没有了（任务已结束）时永远不返回。
async fn cancel_arrived(cancel: &mut executor::CancelSignal) {
    if cancel.changed().await.is_err() {
        std::future::pending::<()>().await;
    }
}

impl Uploader {
    /// 上传任务的产物目录，返回最终要上报的结果。
    pub async fn finish(
        &self,
        task: &AssignTask,
        dir: &Path,
        result: TaskResult,
        cancel: executor::CancelSignal,
    ) -> TaskResult {
        if task.artifact_upload_url.is_empty() {
            return result;
        }
        let (over, sent, upload) = self.upload_all(task, dir, cancel).await;
        // 要上报的原因：超限的说明在前（重试没用的那个），上传失败的原因在后。
        let mut reasons = Vec::new();
        if let Some(over) = &over {
            reasons.push(over.message(sent));
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

    /// 上传产物目录：返回（超限时放不下的文件的说明, 实际上传成功的个数, 上传的结果）。
    async fn upload_all(
        &self,
        task: &AssignTask,
        dir: &Path,
        mut cancel: executor::CancelSignal,
    ) -> (Option<OverLimit>, usize, Result<(), String>) {
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
                    0,
                    Err(format!("读取产物目录 {} 失败：{e}", dir.display())),
                );
            }
            Err(e) => return (None, 0, Err(e.to_string())),
        };
        let (to_upload, over) = plan(files, task.artifact_limit_bytes);
        // 开始上传之前已经有的取消请求不打断上传：取消的任务、超时进入收尾时间的任务照样上传它已经存下的产物。
        cancel.borrow_and_update();
        let mut sent = 0;
        for file in to_upload {
            let result = tokio::select! {
                result = self.upload(task, &file.name, &file.path) => result,
                () = cancel_arrived(&mut cancel) => {
                    Err(format!("{}：任务被取消，上传已放弃", file.name))
                }
            };
            if let Err(e) = result {
                return (over, sent, Err(e));
            }
            sent += 1;
        }
        (over, sent, Ok(()))
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
        let progress = Progress::start();
        let body = reqwest::Body::wrap_stream(FileBody {
            file,
            progress: progress.clone(),
            done: false,
        });
        let mut request = self
            .http
            .put(url.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .header(reqwest::header::CONTENT_LENGTH, len)
            .body(body);
        // 文件的修改时间是按系统时钟记的：换成 Agent 时间（测试用的偏移选项生效时加上偏移量）。
        let modified = metadata.modified().ok().map(clock::system_time_ms);
        if let Some(modified) = modified.map(clock::to_agent_time_ms) {
            request = request.header(MODIFIED_MS_HEADER, modified);
        }
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        let idle = self.idle_timeout;
        let response = tokio::select! {
            response = request.send() => {
                response.map_err(|e| (true, format!("{url} ({e})")))?
            }
            () = progress.stalled(idle) => {
                return Err((
                    true,
                    format!(
                        "{url} 超过 {} 秒没有进展（连接、发送请求体或等响应时对方没有动静）",
                        idle.as_secs()
                    ),
                ));
            }
        };
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        // 错误响应的内容也只等一个空闲超时：读不到就只写状态码。
        let body = tokio::time::timeout(idle, response.text())
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        // 5xx 和 408（控制面读请求体 60 秒没有数据时回的 `upload_idle_timeout`）值得重试，别的拒绝（413、403 等）重试没有用。
        let retry = status.is_server_error() || status == reqwest::StatusCode::REQUEST_TIMEOUT;
        Err((retry, format!("控制面返回 {status} {}", body.trim())))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn found(name: &str, size: u64) -> Found {
        Found {
            name: name.to_string(),
            path: PathBuf::from(name),
            size,
        }
    }

    #[test]
    fn plan_does_not_overflow_when_sizes_and_limit_are_near_the_u64_maximum() {
        // 总数饱和在 u64::MAX、比上限大：只上传放得下的，不 panic（调试构建里普通的加法会溢出 panic）。
        let half = u64::MAX / 2;
        let files = vec![
            found("big-a", half),
            found("big-b", half),
            found("small", 10),
        ];

        let (upload, over) = plan(files, u64::MAX - 1);

        let over = over.expect("合计（饱和后）超过上限");
        assert_eq!(over.total, u64::MAX);
        assert_eq!(
            upload.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            ["small", "big-a"],
            "小的先上传，放不下的是最后一个"
        );
        assert_eq!(over.skipped, vec![("big-b".to_string(), half)]);
    }

    #[test]
    fn plan_uploads_everything_when_the_total_fits_exactly() {
        let files = vec![found("a", 400), found("b", 600)];

        let (upload, over) = plan(files, 1_000);

        assert!(over.is_none());
        assert_eq!(upload.len(), 2);
    }

    #[test]
    fn plan_without_a_limit_checks_nothing() {
        let (upload, over) = plan(vec![found("a", u64::MAX), found("b", u64::MAX)], 0);

        assert!(over.is_none());
        assert_eq!(upload.len(), 2);
    }
}
