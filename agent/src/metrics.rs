//! 任务指标（`ctx.metric`，#29）：按「任务 × 序列 × 单调时钟秒」合并，以及断线期间的有界排队。
//!
//! - 合并（[`Merger`]，每个任务一个）：序列是指标名加标签（#78），同一秒内不同序列的点分别合并。`gauge` 取这一秒最后一个值，并带这一秒的最小值和最大值；
//!   `counter` 取这一秒结束时的值（最小值、最大值与它相同）。非有限值被丢弃（SDK 已经丢弃过一次）。
//!   「秒」按 Agent 从事件管道读到上报时的单调时钟读数划分（ADR 0018，#174），不看 Agent 时间：Agent 时间中途
//!   倒退或往前跳，点都不会丢、不会并错；合并后的点带这一秒起点的读数（控制面折算成控制面时间），
//!   Agent 时间取这一秒里最后一次上报时 SDK 记录的时间。
//!   读数只增不减，一秒过完就不会再有它的点：这一秒一结束就发出（[`Merger::take_due`]，按整秒对齐，
//!   而不是距上一批满一秒，#119），任务结束时发出全部。
//! - 排队（[`MetricQueue`]）：合并后的批次在这里等待发送，所有任务合计最多排队 `limit` 个点；
//!   超出时丢弃最早的点，按任务记下丢弃数，随这个任务下一次发出的批次（`dropped_points`）上报。
//!   一次写满只警告一次（与日志队列一致），又有一批不丢弃地放下之后再写满才再警告。

use std::collections::btree_map::Entry;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt;

use serde::de::{Deserialize, Deserializer, MapAccess, Visitor};

use crate::proto::{MetricBatch, MetricPoint};

/// 断开期间默认最多排队的指标点数（所有任务合计）。
pub const DEFAULT_METRIC_QUEUE_POINTS: usize = 500_000;
/// 合并排队的批次时，一批最多的点数。
const MAX_BATCH_POINTS: usize = 10_000;

/// 一个点的标签（键 → 值）：按键排序、键不重复，内容相同的标签比较时相等。
/// 不带标签时为空（不分配内存）。用排好序的数组而不是 `BTreeMap`：解析时只分配一次，
/// 合并时比较更快（基准 `merge_labeled_events`）。
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Labels(Vec<(String, String)>);

impl Labels {
    pub fn new() -> Self {
        Self::default()
    }
}

/// 按键排序；同一个键出现多次时取最后一个值（与 JSON 对象里键重复时一致）。
impl FromIterator<(String, String)> for Labels {
    fn from_iter<I: IntoIterator<Item = (String, String)>>(pairs: I) -> Self {
        let mut pairs: Vec<(String, String)> = pairs.into_iter().collect();
        if pairs.len() > 1 {
            // 先倒过来再稳定排序：同一个键里原来靠后的排在前面，去重时保留的就是它。
            pairs.reverse();
            pairs.sort_by(|a, b| a.0.cmp(&b.0));
            pairs.dedup_by(|later, kept| later.0 == kept.0);
        }
        Self(pairs)
    }
}

impl IntoIterator for Labels {
    type Item = (String, String);
    type IntoIter = std::vec::IntoIter<(String, String)>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

/// 从事件 JSON 的 `labels` 对象（键 → 字符串值）解析，解析时排序一次。
impl<'de> Deserialize<'de> for Labels {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct LabelsVisitor;

        impl<'de> Visitor<'de> for LabelsVisitor {
            type Value = Labels;

            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an object with string values")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Labels, A::Error> {
                let mut pairs = Vec::with_capacity(map.size_hint().unwrap_or(0));
                while let Some(pair) = map.next_entry()? {
                    pairs.push(pair);
                }
                Ok(pairs.into_iter().collect())
            }
        }

        deserializer.deserialize_map(LabelsVisitor)
    }
}

struct Bucket {
    counter: bool,
    /// 这一秒里最后一次上报的 Agent 时间（Unix 毫秒）。
    agent_time_ms: i64,
    value: f64,
    min: f64,
    max: f64,
}

impl Bucket {
    fn merge<K: Ord>(entry: Entry<'_, K, Bucket>, counter: bool, agent_time_ms: i64, value: f64) {
        entry
            .and_modify(|b| {
                b.agent_time_ms = agent_time_ms;
                b.value = value;
                b.min = b.min.min(value);
                b.max = b.max.max(value);
            })
            .or_insert(Bucket {
                counter,
                agent_time_ms,
                value,
                min: value,
                max: value,
            });
    }

    /// `second` 是这一秒的单调时钟读数（秒）。
    fn point(self, name: String, labels: Labels, second: i64) -> MetricPoint {
        let (min, max) = if self.counter {
            (self.value, self.value)
        } else {
            (self.min, self.max)
        };
        MetricPoint {
            name,
            time_unix_s: self.agent_time_ms.div_euclid(1000),
            value: self.value,
            min,
            max,
            labels: labels.into_iter().collect(),
            // 协议里 0 表示没有读数（旧版本 Agent）。
            monotonic_ms: (second * 1000).max(1),
        }
    }
}

/// 一个任务的指标合并器。
///
/// 不带标签与带标签的序列分开放：合并键里哪怕多一个空的标签字段，不带标签时（最常见）的合并就慢约四成
/// （基准 `merge_events`，ARCHITECTURE §7.6）。
#[derive(Default)]
pub struct Merger {
    /// (指标名, 单调时钟秒) → 不带标签的序列这一秒合并后的值。
    plain: BTreeMap<(String, i64), Bucket>,
    /// (指标名, 标签, 单调时钟秒) → 带标签的序列这一秒合并后的值。
    labeled: BTreeMap<(String, Labels, i64), Bucket>,
    /// [`Merger::take_due`] 上一次的界限：取到哪一秒之前（单调时钟秒，不含）。
    due_before: i64,
}

impl Merger {
    /// 记录一次上报：`read_at_ms` 是从事件管道读到它时的单调时钟读数（毫秒，只增不减），
    /// `agent_time_ms` 是 SDK 记录它的 Agent 时间（Unix 毫秒）。
    pub fn add(
        &mut self,
        read_at_ms: i64,
        agent_time_ms: i64,
        name: String,
        labels: Labels,
        kind: &str,
        value: f64,
    ) {
        if !value.is_finite() {
            return;
        }
        let second = read_at_ms.div_euclid(1000);
        let counter = kind == "counter";
        if labels.0.is_empty() {
            let entry = self.plain.entry((name, second));
            Bucket::merge(entry, counter, agent_time_ms, value);
        } else {
            let entry = self.labeled.entry((name, labels, second));
            Bucket::merge(entry, counter, agent_time_ms, value);
        }
    }

    /// 平时的发送时机：单调时钟读数为 `now_ms` 时已经过完的秒（早于 `now_ms` 所在的秒）的点。
    /// 只在这个界限变化时（每秒一次，一到整秒就变）取出，所以每个任务每秒最多一批。
    /// 机器休眠后错过的秒合成一批。
    pub fn take_due(&mut self, now_ms: i64) -> Vec<MetricPoint> {
        let before = now_ms.div_euclid(1000);
        if before == self.due_before {
            return Vec::new();
        }
        self.due_before = before;
        self.take(Some(before))
    }

    /// 取出早于 `before`（单调时钟秒）的点；`None` 时取出全部。同一序列按单调时钟递增。
    pub fn take(&mut self, before: Option<i64>) -> Vec<MetricPoint> {
        let due = |second: i64| before.is_none_or(|b| second < b);
        let plain = self
            .plain
            .extract_if(.., |(_, second), _| due(*second))
            .map(|((name, second), bucket)| bucket.point(name, Labels::new(), second));
        let labeled = self
            .labeled
            .extract_if(.., |(_, _, second), _| due(*second))
            .map(|((name, labels, second), bucket)| bucket.point(name, labels, second));
        plain.chain(labeled).collect()
    }
}

/// 等待发送的指标批次（所有任务共用），点数有上限。
pub struct MetricQueue {
    batches: VecDeque<MetricBatch>,
    points: usize,
    limit: usize,
    /// (task_id, attempt) → 还没上报的丢弃点数。
    dropped: HashMap<(String, u32), u64>,
    /// 正在丢弃：上一次排队（有点的批次）丢弃了点。一次写满只警告一次，放得下之后再写满才再警告。
    dropping: bool,
}

impl MetricQueue {
    pub fn new(limit: usize) -> Self {
        Self {
            batches: VecDeque::new(),
            points: 0,
            limit,
            dropped: HashMap::new(),
            dropping: false,
        }
    }

    /// 最多排队的点数。
    pub fn limit(&self) -> usize {
        self.limit
    }

    /// 排队一批；超出上限时丢弃最早的点。返回 true 表示这次开始丢弃、调用方应打一条警告：
    /// 与日志队列一致，持续写满期间只在第一次丢弃时返回 true，直到又有一批不丢弃地放下。
    pub fn push(&mut self, batch: MetricBatch) -> bool {
        let empty = batch.points.is_empty();
        self.points += batch.points.len();
        self.batches.push_back(batch);
        let mut dropped = false;
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
            if n > 0 {
                dropped = true;
            }
        }
        if empty {
            return false;
        }
        let warn = dropped && !self.dropping;
        self.dropping = dropped;
        warn
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

#[cfg(test)]
mod tests {
    use super::*;

    fn batch(task_id: &str, n: usize) -> MetricBatch {
        MetricBatch {
            task_id: task_id.into(),
            attempt: 1,
            points: (0..n)
                .map(|i| MetricPoint {
                    name: "m".into(),
                    time_unix_s: i as i64,
                    value: 0.0,
                    min: 0.0,
                    max: 0.0,
                    labels: Default::default(),
                    monotonic_ms: 0,
                })
                .collect(),
            dropped_points: 0,
        }
    }

    fn drain(queue: &mut MetricQueue) -> (usize, u64) {
        let (mut points, mut dropped) = (0, 0);
        while let Some(b) = queue.pop() {
            points += b.points.len();
            dropped += b.dropped_points;
        }
        (points, dropped)
    }

    /// 每个点的单调时钟读数（秒）。
    fn seconds(points: &[MetricPoint]) -> Vec<i64> {
        points.iter().map(|p| p.monotonic_ms / 1000).collect()
    }

    /// 一次不带标签的 gauge 上报：在单调时钟 `read_at_ms` 读到，SDK 记录的 Agent 时间是 `agent_time_ms`。
    fn gauge(merger: &mut Merger, read_at_ms: i64, agent_time_ms: i64, value: f64) {
        merger.add(
            read_at_ms,
            agent_time_ms,
            "m".into(),
            Labels::new(),
            "gauge",
            value,
        );
    }

    /// Agent 时间比单调时钟读数多这么多毫秒（任意取的：两者没有关系）。
    const AGENT_AHEAD_MS: i64 = 1_800_000_000_000;

    #[test]
    fn a_second_is_due_as_soon_as_it_ends() {
        let mut merger = Merger::default();
        gauge(&mut merger, 100_200, AGENT_AHEAD_MS + 100_200, 1.0);
        gauge(&mut merger, 100_900, AGENT_AHEAD_MS + 100_900, 2.0);
        gauge(&mut merger, 101_500, AGENT_AHEAD_MS + 101_500, 3.0);
        // 第 100 秒在 101.000 结束：之前不发，一到 101.000 就发，下一秒的点留下。
        assert!(merger.take_due(100_999).is_empty());
        let due = merger.take_due(101_000);
        assert_eq!(seconds(&due), [100]);
        assert_eq!((due[0].value, due[0].min, due[0].max), (2.0, 1.0, 2.0));
        assert_eq!(due[0].monotonic_ms, 100_000, "带这一秒起点的读数");
        assert_eq!(seconds(&merger.take_due(102_050)), [101]);
    }

    #[test]
    fn at_most_one_batch_per_second() {
        let mut merger = Merger::default();
        gauge(&mut merger, 100_500, 0, 1.0);
        assert_eq!(seconds(&merger.take_due(101_100)), [100]);
        gauge(&mut merger, 101_300, 0, 3.0);
        assert!(merger.take_due(101_400).is_empty());
        assert!(merger.take_due(101_999).is_empty());
        assert_eq!(seconds(&merger.take_due(102_000)), [101]);
        assert!(merger.take_due(102_900).is_empty());
    }

    #[test]
    fn the_agent_time_of_a_point_is_that_of_the_last_report_in_its_second() {
        let mut merger = Merger::default();
        gauge(&mut merger, 100_100, AGENT_AHEAD_MS + 99_950, 1.0);
        gauge(&mut merger, 100_800, AGENT_AHEAD_MS + 100_750, 2.0);
        let points = merger.take(None);
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].time_unix_s, (AGENT_AHEAD_MS + 100_750) / 1000);
    }

    #[test]
    fn when_the_agent_time_steps_back_no_point_is_lost_or_merged_into_the_wrong_second() {
        let mut merger = Merger::default();
        // 每秒一次上报；第 102 秒起 Agent 时间往回拨了一小时，之后又回到与之前重合的时间。
        let hour = 3_600_000;
        gauge(&mut merger, 100_500, AGENT_AHEAD_MS + 100_400, 1.0);
        gauge(&mut merger, 101_500, AGENT_AHEAD_MS + 101_400, 2.0);
        gauge(&mut merger, 102_500, AGENT_AHEAD_MS + 102_400 - hour, 3.0);
        gauge(&mut merger, 103_500, AGENT_AHEAD_MS + 103_400 - hour, 4.0);
        // 拨回到与第 100 秒那个点相同的 Agent 时间：仍是单独的一个点。
        gauge(&mut merger, 104_500, AGENT_AHEAD_MS + 100_400, 5.0);
        assert_eq!(seconds(&merger.take_due(103_000)), [100, 101, 102]);
        let rest = merger.take(None);
        assert_eq!(seconds(&rest), [103, 104]);
        assert_eq!(
            rest.iter()
                .map(|p| (p.time_unix_s, p.value))
                .collect::<Vec<_>>(),
            [
                ((AGENT_AHEAD_MS + 103_400 - hour) / 1000, 4.0),
                ((AGENT_AHEAD_MS + 100_400) / 1000, 5.0),
            ]
        );
    }

    #[test]
    fn when_the_agent_time_jumps_within_a_second_the_reports_still_merge_into_one_point() {
        let mut merger = Merger::default();
        // 同一个单调时钟秒里，Agent 时间往前跳了 613 天：还是一个点，带最后一次上报的 Agent 时间。
        let days_613 = 613 * 86_400_000;
        gauge(&mut merger, 100_100, AGENT_AHEAD_MS + 100_100, 1.0);
        gauge(
            &mut merger,
            100_600,
            AGENT_AHEAD_MS + 100_600 + days_613,
            9.0,
        );
        let points = merger.take(None);
        assert_eq!(points.len(), 1);
        assert_eq!(
            (points[0].value, points[0].min, points[0].max),
            (9.0, 1.0, 9.0)
        );
        assert_eq!(
            points[0].time_unix_s,
            (AGENT_AHEAD_MS + 100_600 + days_613) / 1000
        );
    }

    #[test]
    fn after_the_machine_sleeps_the_missed_seconds_go_out_in_one_batch() {
        let mut merger = Merger::default();
        for s in 100..105 {
            gauge(&mut merger, s * 1000 + 500, 0, s as f64);
        }
        assert_eq!(seconds(&merger.take_due(101_000)), [100]);
        // 休眠后单调时钟（含休眠的时间）前跳：错过的秒合成一批，之后这一秒不再发。
        assert_eq!(seconds(&merger.take_due(200_000)), [101, 102, 103, 104]);
        assert!(merger.take_due(200_900).is_empty());
    }

    fn labels_of(json: &str) -> Labels {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn labels_in_any_order_are_the_same_series_and_a_repeated_key_keeps_its_last_value() {
        let mut merger = Merger::default();
        let a = r#"{"pid":"1","name":"a"}"#;
        merger.add(100_100, 0, "cpu".into(), labels_of(a), "gauge", 1.0);
        merger.add(
            100_200,
            0,
            "cpu".into(),
            labels_of(r#"{"name":"a","pid":"1"}"#),
            "gauge",
            3.0,
        );
        merger.add(
            100_300,
            0,
            "cpu".into(),
            labels_of(r#"{"name":"b","pid":"1","name":"a"}"#),
            "gauge",
            2.0,
        );
        merger.add(
            100_400,
            0,
            "cpu".into(),
            labels_of(r#"{"pid":"2","name":"a"}"#),
            "gauge",
            5.0,
        );
        merger.add(100_500, 0, "cpu".into(), Labels::default(), "gauge", 7.0);
        let points = merger.take(None);
        // 每个点：排好序的「键=值」、值、最小值、最大值。
        let series: Vec<(String, [f64; 3])> = points
            .iter()
            .map(|p| {
                let mut labels: Vec<String> =
                    p.labels.iter().map(|(k, v)| format!("{k}={v}")).collect();
                labels.sort();
                (labels.join(","), [p.value, p.min, p.max])
            })
            .collect();
        assert_eq!(
            series,
            [
                ("".to_owned(), [7.0, 7.0, 7.0]),
                ("name=a,pid=1".to_owned(), [2.0, 1.0, 3.0]),
                ("name=a,pid=2".to_owned(), [5.0, 5.0, 5.0]),
            ]
        );
    }

    #[test]
    fn repeated_overflow_warns_only_once_and_still_counts_dropped_points() {
        let mut queue = MetricQueue::new(10);
        assert!(!queue.push(batch("t", 10)));
        let warnings = (0..5).filter(|_| queue.push(batch("t", 3))).count();
        assert_eq!(warnings, 1);
        assert_eq!(drain(&mut queue), (10, 15));
    }

    #[test]
    fn overflow_warns_again_after_the_queue_has_recovered() {
        let mut queue = MetricQueue::new(10);
        assert!(queue.push(batch("t", 12)));
        assert!(!queue.push(batch("t", 2)));
        // 重连后排空，再写入不超限：恢复；之后再写满可以再打一次。
        drain(&mut queue);
        assert!(!queue.push(batch("t", 4)));
        assert!(queue.push(batch("t", 8)));
        assert!(!queue.push(batch("t", 1)));
        assert_eq!(drain(&mut queue), (10, 3));
    }
}
