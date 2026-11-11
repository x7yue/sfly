//! 传输文件内容共用的部分：块大小、落盘用的临时文件。写入（[`super::file_write`]）和下载（[`super::file_read`]）都用。

use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::io::AsyncWriteExt as _;
use tonic::Status;

use super::fs::{Doing, absolute, file_info, io_error, io_status};
use crate::proto::FileInfo;

/// 读文件时每块、传给目标 Agent 时每段最多多少字节。
pub const CHUNK: usize = 256 * 1024;

/// 进程内的临时文件序号：同一个目标的几次写入各用各的临时文件。
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 目标所在目录里的临时文件（`.<名>.sfly-….tmp`），写完后 [`TempFile::commit`] 改名为目标路径。
/// 出错时用 [`TempFile::discard`] 删除它（删完再回复调用方）；没有提交就被丢弃（调用被取消、调用方断开）时，
/// Drop 在阻塞线程里删除它。
pub struct TempFile {
    /// 目标路径（给人看的写法，调用方给的）。
    path: String,
    target: PathBuf,
    temp: PathBuf,
    pub file: tokio::fs::File,
    /// 目标已经是普通文件时它的权限位：替换后保留。
    mode: Option<u32>,
    /// 已经改名或删除：Drop 不用再管。
    settled: bool,
}

impl TempFile {
    /// 在 `path` 所在的目录里建临时文件。可以随时丢弃这个 future（写入被取消、调用方断开时目标 Agent 就这样丢下
    /// 处理）：整个过程在一个阻塞任务里完成，产出的就是 `TempFile`；中途丢弃时阻塞任务照样做完，它的结果随之丢弃，
    /// Drop 删除刚建的文件。不能先 await 打开文件、再构造 `TempFile`：丢弃恰好发生在文件已经建好、结果还没交回的
    /// 时候，就没有人删它了。
    pub async fn create(path: &str) -> Result<Self, Status> {
        let path = path.to_string();
        tokio::task::spawn_blocking(move || Self::create_blocking(&path))
            .await
            .map_err(|error| Status::internal(format!("建临时文件失败：{error}")))?
    }

    fn create_blocking(path: &str) -> Result<Self, Status> {
        use std::os::unix::fs::MetadataExt as _;

        let target = absolute(path)?;
        let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
            return Err(Status::invalid_argument(format!("{path} 不是文件路径")));
        };
        let mode = match std::fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_dir() => {
                return Err(Status::invalid_argument(format!(
                    "{path} 是目录：只能写入文件"
                )));
            }
            Ok(metadata) if metadata.is_file() => Some(metadata.mode() & 0o7777),
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
            let opened = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o666)
                .open(&temp);
            match opened {
                Ok(file) => {
                    return Ok(Self {
                        path: path.to_string(),
                        target,
                        temp,
                        file: tokio::fs::File::from_std(file),
                        mode,
                        settled: false,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt < 8 => {
                    attempt += 1;
                }
                Err(error) => {
                    let dir = dir.to_string_lossy();
                    return Err(io_error(&error, Doing::Create { path, dir: &dir }));
                }
            }
        }
    }

    /// 写完了：落盘、改名为目标路径，返回它的属性。
    pub async fn commit(mut self) -> Result<FileInfo, Status> {
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
        self.settled = true;
        let metadata = tokio::fs::metadata(&self.target).await.map_err(failed)?;
        Ok(file_info(path, &metadata))
    }

    /// 不要了：删除临时文件，删完才返回（之后回复调用方时它已经不在了）。
    pub async fn discard(mut self) {
        self.settled = true;
        let _ = tokio::fs::remove_file(&self.temp).await;
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        let temp = std::mem::take(&mut self.temp);
        // 被丢弃的地方多半在异步任务里：删除放到阻塞线程，不卡住它。
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn_blocking(move || std::fs::remove_file(temp));
            }
            Err(_) => {
                let _ = std::fs::remove_file(temp);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future as _;
    use std::path::Path;
    use std::task::Poll;
    use std::time::{Duration, Instant};

    use super::TempFile;

    /// 目录里的临时文件（`.<名>.sfly-….tmp`）。
    fn temp_files(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect()
    }

    /// 建临时文件的中途被丢弃（写入被取消、调用方断开，目标 Agent 随之丢下处理）时不留下临时文件。
    /// 最容易漏的时刻是文件已经建好、还没交回给写入方：以前这时丢弃，临时文件会一直留着。
    /// 这里在临时文件出现在目录里之后就不再推进，直接丢弃。
    #[tokio::test]
    async fn dropping_create_after_the_temp_file_exists_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        let path = path.to_str().unwrap();
        let mut dropped_midway = 0;
        for _ in 0..20 {
            let mut create = Box::pin(TempFile::create(path));
            let midway = loop {
                if !temp_files(dir.path()).is_empty() {
                    break true;
                }
                let polled = std::future::poll_fn(|cx| Poll::Ready(create.as_mut().poll(cx))).await;
                if let Poll::Ready(temp) = polled {
                    // 已经建好、交回来了：这一轮没测到，丢弃后再来。
                    drop(temp.unwrap());
                    break false;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            };
            drop(create);
            let deadline = Instant::now() + Duration::from_secs(5);
            while !temp_files(dir.path()).is_empty() {
                assert!(
                    Instant::now() < deadline,
                    "丢弃之后临时文件还在：{:?}",
                    temp_files(dir.path())
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            if midway {
                dropped_midway += 1;
            }
        }
        assert!(
            dropped_midway > 0,
            "没有一次是在临时文件建好之后、交回之前丢弃的"
        );
    }

    /// `discard` 删完临时文件才返回。
    #[tokio::test]
    async fn discard_removes_the_temp_file_before_returning() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.log");
        let temp = TempFile::create(path.to_str().unwrap()).await.unwrap();
        assert_eq!(temp_files(dir.path()).len(), 1);
        temp.discard().await;
        assert!(temp_files(dir.path()).is_empty());
    }
}
