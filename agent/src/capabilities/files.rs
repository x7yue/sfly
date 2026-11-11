//! Agent 能力 `files`：列出文件（`files.list`）、查看文件属性（`files.stat`）。协议见 `proto/sfly/agent/v1/files.proto`。
//!
//! 路径是这台机器上的绝对路径，权限就是 Agent 进程的权限，不做沙箱。文件属性里的修改时间是这台机器的 Agent 时间，原样给出。
//! [`io_status`]、[`file_info`] 也供其它文件类能力使用。

use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::{Stream, StreamExt as _};
use tonic::{Request, Response, Status};

use super::{Capability, Host, Module};
use crate::calls::{BoxFuture, Call, CallError, Method, Target};
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

/// 一批最多多少个文件。
const BATCH: usize = 256;

type ListStream = Pin<Box<dyn Stream<Item = Result<ListFilesResponse, Status>> + Send>>;

/// `AgentFiles` 服务：供其它 Agent 调用，也被自己所在的 Agent 直接调用（[`Target::Local`]）。
pub struct Files;

#[tonic::async_trait]
impl AgentFiles for Files {
    type ListStream = ListStream;

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
        let pattern = Pattern::new(if pattern.is_empty() { "*" } else { &pattern });
        // 要列出的目录本身的错误（不存在、不是目录、没有权限）作为调用的错误；子目录的错误跳过。
        let top = {
            let root = root.clone();
            tokio::task::spawn_blocking(move || sorted_entries(&root))
                .await
                .map_err(|error| Status::internal(format!("列出 {directory} 失败：{error}")))?
                .map_err(|error| io_status(&error, &directory))?
        };
        let (tx, rx) = mpsc::channel(4);
        tokio::task::spawn_blocking(move || {
            let mut walk = Walk {
                pattern,
                recursive,
                batch: Vec::new(),
                tx,
            };
            if walk.directory(&root, top) {
                walk.flush();
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

/// 路径必须是绝对路径。
pub fn absolute(path: &str) -> Result<PathBuf, Status> {
    let buf = PathBuf::from(path);
    if buf.is_absolute() {
        Ok(buf)
    } else {
        Err(Status::invalid_argument(format!(
            "路径必须是绝对路径，收到 {path:?}"
        )))
    }
}

/// 文件系统错误转成 gRPC 状态（调用方据此区分文件不存在、没有权限）；消息写明路径。
pub fn io_status(error: &std::io::Error, path: &str) -> Status {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::NotFound => Status::not_found(format!("{path} 不存在")),
        ErrorKind::PermissionDenied => Status::permission_denied(format!("没有权限访问 {path}")),
        ErrorKind::NotADirectory => Status::invalid_argument(format!("{path} 不是目录")),
        _ => Status::internal(format!("访问 {path} 失败：{error}")),
    }
}

/// 文件属性（`metadata` 跟随符号链接取得）。
pub fn file_info(path: String, metadata: &std::fs::Metadata) -> FileInfo {
    FileInfo {
        path,
        size: metadata.len(),
        mtime_unix_ns: metadata
            .mtime()
            .saturating_mul(1_000_000_000)
            .saturating_add(metadata.mtime_nsec()),
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

/// 文件属性交给 SDK 的 JSON（`sfly.FileInfo`）。
pub fn file_json(file: &FileInfo) -> Value {
    json!({
        "path": file.path,
        "size": file.size,
        "mtime_ns": file.mtime_unix_ns,
        "device": file.device,
        "inode": file.inode,
    })
}

/// 目录里的条目，按名称排序；名字不是 UTF-8 的跳过。
fn sorted_entries(dir: &Path) -> std::io::Result<Vec<(String, std::fs::DirEntry)>> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?
        .flatten()
        .filter_map(|entry| Some((entry.file_name().into_string().ok()?, entry)))
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries)
}

/// 递归列出目录，分批发给调用方。
struct Walk {
    pattern: Pattern,
    recursive: bool,
    batch: Vec<FileInfo>,
    tx: mpsc::Sender<Result<ListFilesResponse, Status>>,
}

impl Walk {
    /// 列出一个目录：先是匹配的文件，再按名称依次进入子目录。调用方已经放弃时返回 false。
    fn directory(&mut self, dir: &Path, entries: Vec<(String, std::fs::DirEntry)>) -> bool {
        let mut subdirs = Vec::new();
        for (name, entry) in entries {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = dir.join(&name);
            if kind.is_dir() {
                if self.recursive {
                    subdirs.push(path);
                }
                continue;
            }
            if !self.pattern.matches(&name) {
                continue;
            }
            // 跟随符号链接；列出期间被删除的文件跳过。
            let Ok(metadata) = std::fs::metadata(&path) else {
                continue;
            };
            let Some(text) = path.to_str() else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            self.batch.push(file_info(text.to_string(), &metadata));
            if self.batch.len() >= BATCH && !self.flush() {
                return false;
            }
        }
        for subdir in subdirs {
            // 没有权限进入、列出期间被删除的子目录跳过。
            let Ok(entries) = sorted_entries(&subdir) else {
                continue;
            };
            if !self.directory(&subdir, entries) {
                return false;
            }
        }
        true
    }

    /// 发出攒下的一批；调用方已经放弃时返回 false。
    fn flush(&mut self) -> bool {
        if self.batch.is_empty() {
            return true;
        }
        let files = std::mem::take(&mut self.batch);
        self.tx
            .blocking_send(Ok(ListFilesResponse { files }))
            .is_ok()
    }
}

/// 文件名通配符，与 Python 的 `fnmatch.fnmatchcase` 相同：`*`、`?`、`[...]`（`[!...]` 取反，`a-z` 范围，
/// `]` 紧跟在 `[` 或 `[!` 之后时是普通字符，没有配对的 `[` 是普通字符），区分大小写。
#[derive(Debug, Clone)]
pub struct Pattern {
    tokens: Vec<Token>,
}

#[derive(Debug, Clone)]
enum Token {
    Star,
    One,
    Char(char),
    Set {
        negate: bool,
        ranges: Vec<(char, char)>,
    },
}

impl Pattern {
    pub fn new(pattern: &str) -> Self {
        let chars: Vec<char> = pattern.chars().collect();
        let mut tokens = Vec::new();
        let mut i = 0;
        while i < chars.len() {
            match chars[i] {
                '*' => {
                    if !matches!(tokens.last(), Some(Token::Star)) {
                        tokens.push(Token::Star);
                    }
                }
                '?' => tokens.push(Token::One),
                '[' => {
                    let mut j = i + 1;
                    if chars.get(j) == Some(&'!') {
                        j += 1;
                    }
                    if chars.get(j) == Some(&']') {
                        j += 1;
                    }
                    while j < chars.len() && chars[j] != ']' {
                        j += 1;
                    }
                    if j >= chars.len() {
                        tokens.push(Token::Char('['));
                    } else {
                        tokens.push(set(&chars[i + 1..j]));
                        i = j;
                    }
                }
                c => tokens.push(Token::Char(c)),
            }
            i += 1;
        }
        Self { tokens }
    }

    pub fn matches(&self, name: &str) -> bool {
        let name: Vec<char> = name.chars().collect();
        // 经典的回溯：记住最近一个 `*` 的位置，失配时让它多吞一个字符。
        let (mut t, mut n) = (0, 0);
        let mut star: Option<(usize, usize)> = None;
        while n < name.len() {
            match self.tokens.get(t) {
                Some(Token::Star) => {
                    star = Some((t, n));
                    t += 1;
                    continue;
                }
                Some(token) if token.matches(name[n]) => {
                    t += 1;
                    n += 1;
                    continue;
                }
                _ => {}
            }
            match star {
                Some((st, sn)) => {
                    t = st + 1;
                    n = sn + 1;
                    star = Some((st, sn + 1));
                }
                None => return false,
            }
        }
        self.tokens[t..]
            .iter()
            .all(|token| matches!(token, Token::Star))
    }
}

impl Token {
    fn matches(&self, c: char) -> bool {
        match self {
            Token::Star | Token::One => true,
            Token::Char(expected) => *expected == c,
            Token::Set { negate, ranges } => {
                ranges.iter().any(|(lo, hi)| *lo <= c && c <= *hi) != *negate
            }
        }
    }
}

fn set(content: &[char]) -> Token {
    let (negate, content) = match content.first() {
        Some('!') => (true, &content[1..]),
        _ => (false, content),
    };
    let mut ranges = Vec::new();
    let mut k = 0;
    while k < content.len() {
        if k + 2 < content.len() && content[k + 1] == '-' {
            ranges.push((content[k], content[k + 2]));
            k += 3;
        } else {
            ranges.push((content[k], content[k]));
            k += 1;
        }
    }
    Token::Set { negate, ranges }
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
    let mut stream: ListStream = match target {
        Target::Local { .. } => call
            .within(Files.list(Request::new(request)))
            .await?
            .map_err(|status| target.error(status))?
            .into_inner(),
        Target::Remote(remote) => Box::pin(
            call.within(AgentFilesClient::new(remote.channel()).list(Request::new(request)))
                .await?
                .map_err(|status| target.error(status))?
                .into_inner(),
        ),
    };
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
    let target = call.target;
    let response = match target {
        Target::Local { .. } => call.within(Files.stat(Request::new(request))).await?,
        Target::Remote(remote) => {
            call.within(AgentFilesClient::new(remote.channel()).stat(Request::new(request)))
                .await?
        }
    }
    .map_err(|status| target.error(status))?
    .into_inner();
    let file = response
        .file
        .ok_or_else(|| target.error(Status::internal("回复里没有文件属性")))?;
    Ok(file_json(&file))
}

#[cfg(test)]
mod tests {
    use super::Pattern;

    #[test]
    fn pattern_matches_like_python_fnmatchcase() {
        let cases: &[(&str, &str, bool)] = &[
            ("*", "app.log", true),
            ("*", ".hidden", true),
            ("*.log", "app.log", true),
            ("*.log", "app.log.1", false),
            ("*.log*", "app.log.1", true),
            ("app.log.?", "app.log.1", true),
            ("app.log.?", "app.log.10", false),
            ("*.[0-9]", "app.log.7", true),
            ("*.[!0-9]", "app.log.7", false),
            ("*.[!0-9]", "app.log.x", true),
            ("[]]", "]", true),
            ("[!]]", "a", true),
            ("[!]]", "]", false),
            ("[a-]", "-", true),
            ("[", "[", true),
            ("a[b", "a[b", true),
            ("*.LOG", "app.log", false),
            ("a*b*c", "aXXbYYc", true),
            ("a*b*c", "aXXbYY", false),
            ("**", "", true),
            ("?", "", false),
            ("日志*", "日志-1", true),
        ];
        for (pattern, name, expected) in cases {
            assert_eq!(
                Pattern::new(pattern).matches(name),
                *expected,
                "{pattern} ~ {name}"
            );
        }
    }
}
