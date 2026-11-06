//! 切入点 B（Agent 一侧）：任务工作目录的磁盘占用（#69、#70）。
//! 事件经命名管道 `events.fifo` 交给 Agent，不落盘；`stdout.log` / `stderr.log` 按大小轮换；
//! 错误摘要里的标准错误尾部取自 Agent 内存。

mod support;

use std::os::unix::fs::FileTypeExt as _;
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use sfly_agent::proto::{TaskStatus, agent_message};
use support::{AgentOptions, FakeControlPlane, WAIT, spawn_agent, stub_task};

/// 目录下（递归）普通文件的总字节数。
fn file_bytes(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(t) if t.is_dir() => file_bytes(&entry.path()),
            Ok(t) if t.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

async fn wait_until(what: &str, check: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + WAIT;
    while !check() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn high_frequency_metrics_go_through_a_fifo_without_growing_the_work_dir() {
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(AgentOptions::new(&cp.url, "agent-fifo"));
    cp.hello(0).await;

    cp.assign(stub_task(
        "task-burst",
        "metric_burst",
        json!({ "seconds": 3 }),
    ))
    .await;
    let dir = agent.work_dir.path().join("task-burst");
    let fifo = dir.join("events.fifo");
    wait_until("events.fifo", || fifo.exists()).await;
    assert!(
        std::fs::metadata(&fifo).unwrap().file_type().is_fifo(),
        "events.fifo 是命名管道"
    );

    // 执行期间采样两次：事件不落盘，工作目录里只有 task.json 这类小文件。
    tokio::time::sleep(Duration::from_millis(800)).await;
    let early = file_bytes(&dir);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let late = file_bytes(&dir);
    assert!(
        early < 16 * 1024 && late <= early,
        "工作目录占用不增长：{early} → {late} 字节"
    );

    let (result, _) = cp.result("task-burst").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let count = serde_json::from_str::<Value>(&result.outputs_json).unwrap()["count"]
        .as_f64()
        .unwrap();
    assert!(count > 10_000.0, "高频上报：{count} 次");
    let points: Vec<_> = cp
        .received()
        .into_iter()
        .filter_map(|m| match m.body {
            Some(agent_message::Body::Metrics(b)) if b.task_id == "task-burst" => Some(b.points),
            _ => None,
        })
        .flatten()
        .collect();
    // 累计计数的最大值等于上报次数：管道写满时写端等待，一个事件也不丢。
    let max = points.iter().map(|p| p.value).fold(0.0, f64::max);
    assert_eq!(max, count);
    // Agent 跟得上（读不过来时写端等待，而不是在内存里越积越多、晚于宽限期才处理）：每秒只有一个点。
    let mut seconds: Vec<i64> = points.iter().map(|p| p.time_unix_s).collect();
    let all = seconds.len();
    seconds.sort_unstable();
    seconds.dedup();
    assert_eq!(seconds.len(), all, "同一秒出现了多个点");
    assert!(!dir.join("events.jsonl").exists(), "不再生成事件文件");
}

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

#[tokio::test]
async fn stdout_and_stderr_copies_rotate_at_8_mib_keeping_at_most_two_files_per_stream() {
    const MIB: u64 = 1024 * 1024;
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(AgentOptions::new(&cp.url, "agent-rotate"));
    cp.hello(0).await;

    cp.assign(stub_task(
        "task-spew",
        "spew",
        json!({ "stdout_mib": 17, "stderr_mib": 9 }),
    ))
    .await;
    let (result, _) = cp.result("task-spew").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");

    let dir = agent.work_dir.path().join("task-spew");
    let size = |name: &str| std::fs::metadata(dir.join(name)).map(|m| m.len()).ok();
    for (stream, written) in [("stdout", 17 * MIB), ("stderr", 9 * MIB)] {
        let current = size(&format!("{stream}.log")).unwrap();
        let previous = size(&format!("{stream}.log.1")).expect("轮换出 .1");
        assert!(
            current <= 8 * MIB && previous <= 8 * MIB,
            "{stream}：{current} + {previous}"
        );
        assert!(
            previous > 7 * MIB,
            "{stream}.log.1 是写满的一个文件：{previous}"
        );
        // 当前文件就是最后写出的那一段。
        let text = std::fs::read_to_string(dir.join(format!("{stream}.log"))).unwrap();
        assert!(text.ends_with("最后一行\n"), "{stream}.log 以最后一行结尾");
        if written > 16 * MIB {
            // 第二次轮换覆盖了旧的 .1：每个流最多留两个文件。
            assert!(
                current + previous < written - 7 * MIB,
                "{stream}：{current} + {previous}"
            );
        }
    }
    assert!(size("stdout.log.2").is_none());
}
