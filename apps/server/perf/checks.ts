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
