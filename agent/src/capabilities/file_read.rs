//! Agent 能力 `files.read`：流式读取文件（`files.read`）、下载到本地路径（`files.download`）。
//! 协议见 `proto/sfly/agent/v1/file_read.proto`。
//!
//! - 读取：目标 Agent 按块读出文件内容，经发起调用的 Agent 以 data 帧（[`Call::data`]）交给节点。
//! - 下载：发起调用的 Agent 自己读目标 Agent 上的文件（同一个 `Read`），边收边写本机的临时文件
//!   （与写入共用 [`TempFile`]），完成并核对后改名为目标路径；数据不经过节点进程，节点只收到进度和结果。连接中断时从已经写下的位置再读
//!   （确认路径上还是原来那个文件），连续多次没有进展才失败。下载开始时的大小就是要下载的大小：读到它为止，
//!   完成时再查看一次源文件，被删除、被替换、被截短或大小变了都以明确的错误失败，临时文件随之删除。

use std::os::unix::fs::FileExt as _;
use std::path::Path;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt as _;
use tokio::sync::mpsc;
use tokio_stream::StreamExt as _;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Code, Request, Response, Status};

use super::files::Files;
use super::fs::{absolute, file_info, file_json, io_status, replied_file};
use super::transfer::{CHUNK, TempFile};
use super::{Capability, Host, Module};
use crate::calls::{
    Backoff, BoxFuture, BoxStream, Call, CallError, ErrorKind, Method, Target, on_target,
};
use crate::proto::agent_file_read_client::AgentFileReadClient;
use crate::proto::agent_file_read_server::{AgentFileRead, AgentFileReadServer};
use crate::proto::agent_files_client::AgentFilesClient;
use crate::proto::agent_files_server::AgentFiles as _;
use crate::proto::{FileIdentity, FileInfo, ReadFileRequest, ReadFileResponse, StatFileRequest};

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
        } = request.into_inner();
        let real = absolute(&path)?;
        let (file, info) = {
            let path = path.clone();
            tokio::task::spawn_blocking(move || open(&real, &path))
                .await
                .map_err(|error| Status::internal(format!("打开文件失败：{error}")))??
        };
        if let Some(expect) = expect
            && (expect.device, expect.inode) != (info.device, info.inode)
        {
            return Err(Status::failed_precondition(format!(
                "{path} 已经不是原来的文件（原来的文件被改名或删除，路径上换成了另一个文件）"
            )));
        }
        let (tx, rx) = mpsc::channel(BUFFERED);
        let first = ReadFileResponse {
            file: Some(info),
            data: Vec::new(),
        };
        tokio::task::spawn_blocking(move || send_chunks(&file, &path, offset, length, first, &tx));
        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }
}

/// 打开要读的文件（跟随符号链接），取得打开时的属性；目录不能读取。
fn open(real: &Path, path: &str) -> Result<(std::fs::File, FileInfo), Status> {
    let file = std::fs::File::open(real).map_err(|error| io_status(&error, path))?;
    let metadata = file.metadata().map_err(|error| io_status(&error, path))?;
    if metadata.is_dir() {
        return Err(Status::invalid_argument(format!("{path} 是目录，不能读取")));
    }
    Ok((file, file_info(path.to_string(), &metadata)))
}

/// 先发打开时的属性，再从 `offset` 起按块发内容，到 `length` 字节或文件末尾为止；调用方放弃时停下。
fn send_chunks(
    file: &std::fs::File,
    path: &str,
    offset: u64,
    length: Option<u64>,
    first: ReadFileResponse,
    tx: &mpsc::Sender<Result<ReadFileResponse, Status>>,
) {
    if tx.blocking_send(Ok(first)).is_err() {
        return;
    }
    let mut position = offset;
    let mut remaining = length.unwrap_or(u64::MAX);
    while remaining > 0 {
        let want = usize::try_from(remaining).map_or(CHUNK, |r| r.min(CHUNK));
        let mut data = vec![0; want];
        let n = match file.read_at(&mut data, position) {
            Ok(0) => return,
            Ok(n) => n,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                let _ = tx.blocking_send(Err(io_status(&error, path)));
                return;
            }
        };
        data.truncate(n);
        position += n as u64;
        remaining -= n as u64;
        if tx
            .blocking_send(Ok(ReadFileResponse { file: None, data }))
            .is_err()
        {
            return;
        }
    }
}

/// 在目标 Agent 上读一个文件：本机直接调用服务的实现，另一台 Agent 用 gRPC。
async fn open_stream(target: &Target, request: ReadFileRequest) -> Result<ReadStream, Status> {
    on_target!(stream target, FileRead, AgentFileReadClient::read(request))
}

/// 查看目标 Agent 上一个文件的属性（能力 files 的 `Stat`）。
async fn stat(target: &Target, path: &str) -> Result<FileInfo, Status> {
    let request = StatFileRequest {
        path: path.to_string(),
    };
    replied_file(on_target!(target, Files, AgentFilesClient::stat(request))?.file)
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
        expect: None,
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

/// 把源文件读到临时文件里，连接中断时从断点继续；完成后核对源文件，返回它这时的属性和写下的字节数。
async fn receive(
    call: &mut Call<'_>,
    path: &str,
    local_path: &str,
    temp: &mut TempFile,
) -> Result<(FileInfo, u64), CallError> {
    let target = call.target;
    let mut source: Option<FileInfo> = None;
    let mut written = 0u64;
    let mut failures = 0u32;
    let mut backoff = Backoff::new();
    let mut reported = Instant::now();
    'attempts: loop {
        let interrupted = 'attempt: {
            let request = ReadFileRequest {
                path: path.to_string(),
                offset: written,
                length: None,
                expect: source.as_ref().map(|file| FileIdentity {
                    device: file.device,
                    inode: file.inode,
                }),
            };
            let mut stream = match call.within(open_stream(target, request)).await? {
                Ok(stream) => stream,
                Err(status) => break 'attempt status,
            };
            loop {
                let response = match call.within(stream.next()).await? {
                    // 读到了文件末尾：是否读全，下面核对。
                    None => break 'attempts,
                    Some(Err(status)) => break 'attempt status,
                    Some(Ok(response)) => response,
                };
                if source.is_none() {
                    source = response.file;
                }
                let size = replied_file(source.clone())
                    .map_err(|status| target.error(status))?
                    .size;
                // 只要下载开始时的那么多：之后续写的部分不要（完成时按大小变了报错）。
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
                if written >= size {
                    break 'attempts;
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
    }

    let source = replied_file(source).map_err(|status| target.error(status))?;
    // 完成：再查看一次源文件，确认下载下来的就是它现在的全部内容。
    let now = loop {
        match call.within(stat(target, path)).await? {
            Ok(file) => break file,
            Err(status) if target.interrupted(&status) && failures < ATTEMPTS => {
                failures += 1;
                tokio::time::sleep(backoff.wait()).await;
            }
            Err(status) => return Err(changed(target, path, status, true)),
        }
    };
    let name = target.name();
    if (now.device, now.inode) != (source.device, source.inode) {
        return Err(CallError::new(
            ErrorKind::Failed,
            format!(
                "Agent {name}：{path} 在下载期间被替换（原来的文件被改名或删除，路径上换成了另一个文件），下载作废"
            ),
        ));
    }
    if written < source.size {
        return Err(CallError::new(
            ErrorKind::Failed,
            format!(
                "Agent {name}：{path} 在下载期间被截短（开始时 {} 字节，读到第 {written} 字节就到了末尾，现在 {} 字节），下载作废",
                source.size, now.size
            ),
        ));
    }
    if now.size != written {
        return Err(CallError::new(
            ErrorKind::Failed,
            format!(
                "Agent {name}：{path} 在下载期间变化了（开始时 {} 字节，现在 {} 字节，可能还在写入），下载作废",
                source.size, now.size
            ),
        ));
    }
    Ok((now, written))
}

/// 下载进度：已经写下的字节数、要下载的字节数。
fn progress(downloaded: u64, size: u64) -> Value {
    json!({ "downloaded": downloaded, "size": size })
}

/// 读源文件失败。已经开始下载（`started`）之后文件不存在、换成了别的文件，说成是下载期间发生的。
fn changed(target: &Target, path: &str, status: Status, started: bool) -> CallError {
    let name = target.name();
    match status.code() {
        Code::NotFound if started => CallError::new(
            ErrorKind::NotFound,
            format!("Agent {name}：{path} 在下载期间被删除，下载作废"),
        ),
        Code::FailedPrecondition if started => CallError::new(
            ErrorKind::Failed,
            format!(
                "Agent {name}：{path} 在下载期间被替换（原来的文件被改名或删除，路径上换成了另一个文件），下载作废"
            ),
        ),
        _ => target.error(status),
    }
}
