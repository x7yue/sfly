//! Agent 能力 `files.write`：写入文件（`files.write`，节点流式发来内容）、从本地路径上传（`files.upload`）、
//! 删除文件（`files.delete`）。协议见 `proto/sfly/agent/v1/file_write.proto`。
//!
//! - 写入先写到目标所在目录里的临时文件，收到全部内容后才改名为目标路径（[`receive`]）：写到一半失败、被取消、
//!   调用方断开时删除临时文件，目标路径上不会出现半截文件。
//! - 上传时由自己所在的 Agent 读本地文件，直接传给目标 Agent，不经过节点进程；目标是自己时就是本机复制。
//!
//! 路径是那台机器上的绝对路径，权限就是 Agent 进程的权限，不做沙箱。

use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::{Stream, StreamExt as _};
use tonic::{Request, Response, Status, Streaming};

use super::files::{absolute, file_info, file_json, io_status};
use super::{Capability, Host, Module};
use crate::calls::{BoxFuture, Call, CallError, Method, Target};
use crate::proto::agent_file_write_client::AgentFileWriteClient;
use crate::proto::agent_file_write_server::{AgentFileWrite, AgentFileWriteServer};
use crate::proto::write_file_request::Part;
use crate::proto::{
    DeleteFileRequest, DeleteFileResponse, FileInfo, WriteFileEnd, WriteFileRequest,
    WriteFileResponse, WriteFileStart,
};

pub const MODULE: Module = Module {
    capability: Capability {
        name: "files.write",
        version: 1,
    },
    methods: &[
        Method {
            name: "files.write",
            call: write_call,
        },
        Method {
            name: "files.upload",
            call: upload_call,
        },
        Method {
            name: "files.delete",
            call: delete_call,
        },
    ],
    add_service,
};

fn add_service(routes: &mut tonic::service::RoutesBuilder, _host: &Host) {
    routes.add_service(AgentFileWriteServer::new(FileWrite));
}

/// 传给目标 Agent 时每段最多多少字节。
const CHUNK: usize = 256 * 1024;

/// `AgentFileWrite` 服务：供其它 Agent 调用，也被自己所在的 Agent 直接调用（[`Target::Local`]）。
pub struct FileWrite;

#[tonic::async_trait]
impl AgentFileWrite for FileWrite {
    async fn write(
        &self,
        request: Request<Streaming<WriteFileRequest>>,
    ) -> Result<Response<WriteFileResponse>, Status> {
        let file = receive(request.into_inner()).await?;
        Ok(Response::new(WriteFileResponse { file: Some(file) }))
    }

    async fn delete(
        &self,
        request: Request<DeleteFileRequest>,
    ) -> Result<Response<DeleteFileResponse>, Status> {
        let path = request.into_inner().path;
        let target = absolute(&path)?;
        let metadata = tokio::fs::symlink_metadata(&target)
            .await
            .map_err(|error| io_status(&error, &path))?;
        if metadata.is_dir() {
            return Err(Status::invalid_argument(format!(
                "{path} 是目录：只能删除文件"
            )));
        }
        tokio::fs::remove_file(&target)
            .await
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::PermissionDenied => {
                    Status::permission_denied(format!("没有权限删除 {path}"))
                }
                _ => io_status(&error, &path),
            })?;
        Ok(Response::new(DeleteFileResponse {}))
    }
}

/// 收下一次写入（start、若干 data、end），返回写好的文件的属性。收到 end 并核对字节数之后才改名为目标路径；
/// 在这之前出错、流结束或被丢弃（调用方放弃）时删除临时文件。
pub async fn receive(
    mut parts: impl Stream<Item = Result<WriteFileRequest, Status>> + Unpin,
) -> Result<FileInfo, Status> {
    let path = match next_part(&mut parts).await? {
        Some(Part::Start(WriteFileStart { path })) => path,
        _ => {
            return Err(Status::invalid_argument("写入文件的第一条消息必须是 start"));
        }
    };
    let mut temp = TempFile::create(&path).await?;
    let mut size: u64 = 0;
    loop {
        match next_part(&mut parts).await? {
            Some(Part::Data(data)) => {
                temp.file
                    .write_all(&data)
                    .await
                    .map_err(|error| io_status(&error, &path))?;
                size += data.len() as u64;
            }
            Some(Part::End(WriteFileEnd { size: sent })) => {
                if sent != size {
                    return Err(Status::data_loss(format!(
                        "写入 {path} 时收到 {size} 字节，发送方发出的是 {sent} 字节：没有改动 {path}"
                    )));
                }
                return temp.commit().await;
            }
            Some(Part::Start(_)) => {
                return Err(Status::invalid_argument("写入文件时收到第二条 start"));
            }
            None => {
                return Err(Status::aborted(format!(
                    "写入 {path} 在发完之前中断了：没有改动 {path}"
                )));
            }
        }
    }
}

async fn next_part(
    parts: &mut (impl Stream<Item = Result<WriteFileRequest, Status>> + Unpin),
) -> Result<Option<Part>, Status> {
    match parts.next().await {
        None => Ok(None),
        Some(message) => match message?.part {
            Some(part) => Ok(Some(part)),
            None => Err(Status::invalid_argument("写入文件的消息是空的")),
        },
    }
}

/// 进程内的临时文件序号：同一个目标的几次写入各用各的临时文件。
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 目标所在目录里的临时文件：没有 [`TempFile::commit`] 就被丢弃时删除。下载（[`super::file_read`]）也用它落盘。
pub(super) struct TempFile {
    /// 目标路径（给人看的写法，调用方给的）。
    path: String,
    target: PathBuf,
    temp: PathBuf,
    pub(super) file: tokio::fs::File,
    /// 目标已经是普通文件时它的权限位：替换后保留。
    mode: Option<u32>,
    committed: bool,
}

impl TempFile {
    pub(super) async fn create(path: &str) -> Result<Self, Status> {
        let target = absolute(path)?;
        let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
            return Err(Status::invalid_argument(format!("{path} 不是文件路径")));
        };
        let mode = match tokio::fs::symlink_metadata(&target).await {
            Ok(metadata) if metadata.is_dir() => {
                return Err(Status::invalid_argument(format!(
                    "{path} 是目录：只能写入文件"
                )));
            }
            Ok(metadata) if metadata.is_file() => Some(metadata.permissions().mode() & 0o7777),
            Ok(_) => None,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(io_status(&error, path)),
        };
        let name = name.to_string_lossy();
        // 文件名太长时临时文件名截短，免得超过文件系统的上限。
        let short: String = name.chars().take(100).collect();
        let mut attempt = 0;
        loop {
            let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0);
            let temp = dir.join(format!(
                ".{short}.sfly-{:x}-{seq:x}-{nanos:x}.tmp",
                std::process::id()
            ));
            let opened = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o666)
                .open(&temp)
                .await;
            match opened {
                Ok(file) => {
                    return Ok(Self {
                        path: path.to_string(),
                        target,
                        temp,
                        file,
                        mode,
                        committed: false,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt < 8 => {
                    attempt += 1;
                }
                Err(error) => return Err(create_status(&error, path, dir)),
            }
        }
    }

    /// 写完了：落盘、改名为目标路径，返回它的属性。
    pub(super) async fn commit(mut self) -> Result<FileInfo, Status> {
        let path = self.path.clone();
        let failed = |error: std::io::Error| io_status(&error, &path);
        self.file.flush().await.map_err(failed)?;
        self.file.sync_all().await.map_err(failed)?;
        if let Some(mode) = self.mode {
            tokio::fs::set_permissions(&self.temp, std::fs::Permissions::from_mode(mode))
                .await
                .map_err(failed)?;
        }
        tokio::fs::rename(&self.temp, &self.target)
            .await
            .map_err(failed)?;
        self.committed = true;
        let metadata = tokio::fs::metadata(&self.target).await.map_err(failed)?;
        Ok(file_info(path, &metadata))
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.temp);
        }
    }
}

/// 建不了临时文件：多半是目录不存在或没有写权限。
fn create_status(error: &std::io::Error, path: &str, dir: &Path) -> Status {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::NotFound => Status::not_found(format!("目录 {} 不存在", dir.display())),
        ErrorKind::PermissionDenied => Status::permission_denied(format!("没有权限写入 {path}")),
        ErrorKind::NotADirectory => Status::invalid_argument(format!("{} 不是目录", dir.display())),
        _ => io_status(error, path),
    }
}

// ---- 节点调用（[`crate::calls`]）----

#[derive(Deserialize)]
struct WriteArgs {
    path: String,
}

#[derive(Deserialize)]
struct UploadArgs {
    /// 自己所在的 Agent 这台机器上的文件（绝对路径）。
    local_path: String,
    path: String,
}

fn write_call(call: Call<'_>) -> BoxFuture<'_, Result<Value, CallError>> {
    Box::pin(write(call))
}

/// `files.write`：调用方在请求之后发来内容（[`crate::calls::input`]），结果是写好的文件的属性。
async fn write(mut call: Call<'_>) -> Result<Value, CallError> {
    let WriteArgs { path } = call.args()?;
    send(&mut call, path, Source::Caller).await
}

fn upload_call(call: Call<'_>) -> BoxFuture<'_, Result<Value, CallError>> {
    Box::pin(upload(call))
}

/// `files.upload`：自己所在的 Agent 读本地文件传给目标，结果是写好的文件的属性。
async fn upload(mut call: Call<'_>) -> Result<Value, CallError> {
    let UploadArgs { local_path, path } = call.args()?;
    // 本地文件的错误是自己所在的 Agent 上的。
    let own = Target::Local {
        name: call.target.own().to_string(),
    };
    let local = absolute(&local_path).map_err(|status| own.error(status))?;
    let file = tokio::fs::File::open(&local)
        .await
        .map_err(|error| own.error(io_status(&error, &local_path)))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|error| own.error(io_status(&error, &local_path)))?;
    if !metadata.is_file() {
        return Err(own.error(Status::invalid_argument(format!("{local_path} 不是文件"))));
    }
    let source = Source::File {
        file,
        path: local_path,
        own: own.name().to_string(),
    };
    send(&mut call, path, source).await
}

/// 要写入的内容从哪来。
enum Source {
    /// 调用方（节点）在请求之后发来。
    Caller,
    /// 自己所在的 Agent 这台机器上的文件。
    File {
        file: tokio::fs::File,
        path: String,
        /// 自己所在的 Agent 的名称（读文件出错时消息里写它）。
        own: String,
    },
}

impl Source {
    /// 下一段内容；没有了时为 None。
    async fn next(&mut self, call: &mut Call<'_>) -> Result<Option<Vec<u8>>, CallError> {
        match self {
            Self::Caller => call.input().await,
            Self::File { file, path, own } => {
                let mut buf = vec![0u8; CHUNK];
                let n = file.read(&mut buf).await.map_err(|error| {
                    Target::Local { name: own.clone() }.error(io_status(&error, path))
                })?;
                if n == 0 {
                    return Ok(None);
                }
                buf.truncate(n);
                Ok(Some(buf))
            }
        }
    }
}

/// 把内容写到目标 Agent 上的 `path`：一边从 `source` 取，一边交给目标（本机直接调用 [`receive`]，
/// 另一台用 gRPC）。等目标接收每一段、等最后的结果各自最多 [`Call::timeout`]。出错时丢下目标那一侧（不发 end），
/// 它随之删除临时文件。
async fn send(call: &mut Call<'_>, path: String, mut source: Source) -> Result<Value, CallError> {
    let target = call.target;
    let (tx, rx) = mpsc::channel::<WriteFileRequest>(2);
    let mut sink: BoxFuture<'static, Result<FileInfo, Status>> = match target {
        Target::Local { .. } => Box::pin(receive(ReceiverStream::new(rx).map(Ok))),
        Target::Remote(remote) => {
            let mut client = AgentFileWriteClient::new(remote.channel());
            Box::pin(async move {
                client
                    .write(ReceiverStream::new(rx))
                    .await?
                    .into_inner()
                    .file
                    .ok_or_else(|| Status::internal("回复里没有文件属性"))
            })
        }
    };
    {
        let push = push(call, tx, path, &mut source);
        tokio::pin!(push);
        tokio::select! {
            pushed = &mut push => pushed?,
            // 目标在收到 end 之前就结束了：只能是出错了（它只在收到 end 之后才成功）。
            done = &mut sink => {
                return done.map(|file| file_json(&file)).map_err(|status| target.error(status));
            }
        }
    }
    let file = call
        .within(sink)
        .await?
        .map_err(|status| target.error(status))?;
    Ok(file_json(&file))
}

/// 依次发 start、各段 data、end。目标那一侧已经结束（通道关闭）时停下，由它的结果说明原因。
async fn push(
    call: &mut Call<'_>,
    tx: mpsc::Sender<WriteFileRequest>,
    path: String,
    source: &mut Source,
) -> Result<(), CallError> {
    let message = |part| WriteFileRequest { part: Some(part) };
    if call
        .within(tx.send(message(Part::Start(WriteFileStart { path }))))
        .await?
        .is_err()
    {
        return Ok(());
    }
    let mut size: u64 = 0;
    while let Some(data) = source.next(call).await? {
        for chunk in data.chunks(CHUNK) {
            size += chunk.len() as u64;
            if call
                .within(tx.send(message(Part::Data(chunk.to_vec()))))
                .await?
                .is_err()
            {
                return Ok(());
            }
        }
    }
    let _ = call
        .within(tx.send(message(Part::End(WriteFileEnd { size }))))
        .await?;
    Ok(())
}

#[derive(Deserialize)]
struct DeleteArgs {
    path: String,
}

fn delete_call(call: Call<'_>) -> BoxFuture<'_, Result<Value, CallError>> {
    Box::pin(delete(call))
}

/// `files.delete`：结果为 null。
async fn delete(call: Call<'_>) -> Result<Value, CallError> {
    let DeleteArgs { path } = call.args()?;
    let request = DeleteFileRequest { path };
    let target = call.target;
    match target {
        Target::Local { .. } => call.within(FileWrite.delete(Request::new(request))).await?,
        Target::Remote(remote) => {
            call.within(AgentFileWriteClient::new(remote.channel()).delete(Request::new(request)))
                .await?
        }
    }
    .map_err(|status| target.error(status))?;
    Ok(Value::Null)
}
