//! 文件类能力共用的部分：路径、文件系统错误、文件属性、文件名通配符、遍历目录。
//!
//! 路径是那台机器上的绝对路径，权限就是 Agent 进程的权限，不做沙箱。

use std::ops::ControlFlow;
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tonic::Status;

use crate::proto::FileInfo;

/// 一批最多多少个文件（列出的结果、监听的快照）。
pub const BATCH: usize = 256;

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

/// 出错时在做什么：决定消息怎么写。
#[derive(Debug, Clone, Copy)]
pub enum Doing<'a> {
    /// 访问一个路径（查看、读取、列出、写入）。
    Access(&'a str),
    /// 在目录 `dir` 里新建文件，最终写到 `path`（写入的临时文件）。
    Create { path: &'a str, dir: &'a str },
    /// 删除一个路径。
    Delete(&'a str),
    /// 启动一个程序。
    Run(&'a str),
}

/// 文件系统错误转成 gRPC 状态：状态码只由原因决定（不存在、没有权限、不是目录，调用方据此抛出不同的异常），
/// 消息按在做什么写明是哪个路径。
pub fn io_error(error: &std::io::Error, doing: Doing<'_>) -> Status {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::NotFound => Status::not_found(match doing {
            Doing::Access(path) | Doing::Delete(path) => format!("{path} 不存在"),
            Doing::Create { dir, .. } => format!("目录 {dir} 不存在"),
            Doing::Run(program) => format!("找不到程序 {program}"),
        }),
        ErrorKind::PermissionDenied => Status::permission_denied(match doing {
            Doing::Access(path) => format!("没有权限访问 {path}"),
            Doing::Create { path, .. } => format!("没有权限写入 {path}"),
            Doing::Delete(path) => format!("没有权限删除 {path}"),
            Doing::Run(program) => format!("没有权限执行 {program}"),
        }),
        ErrorKind::NotADirectory => Status::invalid_argument(match doing {
            Doing::Access(path) | Doing::Delete(path) => format!("{path} 不是目录"),
            Doing::Create { dir, .. } => format!("{dir} 不是目录"),
            Doing::Run(program) => format!("找不到程序 {program}：路径中有一段不是目录"),
        }),
        _ => Status::internal(match doing {
            Doing::Access(path) | Doing::Create { path, .. } => {
                format!("访问 {path} 失败：{error}")
            }
            Doing::Delete(path) => format!("删除 {path} 失败：{error}"),
            Doing::Run(program) => format!("启动 {program} 失败：{error}"),
        }),
    }
}

/// 访问 `path` 时的文件系统错误（[`io_error`] 最常用的写法）。
pub fn io_status(error: &std::io::Error, path: &str) -> Status {
    io_error(error, Doing::Access(path))
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

/// 回复里的文件属性：应该有却没有时是对方的错误。
pub fn replied_file(file: Option<FileInfo>) -> Result<FileInfo, Status> {
    file.ok_or_else(|| Status::internal("回复里没有文件属性"))
}

/// 两个文件属性是不是同一个文件（设备号 + inode）。
pub fn same_file(a: &FileInfo, b: &FileInfo) -> bool {
    (a.device, a.inode) == (b.device, b.inode)
}

/// 目录 `dir` 下的 `name`。
pub fn join(dir: &str, name: &str) -> String {
    format!("{}/{name}", dir.trim_end_matches('/'))
}

/// 目录里的条目，按名称排序；名字不是 UTF-8 的跳过。
pub fn sorted_entries(dir: &Path) -> std::io::Result<Vec<(String, std::fs::DirEntry)>> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?
        .flatten()
        .filter_map(|entry| Some((entry.file_name().into_string().ok()?, entry)))
        .collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries)
}

/// 名字匹配 `pattern` 的普通文件（跟随符号链接判断）的属性；不匹配、不存在、不是普通文件时为 None。
pub fn matching(pattern: &Pattern, name: &str, path: &str) -> Option<FileInfo> {
    if !pattern.matches(name) {
        return None;
    }
    let metadata = std::fs::metadata(path).ok()?;
    metadata
        .is_file()
        .then(|| file_info(path.to_string(), &metadata))
}

/// 遍历目录时看到的东西（[`walk`]）。
pub trait Visit {
    /// 停下时带出的值。
    type Stop;

    /// 一个名字匹配的普通文件。
    fn file(&mut self, file: FileInfo) -> ControlFlow<Self::Stop>;

    /// 递归时将要进入子目录 `dir`（还没有列出它）：`Continue(false)` 跳过它。
    fn enter(&mut self, _dir: &str) -> ControlFlow<Self::Stop, bool> {
        ControlFlow::Continue(true)
    }
}

/// 列出目录 `dir`（`entries` 是它的条目，[`sorted_entries`]）：先依次是名字匹配 `pattern` 的普通文件，
/// 再按名称依次进入子目录（`recursive` 时）。遍历期间被删除的文件、列不出的子目录跳过。`files.list` 和监听的快照共用，
/// 所以两者的顺序相同。
pub fn walk<V: Visit>(
    dir: &str,
    entries: Vec<(String, std::fs::DirEntry)>,
    pattern: &Pattern,
    recursive: bool,
    visit: &mut V,
) -> ControlFlow<V::Stop> {
    let mut subdirs = Vec::new();
    for (name, entry) in entries {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = join(dir, &name);
        if kind.is_dir() {
            if recursive {
                subdirs.push(path);
            }
            continue;
        }
        if let Some(file) = matching(pattern, &name, &path) {
            visit.file(file)?;
        }
    }
    for subdir in subdirs {
        if !visit.enter(&subdir)? {
            continue;
        }
        let Ok(entries) = sorted_entries(Path::new(&subdir)) else {
            continue;
        };
        walk(&subdir, entries, pattern, recursive, visit)?;
    }
    ControlFlow::Continue(())
}

/// 文件名通配符，与 Python 的 `fnmatch.fnmatchcase` 相同：`*`、`?`、`[...]`（`[!...]` 取反，`a-z` 范围，
/// `]` 紧跟在 `[` 或 `[!` 之后时是普通字符，没有配对的 `[` 是普通字符），区分大小写。为空时等同于 `*`。
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
        let pattern = if pattern.is_empty() { "*" } else { pattern };
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

#[cfg(test)]
mod tests {
    use super::Pattern;

    #[test]
    fn pattern_matches_like_python_fnmatchcase() {
        let cases: &[(&str, &str, bool)] = &[
            ("*", "app.log", true),
            ("*", ".hidden", true),
            ("", "app.log", true),
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
