//! 带凭据的 proto 消息的 `Debug`：凭据的位置写 `<redacted>`，别的字段照常输出。
//!
//! `AssignTask.task_token`（任务凭据）和 `Hello.token`（Agent 凭据）是明文的字符串字段。prost 生成的 `Debug` 会把它们
//! 原样打出来，而这两个消息会出现在 `{:?}` 里（`ServerMessage` 的报错、测试断言失败的输出、以后加的日志）。所以 build.rs 让 prost
//! 不为它们生成 `Debug`（`skip_debug`），这里手写：**每个字段都列出来、不用 `..`**——proto 里加了字段，这里编译不过，
//! 不会悄悄漏掉字段，也不会漏掉新加的凭据类字段。

use std::fmt;

use crate::proto::{AssignTask, Hello};

/// 凭据字段的显示：有值写 `<redacted>`，空的写 `""`（看得出「没有」）。
struct Redacted<'a>(&'a str);

impl fmt::Debug for Redacted<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.0.is_empty() {
            f.write_str("\"\"")
        } else {
            f.write_str("<redacted>")
        }
    }
}

impl fmt::Debug for AssignTask {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let AssignTask {
            task_id,
            attempt,
            package,
            package_version,
            node,
            inputs_json,
            timeout_seconds,
            run_id,
            node_id,
            package_sha256,
            package_url,
            artifact_upload_url,
            referenced_agents,
            referenced_feishu_bots,
            artifact_limit_bytes,
            task_token,
        } = self;
        f.debug_struct("AssignTask")
            .field("task_id", task_id)
            .field("attempt", attempt)
            .field("package", package)
            .field("package_version", package_version)
            .field("node", node)
            .field("inputs_json", inputs_json)
            .field("timeout_seconds", timeout_seconds)
            .field("run_id", run_id)
            .field("node_id", node_id)
            .field("package_sha256", package_sha256)
            .field("package_url", package_url)
            .field("artifact_upload_url", artifact_upload_url)
            .field("referenced_agents", referenced_agents)
            .field("referenced_feishu_bots", referenced_feishu_bots)
            .field("artifact_limit_bytes", artifact_limit_bytes)
            .field("task_token", &Redacted(task_token))
            .finish()
    }
}

impl fmt::Debug for Hello {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let Hello {
            name,
            token,
            agent_version,
            os,
            arch,
            slots,
            installed_packages,
            dev_packages,
            running_tasks,
            agent_time_unix_ms,
            monotonic_ms,
            capabilities,
            peer,
        } = self;
        f.debug_struct("Hello")
            .field("name", name)
            .field("token", &Redacted(token))
            .field("agent_version", agent_version)
            .field("os", os)
            .field("arch", arch)
            .field("slots", slots)
            .field("installed_packages", installed_packages)
            .field("dev_packages", dev_packages)
            .field("running_tasks", running_tasks)
            .field("agent_time_unix_ms", agent_time_unix_ms)
            .field("monotonic_ms", monotonic_ms)
            .field("capabilities", capabilities)
            .field("peer", peer)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::{AgentMessage, ServerMessage, agent_message, server_message};

    #[test]
    fn assign_task_debug_hides_the_task_token_everywhere_it_can_be_printed() {
        let task = AssignTask {
            task_id: "t1".into(),
            node: "echo".into(),
            task_token: "sfly_tsk_0123456789abcdef".into(),
            ..Default::default()
        };
        let shown = [
            format!("{task:?}"),
            format!("{task:#?}"),
            format!(
                "{:?}",
                ServerMessage {
                    body: Some(server_message::Body::Assign(task.clone())),
                }
            ),
        ];
        for text in shown {
            assert!(!text.contains("sfly_tsk_"), "{text}");
            assert!(text.contains("<redacted>"), "{text}");
            assert!(text.contains("t1") && text.contains("echo"), "{text}");
        }
        // 没有任务凭据的（旧版本控制面）写空串，看得出「没有」。
        assert!(format!("{:?}", AssignTask::default()).contains("task_token: \"\""));
    }

    #[test]
    fn hello_debug_hides_the_agent_credential() {
        let hello = Hello {
            name: "agent-a".into(),
            token: "sfly_agt_0123456789abcdef".into(),
            ..Default::default()
        };
        let shown = format!(
            "{:?} {:#?}",
            AgentMessage {
                body: Some(agent_message::Body::Hello(hello.clone())),
            },
            hello
        );
        assert!(!shown.contains("sfly_agt_"), "{shown}");
        assert!(
            shown.contains("<redacted>") && shown.contains("agent-a"),
            "{shown}"
        );
    }
}
