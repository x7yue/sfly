//! 基准测试（ARCHITECTURE §7.6）：Agent 的指标合并与按行切分吞吐。只在本地运行，不进 CI：
//! `cargo test` 不运行 benches/，`pnpm perf` 顺带运行并汇总进报告（apps/server/perf/items/08-bench-agent.ts）。
//!
//! 单独运行：`cargo bench -p sfly-agent --bench telemetry`；结果写在 `target/criterion/`
//! （环境变量 `CRITERION_HOME` 可以改）。
//!
//! - `merge_events`：[`Merger`] 合并 1 秒内的 1 万次上报（4 个指标轮流），再全部取出——
//!   对应节点每秒 1 万次 `ctx.metric()` 时 Agent 每秒的合并工作量；
//! - `merge_labeled_events`：同样 1 万次上报，但是 4 个带标签（`pid`、`name`）的指标 × 50 个进程
//!   （200 个序列轮流），每次上报新建标签（与 Agent 解析事件 JSON 时一样，含排序）——对应按进程上报的节点；
//! - `split_short_lines` / `split_long_lines`：[`LineSplitter`] 按 16 KiB 一块（与读取管道时相同）切分
//!   1 MiB 的输出，分别是 80 字节的短行和没有换行、按 64 KiB 拆开的长行。

use std::hint::black_box;
use std::time::Duration;

use criterion::{BatchSize, Criterion, Throughput, criterion_group, criterion_main};
use sfly_agent::logs::LineSplitter;
use sfly_agent::metrics::{Labels, Merger};

const EVENTS: usize = 10_000;
const METRICS: [&str; 4] = ["seq", "tps", "latency", "errors"];
const LABELED_METRICS: [&str; 4] = [
    "cpu_by_process",
    "rss_by_process",
    "fds_by_process",
    "io_by_process",
];
const PROCESSES: usize = 50;
const OUTPUT_BYTES: usize = 1024 * 1024;
const READ_CHUNK: usize = 16 * 1024;

fn merge(c: &mut Criterion) {
    // 2026-01-01T00:00:00Z 起的 1 秒内均匀分布。
    let start_ms = 1_767_225_600_000_i64;
    let events: Vec<(i64, &str, &str, f64)> = (0..EVENTS)
        .map(|i| {
            let name = METRICS[i % METRICS.len()];
            let kind = if name == "errors" { "counter" } else { "gauge" };
            (start_ms + (i * 1000 / EVENTS) as i64, name, kind, i as f64)
        })
        .collect();
    let mut group = c.benchmark_group("merge");
    group.throughput(Throughput::Elements(EVENTS as u64));
    group.bench_function("merge_events", |b| {
        b.iter(|| {
            let mut merger = Merger::default();
            for &(ts, name, kind, value) in &events {
                // 与 Agent 一样每次上报一个新的 String（来自事件 JSON 的解析结果）。
                merger.add(ts, name.to_owned(), Labels::new(), kind, value);
            }
            black_box(merger.take(None))
        });
    });
    let processes: Vec<(String, String)> = (0..PROCESSES)
        .map(|p| ((1000 + p).to_string(), format!("worker-{p}")))
        .collect();
    let labeled: Vec<(i64, &str, &str, &str, f64)> = (0..EVENTS)
        .map(|i| {
            let name = LABELED_METRICS[i % LABELED_METRICS.len()];
            let (pid, process) = &processes[i / LABELED_METRICS.len() % PROCESSES];
            (
                start_ms + (i * 1000 / EVENTS) as i64,
                name,
                pid.as_str(),
                process.as_str(),
                i as f64,
            )
        })
        .collect();
    group.bench_function("merge_labeled_events", |b| {
        b.iter(|| {
            let mut merger = Merger::default();
            for &(ts, name, pid, process, value) in &labeled {
                // 事件里的标签对象顺序是 SDK 写入的顺序（不一定按键排序），解析时排序。
                let labels = Labels::from_iter([
                    ("pid".to_owned(), pid.to_owned()),
                    ("name".to_owned(), process.to_owned()),
                ]);
                merger.add(ts, name.to_owned(), labels, "gauge", value);
            }
            black_box(merger.take(None))
        });
    });
    group.finish();
}

fn split(c: &mut Criterion) {
    let short: Vec<u8> = {
        let line = format!("{}\n", "x".repeat(79));
        line.as_bytes()
            .iter()
            .copied()
            .cycle()
            .take(OUTPUT_BYTES)
            .collect()
    };
    let long = vec![b'y'; OUTPUT_BYTES];
    let mut group = c.benchmark_group("split");
    group.throughput(Throughput::Bytes(OUTPUT_BYTES as u64));
    for (name, output) in [("split_short_lines", &short), ("split_long_lines", &long)] {
        group.bench_function(name, |b| {
            b.iter_batched(
                LineSplitter::default,
                |mut splitter| {
                    let mut lines = 0usize;
                    for chunk in output.chunks(READ_CHUNK) {
                        splitter.push(chunk, |text| {
                            black_box(text);
                            lines += 1;
                        });
                    }
                    splitter.finish(|text| {
                        black_box(text);
                        lines += 1;
                    });
                    lines
                },
                BatchSize::SmallInput,
            );
        });
    }
    group.finish();
}

fn config() -> Criterion {
    // 缩短默认的 3 秒预热 + 5 秒测量、100 个样本：pnpm perf 要在约 10 分钟内跑完，
    // 这几项每次迭代约 1 ms，1 + 3 秒、50 个样本已经足够稳定。
    Criterion::default()
        .warm_up_time(Duration::from_secs(1))
        .measurement_time(Duration::from_secs(3))
        .sample_size(50)
}

criterion_group! {
    name = benches;
    config = config();
    targets = merge, split
}
criterion_main!(benches);
