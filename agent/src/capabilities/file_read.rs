//! Agent 能力 `files.read`：流式读取文件（`files.read`）、下载到本地路径（`files.download`）。
//! 协议见 `proto/sfly/agent/v1/file_read.proto`。
//!
//! - 读取：目标 Agent 打开文件后按块读出内容，经发起调用的 Agent 以 data 帧（[`Call::data`]）交给节点；
//!   读完时再给出打开的那个文件的属性（[`ReadFileEnd`]）。
//! - 下载：发起调用的 Agent 自己读目标 Agent 上的文件（同一个 `Read`），边收边写本机的临时文件
//!   （[`TempFile`]），完成并核对后改名为目标路径；数据不经过节点进程，节点只收到进度和结果。
//!   - 下载开始时的大小就是要下载的大小：读到它为止。内容都从打开的文件读，完成时按读完时这个文件的属性核对
//!     （不按路径再查看一次）：读的过程中它被删除、被截短或大小变了都以明确的错误失败，临时文件随之删除；
//!     只是被改名（日志轮转）时下载照常完成，结果里的路径是它现在的路径。
//!   - 连接中断时从已经写下的位置再读，要求读的还是原来那个文件（[`ReadFileRequest::expect`]）：它在同一目录里
//!     改了名时目标 Agent 找到它接着读；找不到时路径上没有文件是「不存在」，换成了另一个文件是「移走了」
//!     （[`ErrorKind::Moved`]），调用方据此决定去哪里找它。连续多次没有进展才失败。

use std::os::unix::fs::{DirEntryExt as _, FileExt as _, MetadataExt as _};
use std::path::Path;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt as _;
use tokio::sync::mpsc;
use tokio_stream::StreamExt as _;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Code, Request, Response, Status};

use super::fs::{absolute, file_info, file_json, io_status, replied_file};
use super::transfer::{CHUNK, TempFile};
use super::{Capability, Host, Module};
use crate::calls::{
    Backoff, BoxFuture, BoxStream, Call, CallError, ErrorKind, Method, Target, on_target,
};
use crate::proto::agent_file_read_client::AgentFileReadClient;
use crate::proto::agent_file_read_server::{AgentFileRead, AgentFileReadServer};
use crate::proto::{FileIdentity, FileInfo, ReadFileEnd, ReadFileRequest, ReadFileResponse};

pub const MODULE: Module = Module {
    capability: Capability {
        name: "files.read",
        version: 1,
    },
    methods: &[
        Method {
            name: "files.read",
            call: read_call,
        },
        Method {
            name: "files.download",
            call: download_call,
        },
    ],
    add_service,
};

fn add_service(routes: &mut tonic::service::RoutesBuilder, _host: &Host) {
    routes.add_service(AgentFileReadServer::new(FileRead));
}

/// 读出来还没发走的块最多攒几块：读得比对方收得快时停下来等，内存占用有上限。
const BUFFERED: usize = 8;

type ReadStream = BoxStream<ReadFileResponse>;

/// `AgentFileRead` 服务：供其它 Agent 调用，也被自己所在的 Agent 直接调用（[`Target::Local`]）。
pub struct FileRead;

#[tonic::async_trait]
impl AgentFileRead for FileRead {
    type ReadStream = ReadStream;

    async fn read(
        &self,
        request: Request<ReadFileRequest>,
    ) -> Result<Response<Self::ReadStream>, Status> {
        let ReadFileRequest {
            path,
            offset,
            length,
            expect,
            to_open_size,
        } = request.into_inner();
        absolute(&path)?;
        let (file, info) = tokio::task::spawn_blocking(move || open(&path, expect))
            .await
            .map_err(|error| Status::internal(format!("打开文件失败：{error}")))??;
        let length = length.or_else(|| to_open_size.then(|| info.size.saturating_sub(offset)));
        let (tx, rx) = mpsc::channel(BUFFERED);
        tokio::task::spawn_blocking(move || send_chunks(&file, info, offset, length, &tx));
        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }
}

/// 打开要读的文件（跟随符号链接），取得打开时的属性；目录不能读取。给了 `expect` 时读的必须是它：
/// 路径上已经不是它时（日志轮转时改了名）在同一目录里按文件标识找，属性里的路径是找到的路径。
fn open(path: &str, expect: Option<FileIdentity>) -> Result<(std::fs::File, FileInfo), Status> {
    let opened = open_path(path);
    let Some(want) = expect else {
        return opened;
    };
    match opened {
        Ok((file, info)) if is(&info, &want) => Ok((file, info)),
        Err(status) if status.code() != Code::NotFound => Err(status),
        opened => match find_in_dir(path, &want).and_then(|found| open_path(&found).ok()) {
            Some((file, info)) if is(&info, &want) => Ok((file, info)),
            _ if opened.is_err() => Err(Status::not_found(format!(
                "{path} 不存在（原来的文件在同一目录里也找不到）"
            ))),
            _ => Err(Status::failed_precondition(format!(
                "{path} 已经不是原来的文件（路径上换成了另一个文件，原来的文件在同一目录里也找不到）"
            ))),
        },
    }
}

fn open_path(path: &str) -> Result<(std::fs::File, FileInfo), Status> {
    let file = std::fs::File::open(path).map_err(|error| io_status(&error, path))?;
    let metadata = file.metadata().map_err(|error| io_status(&error, path))?;
    if metadata.is_dir() {
        return Err(Status::invalid_argument(format!("{path} 是目录，不能读取")));
    }
    Ok((file, file_info(path.to_string(), &metadata)))
}

fn is(info: &FileInfo, want: &FileIdentity) -> bool {
    (info.device, info.inode) == (want.device, want.inode)
}

/// 在 `path` 所在的目录里按文件标识找一个文件（日志轮转通常只是在同一目录里改名），返回它的路径。
/// 先按目录项里的 inode 筛，只对筛出来的查看属性，目录里文件很多时也不慢。
fn find_in_dir(path: &str, want: &FileIdentity) -> Option<String> {
    let dir = Path::new(path).parent()?;
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|entry| entry.ino() == want.inode)
        .map(|entry| entry.path())
        .find(|found| {
            std::fs::metadata(found).is_ok_and(|m| (m.dev(), m.ino()) == (want.device, want.inode))
        })
        .and_then(|found| found.to_str().map(str::to_string))
}

/// 打开的文件 `metadata` 现在在哪里：还在 `path` 上就是 `path`，在同一目录里改了名就是新路径，找不到时仍是 `path`。
fn located(path: &str, metadata: &std::fs::Metadata) -> String {
    let want = FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    };
    let here =
        std::fs::metadata(path).is_ok_and(|m| (m.dev(), m.ino()) == (want.device, want.inode));
    if here {
        return path.to_string();
    }
    find_in_dir(path, &want).unwrap_or_else(|| path.to_string())
}

/// 先发打开时的属性，再从 `offset` 起按块发内容，到 `length` 字节或文件末尾为止，最后发读完时这个文件的属性；
/// 调用方放弃时停下。
fn send_chunks(
    file: &std::fs::File,
    opened: FileInfo,
    offset: u64,
    length: Option<u64>,
    tx: &mpsc::Sender<Result<ReadFileResponse, Status>>,
) {
    let path = opened.path.clone();
    let first = ReadFileResponse {
        file: Some(opened),
        ..Default::default()
    };
    if tx.blocking_send(Ok(first)).is_err() {
        return;
    }
    let mut position = offset;
    let mut remaining = length.unwrap_or(u64::MAX);
    while remaining > 0 {
        let want = usize::try_from(remaining).map_or(CHUNK, |r| r.min(CHUNK));
        let mut data = vec![0; want];
        let n = match file.read_at(&mut data, position) {
            Ok(0) => break,
            Ok(n) => n,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                let _ = tx.blocking_send(Err(io_status(&error, &path)));
                return;
            }
        };
        data.truncate(n);
        position += n as u64;
        remaining -= n as u64;
        let chunk = ReadFileResponse {
            data,
            ..Default::default()
        };
        if tx.blocking_send(Ok(chunk)).is_err() {
            return;
        }
    }
    let end = match file.metadata() {
        Ok(metadata) => Ok(ReadFileResponse {
            end: Some(ReadFileEnd {
                file: Some(file_info(located(&path, &metadata), &metadata)),
                links: metadata.nlink(),
            }),
            ..Default::default()
        }),
        Err(error) => Err(io_status(&error, &path)),
    };
    let _ = tx.blocking_send(end);
}

/// 在目标 Agent 上读一个文件：本机直接调用服务的实现，另一台 Agent 用 gRPC。
async fn open_stream(target: &Target, request: ReadFileRequest) -> Result<ReadStream, Status> {
    on_target!(stream target, FileRead, AgentFileReadClient::read(request))
}

// ---- 节点调用（[`crate::calls`]）----

#[derive(Deserialize)]
struct ReadArgs {
    path: String,
    #[serde(default)]
    offset: u64,
    #[serde(default)]
    length: Option<u64>,
}

fn read_call(call: Call<'_>) -> BoxFuture<'_, Result<Value, CallError>> {
    Box::pin(read(call))
}

/// `files.read`：内容以 data 帧依次回复，结果为 null。
async fn read(mut call: Call<'_>) -> Result<Value, CallError> {
    let ReadArgs {
        path,
        offset,
        length,
    } = call.args()?;
    let target = call.target;
    let request = ReadFileRequest {
        path,
        offset,
        length,
        ..Default::default()
    };
    let mut stream = call
        .within(open_stream(target, request))
        .await?
        .map_err(|status| target.error(status))?;
    while let Some(response) = call.within(stream.next()).await? {
        let response = response.map_err(|status| target.error(status))?;
        if !response.data.is_empty() {
            call.data(&response.data).await?;
        }
    }
    Ok(Value::Null)
}

#[derive(Deserialize)]
struct DownloadArgs {
    path: String,
    /// 自己所在的 Agent 上的目标路径（绝对路径）。
    local_path: String,
}

/// 连接中断后最多连续重连几次没有进展（重连之后收到了内容就重新计数）。
const ATTEMPTS: u32 = 8;

/// 下载期间多久回复一次进度：节点据此知道调用还活着（SDK 在超时之外多等几秒），也可以显示进度。
const PROGRESS_EVERY: Duration = Duration::from_secs(1);

fn download_call(call: Call<'_>) -> BoxFuture<'_, Result<Value, CallError>> {
    Box::pin(download(call))
}

/// `files.download`：每隔一段时间回复一项进度 `{"downloaded", "size"}`，结果是完成时源文件的属性。
async fn download(mut call: Call<'_>) -> Result<Value, CallError> {
    let DownloadArgs { path, local_path } = call.args()?;
    let target = call.target;
    // 本机（目标路径）上的错误：消息写明是自己所在的 Agent。
    let local = |status: Status| target.local_error(status);
    let dest = absolute(&local_path).map_err(local)?;
    // 目标所在的目录不存在时一并创建（下载到本地常常是新目录）。
    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|error| local(io_status(&error, &dir.to_string_lossy())))?;
    }
    let mut temp = TempFile::create(&local_path).await.map_err(local)?;
    let (now, written) = match receive(&mut call, &path, &local_path, &mut temp).await {
        Ok(done) => done,
        Err(error) => {
            temp.discard().await;
            return Err(error);
        }
    };
    // 落盘、改名为目标路径。落盘可能要一会儿（大文件还有很多没写到磁盘的内容）：照常回复进度。
    let commit = temp.commit();
    tokio::pin!(commit);
    loop {
        tokio::select! {
            committed = &mut commit => {
                committed.map_err(local)?;
                break;
            }
            () = tokio::time::sleep(PROGRESS_EVERY) => call.item(progress(written, written)).await?,
        }
    }
    Ok(file_json(&now))
}

/// 把源文件读到临时文件里，连接中断时从断点继续；完成后按读完时打开的那个文件核对，返回它这时的属性
/// （路径是它现在的路径）和写下的字节数。
async fn receive(
    call: &mut Call<'_>,
    path: &str,
    local_path: &str,
    temp: &mut TempFile,
) -> Result<(FileInfo, u64), CallError> {
    let target = call.target;
    let no_file = |status| target.error(status);
    // 源文件现在的路径：续传时目标 Agent 在同一目录里找到改了名的它，之后从新路径读。
    let mut current = path.to_string();
    // 开始时打开的文件：要下载它的这么多字节，续传时要求还是它。
    let mut source: Option<FileInfo> = None;
    let mut written = 0u64;
    let mut failures = 0u32;
    let mut backoff = Backoff::new();
    let mut reported = Instant::now();
    let end: ReadFileEnd = 'attempts: loop {
        let interrupted = 'attempt: {
            let request = ReadFileRequest {
                path: current.clone(),
                offset: written,
                length: source.as_ref().map(|file| file.size - written),
                expect: source.as_ref().map(|file| FileIdentity {
                    device: file.device,
                    inode: file.inode,
                }),
                to_open_size: true,
            };
            let mut stream = match call.within(open_stream(target, request)).await? {
                Ok(stream) => stream,
                Err(status) => break 'attempt status,
            };
            loop {
                let response = match call.within(stream.next()).await? {
                    None => break 'attempt Status::internal("回复不完整：没有读完时的文件属性"),
                    Some(Err(status)) => break 'attempt status,
                    Some(Ok(response)) => response,
                };
                if let Some(file) = response.file {
                    current.clone_from(&file.path);
                    source.get_or_insert(file);
                }
                let size = replied_file(source.clone()).map_err(no_file)?.size;
                // 只要下载开始时的那么多（目标 Agent 也只读到这里）。
                let take = usize::try_from(size - written)
                    .map_or(response.data.len(), |rest| rest.min(response.data.len()));
                if take > 0 {
                    temp.file
                        .write_all(&response.data[..take])
                        .await
                        .map_err(|error| target.local_error(io_status(&error, local_path)))?;
                    written += take as u64;
                    failures = 0;
                    backoff.reset();
                }
                if let Some(end) = response.end {
                    break 'attempts end;
                }
                if reported.elapsed() >= PROGRESS_EVERY {
                    call.item(progress(written, size)).await?;
                    reported = Instant::now();
                }
            }
        };
        if !target.interrupted(&interrupted) {
            return Err(changed(target, path, interrupted, source.is_some()));
        }
        failures += 1;
        if failures > ATTEMPTS {
            let error = target.error(interrupted);
            return Err(CallError::new(
                error.kind,
                format!(
                    "下载 {path} 时连接中断，连续重连 {ATTEMPTS} 次都没有成功：{}",
                    error.message
                ),
            ));
        }
        if let Some(file) = &source {
            call.item(progress(written, file.size)).await?;
            reported = Instant::now();
        }
        tokio::time::sleep(backoff.wait()).await;
    };

    // 完成：按读完时打开的那个文件核对，确认下载下来的就是它现在的全部内容。
    let start = replied_file(source).map_err(no_file)?.size;
    let now = replied_file(end.file).map_err(no_file)?;
    let name = target.name();
    let failed = |kind, what: String| {
        Err(CallError::new(
            kind,
            format!("Agent {name}：{path} 在下载期间{what}，下载作废"),
        ))
    };
    if end.links == 0 {
        return failed(ErrorKind::NotFound, "被删除".into());
    }
    if written < start {
        return failed(
            ErrorKind::Failed,
            format!(
                "被截短（开始时 {start} 字节，读到第 {written} 字节就到了末尾，现在 {} 字节）",
                now.size
            ),
        );
    }
    if now.size != written {
        return failed(
            ErrorKind::Failed,
            format!(
                "变化了（开始时 {start} 字节，现在 {} 字节，可能还在写入）",
                now.size
            ),
        );
    }
    Ok((now, written))
}

/// 下载进度：已经写下的字节数、要下载的字节数。
fn progress(downloaded: u64, size: u64) -> Value {
    json!({ "downloaded": downloaded, "size": size })
}

/// 读源文件失败。续传时（`started`）原来的文件已经不在路径上、在同一目录里也找不到：路径上没有文件说成被删除
/// （也可能移到了别的目录），路径上换成了另一个文件说成被移走（[`ErrorKind::Moved`]）。
fn changed(target: &Target, path: &str, status: Status, started: bool) -> CallError {
    let name = target.name();
    match status.code() {
        Code::NotFound if started => CallError::new(
            ErrorKind::NotFound,
            format!("Agent {name}：{path} 在下载期间被删除（或移到了别的目录），下载作废"),
        ),
        Code::FailedPrecondition if started => CallError::new(
            ErrorKind::Moved,
            format!(
                "Agent {name}：{path} 在下载期间被移走（路径上换成了另一个文件，原来的文件不在同一目录里），下载作废"
            ),
        ),
        _ => target.error(status),
    }
}
