// 负载测试里的数据正确性核对（纯逻辑，单测见 test/perf-report.test.ts）。

/** 序列查询里一秒的桶（bucket_seconds = 1）。 */
export interface SecondBucket {
	min: number;
	max: number;
	last: number;
	/** 这一秒写入的点数，正常为 1。 */
	points: number;
}

export interface SequenceCheck {
	/** 能确定丢失的序号个数（开头、结尾和相邻两秒之间缺的）。 */
	missing: number;
	/** 相邻两秒序号重叠的个数（重复或乱序）。 */
	duplicated: number;
	/** 同一秒多出来的点数。 */
	duplicatePoints: number;
}

/**
 * 核对定速指标节点（stub 节点 metric_rate：第 i 次上报 seq = i，共 count 次）的 seq 序列。
 * Agent 按秒合并，一秒内部的序号看不到，只能核对每秒的首尾：第一秒从 1 开始、最后一秒到 count 结束、
 * 每秒的最小值紧接上一秒的最大值。每秒上报上万次时，任何一秒整秒丢失或重复都会被发现。
 */
export function checkSequence(buckets: SecondBucket[], count: number): SequenceCheck {
	const first = buckets[0];
	const last = buckets.at(-1);
	if (!first || !last) return { missing: count, duplicated: 0, duplicatePoints: 0 };
	let missing = Math.max(0, first.min - 1) + Math.max(0, count - last.last);
	let duplicated = 0;
	let duplicatePoints = 0;
	buckets.forEach((bucket, i) => {
		duplicatePoints += bucket.points - 1;
		const prev = buckets[i - 1];
		if (!prev) return;
		const gap = bucket.min - prev.max - 1;
		if (gap > 0) missing += gap;
		else duplicated -= gap;
	});
	return { missing, duplicated, duplicatePoints };
}

export interface NumberedCheck {
	/** 1..count 里没出现的序号个数。 */
	missing: number;
	/** 1..count 里多出现的次数（出现 k 次算 k - 1 个重复）。 */
	duplicated: number;
	/** 不在 1..count 里（或不是整数）的个数。 */
	unexpected: number;
}

/**
 * 核对一组应当恰好是 1..count 各出现一次的序号（例如桩节点 stdout_rate 每行开头的序号），与顺序无关：
 * 不同来源的日志在 Agent 里按时间排序，这里只关心有没有丢、有没有重复。
 */
export function checkNumbered(numbers: Iterable<number>, count: number): NumberedCheck {
	const seen = new Uint8Array(count + 1);
	let duplicated = 0;
	let unexpected = 0;
	let distinct = 0;
	for (const n of numbers) {
		if (!Number.isInteger(n) || n < 1 || n > count) unexpected++;
		else if (seen[n]) duplicated++;
		else {
			seen[n] = 1;
			distinct++;
		}
	}
	return { missing: count - distinct, duplicated, unexpected };
}

export interface WindowGrowth {
	/** 窗口里第一个采样。 */
	baselineBytes: number;
	/** 窗口里的峰值。 */
	peakBytes: number;
	/** 峰值比基准多出的部分（不会是负数）。 */
	growthBytes: number;
}

/**
 * 一段时间 [from, to]（毫秒，与采样同一时钟）内占用的增长：以窗口里第一个采样为基准、取窗口内的峰值。
 * 用来判断「工作目录占用不增长」：任务启动时创建的文件不算（窗口从所有任务都开始之后算起），
 * 之后事件若落盘（#69 那样），占用会随时间一直涨。窗口里没有采样时返回 null。
 */
export function windowGrowth(
	samples: ReadonlyArray<{ ms: number; bytes: number }>,
	from: number,
	to: number,
): WindowGrowth | null {
	const inWindow = samples.filter((s) => s.ms >= from && s.ms <= to);
	const first = inWindow[0];
	if (!first) return null;
	const peakBytes = Math.max(...inWindow.map((s) => s.bytes));
	return {
		baselineBytes: first.bytes,
		peakBytes,
		growthBytes: Math.max(0, peakBytes - first.bytes),
	};
}

export interface LogCopies {
	files: number;
	largestBytes: number;
	totalBytes: number;
}

/**
 * 任务工作目录里一个流的日志副本（`stdout.log` 与轮换出的 `stdout.log.N`）：文件数、最大的文件与合计字节数。
 * Agent 每个流最多两个文件、每个 8 MiB（agent/src/logs.rs 的 LogCopy）。
 */
export function checkLogCopies(
	files: ReadonlyArray<{ name: string; size: number }>,
	base: string,
): LogCopies {
	const isCopy = (name: string) =>
		name === base || (name.startsWith(`${base}.`) && /^\d+$/.test(name.slice(base.length + 1)));
	const copies = files.filter((f) => isCopy(f.name));
	return {
		files: copies.length,
		largestBytes: Math.max(0, ...copies.map((f) => f.size)),
		totalBytes: copies.reduce((sum, f) => sum + f.size, 0),
	};
}

/**
 * 把 [first, last]（整秒，首尾都包含）切成每段最多 width 秒的窗口，相邻两段首尾相接、不重叠。
 * 长时负载测试的指标序列很长：分段查询才能保持每秒一个桶，逐秒核对序号。
 */
export function secondWindows(first: number, last: number, width: number): Array<[number, number]> {
	const windows: Array<[number, number]> = [];
	for (let from = first; from <= last; from += width) {
		windows.push([from, Math.min(from + width - 1, last)]);
	}
	return windows;
}

type TimePoints = ReadonlyArray<readonly [number, number]>;

/** 按时间对半分（[毫秒, 值]，中点归后半段）；少于两个采样时返回 null。 */
function halves(points: TimePoints): [number[], number[]] | null {
	const first = points[0];
	const last = points.at(-1);
	if (!first || !last || points.length < 2) return null;
	const middle = (first[0] + last[0]) / 2;
	return [
		points.filter(([ms]) => ms < middle).map(([, v]) => v),
		points.filter(([ms]) => ms >= middle).map(([, v]) => v),
	];
}

/**
 * 随时间变化的数据（[毫秒, 值]）按时间对半分，后半段的峰值减去前半段的峰值：平稳时约为 0，
 * 缓慢泄漏（内存、磁盘随运行时长一直涨）时为正。少于两个采样时返回 null。
 */
export function lateGrowth(points: TimePoints): number | null {
	const parts = halves(points);
	if (!parts) return null;
	const peak = (values: number[]) =>
		values.reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);
	return peak(parts[1]) - peak(parts[0]);
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * 按时间对半分，后半段的中位数减去前半段的中位数。用来判断积压是否随时间增长（同步探测的往返时间）：
 * 处理不过来时积压越来越多，整体一直往上走；控制面周期性地批量写库（一批指标段同时攒满）造成的一次性尖峰
 * 不影响中位数。少于两个采样时返回 null。
 */
export function lateMedianGrowth(points: TimePoints): number | null {
	const parts = halves(points);
	if (!parts) return null;
	return median(parts[1]) - median(parts[0]);
}
