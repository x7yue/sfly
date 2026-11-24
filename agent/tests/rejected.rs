//! 控制面明确拒绝这条连接（握手时回 `Unauthenticated` 或 `PermissionDenied`：凭据无效或被吊销、名字和凭据不一致、
//! Agent 被停用……）之后 Agent 的行为（#492）：**不退出**，按 30 秒起、5 分钟封顶的退避重试（测试里改成毫秒），
//! 原因只在第一次被拒绝和原因变了的时候打一行，管理员在控制面改好之后它自己连上，不需要重启；原因里没有凭据。
//! 以前 `Unauthenticated` 直接退出，systemd（`Restart=on-failure`、`RestartSec=5`）每 5 秒把它拉起来，等于快速重试。

mod support;

use std::time::Duration;

use support::{AgentOptions, FakeControlPlane, capture_stderr, spawn_agent, wait_until};
use tonic::Code;

const SECRET: &str = "sfly_agt_0123456789abcdef0123456789abcdef";
const REJECTED: &str = "控制面拒绝了这台 Agent 的连接";

/// 退避从 100 毫秒起、封顶 400 毫秒的 Agent，凭据经环境变量交给它（和 `agent.env` 里的 `SFLY_TOKEN` 一样）。
fn spawn(cp: &FakeControlPlane, name: &str) -> support::AgentProcess {
    let mut options = AgentOptions::new(&cp.url, name);
    options.env = vec![
        ("SFLY_TOKEN", SECRET),
        ("SFLY_REJECTED_RETRY_MIN_MS", "100"),
        ("SFLY_REJECTED_RETRY_MAX_MS", "400"),
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

    // 之后又因为同一个原因被拒绝：连上过一次，原因重新打一行；凭据的任何部分都不在输出里。
    cp.reject_every_connection(Code::Unauthenticated, "这个 Agent 凭据已被吊销");
    cp.end_session();
    wait_until("又被拒绝", || reported().len() == 3).await;
    let everything = stderr.lock().unwrap().join("\n");
    assert!(!everything.contains(SECRET), "{everything}");
    assert!(!everything.contains("sfly_agt_"), "{everything}");
}
