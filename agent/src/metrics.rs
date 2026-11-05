//! 任务指标（`ctx.metric`，#29）：按「任务 × 指标 × 秒」合并，以及断线期间的有界排队。
//!
//! - 合并（[`Merger`]，每个任务一个）：`gauge` 取这一秒最后一个值，并带这一秒的最小值和最大值；
//!   `counter` 取这一秒结束时的值（最小值、最大值与它相同）。非有限值被丢弃（SDK 已经丢弃过一次）。
//!   只有已经结束的秒才发出（同一秒后到的值不会再变成重复点），任务结束时发出全部。
//! - 排队（[`MetricQueue`]）：合并后的批次在这里等待发送，所有任务合计最多排队 `limit` 个点；
//!   超出时丢弃最早的点，按任务记下丢弃数，随这个任务下一次发出的批次（`dropped_points`）上报。

use std::collections::{BTreeMap, HashMap, VecDeque};

use crate::proto::{MetricBatch, MetricPoint};

/// 断开期间默认最多排队的指标点数（所有任务合计）。
pub const DEFAULT_METRIC_QUEUE_POINTS: usize = 500_000;
/// 合并排队的批次时，一批最多的点数。
const MAX_BATCH_POINTS: usize = 10_000;

struct Bucket {
    counter: bool,
    value: f64,
    min: f64,
    max: f64,
}

/// 一个任务的指标合并器。
#[derive(Default)]
pub struct Merger {
    /// (指标名, Unix 秒) → 这一秒合并后的值。
    buckets: BTreeMap<(String, i64), Bucket>,
}

impl Merger {
    /// 记录一次上报；`ts_ms` 是 SDK 记录的时间（Unix 毫秒）。
    pub fn add(&mut self, ts_ms: i64, name: String, kind: &str, value: f64) {
        if !value.is_finite() {
            return;
        }
        let second = ts_ms.div_euclid(1000);
        let counter = kind == "counter";
        self.buckets
            .entry((name, second))
            .and_modify(|b| {
                b.value = value;
                b.min = b.min.min(value);
                b.max = b.max.max(value);
            })
            .or_insert(Bucket {
                counter,
                value,
                min: value,
                max: value,
            });
    }

    /// 取出早于 `before`（Unix 秒）的点；`None` 时取出全部。同一指标按时间递增。
    pub fn take(&mut self, before: Option<i64>) -> Vec<MetricPoint> {
        let keys: Vec<(String, i64)> = self
            .buckets
            .keys()
            .filter(|(_, second)| before.is_none_or(|b| *second < b))
            .cloned()
            .collect();
        keys.into_iter()
            .filter_map(|key| {
                let bucket = self.buckets.remove(&key)?;
                let (name, second) = key;
                let (min, max) = if bucket.counter {
                    (bucket.value, bucket.value)
                } else {
                    (bucket.min, bucket.max)
                };
                Some(MetricPoint {
                    name,
                    time_unix_s: second,
                    value: bucket.value,
                    min,
                    max,
                })
            })
            .collect()
    }
}

/// 等待发送的指标批次（所有任务共用），点数有上限。
pub struct MetricQueue {
    batches: VecDeque<MetricBatch>,
    points: usize,
    limit: usize,
    /// (task_id, attempt) → 还没上报的丢弃点数。
    dropped: HashMap<(String, u32), u64>,
}

impl MetricQueue {
    pub fn new(limit: usize) -> Self {
        Self {
            batches: VecDeque::new(),
            points: 0,
            limit,
            dropped: HashMap::new(),
        }
    }

    /// 排队一批；超出上限时丢弃最早的点。
    pub fn push(&mut self, batch: MetricBatch) {
        self.points += batch.points.len();
        self.batches.push_back(batch);
        let mut warned = false;
        while self.points > self.limit {
            let Some(front) = self.batches.front_mut() else {
                break;
            };
            let n = (self.points - self.limit).min(front.points.len());
            front.points.drain(..n);
            self.points -= n;
            *self
                .dropped
                .entry((front.task_id.clone(), front.attempt))
                .or_default() += n as u64;
            if front.points.is_empty() {
                self.batches.pop_front();
            }
            if n > 0 && !warned {
                warned = true;
                eprintln!(
                    "metric queue is full ({} points queued while disconnected): dropping the oldest points",
                    self.limit
                );
            }
        }
    }

    /// 取出最早的一批（同一任务排在后面的批次合并进来），带上这个任务的丢弃计数；
    /// 没有排队的点、只有丢弃计数时发一批空的；都没有时为 None。
    pub fn pop(&mut self) -> Option<MetricBatch> {
        let Some(mut batch) = self.batches.pop_front() else {
            let key = self.dropped.keys().next()?.clone();
            let dropped = self.dropped.remove(&key).unwrap_or_default();
            return Some(MetricBatch {
                task_id: key.0,
                attempt: key.1,
                points: Vec::new(),
                dropped_points: dropped,
            });
        };
        self.points -= batch.points.len();
        let mut i = 0;
        while i < self.batches.len() && batch.points.len() < MAX_BATCH_POINTS {
            let same = self.batches[i].task_id == batch.task_id
                && self.batches[i].attempt == batch.attempt;
            if same && let Some(next) = self.batches.remove(i) {
                self.points -= next.points.len();
                batch.points.extend(next.points);
            } else {
                i += 1;
            }
        }
        batch.dropped_points += self
            .dropped
            .remove(&(batch.task_id.clone(), batch.attempt))
            .unwrap_or_default();
        Some(batch)
    }
}
