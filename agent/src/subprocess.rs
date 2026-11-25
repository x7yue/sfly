//! Agent 起子进程的唯一出口：给出已经去掉 Agent 凭据的命令。
//!
//! Agent 凭据可以经环境变量 `SFLY_TOKEN` 交给 Agent（另一条路是 `agent.env`，由 Agent 自己读，不进环境）。Agent 起的
//! 子进程都不需要它：执行器（节点的代码）、`exec.run` 起的命令（连同它留下的后台进程）、装依赖的 uv（会运行第三方包的
//! 构建脚本）、准备环境的进程，所以所有子进程都从 [`command`] 来，环境里去掉 [`crate::secret::CREDENTIAL_ENV`]，
//! 不靠每个起进程的地方各自记得。这是多一层防护，不是隔离：节点和 Agent 是同一个系统用户，读得到 `agent.env`
//! （ADR 0029：边界是那台机器）。
//!
//! `agent/tests/spawn_exit.rs` 扫 `agent/src`：直接起进程（`Command::new`……）的地方只能是这里和写明理由的例外
//! （启动 Agent 自己的新版本：试运行、替换自己，见 [`crate::update`]）；新加的地方不经这里，测试就红。

use std::ffi::OsStr;

use tokio::process::Command;

use crate::secret::CREDENTIAL_ENV;

/// 起 `program` 的命令，环境里没有 Agent 凭据。调用方之后设置的环境变量照常生效（`exec.run` 的调用方自己给的
/// `env` 是他们自己的值，不是 Agent 的凭据）。
pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    command.env_remove(CREDENTIAL_ENV);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_has_no_agent_credential_in_its_environment() {
        let command = command("true");
        let removed: Vec<_> = command
            .as_std()
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(key, _)| key.to_owned())
            .collect();
        assert_eq!(removed, [OsStr::new(CREDENTIAL_ENV)]);
    }
}
