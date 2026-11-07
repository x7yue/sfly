//! 切入点 B（Agent 一侧）：任务目录的保留期（#69）。
//! 结果被 Ack 时写结束标记 `.finished`（保留期为 0 时立即删除目录）；Agent 启动时和之后定期扫描工作目录，
//! 删除超过保留期的任务目录。手上的任务、以点开头的目录和 `agent.sock` 不动。

mod support;

use std::path::Path;
use std::time::{Duration, SystemTime};

use serde_json::json;
use sfly_agent::proto::TaskStatus;
use support::{AgentOptions, FakeControlPlane, WAIT, spawn_agent, stub_task};

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

fn options<'a>(cp: &FakeControlPlane, name: &'a str, args: &[&str]) -> AgentOptions<'a> {
    let mut options = AgentOptions::new(&cp.url, name);
    options.args = args.iter().map(|a| a.to_string()).collect();
    options
}

/// 把文件或目录的修改时间改到 `ago` 之前。
fn age(path: &Path, ago: Duration) {
    std::fs::File::open(path)
        .unwrap()
        .set_modified(SystemTime::now() - ago)
        .unwrap();
}

const HOUR: Duration = Duration::from_secs(3600);
const DAY: Duration = Duration::from_secs(24 * 3600);

/// 上次运行留下的任务目录：目录的修改时间在 `ago` 之前；`finished` 给出时带上那么久之前写的结束标记。
fn leftover(work: &Path, name: &str, ago: Duration, finished: Option<Duration>) {
    let dir = work.join(name);
    std::fs::create_dir_all(dir.join("artifacts")).unwrap();
    std::fs::write(dir.join("task.json"), "{}").unwrap();
    if let Some(finished) = finished {
        std::fs::write(dir.join(".finished"), "").unwrap();
        age(&dir.join(".finished"), finished);
    }
    age(&dir, ago);
}

/// 不是任务目录的子目录（没有 task.json，也没有结束标记）。
fn other_dir(work: &Path, name: &str, ago: Duration) {
    let dir = work.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("state"), "x").unwrap();
    age(&dir, ago);
}

#[tokio::test]
async fn with_zero_retention_the_task_dir_is_removed_once_the_result_is_acked() {
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(options(
        &cp,
        "agent-retention-0",
        &["--task-dir-retention", "0"],
    ));
    cp.hello(0).await;

    cp.assign(stub_task("task-gone", "echo", json!({ "text": "x" })))
        .await;
    let (result, _) = cp.result("task-gone").await;
    assert_eq!(result.status(), TaskStatus::Success, "{result:?}");
    let dir = agent.work_dir.path().join("task-gone");
    wait_until("task dir removed", || !dir.exists()).await;
}

#[tokio::test]
async fn by_default_an_acked_task_dir_is_kept_with_a_finished_marker() {
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(AgentOptions::new(&cp.url, "agent-retention-default"));
    cp.hello(0).await;

    cp.assign(stub_task("task-kept", "echo", json!({ "text": "x" })))
        .await;
    cp.result("task-kept").await;
    let dir = agent.work_dir.path().join("task-kept");
    wait_until(".finished", || dir.join(".finished").exists()).await;
    assert!(dir.join("task.json").exists());
    assert!(dir.join("output.json").exists());
}

#[tokio::test]
async fn at_startup_task_dirs_past_the_retention_are_removed_and_everything_else_is_kept() {
    let cp = FakeControlPlane::start().await;
    let work = tempfile::tempdir().unwrap();
    let w = work.path();
    leftover(w, "old-finished", 3 * DAY, Some(2 * DAY));
    leftover(w, "old-leftover", 2 * DAY, None);
    std::fs::create_dir_all(w.join("half~deleted/artifacts")).unwrap();
    // Ack 的时间（结束标记）还在保留期内：目录本身旧也保留。
    leftover(w, "recent-finished", 3 * DAY, Some(HOUR));
    leftover(w, "recent-leftover", HOUR, None);
    other_dir(w, ".dev", 30 * DAY);
    other_dir(w, ".install", 30 * DAY);
    other_dir(w, "not-a-task", 30 * DAY);

    let workdir = w.to_str().unwrap();
    let _agent = spawn_agent(options(
        &cp,
        "agent-sweep-startup",
        &["--work-dir", workdir, "--task-dir-retention", "24h"],
    ));
    cp.hello(0).await;

    wait_until("expired task dirs removed", || {
        ["old-finished", "old-leftover", "half~deleted"]
            .iter()
            .all(|name| !w.join(name).exists())
    })
    .await;
    for kept in [
        "recent-finished",
        "recent-leftover",
        ".dev",
        ".install",
        "not-a-task",
        "agent.sock",
    ] {
        assert!(w.join(kept).exists(), "{kept} 保留");
    }
}

#[tokio::test]
async fn periodic_sweeps_skip_running_and_unacked_tasks() {
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(options(
        &cp,
        "agent-sweep-held",
        &[
            "--task-dir-retention",
            "0",
            "--task-dir-sweep-interval",
            "1",
        ],
    ));
    let w = agent.work_dir.path();
    cp.hello(0).await;
    cp.stop_acking();

    let ready = w.join("gate-ready");
    let release = w.join("gate-release");
    cp.assign(stub_task(
        "task-running",
        "gate",
        json!({ "ready_file": ready, "release_file": release }),
    ))
    .await;
    cp.assign(stub_task("task-unacked", "echo", json!({ "text": "x" })))
        .await;
    cp.result("task-unacked").await;
    wait_until("gate ready", || ready.exists()).await;

    // 运行中新出现的残留目录在下一次扫描时删除：这次扫描时两个任务都还在手上。
    leftover(w, "late-leftover", Duration::ZERO, None);
    wait_until("periodic sweep", || !w.join("late-leftover").exists()).await;
    assert!(
        w.join("task-running/task.json").exists(),
        "正在执行的任务不动"
    );
    assert!(
        w.join("task-unacked/output.json").exists(),
        "结果没有 Ack 的任务不动"
    );

    // 恢复 Ack：重连后重新上报的结果被 Ack，目录随即删除。
    std::fs::write(&release, "").unwrap();
    cp.result("task-running").await;
    cp.start_acking();
    cp.end_session();
    cp.hello(1).await;
    wait_until("acked task dirs removed", || {
        !w.join("task-running").exists() && !w.join("task-unacked").exists()
    })
    .await;
}

/// 上次运行留下的后台进程目录 `<procs>/<运行 ID>/`：目录和里面的日志的修改时间分别在 `dir_ago`、`log_ago` 之前。
fn procs_run(procs: &Path, run_id: &str, dir_ago: Duration, log_ago: Duration) {
    let dir = procs.join(run_id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("start.log"), "log").unwrap();
    age(&dir.join("start.log"), log_ago);
    age(&dir, dir_ago);
}

#[tokio::test]
async fn procs_dirs_past_the_retention_are_removed_by_the_latest_write_in_them() {
    let cp = FakeControlPlane::start().await;
    let procs_root = tempfile::tempdir().unwrap();
    let p = procs_root.path();
    procs_run(p, "run-old", 3 * DAY, 2 * DAY);
    // 后台进程还在写日志：目录本身旧也保留。
    procs_run(p, "run-writing", 3 * DAY, HOUR);
    procs_run(p, "run-recent", HOUR, HOUR);
    std::fs::create_dir_all(p.join("run-half~deleted")).unwrap();
    other_dir(p, ".hidden", 30 * DAY);
    std::fs::write(p.join("notes.txt"), "x").unwrap();
    age(&p.join("notes.txt"), 30 * DAY);

    let _agent = spawn_agent(options(
        &cp,
        "agent-sweep-procs",
        &[
            "--procs-dir",
            p.to_str().unwrap(),
            "--task-dir-retention",
            "24h",
        ],
    ));
    cp.hello(0).await;

    wait_until("expired procs dirs removed", || {
        !p.join("run-old").exists() && !p.join("run-half~deleted").exists()
    })
    .await;
    for kept in ["run-writing", "run-recent", ".hidden", "notes.txt"] {
        assert!(p.join(kept).exists(), "{kept} 保留");
    }
}

#[tokio::test]
async fn periodic_sweeps_skip_procs_dirs_of_runs_with_running_or_unacked_tasks() {
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(options(
        &cp,
        "agent-sweep-procs-held",
        &[
            "--task-dir-retention",
            "24h",
            "--task-dir-sweep-interval",
            "1",
        ],
    ));
    let w = agent.work_dir.path();
    let p = w.join("sfly-home/procs");
    cp.hello(0).await;
    cp.stop_acking();

    let ready = w.join("gate-ready");
    let release = w.join("gate-release");
    let mut running = stub_task(
        "task-running",
        "gate",
        json!({ "ready_file": ready, "release_file": release }),
    );
    running.run_id = "run-running".into();
    cp.assign(running).await;
    let mut unacked = stub_task("task-unacked", "echo", json!({ "text": "x" }));
    unacked.run_id = "run-unacked".into();
    cp.assign(unacked).await;
    cp.result("task-unacked").await;
    wait_until("gate ready", || ready.exists()).await;

    for run in ["run-running", "run-unacked", "run-other"] {
        procs_run(&p, run, 2 * DAY, 2 * DAY);
    }
    wait_until("periodic sweep", || !p.join("run-other").exists()).await;
    assert!(
        p.join("run-running").exists(),
        "运行中的任务所在运行的目录不动"
    );
    assert!(
        p.join("run-unacked").exists(),
        "结果没有 Ack 的任务所在运行的目录不动"
    );

    std::fs::write(&release, "").unwrap();
    cp.result("task-running").await;
    cp.start_acking();
    cp.end_session();
    cp.hello(1).await;
    wait_until("procs dirs of acked runs removed", || {
        !p.join("run-running").exists() && !p.join("run-unacked").exists()
    })
    .await;
}
