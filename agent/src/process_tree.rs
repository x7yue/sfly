//! 进程树：任务子进程连同它启动的全部后代，作为一个整体等待或终止。
//!
//! 超时（#11）和取消（#12）都通过 [`ProcessTree::terminate`] 结束任务：先发优雅终止信号，
//! 宽限期过后强制杀掉整棵树。
//!
//! - Linux / Unix：子进程自成一个进程组（`process_group(0)`），信号发给整个进程组；
//!   后代如果自己调用 `setsid` / `setpgid` 离开进程组，就不在这棵树里。
//! - Windows：目前只能结束子进程本身；整棵树由 Job Object 实现（#20）。

use std::io;
use std::process::ExitStatus;
use std::time::Duration;

use tokio::process::{Child, ChildStderr, ChildStdout, Command};

/// 强制杀掉前检查进程组是否已经清空的间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// 以进程树方式启动的子进程。
pub struct ProcessTree {
    child: Child,
    /// 进程组 ID（= 组长 PID）。
    #[cfg(unix)]
    pgid: nix::unistd::Pid,
}

impl ProcessTree {
    /// 启动 command，让它和之后的后代成为一棵可以整体终止的进程树。
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        #[cfg(unix)]
        command.process_group(0);
        let child = command.spawn()?;
        #[cfg(unix)]
        {
            let pid = child
                .id()
                .ok_or_else(|| io::Error::other("child exited before its pid was read"))?;
            let pgid = nix::unistd::Pid::from_raw(
                i32::try_from(pid).map_err(|_| io::Error::other("pid out of range"))?,
            );
            Ok(Self { child, pgid })
        }
        #[cfg(not(unix))]
        Ok(Self { child })
    }

    /// 组长进程的 PID（已经退出并回收后为 None）。
    pub fn id(&self) -> Option<u32> {
        self.child.id()
    }

    /// 取走组长的标准输出 / 标准错误管道（command 设置为 `Stdio::piped()` 时才有）。
    pub fn take_output_pipes(&mut self) -> (Option<ChildStdout>, Option<ChildStderr>) {
        (self.child.stdout.take(), self.child.stderr.take())
    }

    /// 等待组长进程退出（不影响后代）。可以安全地在 `select!` 中取消。
    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        self.child.wait().await
    }

    /// 请求整棵树优雅退出（Unix：向进程组发 SIGTERM）。
    pub fn request_stop(&mut self) {
        #[cfg(unix)]
        self.signal(nix::sys::signal::Signal::SIGTERM);
        #[cfg(not(unix))]
        let _ = self.child.start_kill();
    }

    /// 立即强制杀掉整棵树（Unix：向进程组发 SIGKILL）。
    pub fn kill(&mut self) {
        #[cfg(unix)]
        self.signal(nix::sys::signal::Signal::SIGKILL);
        let _ = self.child.start_kill();
    }

    /// 终止整棵树：先请求优雅退出，等组长和全部后代退出，最多等 grace；仍未退出的强制杀掉。
    /// 返回组长进程的退出状态。
    pub async fn terminate(&mut self, grace: Duration) -> io::Result<ExitStatus> {
        self.request_stop();
        let deadline = tokio::time::Instant::now() + grace;
        let mut leader_exited = false;
        while tokio::time::Instant::now() < deadline {
            if !leader_exited {
                // 一边等一边回收组长，否则它的僵尸进程会让进程组一直“活着”。
                let step = grace.min(POLL_INTERVAL);
                leader_exited = tokio::time::timeout(step, self.wait()).await.is_ok();
            } else if self.group_alive() {
                tokio::time::sleep(POLL_INTERVAL).await;
            } else {
                break;
            }
        }
        self.kill();
        self.wait().await
    }

    #[cfg(unix)]
    fn signal(&self, signal: nix::sys::signal::Signal) {
        // 进程组已经清空（ESRCH）时没有可以发信号的对象，忽略。
        let _ = nix::sys::signal::killpg(self.pgid, signal);
    }

    /// 进程组里是否还有进程。
    #[cfg(unix)]
    fn group_alive(&self) -> bool {
        nix::sys::signal::killpg(self.pgid, None).is_ok()
    }

    #[cfg(not(unix))]
    fn group_alive(&self) -> bool {
        false
    }
}
