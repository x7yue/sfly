//! 进程树：任务子进程连同它启动的全部后代，作为一个整体等待或终止。
//!
//! 超时（#11）和取消（#12）都通过 [`ProcessTree::terminate`] 结束任务：先发优雅终止信号，
//! 宽限期过后强制杀掉整棵树。
//!
//! - Linux / Unix：子进程自成一个进程组（`process_group(0)`），信号发给整个进程组；
//!   后代如果自己调用 `setsid` / `setpgid` 离开进程组，就不在这棵树里。
//! - Windows：目前只能结束子进程本身；整棵树由 Job Object 实现（#20）。
//!
//! 进程树不随 Agent 一起收到终端或服务管理器发给 Agent 的信号，Agent 退出时用 [`terminate_all`]
//! 终止还在运行的进程树，否则执行器会成为孤儿继续运行（#113）。

use std::io;
use std::path::PathBuf;
use std::process::ExitStatus;
use std::time::Duration;

use tokio::process::{Child, ChildStderr, ChildStdout, Command};

/// 强制杀掉前检查进程组是否已经清空的间隔。
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// 还在运行的进程树：启动时登记，[`ProcessTree`] 被丢弃时移除。
#[cfg(unix)]
struct Live {
    /// [`terminate_all`] 已经开始：不再启动新的进程树。
    closing: bool,
    /// 进程组 ID → 取消标记文件（[`ProcessTree::spawn_cancellable`] 启动的才有）。
    groups: std::collections::BTreeMap<nix::unistd::Pid, Option<PathBuf>>,
}

#[cfg(unix)]
static LIVE: std::sync::Mutex<Live> = std::sync::Mutex::new(Live {
    closing: false,
    groups: std::collections::BTreeMap::new(),
});

/// 终止全部还在运行的进程树（Agent 退出前调用），和取消任务的方式一致（docs/SEMANTICS.md §3.4）：
/// 先写取消标记、向每个进程组发 SIGTERM，等它们都清空，最多等 grace；`force` 先完成（例如
/// 宽限期内又收到退出信号）时不再等。仍未清空的强制杀掉。
///
/// 开始之后不再启动新的进程树（[`ProcessTree::spawn`] 返回错误）：还在准备环境的任务之后才启动的
/// 执行器不在这次终止的范围里，Agent 退出后会成为孤儿。
///
/// 组长由各自任务的 [`ProcessTree::wait`] 回收，调用方要让运行时继续驱动这些任务；
/// 没有回收的组长（僵尸）让进程组一直“活着”，最多多等到 grace。
pub async fn terminate_all(grace: Duration, force: impl Future<Output = ()>) {
    #[cfg(unix)]
    {
        use nix::sys::signal::{Signal, killpg};
        let groups: Vec<_> = {
            let mut live = LIVE.lock().unwrap();
            live.closing = true;
            live.groups
                .iter()
                .map(|(pgid, marker)| (*pgid, marker.clone()))
                .collect()
        };
        for (_, marker) in &groups {
            if let Some(marker) = marker
                && let Err(error) = std::fs::write(marker, b"")
            {
                eprintln!("cannot write cancel marker {}: {error}", marker.display());
            }
        }
        for (pgid, _) in &groups {
            let _ = killpg(*pgid, Signal::SIGTERM);
        }
        let emptied = async {
            while groups.iter().any(|(pgid, _)| killpg(*pgid, None).is_ok()) {
                tokio::time::sleep(POLL_INTERVAL).await;
            }
        };
        tokio::select! {
            _ = tokio::time::timeout(grace, emptied) => {}
            () = force => {}
        }
        for (pgid, _) in &groups {
            let _ = killpg(*pgid, Signal::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = (grace, force);
}

/// 以进程树方式启动的子进程。
pub struct ProcessTree {
    child: Child,
    /// 进程组 ID（= 组长 PID）。
    #[cfg(unix)]
    pgid: nix::unistd::Pid,
}

impl ProcessTree {
    /// 启动 command，让它和之后的后代成为一棵可以整体终止的进程树。
    /// [`terminate_all`] 开始之后返回错误。
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        Self::spawn_registered(command, None)
    }

    /// 同 [`ProcessTree::spawn`]，并登记取消标记文件：[`terminate_all`] 终止它之前先写这个文件，
    /// 和取消任务时一样（执行器的 `SFLY_CANCEL`）。
    pub fn spawn_cancellable(command: &mut Command, cancel_marker: PathBuf) -> io::Result<Self> {
        Self::spawn_registered(command, Some(cancel_marker))
    }

    #[cfg_attr(not(unix), allow(unused_variables))]
    fn spawn_registered(command: &mut Command, cancel_marker: Option<PathBuf>) -> io::Result<Self> {
        #[cfg(unix)]
        {
            command.process_group(0);
            // 持锁启动并登记：terminate_all 要么在快照里看到它，要么先置了 closing 让这里不再启动。
            let mut live = LIVE.lock().unwrap();
            if live.closing {
                return Err(io::Error::other("Agent 正在退出，不再启动新的进程"));
            }
            let child = command.spawn()?;
            let pid = child
                .id()
                .ok_or_else(|| io::Error::other("child exited before its pid was read"))?;
            let pgid = nix::unistd::Pid::from_raw(
                i32::try_from(pid).map_err(|_| io::Error::other("pid out of range"))?,
            );
            live.groups.insert(pgid, cancel_marker);
            Ok(Self { child, pgid })
        }
        #[cfg(not(unix))]
        Ok(Self {
            child: command.spawn()?,
        })
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

impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(unix)]
        LIVE.lock().unwrap().groups.remove(&self.pgid);
    }
}
