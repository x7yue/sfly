//! Agent 的**本地 socket**（Unix domain socket，默认 `<work_dir>/agent.sock`，权限 0600）：只有本机、运行 Agent 的用户
//! 可以连接，不经过供其它 Agent 连接的端口（[`crate::peer`]）。
//!
//! 每个连接先发一行 JSON 请求，`command` 决定怎么处理：
//!
//! - `dev`：`sfly dev` 加载开发版本（[`crate::dev`]），Agent 回复一行 JSON 后关闭连接；
//! - `call`：节点调用 Agent 能力（[`crate::calls`]，执行器的环境变量 `SFLY_AGENT_SOCKET` 指向这个 socket），
//!   Agent 回复若干行后关闭连接。
//!
//! socket 文件已存在时先删除（上一次运行留下的）。绑定失败时返回错误，由调用方决定是否继续运行。

use std::path::Path;
use std::sync::Arc;

use anyhow::Context as _;
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader};

use crate::Runtime;
use crate::calls::CallRequest;
use crate::dev::{DevReply, DevRequest};

/// 请求的大小上限（`sfly dev` 的元信息里有全部节点的 schema）。
const MAX_REQUEST: u64 = 16 * 1024 * 1024;

#[derive(Deserialize)]
struct Command {
    command: String,
}

#[cfg(unix)]
pub(crate) fn serve(
    path: &Path,
    runtime: Arc<Runtime>,
) -> anyhow::Result<tokio::task::JoinHandle<()>> {
    use std::os::unix::fs::PermissionsExt as _;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let _ = std::fs::remove_file(path);
    let listener = tokio::net::UnixListener::bind(path)
        .with_context(|| format!("bind local socket {}", path.display()))?;
    // 只有运行 Agent 的用户可以连接。
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let runtime = runtime.clone();
            tokio::spawn(async move { connection(stream, runtime).await });
        }
    }))
}

#[cfg(unix)]
async fn connection(stream: tokio::net::UnixStream, runtime: Arc<Runtime>) {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read);
    let mut line = String::new();
    let read = (&mut reader).take(MAX_REQUEST).read_line(&mut line).await;
    let reply = match read {
        Err(error) => DevReply::error(format!("读取请求失败：{error}")),
        Ok(_) => match serde_json::from_str::<Command>(&line) {
            Err(error) => DevReply::error(format!("无法解析请求：{error}")),
            Ok(command) => match command.command.as_str() {
                "dev" => match serde_json::from_str::<DevRequest>(&line) {
                    Ok(request) => runtime.load_dev(request).await,
                    Err(error) => DevReply::error(format!("无法解析请求：{error}")),
                },
                "call" => {
                    match serde_json::from_str::<CallRequest>(&line) {
                        Ok(request) => runtime.call(request, reader, write).await,
                        Err(error) => {
                            let frame = serde_json::json!({ "error": {
                                "kind": "invalid", "message": format!("无法解析调用请求：{error}"), "agent": runtime.name,
                            }});
                            let mut bytes = frame.to_string().into_bytes();
                            bytes.push(b'\n');
                            let _ = write.write_all(&bytes).await;
                            let _ = write.shutdown().await;
                        }
                    }
                    return;
                }
                other => DevReply::error(format!("未知命令 {other:?}")),
            },
        },
    };
    let mut bytes = serde_json::to_vec(&reply).unwrap_or_default();
    bytes.push(b'\n');
    let _ = write.write_all(&bytes).await;
    let _ = write.shutdown().await;
}

/// 非 Unix 平台暂不支持本地 socket（Windows 的命名管道留给 Windows Agent 票据）。
#[cfg(not(unix))]
pub(crate) fn serve(
    _path: &Path,
    _runtime: Arc<Runtime>,
) -> anyhow::Result<tokio::task::JoinHandle<()>> {
    anyhow::bail!("这个平台暂不支持本地 socket")
}
