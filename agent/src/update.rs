//! Agent 自更新（ADR 0014）：版本与控制面不一致时的更新状态，随 Heartbeat 上报。
//!
//! 控制面在 Welcome 里给出目标版本（控制面的版本）；与 Agent 上报的版本不同（高于或低于）时控制面不再派新任务，
//! Agent 应当更新到目标版本。能不能自更新由 [`SelfUpdate::blocker`] 判断；不能时上报「需要手动升级」及原因。
//! 自更新本身（下载、等待任务结束、替换并 execve）还没有实现，能自更新时同样上报「需要手动升级」。

use std::path::{Path, PathBuf};

use crate::proto::{AgentUpdate, AgentUpdateState, Welcome};

/// 判断能否自更新所需的信息（启动时确定）。
#[derive(Debug, Clone)]
pub struct SelfUpdate {
    /// 是否允许自动更新（没有指定 `--no-auto-update`）。
    pub enabled: bool,
    /// 当前可执行文件的路径：启动时解析并记住（替换之后 `/proc/self/exe` 会变成「(deleted)」）。
    pub exe: Option<PathBuf>,
    /// `SFLY_HOME`；找不到时为 None。
    pub home: Option<PathBuf>,
}

impl SelfUpdate {
    /// 启动时调用：解析当前可执行文件的路径。
    pub fn detect(enabled: bool, home: Option<PathBuf>) -> Self {
        let exe = std::env::current_exe()
            .ok()
            .map(|exe| std::fs::canonicalize(&exe).unwrap_or(exe));
        Self { enabled, exe, home }
    }

    /// 不能自更新的原因；能自更新时为 None。依次检查：`--no-auto-update`、二进制在 `SFLY_HOME/bin` 下、目录可写。
    pub fn blocker(&self) -> Option<String> {
        if !self.enabled {
            return Some("已指定 --no-auto-update，不自动更新".to_string());
        }
        let Some(exe) = &self.exe else {
            return Some("无法确定 Agent 二进制的路径".to_string());
        };
        let Some(home) = &self.home else {
            return Some(format!(
                "找不到 SFLY_HOME，无法确认 Agent 二进制 {} 是否由安装脚本安装",
                exe.display()
            ));
        };
        let bin = home.join("bin");
        let dir = exe.parent().unwrap_or(Path::new("/"));
        let in_bin = std::fs::canonicalize(&bin).is_ok_and(|bin| bin == dir);
        if !in_bin {
            return Some(format!(
                "Agent 二进制 {} 不在 {} 下（只更新安装脚本安装的 Agent）",
                exe.display(),
                bin.display()
            ));
        }
        if let Err(error) = probe_writable(dir) {
            return Some(format!("{} 不可写：{error}", bin.display()));
        }
        None
    }

    /// 根据 Welcome 的目标版本得出要上报的更新状态。控制面没有给出目标版本（旧版本控制面）时视为一致。
    pub fn status(&self, version: &str, welcome: &Welcome) -> AgentUpdate {
        let target = welcome.target_agent_version.as_str();
        if target.is_empty() || target == version {
            return AgentUpdate {
                state: AgentUpdateState::None.into(),
                ..Default::default()
            };
        }
        let reason = self
            .blocker()
            .unwrap_or_else(|| "这个版本的 Agent 还不支持自更新".to_string());
        AgentUpdate {
            state: AgentUpdateState::ManualUpgradeRequired.into(),
            reason,
            ..Default::default()
        }
    }
}

/// 在目录里创建再删除一个临时文件：替换二进制要在同一目录写临时文件并 rename。
fn probe_writable(dir: &Path) -> std::io::Result<()> {
    let probe = dir.join(format!(".sfly-agent.write-test.{}", std::process::id()));
    std::fs::File::create(&probe)?;
    std::fs::remove_file(&probe)
}
