//! Agent 能力 exec（ADR 0019）：节点经自己所在 Agent 的本地 socket 在另一台 Agent（或自己）上执行一条命令。
//! 两台真实 Agent 在同一台机器上，命令写下的 pid 文件和进程都在这台机器上，可以直接检查。
//!
//! 命令归属于发起调用的任务：输出逐行回到调用方（标明来自哪台 Agent），必须带超时；超时、任务被取消或结束、
//! 调用方断开、两台 Agent 之间的连接断开时，命令连同它的进程树一起结束。命令不占那台 Agent 的槽位，不产生任务。
#![cfg(unix)]

mod support;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use sfly_agent::proto::{CancelTask, agent_message, server_message};
use support::calls::{AgentPair, Reply, call, hold_task, open_call, read_reply, referenced};
use support::{stub_task, wait_until};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

/// 一棵进程树：sh 在后台启动 sleep，把两者的 PID 写进 `$PIDS`，然后等它。
const TREE: &str = r#"sleep 300 & echo $! >> "$PIDS"; echo $$ >> "$PIDS"; echo started; wait"#;

/// `task_id` 在 `agent`（空串为自己）上执行 `sh -c script`，环境变量 `PIDS` 指向 `pids`。
fn run(task: &str, agent: &str, script: &str, pids: &Path, timeout_ms: u64) -> Value {
    json!({
        "task_id": task,
        "attempt": 1,
        "agent": agent,
        "method": "exec.run",
        "args": { "argv": ["sh", "-c", script], "env": { "PIDS": pids } },
        "timeout_ms": timeout_ms,
    })
}

/// `{"stdout": ...}`（或 `stderr`）的各行。
fn lines(reply: &Reply, stream: &str) -> Vec<String> {
    reply
        .items
        .iter()
        .filter_map(|item| item.get(stream)?.as_str().map(str::to_string))
        .collect()
}

/// 进程是否还活着（僵尸进程算已经结束）。
fn alive(pid: u32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        // 第三个字段是状态；命令名在括号里，可能有空格，从最后一个 ')' 之后取。
        Ok(stat) => !stat
            .rsplit_once(')')
            .is_some_and(|(_, rest)| rest.trim_start().starts_with(['Z', 'X'])),
        Err(_) => false,
    }
}

/// 等 [`TREE`] 写好两个 PID，读出来。
async fn tree_pids(path: &Path) -> Vec<u32> {
    let read = || -> Vec<u32> {
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .split_whitespace()
            .filter_map(|p| p.parse().ok())
            .collect()
    };
    wait_until("the command to write its pids", || read().len() == 2).await;
    read()
}

async fn wait_gone(pids: &[u32]) {
    wait_until("the command's process tree to be gone", || {
        pids.iter().all(|&p| !alive(p))
    })
    .await;
}

#[tokio::test]
async fn a_command_runs_on_another_agent_and_its_output_comes_back_line_by_line_tagged_with_that_agent()
 {
    let pair = AgentPair::start("runner-exec-ok", "source-exec-ok").await;
    hold_task(
        &pair.runner_cp,
        "task-exec-ok",
        vec![pair.source_ref("source-exec-ok")],
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let pids = dir.path().join("pids");
    // $PPID 是执行它的 Agent：命令在 source 上运行，不在 runner 上。
    let script =
        r#"echo out; echo err >&2; pwd; echo "$GREETING"; echo $PPID; printf tail; exit 3"#;
    let mut request = run("task-exec-ok", "source-exec-ok", script, &pids, 20_000);
    request["args"]["cwd"] = json!(dir.path());
    request["args"]["env"]["GREETING"] = json!("你好");

    let reply = call(&pair.socket(), request).await;

    assert_eq!(reply.result(), &json!({ "exit_code": 3 }));
    let tag = "[Agent source-exec-ok] ";
    let source_pid = pair.source.child.id().unwrap();
    assert_eq!(
        lines(&reply, "stdout"),
        [
            format!("{tag}out"),
            format!("{tag}{}", dir.path().display()),
            format!("{tag}你好"),
            format!("{tag}{source_pid}"),
            format!("{tag}tail"),
        ]
    );
    assert_eq!(lines(&reply, "stderr"), [format!("{tag}err")]);

    // 自己所在的 Agent 同样可以执行，输出标明是自己。
    let own = call(
        &pair.socket(),
        run("task-exec-ok", "", "echo $PPID", &pids, 20_000),
    )
    .await;
    assert_eq!(own.result(), &json!({ "exit_code": 0 }));
    assert_eq!(
        lines(&own, "stdout"),
        [format!(
            "[Agent runner-exec-ok] {}",
            pair.runner.child.id().unwrap()
        )]
    );
}

#[tokio::test]
async fn a_missing_program_or_working_directory_is_not_found() {
    let pair = AgentPair::start("runner-exec-missing", "source-exec-missing").await;
    hold_task(
        &pair.runner_cp,
        "task-exec-missing",
        vec![pair.source_ref("source-exec-missing")],
    )
    .await;
    let mut request = run(
        "task-exec-missing",
        "source-exec-missing",
        "",
        Path::new("/"),
        20_000,
    );
    request["args"]["argv"] = json!(["sfly-no-such-program"]);
    let (kind, message) = call(&pair.socket(), request.clone()).await.error();
    assert_eq!(kind, "not_found");
    assert_eq!(
        message,
        "Agent source-exec-missing：找不到程序 sfly-no-such-program"
    );

    request["args"]["argv"] = json!(["true"]);
    request["args"]["cwd"] = json!("/sfly-no-such-dir");
    let (kind, message) = call(&pair.socket(), request.clone()).await.error();
    assert_eq!(kind, "not_found");
    assert_eq!(
        message,
        "Agent source-exec-missing：工作目录 /sfly-no-such-dir 不存在"
    );

    request["args"]["cwd"] = json!("relative");
    assert_eq!(call(&pair.socket(), request).await.error().0, "invalid");
}

#[tokio::test]
async fn a_command_needs_a_timeout_and_running_past_it_ends_the_whole_tree() {
    let pair = AgentPair::start("runner-exec-timeout", "source-exec-timeout").await;
    hold_task(
        &pair.runner_cp,
        "task-exec-timeout",
        vec![pair.source_ref("source-exec-timeout")],
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let pids = dir.path().join("pids");

    // 不给超时（0 为不限）不能执行。
    let (kind, message) = call(
        &pair.socket(),
        run("task-exec-timeout", "source-exec-timeout", "true", &pids, 0),
    )
    .await
    .error();
    assert_eq!(kind, "invalid");
    assert!(message.contains("必须给超时"), "{message}");

    // 进程树里的进程都忽略 SIGTERM：宽限期过后被强制杀掉。
    let script = format!("trap '' TERM; {TREE}");
    let mut stream = open_call(
        &pair.socket(),
        &run(
            "task-exec-timeout",
            "source-exec-timeout",
            &script,
            &pids,
            1_000,
        ),
    )
    .await;
    let tree = tree_pids(&pids).await;
    let reply = read_reply(&mut stream).await;
    let (kind, message) = reply.error();
    assert_eq!(kind, "timeout");
    assert_eq!(
        message,
        "Agent source-exec-timeout：命令超过 1 秒没有结束，已结束它的进程树"
    );
    // 超时之前的输出照常给出。
    assert_eq!(
        lines(&reply, "stdout"),
        ["[Agent source-exec-timeout] started"]
    );
    wait_gone(&tree).await;
}

#[tokio::test]
async fn cancelling_the_calling_task_ends_the_command_and_its_tree() {
    let pair = AgentPair::start("runner-exec-cancel", "source-exec-cancel").await;
    hold_task(
        &pair.runner_cp,
        "task-exec-cancel",
        vec![pair.source_ref("source-exec-cancel")],
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let pids = dir.path().join("pids");
    let mut stream = open_call(
        &pair.socket(),
        &run(
            "task-exec-cancel",
            "source-exec-cancel",
            TREE,
            &pids,
            600_000,
        ),
    )
    .await;
    let tree = tree_pids(&pids).await;

    pair.runner_cp
        .send(server_message::Body::Cancel(CancelTask {
            task_id: "task-exec-cancel".into(),
            attempt: 1,
            force: false,
        }))
        .await;
    let reply = tokio::time::timeout(Duration::from_secs(10), read_reply(&mut stream))
        .await
        .expect("the command did not end when the task was cancelled");
    assert_eq!(reply.error().0, "cancelled");
    wait_gone(&tree).await;
}

#[tokio::test]
async fn the_command_ends_with_its_tree_when_the_calling_task_finishes() {
    let pair = AgentPair::start("runner-exec-finish", "source-exec-finish").await;
    // 一个几秒后就正常结束的任务。
    let mut task = stub_task("task-exec-finish", "sleep", json!({ "seconds": 5 }));
    task.referenced_agents = vec![pair.source_ref("source-exec-finish")];
    pair.runner_cp.assign(task).await;
    pair.runner_cp
        .wait_for("task-exec-finish started", |all| {
            all.iter()
                .any(|r| matches!(&r.message.body, Some(agent_message::Body::Started(_))))
                .then_some(())
        })
        .await;
    let dir = tempfile::tempdir().unwrap();
    let pids = dir.path().join("pids");
    let mut stream = open_call(
        &pair.socket(),
        &run(
            "task-exec-finish",
            "source-exec-finish",
            TREE,
            &pids,
            600_000,
        ),
    )
    .await;
    let tree = tree_pids(&pids).await;

    let (result, _) = pair.runner_cp.result("task-exec-finish").await;
    assert_eq!(result.status, sfly_agent::proto::TaskStatus::Success as i32);
    let reply = read_reply(&mut stream).await;
    assert_eq!(reply.error().0, "cancelled");
    wait_gone(&tree).await;
}

#[tokio::test]
async fn the_command_ends_with_its_tree_when_the_caller_goes_away() {
    let pair = AgentPair::start("runner-exec-gone", "source-exec-gone").await;
    hold_task(
        &pair.runner_cp,
        "task-exec-gone",
        vec![pair.source_ref("source-exec-gone")],
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    for (agent, name) in [("source-exec-gone", "remote"), ("", "own")] {
        let pids = dir.path().join(name);
        let stream = open_call(
            &pair.socket(),
            &run("task-exec-gone", agent, TREE, &pids, 600_000),
        )
        .await;
        let tree = tree_pids(&pids).await;
        // 节点进程退出、提前放弃调用：连接关闭。
        drop(stream);
        wait_gone(&tree).await;
    }
}

/// 两台 Agent 之间的 TCP 中转：runner 经它连到 source；[`Relay::cut`] 断开全部连接、不再接受新连接，
/// 模拟两台机器之间的网络断开。
struct Relay {
    port: u16,
    accept: JoinHandle<()>,
    links: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl Relay {
    async fn start(upstream: u16) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let links: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::default();
        let accept = tokio::spawn({
            let links = links.clone();
            async move {
                while let Ok((mut down, _)) = listener.accept().await {
                    let link = tokio::spawn(async move {
                        let mut up = TcpStream::connect(("127.0.0.1", upstream)).await.unwrap();
                        let _ = tokio::io::copy_bidirectional(&mut down, &mut up).await;
                    });
                    links.lock().unwrap().push(link);
                }
            }
        });
        Self {
            port,
            accept,
            links,
        }
    }

    fn cut(&self) {
        self.accept.abort();
        for link in self.links.lock().unwrap().drain(..) {
            link.abort();
        }
    }
}

#[tokio::test]
async fn the_command_ends_with_its_tree_when_the_connection_between_the_agents_breaks() {
    let pair = AgentPair::start("runner-exec-cut", "source-exec-cut").await;
    let relay = Relay::start(pair.source_port).await;
    hold_task(
        &pair.runner_cp,
        "task-exec-cut",
        vec![referenced("source-exec-cut", "127.0.0.1", relay.port)],
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let pids = dir.path().join("pids");
    let mut stream = open_call(
        &pair.socket(),
        &run("task-exec-cut", "source-exec-cut", TREE, &pids, 600_000),
    )
    .await;
    let tree = tree_pids(&pids).await;

    relay.cut();
    wait_gone(&tree).await;
    // 调用方得到失败（连接断了），不会一直等下去。
    let reply = tokio::time::timeout(Duration::from_secs(10), read_reply(&mut stream))
        .await
        .expect("the call did not end when the connection broke");
    let (kind, message) = reply.error();
    assert_eq!(kind, "unreachable", "{message}");
}

#[tokio::test]
async fn a_command_that_exits_leaves_no_processes_behind() {
    let pair = AgentPair::start("runner-exec-leftover", "source-exec-leftover").await;
    hold_task(
        &pair.runner_cp,
        "task-exec-leftover",
        vec![pair.source_ref("source-exec-leftover")],
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let pids = dir.path().join("pids");
    // 留下一个后台进程（还拿着输出管道）就退出：不用来启动常驻进程，剩下的进程被结束。
    let script = r#"sleep 300 & echo $! >> "$PIDS"; echo $$ >> "$PIDS"; echo bye"#;
    let reply = tokio::time::timeout(
        Duration::from_secs(15),
        call(
            &pair.socket(),
            run(
                "task-exec-leftover",
                "source-exec-leftover",
                script,
                &pids,
                600_000,
            ),
        ),
    )
    .await
    .expect("the call waited for the background process");
    assert_eq!(reply.result(), &json!({ "exit_code": 0 }));
    assert_eq!(
        lines(&reply, "stdout"),
        ["[Agent source-exec-leftover] bye"]
    );
    wait_gone(&tree_pids(&pids).await).await;
}

#[tokio::test]
async fn a_command_takes_no_slot_and_makes_no_task_on_the_agent_it_runs_on() {
    let pair = AgentPair::start("runner-exec-slot", "source-exec-slot").await;
    hold_task(
        &pair.runner_cp,
        "task-exec-slot",
        vec![pair.source_ref("source-exec-slot")],
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let pids = dir.path().join("pids");
    let stream = open_call(
        &pair.socket(),
        &run("task-exec-slot", "source-exec-slot", TREE, &pids, 600_000),
    )
    .await;
    tree_pids(&pids).await;
    let running_since = tokio::time::Instant::now();

    // 命令运行期间 source 的心跳里没有任务（槽位占用不变），也没有上报任务开始。
    let running = pair
        .source_cp
        .wait_for("a heartbeat while the command runs", |all| {
            all.iter().find_map(|r| match &r.message.body {
                Some(agent_message::Body::Heartbeat(h)) if r.at > running_since => {
                    Some(h.running_tasks.len())
                }
                _ => None,
            })
        })
        .await;
    assert_eq!(running, 0);
    assert!(
        !pair
            .source_cp
            .received()
            .iter()
            .any(|m| matches!(m.body, Some(agent_message::Body::Started(_)))),
        "the command showed up as a task on source"
    );
    drop(stream);
}
