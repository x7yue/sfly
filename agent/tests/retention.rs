//! 切入点 B（Agent 一侧）：任务目录的保留期（#69）。
//! 结果被 Ack 时写结束标记 `.finished`（保留期为 0 时立即删除目录）；Agent 启动时和之后定期扫描工作目录，
//! 删除超过保留期的任务目录。手上的任务、以点开头的目录和 `agent.sock` 不动。
//! 保留期按真实流逝的时长判断（#170，ADR 0018）：不受 Agent 时间修改影响，Agent 重启后从启动那一刻重新计时。

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
async fn at_startup_leftover_dirs_are_kept_whatever_their_age_and_half_deleted_ones_are_removed() {
    let cp = FakeControlPlane::start().await;
    let work = tempfile::tempdir().unwrap();
    let w = work.path();
    // 上次运行留下的目录没有内存里的记录：不看修改时间，保留期从这次启动算起。
    leftover(w, "old-finished", 3 * DAY, Some(2 * DAY));
    leftover(w, "old-leftover", 2 * DAY, None);
    leftover(w, "recent-finished", 3 * DAY, Some(HOUR));
    std::fs::create_dir_all(w.join("half~deleted/artifacts")).unwrap();
    other_dir(w, ".dev", 30 * DAY);
    other_dir(w, "not-a-task", 30 * DAY);

    let workdir = w.to_str().unwrap();
    let _agent = spawn_agent(options(
        &cp,
        "agent-sweep-startup",
        &["--work-dir", workdir, "--task-dir-retention", "24h"],
    ));
    cp.hello(0).await;

    wait_until("half-deleted dir removed", || {
        !w.join("half~deleted").exists()
    })
    .await;
    for kept in [
        "old-finished",
        "old-leftover",
        "recent-finished",
        ".dev",
        "not-a-task",
        "agent.sock",
    ] {
        assert!(w.join(kept).exists(), "{kept} 保留");
    }
}

#[tokio::test]
async fn leftover_dirs_past_the_retention_since_startup_are_removed_and_everything_else_is_kept() {
    let cp = FakeControlPlane::start().await;
    let work = tempfile::tempdir().unwrap();
    let w = work.path();
    leftover(w, "finished", HOUR, Some(HOUR));
    leftover(w, "leftover", HOUR, None);
    other_dir(w, ".dev", 30 * DAY);
    other_dir(w, ".install", 30 * DAY);
    other_dir(w, "not-a-task", 30 * DAY);

    let mut options = short_retention(&cp, "agent-sweep-since-startup", "1s");
    options
        .args
        .extend(["--work-dir".into(), w.to_str().unwrap().into()]);
    let _agent = spawn_agent(options);
    cp.hello(0).await;

    wait_until("expired task dirs removed", || {
        !w.join("finished").exists() && !w.join("leftover").exists()
    })
    .await;
    for kept in [".dev", ".install", "not-a-task", "agent.sock"] {
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
async fn at_startup_procs_dirs_are_kept_whatever_their_age() {
    let cp = FakeControlPlane::start().await;
    let procs_root = tempfile::tempdir().unwrap();
    let p = procs_root.path();
    procs_run(p, "run-old", 3 * DAY, 2 * DAY);
    procs_run(p, "run-recent", HOUR, HOUR);
    std::fs::create_dir_all(p.join("run-half~deleted")).unwrap();

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

    wait_until("half-deleted procs dir removed", || {
        !p.join("run-half~deleted").exists()
    })
    .await;
    for kept in ["run-old", "run-recent"] {
        assert!(p.join(kept).exists(), "{kept} 保留");
    }
}

#[tokio::test]
async fn procs_dirs_past_the_retention_since_startup_are_removed() {
    let cp = FakeControlPlane::start().await;
    let procs_root = tempfile::tempdir().unwrap();
    let p = procs_root.path();
    procs_run(p, "run-left", HOUR, HOUR);
    other_dir(p, ".hidden", 30 * DAY);
    std::fs::write(p.join("notes.txt"), "x").unwrap();

    let mut options = short_retention(&cp, "agent-sweep-procs-since-startup", "1s");
    options
        .args
        .extend(["--procs-dir".into(), p.to_str().unwrap().into()]);
    let _agent = spawn_agent(options);
    cp.hello(0).await;

    wait_until("expired procs dir removed", || !p.join("run-left").exists()).await;
    for kept in [".hidden", "notes.txt"] {
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
            "2s",
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

/// Agent 时间的 613 天（毫秒）：内网里实际遇到的偏差。
const DAYS_613_MS: i64 = 613 * 24 * 3600 * 1000;

/// 放一个等待删除的目录，等下一次扫描把它删掉：之后看到的就是这次扫描留下的状态。
async fn next_sweep(dir: &Path) {
    let probe = dir.join(format!("probe-{}~deleted", std::process::id()));
    std::fs::create_dir_all(&probe).unwrap();
    wait_until("next sweep", || !probe.exists()).await;
}

/// 短保留期的 Agent：每秒扫描一次。
fn short_retention<'a>(cp: &FakeControlPlane, name: &'a str, retention: &str) -> AgentOptions<'a> {
    options(
        cp,
        name,
        &[
            "--task-dir-retention",
            retention,
            "--task-dir-sweep-interval",
            "1",
        ],
    )
}

#[tokio::test]
async fn a_finished_task_dir_survives_agent_time_jumping_613_days_ahead_and_goes_after_the_retention()
 {
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(short_retention(&cp, "agent-retention-ahead", "10s"));
    let w = agent.work_dir.path();
    cp.hello(0).await;

    cp.assign(stub_task("task-ahead", "echo", json!({ "text": "x" })))
        .await;
    cp.result("task-ahead").await;
    let dir = w.join("task-ahead");
    wait_until(".finished", || dir.join(".finished").exists()).await;

    agent.set_agent_time_offset_ms(DAYS_613_MS);
    next_sweep(w).await;
    assert!(
        dir.join("output.json").exists(),
        "Agent 时间往后拨 613 天不会让任务目录过期"
    );
    wait_until("task dir removed after the retention", || !dir.exists()).await;
}

#[tokio::test]
async fn a_finished_task_dir_still_goes_after_the_retention_when_agent_time_jumps_back() {
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(short_retention(&cp, "agent-retention-back", "2s"));
    let w = agent.work_dir.path();
    cp.hello(0).await;

    cp.assign(stub_task("task-back", "echo", json!({ "text": "x" })))
        .await;
    cp.result("task-back").await;
    let dir = w.join("task-back");
    wait_until(".finished or removed", || {
        dir.join(".finished").exists() || !dir.exists()
    })
    .await;

    agent.set_agent_time_offset_ms(-DAYS_613_MS);
    wait_until("task dir removed after the retention", || !dir.exists()).await;
}

#[tokio::test]
async fn the_procs_dir_of_a_run_survives_agent_time_jumping_ahead_and_goes_after_the_retention() {
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(short_retention(&cp, "agent-retention-procs-ahead", "10s"));
    let w = agent.work_dir.path();
    let p = w.join("sfly-home/procs");
    cp.hello(0).await;

    let mut task = stub_task("task-of-run", "echo", json!({ "text": "x" }));
    task.run_id = "run-ahead".into();
    procs_run(&p, "run-ahead", Duration::ZERO, Duration::ZERO);
    cp.assign(task).await;
    cp.result("task-of-run").await;
    wait_until(".finished", || w.join("task-of-run/.finished").exists()).await;

    agent.set_agent_time_offset_ms(DAYS_613_MS);
    next_sweep(&p).await;
    assert!(
        p.join("run-ahead/start.log").exists(),
        "Agent 时间往后拨 613 天不会让后台进程目录过期"
    );
    wait_until("procs dir removed after the retention", || {
        !p.join("run-ahead").exists()
    })
    .await;
}

#[tokio::test]
async fn the_procs_dir_of_a_run_is_kept_from_its_last_task_not_from_startup() {
    let cp = FakeControlPlane::start().await;
    let agent = spawn_agent(short_retention(&cp, "agent-retention-procs-last", "3s"));
    let w = agent.work_dir.path();
    let p = w.join("sfly-home/procs");
    cp.hello(0).await;

    // 任务执行得比保留期久：结束时 Agent 已经启动了超过保留期，运行的目录仍从任务结束（Ack）那一刻算起。
    let ready = w.join("gate-ready");
    let release = w.join("gate-release");
    let mut task = stub_task(
        "task-long",
        "gate",
        json!({ "ready_file": ready, "release_file": release }),
    );
    task.run_id = "run-long".into();
    procs_run(&p, "run-long", Duration::ZERO, Duration::ZERO);
    procs_run(&p, "run-unrelated", Duration::ZERO, Duration::ZERO);
    cp.assign(task).await;
    // 没有记录的目录从启动算起，到期被删：这时 Agent 已经启动了超过保留期。
    wait_until("unrelated procs dir removed", || {
        !p.join("run-unrelated").exists()
    })
    .await;
    std::fs::write(&release, "").unwrap();
    cp.result("task-long").await;
    wait_until(".finished", || w.join("task-long/.finished").exists()).await;

    next_sweep(&p).await;
    assert!(p.join("run-long").exists(), "从最后一个任务结束时算起");
    assert!(w.join("task-long").exists(), "从结果被 Ack 时算起");
    wait_until("dirs removed after the retention", || {
        !p.join("run-long").exists() && !w.join("task-long").exists()
    })
    .await;
}

#[tokio::test]
async fn after_a_restart_finished_task_dirs_are_kept_for_the_retention_from_startup() {
    let cp = FakeControlPlane::start().await;
    let first = spawn_agent(AgentOptions::new(&cp.url, "agent-retention-restart"));
    cp.hello(0).await;
    cp.assign(stub_task("task-before", "echo", json!({ "text": "x" })))
        .await;
    cp.result("task-before").await;
    let work = first.work_dir;
    let w = work.path();
    let dir = w.join("task-before");
    wait_until(".finished", || dir.join(".finished").exists()).await;
    drop(first.child);
    // 结束标记是很久以前写的：重启后不看它的修改时间。
    age(&dir.join(".finished"), 30 * DAY);
    age(&dir, 30 * DAY);

    let mut options = short_retention(&cp, "agent-retention-restart", "10s");
    options
        .args
        .extend(["--work-dir".into(), w.to_str().unwrap().into()]);
    let _second = spawn_agent(options);
    cp.hello(1).await;
    next_sweep(w).await;
    assert!(
        dir.join("output.json").exists(),
        "重启后已结束的任务目录从启动那一刻重新计时"
    );
    wait_until("task dir removed after the retention", || !dir.exists()).await;
}

#[tokio::test]
async fn a_procs_dir_still_being_written_to_is_kept_until_the_writes_stop() {
    let cp = FakeControlPlane::start().await;
    let procs_root = tempfile::tempdir().unwrap();
    let p = procs_root.path().to_path_buf();
    procs_run(&p, "run-quiet", HOUR, HOUR);
    procs_run(&p, "run-writing", HOUR, HOUR);
    // 后台进程还在写日志。
    let log = p.join("run-writing/start.log");
    let writer = tokio::spawn(async move {
        loop {
            let _ = std::fs::write(&log, "log");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });

    let mut options = short_retention(&cp, "agent-sweep-procs-writing", "2s");
    options
        .args
        .extend(["--procs-dir".into(), p.to_str().unwrap().into()]);
    let _agent = spawn_agent(options);
    cp.hello(0).await;

    wait_until("quiet procs dir removed", || !p.join("run-quiet").exists()).await;
    next_sweep(&p).await;
    assert!(p.join("run-writing").exists(), "还在写日志的目录不过期");

    writer.abort();
    let _ = writer.await;
    wait_until("procs dir removed once the writes stop", || {
        !p.join("run-writing").exists()
    })
    .await;
}
