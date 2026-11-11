//! 调用方发来的数据（流式写入文件）：请求那一行之后，调用方可以接着发
//!
//! - `{"data": N}` 一行之后紧跟 N 个原始字节（N 不超过 [`MAX_DATA`]）：数据的下一段，零到多次；
//! - `{"end": true}`：数据发完了。
//!
//! 和回复的 `data` 帧是同一种写法。[`pump`] 读这个连接，把数据交给方法（[`super::Call::input`]）；
//! 读到连接关闭时结束，[`super::serve`] 据此知道调用方已经断开、放弃调用。

use serde::Deserialize;
use tokio::io::{AsyncBufRead, AsyncBufReadExt as _, AsyncReadExt as _};
use tokio::sync::mpsc;

use super::{CallError, ErrorKind};

/// 一个 `data` 帧最多多少字节（SDK 每帧最多发 256 KiB）。
pub const MAX_DATA: usize = 4 * 1024 * 1024;

/// 一行帧头最多多少字节。
const MAX_LINE: u64 = 4096;

/// 调用方发来的一项：一段数据，或 None（发完了）；帧不合法时是错误。
pub(super) type Part = Result<Option<Vec<u8>>, CallError>;

/// 调用方发来的数据（方法用 [`super::Call::input`] 逐段取）。
pub struct Input {
    rx: mpsc::Receiver<Part>,
    ended: bool,
}

impl Input {
    pub(super) fn new(rx: mpsc::Receiver<Part>) -> Self {
        Self { rx, ended: false }
    }

    /// 下一段数据；发完了（收到 `end`）时为 None。调用方在发完之前断开、帧不合法时是错误。
    pub(super) async fn next(&mut self) -> Result<Option<Vec<u8>>, CallError> {
        if self.ended {
            return Ok(None);
        }
        match self.rx.recv().await {
            Some(Ok(Some(data))) => Ok(Some(data)),
            Some(Ok(None)) => {
                self.ended = true;
                Ok(None)
            }
            Some(Err(error)) => Err(error),
            None => Err(CallError::new(
                ErrorKind::Failed,
                "调用方在数据发完之前断开了",
            )),
        }
    }
}

#[derive(Deserialize)]
struct Frame {
    data: Option<usize>,
    #[serde(default)]
    end: bool,
}

/// 读调用方的连接，把数据交给 `tx`，直到连接关闭（调用方断开）才返回。方法不取数据时，数据留在 `tx` 里，
/// 读满了就不再读，等方法结束（一次性的方法调用方不会发数据）。帧不合法时告诉方法，之后的内容丢掉。
pub(super) async fn pump(mut reader: impl AsyncBufRead + Unpin, tx: mpsc::Sender<Part>) {
    let mut broken = false;
    let mut line = Vec::new();
    loop {
        line.clear();
        if broken {
            let mut sink = [0u8; 8192];
            match reader.read(&mut sink).await {
                Ok(n) if n > 0 => continue,
                _ => return,
            }
        }
        match (&mut reader)
            .take(MAX_LINE)
            .read_until(b'\n', &mut line)
            .await
        {
            Ok(n) if n > 0 => {}
            _ => return,
        }
        let part = match serde_json::from_slice::<Frame>(&line) {
            Ok(Frame {
                data: Some(size), ..
            }) if size <= MAX_DATA => {
                let mut data = vec![0u8; size];
                if reader.read_exact(&mut data).await.is_err() {
                    return;
                }
                Ok(Some(data))
            }
            Ok(Frame {
                data: None,
                end: true,
            }) => Ok(None),
            _ => {
                broken = true;
                Err(CallError::new(
                    ErrorKind::Invalid,
                    format!(
                        "调用方发来的数据帧不合法（每帧最多 {MAX_DATA} 字节）：{}",
                        String::from_utf8_lossy(&line).trim_end()
                    ),
                ))
            }
        };
        // 方法已经结束、不再取数据时丢掉。
        let _ = tx.send(part).await;
    }
}
