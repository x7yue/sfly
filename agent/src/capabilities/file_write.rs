//! Agent 能力 `files.write`：写入文件（`files.write`，节点流式发来内容）、从本地路径上传（`files.upload`）、
//! 删除文件（`files.delete`）。协议见 `proto/sfly/agent/v1/file_write.proto`。
//!
//! - 写入先写到目标所在目录里的临时文件（[`TempFile`]），收到全部内容后才改名为目标路径（[`receive`]）：写到一半失败、
//!   被取消、调用方断开时删除临时文件，目标路径上不会出现半截文件。
//! - 上传时由自己所在的 Agent 读本地文件，直接传给目标 Agent，不经过节点进程；目标是自己时就是本机复制。
//!
//! 路径是那台机器上的绝对路径，权限就是 Agent 进程的权限，不做沙箱。

use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::{Stream, StreamExt as _};
use tonic::{Request, Response, Status, Streaming};

use super::fs::{Doing, absolute, file_json, io_error, io_status, replied_file};
use super::transfer::{CHUNK, TempFile};
use super::{Capability, Host, Module};
use crate::calls::{BoxFuture, Call, CallError, Method, Target, on_target};
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
            .map_err(|error| io_error(&error, Doing::Delete(&path)))?;
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
    match fill(&mut parts, &path, &mut temp).await {
        Ok(()) => temp.commit().await,
        Err(status) => {
            temp.discard().await;
            Err(status)
        }
    }
}

/// 把各段 data 写进临时文件，直到 end（核对字节数）。
async fn fill(
    parts: &mut (impl Stream<Item = Result<WriteFileRequest, Status>> + Unpin),
    path: &str,
    temp: &mut TempFile,
) -> Result<(), Status> {
    let mut size: u64 = 0;
    loop {
        match next_part(parts).await? {
            Some(Part::Data(data)) => {
                temp.file
                    .write_all(&data)
                    .await
                    .map_err(|error| io_status(&error, path))?;
                size += data.len() as u64;
            }
            Some(Part::End(WriteFileEnd { size: sent })) => {
                if sent != size {
                    return Err(Status::data_loss(format!(
                        "写入 {path} 时收到 {size} 字节，发送方发出的是 {sent} 字节：没有改动 {path}"
                    )));
                }
                return Ok(());
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
    let local = |status: Status| call.target.local_error(status);
    let real = absolute(&local_path).map_err(local)?;
    let file = tokio::fs::File::open(&real)
        .await
        .map_err(|error| local(io_status(&error, &local_path)))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|error| local(io_status(&error, &local_path)))?;
    if !metadata.is_file() {
        return Err(local(Status::invalid_argument(format!(
            "{local_path} 不是文件"
        ))));
    }
    let source = Source::File {
        file,
        path: local_path,
    };
    send(&mut call, path, source).await
}

/// 要写入的内容从哪来。
enum Source {
    /// 调用方（节点）在请求之后发来。
    Caller,
    /// 自己所在的 Agent 这台机器上的文件。
    File { file: tokio::fs::File, path: String },
}

impl Source {
    /// 下一段内容；没有了时为 None。
    async fn next(&mut self, call: &mut Call<'_>) -> Result<Option<Vec<u8>>, CallError> {
        match self {
            Self::Caller => call.input().await,
            Self::File { file, path } => {
                let mut buf = vec![0u8; CHUNK];
                let n = file
                    .read(&mut buf)
                    .await
                    .map_err(|error| call.target.local_error(io_status(&error, path)))?;
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
    // 本机直接交给 [`receive`]（服务的 `write` 只接受 gRPC 收到的流，本机构造不出来），所以不用 `on_target!`。
    let mut sink: BoxFuture<'static, Result<FileInfo, Status>> = match target {
        Target::Local { .. } => Box::pin(receive(ReceiverStream::new(rx).map(Ok))),
        Target::Remote(remote) => {
            let mut client = AgentFileWriteClient::new(remote.channel());
            Box::pin(async move {
                replied_file(
                    client
                        .write(ReceiverStream::new(rx))
                        .await?
                        .into_inner()
                        .file,
                )
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
    call.rpc(async {
        on_target!(
            call.target,
            FileWrite,
            AgentFileWriteClient::delete(request)
        )
    })
    .await?;
    Ok(Value::Null)
}
