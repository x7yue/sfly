//! 控制面明确拒绝这条连接（握手时回 `Unauthenticated` 或 `PermissionDenied`：凭据无效或被吊销、名字和凭据不一致、
//! Agent 被停用……）之后 Agent 的行为（#492）：**不退出**，按 30 秒起、5 分钟封顶的退避重试（测试里改成毫秒），
//! 原因只在第一次被拒绝和原因变了的时候打一行，管理员在控制面改好之后它自己连上，不需要重启；原因里没有凭据。
//! 以前 `Unauthenticated` 直接退出，systemd（`Restart=on-failure`、`RestartSec=5`）每 5 秒把它拉起来，等于快速重试。
//! 被拒绝期间手上的任务照常跑完（和连不上控制面时一样，不终止），恢复之后由握手决定继续还是放弃。
//! 这里的退避不加抖动（`SFLY_REJECTED_RETRY_JITTER=0`），间隔才好断言；抖动本身在 `src/lib.rs` 的单元测试里。

mod support;

use std::time::Duration;

use sfly_agent::proto::TaskStatus;
use sfly_agent::proto::agent_message::Body as AgentBody;
use support::{AgentOptions, FakeControlPlane, capture_stderr, spawn_agent, stub_task, wait_until};
use tonic::Code;

const SECRET: &str = "sfly_agt_0123456789abcdef0123456789abcdef";
const TASK_TOKEN: &str = "sfly_tsk_0123456789abcdef0123456789abcdef";
const REJECTED: &str = "控制面拒绝了这台 Agent 的连接";

/// 退避从 100 毫秒起、封顶 400 毫秒的 Agent，凭据经环境变量交给它（和 `agent.env` 里的 `SFLY_TOKEN` 一样）。
fn spawn(cp: &FakeControlPlane, name: &str) -> support::AgentProcess {
    spawn_with(cp, name, "100", "400")
}

/// 退避从 `min` 毫秒起、封顶 `max` 毫秒、不加抖动的 Agent。
fn spawn_with(cp: &FakeControlPlane, name: &str, min: &str, max: &str) -> support::AgentProcess {
    let mut options = AgentOptions::new(&cp.url, name);
    options.env = vec![
        ("SFLY_TOKEN", SECRET),
        ("SFLY_REJECTED_RETRY_MIN_MS", min),
        ("SFLY_REJECTED_RETRY_MAX_MS", max),
        ("SFLY_REJECTED_RETRY_JITTER", "0"),
    ];
    options.pipe_stderr = true;
    spawn_agent(options)
}

async fn wait_for_rejections(cp: &FakeControlPlane, at_least: usize) {
    wait_until(&format!("{at_least} 次被拒绝"), || {
        cp.rejection_times().len() >= at_least
    })
    .await;
}

#[tokio::test]
async fn a_rejected_agent_keeps_running_and_retries_with_a_growing_wait() {
    for code in [Code::Unauthenticated, Code::PermissionDenied] {
        let cp = FakeControlPlane::start().await;
        cp.reject_every_connection(code, "凭据已被吊销");
        let mut agent = spawn(&cp, "agent-rejected");
        wait_for_rejections(&cp, 6).await;

        // 没有退出（以前 `Unauthenticated` 直接退出）。
        assert!(
            agent.child.try_wait().unwrap().is_none(),
            "{code:?}：被拒绝之后 Agent 不能退出"
        );
        // 等待从 100 毫秒起翻倍到 400 毫秒封顶：每次至少等这么久（不会快速重试），也不会等得没有尽头。
        let times = cp.rejection_times();
        let gaps: Vec<Duration> = times.windows(2).map(|w| w[1] - w[0]).collect();
        for (gap, wait) in gaps.iter().zip([100, 200, 400, 400, 400]) {
            let wait = Duration::from_millis(wait);
            assert!(
                *gap + Duration::from_millis(40) >= wait,
                "{code:?}：间隔 {gap:?} 比应有的等待 {wait:?} 短：{gaps:?}"
            );
            assert!(
                *gap < wait + Duration::from_secs(3),
                "{code:?}：间隔 {gap:?} 比应有的等待 {wait:?} 长得多：{gaps:?}"
            );
        }
        // 封顶：最后几次的间隔不再变长。
        assert!(
            gaps[3..]
                .iter()
                .all(|g| *g < Duration::from_millis(400) + Duration::from_secs(3)),
            "{gaps:?}"
        );
    }
}

#[tokio::test]
async fn the_reason_is_printed_once_and_again_only_when_it_changes() {
    let cp = FakeControlPlane::start().await;
    cp.reject_every_connection(Code::Unauthenticated, "这个 Agent 凭据已被吊销");
    let mut agent = spawn(&cp, "agent-reason");
    let stderr = capture_stderr(&mut agent);
    let reported = || -> Vec<String> {
        stderr
            .lock()
            .unwrap()
            .iter()
            .filter(|line| line.contains(REJECTED))
            .cloned()
            .collect()
    };

    // 同一个原因被拒绝很多次：只打一行，写明状态码和控制面的说明。
    wait_for_rejections(&cp, 5).await;
    let first = reported();
    assert_eq!(first.len(), 1, "{first:?}");
    assert!(
        first[0].contains("Unauthenticated") && first[0].contains("这个 Agent 凭据已被吊销"),
        "{first:?}"
    );

    // 原因变了：再打一行。
    let seen = cp.rejection_times().len();
    cp.reject_every_connection(
        Code::PermissionDenied,
        "Agent「agent-reason」已被停用：让项目管理员恢复它",
    );
    wait_for_rejections(&cp, seen + 4).await;
    let second = reported();
    assert_eq!(second.len(), 2, "{second:?}");
    assert!(
        second[1].contains("PermissionDenied") && second[1].contains("已被停用"),
        "{second:?}"
    );

    // 管理员改好之后 Agent 自己连上，不需要重启：握手成功，并说一声「之前被拒绝」。
    cp.stop_rejecting();
    let hello = cp.hello(0).await;
    assert_eq!(hello.name, "agent-reason");
    wait_until("接受的说明", || {
        stderr
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.contains("控制面接受了这台 Agent 的连接（之前被拒绝）"))
    })
    .await;
    assert!(agent.child.try_wait().unwrap().is_none());

    // 之后又因为和上一次打印的同一个原因被拒绝：连上过一次，原因重新打一行（不是因为原因变了，是因为这次又是
    // 从「已经连上」变成「被拒绝」）；凭据的任何部分都不在输出里。
    cp.reject_every_connection(
        Code::PermissionDenied,
        "Agent「agent-reason」已被停用：让项目管理员恢复它",
    );
    cp.end_session();
    wait_until("又被拒绝", || reported().len() == 3).await;
    assert!(
        reported()[2].contains("PermissionDenied") && reported()[2].contains("已被停用"),
        "{:?}",
        reported()
    );
    let everything = stderr.lock().unwrap().join("\n");
    assert!(!everything.contains(SECRET), "{everything}");
    assert!(!everything.contains("sfly_agt_"), "{everything}");
}

/// 连上过一次之后又被拒绝：等待回到起点，不是接着上一轮已经翻倍的长度。
#[tokio::test]
async fn after_a_connection_the_wait_starts_over_from_the_beginning() {
    let cp = FakeControlPlane::start().await;
    cp.reject_every_connection(Code::Unauthenticated, "凭据已被吊销");
    // 200 毫秒起、封顶 800 毫秒：第一轮被拒绝很多次，等待已经到了封顶。
    let mut agent = spawn_with(&cp, "agent-reset", "200", "800");
    let _stderr = capture_stderr(&mut agent);
    wait_for_rejections(&cp, 5).await;

    // 管理员改好：连上。
    cp.stop_rejecting();
    cp.hello(0).await;

    // 又被拒绝：这一轮的第一次间隔是 200 毫秒（接着上一轮会是 800 毫秒）。
    let seen = cp.rejection_times().len();
    cp.reject_every_connection(Code::Unauthenticated, "凭据又被吊销了");
    cp.end_session();
    wait_for_rejections(&cp, seen + 3).await;
    let times = cp.rejection_times();
    let gaps: Vec<Duration> = times[seen..].windows(2).map(|w| w[1] - w[0]).collect();
    assert!(
        gaps[0] >= Duration::from_millis(160) && gaps[0] < Duration::from_millis(600),
        "这一轮的第一次间隔应当是 200 毫秒（上一轮已经到了 800 毫秒封顶）：{gaps:?}"
    );
    assert!(
        gaps[1] >= Duration::from_millis(360) && gaps[1] < Duration::from_millis(1400),
        "第二次间隔翻倍到 400 毫秒：{gaps:?}"
    );
}

/// 被拒绝期间手上的任务照常跑完（不终止，和连不上控制面时一样）：结果留在 Agent 里，恢复之后 Hello 列出它，
/// 控制面按握手决定继续（这里是继续），结果在这时上报。吊销或停用一台 Agent 不会停下它手上正在跑的任务。
#[tokio::test]
async fn a_task_in_hand_runs_to_the_end_while_the_agent_is_rejected_and_is_reported_after_recovery()
{
    let cp = FakeControlPlane::start().await;
    let mut agent = spawn_with(&cp, "agent-task", "100", "400");
    let stderr = capture_stderr(&mut agent);
    cp.hello(0).await;
    let mut task = stub_task(
        "rejected-task",
        "sleep",
        serde_json::json!({ "seconds": 2 }),
    );
    task.task_token = TASK_TOKEN.into();
    cp.assign(task).await;
    cp.wait_for("任务开始", |all| {
        all.iter().find_map(|r| match &r.message.body {
            Some(AgentBody::Started(started)) if started.task_id == "rejected-task" => Some(()),
            _ => None,
        })
    })
    .await;

    // 吊销：控制面断开这条连接，之后的每次握手都被拒绝。
    cp.reject_every_connection(Code::Unauthenticated, "Agent 凭据已被吊销");
    cp.end_session();
    wait_for_rejections(&cp, 2).await;
    // 任务在被拒绝期间继续跑，跑完（执行器写了 output.json）；Agent 没有退出，也没有终止它。
    let output = agent
        .work_dir
        .path()
        .join("rejected-task")
        .join("output.json");
    wait_until("任务在被拒绝期间跑完", || output.exists()).await;
    assert!(agent.child.try_wait().unwrap().is_none(), "Agent 没有退出");
    let results = || {
        cp.received()
            .iter()
            .filter(|m| matches!(m.body, Some(AgentBody::Result(_))))
            .count()
    };
    assert_eq!(results(), 0, "被拒绝期间连不上控制面，结果还留在 Agent 里");

    // 恢复：Hello 列出这个任务，结果在新会话里上报，状态是成功（没有被终止）。
    cp.stop_rejecting();
    let hello = cp.hello(1).await;
    let listed: Vec<(&str, bool)> = hello
        .running_tasks
        .iter()
        .map(|t| (t.task_id.as_str(), t.started))
        .collect();
    assert_eq!(listed, [("rejected-task", true)], "{hello:?}");
    let (result, session) = cp.result("rejected-task").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    assert_eq!(session, 1, "结果在恢复之后的会话里上报");
    // 输出里没有凭据。
    let everything = stderr.lock().unwrap().join("\n");
    assert!(
        !everything.contains(SECRET) && !everything.contains(TASK_TOKEN),
        "{everything}"
    );
}
