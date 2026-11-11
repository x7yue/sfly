//! 测试支撑：节点调用 Agent 能力（`sfly_agent::calls`）。
//!
//! - [`call`]：像 SDK 一样连到 Agent 的本地 socket 发一次调用，收下全部回复；
//! - [`AgentPair`]：两台真实 Agent（各连一个假控制面），`runner` 上的任务调用 `source` 的能力；
//! - [`hold_task`]：在一台 Agent 上派发一个一直运行的任务（桩节点 sleep），带上它引用的 Agent，
//!   等它启动：之后就能以这个任务的身份发起调用。

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use sfly_agent::proto::{ReferencedAgent, agent_message};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::UnixStream;

use super::{AgentOptions, AgentProcess, FakeControlPlane, spawn_agent, stub_task, wait_until};

/// 一次调用的全部回复。
#[derive(Debug, Clone)]
pub struct Reply {
    /// `{"item": ...}` 的各项。
    pub items: Vec<Value>,
    /// 最后一帧：`{"result": ...}` 或 `{"error": {...}}`。
    pub end: Value,
}

impl Reply {
    /// 调用成功时的结果；失败时 panic。
    pub fn result(&self) -> &Value {
        self.end
            .get("result")
            .unwrap_or_else(|| panic!("call failed: {}", self.end))
    }

    /// 调用失败时的 (kind, message)；成功时 panic。
    pub fn error(&self) -> (String, String) {
        let error = self
            .end
            .get("error")
            .unwrap_or_else(|| panic!("call succeeded: {}", self.end));
        (
            error["kind"].as_str().unwrap().to_string(),
            error["message"].as_str().unwrap().to_string(),
        )
    }
}

/// 一台 Agent 的本地 socket（[`spawn_agent`] 的工作目录下的 `agent.sock`）。
pub fn socket_of(agent: &AgentProcess) -> PathBuf {
    agent.work_dir.path().join("agent.sock")
}

/// 打开一个调用：发出请求，返回连接（调用方断开的测试自己关掉它）。
pub async fn open_call(socket: &Path, request: &Value) -> BufReader<UnixStream> {
    let mut request = request.clone();
    request["command"] = json!("call");
    let mut stream = UnixStream::connect(socket)
        .await
        .unwrap_or_else(|error| panic!("connect {}: {error}", socket.display()));
    let mut line = request.to_string().into_bytes();
    line.push(b'\n');
    stream.write_all(&line).await.unwrap();
    BufReader::new(stream)
}

/// 读完一个调用的全部回复。
pub async fn read_reply(stream: &mut BufReader<UnixStream>) -> Reply {
    let mut items = Vec::new();
    loop {
        let mut line = String::new();
        let n = stream.read_line(&mut line).await.unwrap();
        assert!(n > 0, "the agent closed the call without a final frame");
        let frame: Value = serde_json::from_str(&line).unwrap();
        if let Some(item) = frame.get("item") {
            items.push(item.clone());
            continue;
        }
        return Reply { items, end: frame };
    }
}

/// 发一次调用并读完回复。
pub async fn call(socket: &Path, request: Value) -> Reply {
    let mut stream = open_call(socket, &request).await;
    read_reply(&mut stream).await
}

/// 调用请求：`task_id` 的第 1 次尝试调用 `agent`（空串为自己）的 `method`。
pub fn request(task_id: &str, agent: &str, method: &str, args: Value) -> Value {
    json!({
        "task_id": task_id,
        "attempt": 1,
        "agent": agent,
        "method": method,
        "args": args,
        "timeout_ms": 20_000,
    })
}

/// 被引用的 Agent（AssignTask.referenced_agents 的一项）。
pub fn referenced(name: &str, address: &str, port: u16) -> ReferencedAgent {
    ReferencedAgent {
        name: name.to_string(),
        address: address.to_string(),
        port: port.into(),
        unavailable_reason: String::new(),
    }
}

/// 在 `cp` 连着的 Agent 上派发一个一直运行的任务（引用 `agents`），等到它启动。
pub async fn hold_task(cp: &FakeControlPlane, task_id: &str, agents: Vec<ReferencedAgent>) {
    let mut task = stub_task(task_id, "sleep", json!({ "seconds": 3600 }));
    task.referenced_agents = agents;
    cp.assign(task).await;
    cp.wait_for(&format!("{task_id} started"), |all| {
        all.iter()
            .any(|r| {
                matches!(&r.message.body, Some(agent_message::Body::Started(s)) if s.task_id == task_id)
            })
            .then_some(())
    })
    .await;
}

/// 两台真实 Agent：`runner` 上的任务调用 `source` 的能力。
pub struct AgentPair {
    pub runner_cp: FakeControlPlane,
    pub runner: AgentProcess,
    pub source_cp: FakeControlPlane,
    pub source: AgentProcess,
    /// `source` 供其它 Agent 连接的端口（系统分配，随 Hello 上报）。
    pub source_port: u16,
}

impl AgentPair {
    pub async fn start(runner: &str, source: &str) -> Self {
        let (runner_cp, source_cp) = (
            FakeControlPlane::start().await,
            FakeControlPlane::start().await,
        );
        let runner_agent = spawn_agent(AgentOptions::new(&runner_cp.url, runner));
        let source_agent = spawn_agent(AgentOptions::new(&source_cp.url, source));
        let peer = source_cp.hello(0).await.peer.expect("Hello.peer");
        assert_eq!(peer.listen_error, "", "{source} is not listening");
        runner_cp.hello(0).await;
        let socket = socket_of(&runner_agent);
        wait_until("the runner's local socket", || socket.exists()).await;
        Self {
            runner_cp,
            runner: runner_agent,
            source_cp,
            source: source_agent,
            source_port: u16::try_from(peer.port).unwrap(),
        }
    }

    /// `source` 作为被引用的 Agent（地址 127.0.0.1）。
    pub fn source_ref(&self, name: &str) -> ReferencedAgent {
        referenced(name, "127.0.0.1", self.source_port)
    }

    /// runner 的本地 socket。
    pub fn socket(&self) -> PathBuf {
        socket_of(&self.runner)
    }
}
