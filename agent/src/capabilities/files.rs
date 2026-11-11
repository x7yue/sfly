//! Agent 能力 `files`：列出文件（`files.list`）、查看文件属性（`files.stat`）。协议见 `proto/sfly/agent/v1/files.proto`。
//! 它是第一项文件类能力，名字里没有后缀；之后加的各自叫 `files.<操作>`（`files.read`、`files.write`、`files.watch`），
//! 方法名前缀和能力名不是一一对应的（`files.list` 属于能力 `files`，`files.download` 属于能力 `files.read`）。
//!
//! 路径是这台机器上的绝对路径，权限就是 Agent 进程的权限，不做沙箱。文件属性里的修改时间是这台机器的 Agent 时间，原样给出。

use std::ops::ControlFlow;

use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_stream::StreamExt as _;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status};

use super::fs::{
    BATCH, Pattern, Visit, absolute, file_info, file_json, io_status, replied_file, sorted_entries,
    walk,
};
use super::{Capability, Host, Module};
use crate::calls::{BoxFuture, BoxStream, Call, CallError, Method, on_target};
use crate::proto::agent_files_client::AgentFilesClient;
use crate::proto::agent_files_server::{AgentFiles, AgentFilesServer};
use crate::proto::{
    FileInfo, ListFilesRequest, ListFilesResponse, StatFileRequest, StatFileResponse,
};

pub const MODULE: Module = Module {
    capability: Capability {
        name: "files",
        version: 1,
    },
    methods: &[
        Method {
            name: "files.list",
            call: list_call,
        },
        Method {
            name: "files.stat",
            call: stat_call,
        },
    ],
    add_service,
};

fn add_service(routes: &mut tonic::service::RoutesBuilder, _host: &Host) {
    routes.add_service(AgentFilesServer::new(Files));
}

/// `AgentFiles` 服务：供其它 Agent 调用，也被自己所在的 Agent 直接调用（[`crate::calls::Target::Local`]）。
pub struct Files;

#[tonic::async_trait]
impl AgentFiles for Files {
    type ListStream = BoxStream<ListFilesResponse>;

    async fn list(
        &self,
        request: Request<ListFilesRequest>,
    ) -> Result<Response<Self::ListStream>, Status> {
        let ListFilesRequest {
            directory,
            pattern,
            recursive,
        } = request.into_inner();
        let root = absolute(&directory)?;
        let pattern = Pattern::new(&pattern);
        // 要列出的目录本身的错误（不存在、不是目录、没有权限）作为调用的错误；子目录的错误跳过。
        let top = tokio::task::spawn_blocking(move || sorted_entries(&root))
            .await
            .map_err(|error| Status::internal(format!("列出 {directory} 失败：{error}")))?
            .map_err(|error| io_status(&error, &directory))?;
        let (tx, rx) = mpsc::channel(4);
        tokio::task::spawn_blocking(move || {
            let mut batches = Batches {
                batch: Vec::new(),
                tx,
            };
            if walk(&directory, top, &pattern, recursive, &mut batches).is_continue() {
                let _ = batches.flush();
            }
        });
        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }

    async fn stat(
        &self,
        request: Request<StatFileRequest>,
    ) -> Result<Response<StatFileResponse>, Status> {
        let path = request.into_inner().path;
        let absolute = absolute(&path)?;
        let metadata = tokio::fs::metadata(&absolute)
            .await
            .map_err(|error| io_status(&error, &path))?;
        Ok(Response::new(StatFileResponse {
            file: Some(file_info(path, &metadata)),
        }))
    }
}

/// 列出的文件分批发给调用方；调用方已经放弃时停下。
struct Batches {
    batch: Vec<FileInfo>,
    tx: mpsc::Sender<Result<ListFilesResponse, Status>>,
}

impl Batches {
    /// 发出攒下的一批；调用方已经放弃时停下。
    fn flush(&mut self) -> ControlFlow<()> {
        if self.batch.is_empty() {
            return ControlFlow::Continue(());
        }
        let files = std::mem::take(&mut self.batch);
        match self.tx.blocking_send(Ok(ListFilesResponse { files })) {
            Ok(()) => ControlFlow::Continue(()),
            Err(_) => ControlFlow::Break(()),
        }
    }
}

impl Visit for Batches {
    type Stop = ();

    fn file(&mut self, file: FileInfo) -> ControlFlow<()> {
        self.batch.push(file);
        if self.batch.len() >= BATCH {
            return self.flush();
        }
        ControlFlow::Continue(())
    }
}

// ---- 节点调用（[`crate::calls`]）----

#[derive(Deserialize)]
struct ListArgs {
    directory: String,
    #[serde(default)]
    pattern: String,
    #[serde(default)]
    recursive: bool,
}

fn list_call(call: Call<'_>) -> BoxFuture<'_, Result<Value, CallError>> {
    Box::pin(list(call))
}

/// `files.list`：每个文件回复一项，结果为 null。
async fn list(mut call: Call<'_>) -> Result<Value, CallError> {
    let ListArgs {
        directory,
        pattern,
        recursive,
    } = call.args()?;
    let request = ListFilesRequest {
        directory,
        pattern,
        recursive,
    };
    let target = call.target;
    let mut stream = call
        .rpc(async { on_target!(stream target, Files, AgentFilesClient::list(request)) })
        .await?;
    while let Some(batch) = call.within(stream.next()).await? {
        for file in batch.map_err(|status| target.error(status))?.files {
            call.item(file_json(&file)).await?;
        }
    }
    Ok(Value::Null)
}

#[derive(Deserialize)]
struct StatArgs {
    path: String,
}

fn stat_call(call: Call<'_>) -> BoxFuture<'_, Result<Value, CallError>> {
    Box::pin(stat(call))
}

/// `files.stat`：结果是文件属性。
async fn stat(call: Call<'_>) -> Result<Value, CallError> {
    let StatArgs { path } = call.args()?;
    let request = StatFileRequest { path };
    let file = call
        .rpc(async {
            replied_file(on_target!(call.target, Files, AgentFilesClient::stat(request))?.file)
        })
        .await?;
    Ok(file_json(&file))
}
