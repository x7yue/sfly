//! 切入点 B（Agent 一侧）：任务工作目录与磁盘（#70）。
//! 错误摘要里的标准错误尾部取自 Agent 内存。

mod support;

use serde_json::json;
use sfly_agent::proto::TaskStatus;
use support::{AgentOptions, FakeControlPlane, spawn_agent, stub_task};

#[tokio::test]
async fn the_failure_summary_keeps_the_stderr_tail_when_stderr_log_cannot_be_read() {
    let cp = FakeControlPlane::start().await;
    let _agent = spawn_agent(AgentOptions::new(&cp.url, "agent-stderr-tail"));
    cp.hello(0).await;

    // 节点往标准错误打一行后，stderr.log 读不到、执行器写不出结果（模拟磁盘写满）。
    cp.assign(stub_task(
        "task-disk-full",
        "write_failure",
        json!({ "message": "OSError: [Errno 122] Disk quota exceeded" }),
    ))
    .await;

    let (result, _) = cp.result("task-disk-full").await;
    assert_eq!(result.status(), TaskStatus::Failed, "{result:?}");
    let message = &result.error.as_ref().unwrap().message;
    assert!(message.contains("没有写出结果"), "{message}");
    assert!(
        message.contains("OSError: [Errno 122] Disk quota exceeded"),
        "错误摘要带上节点打到标准错误的那一行：{message}"
    );
    // 执行器自己写结果失败的 traceback 也在。
    assert!(message.contains("IsADirectoryError"), "{message}");
}
