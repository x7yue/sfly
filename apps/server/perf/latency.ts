// 延迟样本的汇总（纯逻辑，单测见 test/perf-control-plane.test.ts）。

export interface Distribution {
	count: number;
	p50: number;
	p95: number;
	p99: number;
	max: number;
}

/** 最近秩法的分位数：已排序样本里不小于 p% 样本的最小值。 */
function rank(sorted: number[], p: number): number {
	return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

/** 样本的分布：样本数、p50、p95、p99 与最大值；没有样本时为 null。 */
export function distribution(samples: readonly number[]): Distribution | null {
	if (samples.length === 0) return null;
	const sorted = [...samples].sort((a, b) => a - b);
	return {
		count: sorted.length,
		p50: rank(sorted, 50),
		p95: rank(sorted, 95),
		p99: rank(sorted, 99),
		max: sorted.at(-1) as number,
	};
}

/** 一秒的端到端延迟（毫秒）。 */
export interface PushLatency {
	/** 点所在的秒（Unix 秒）。 */
	second: number;
	/** 这一秒第一次调用 ctx.metric() 到收到推送。 */
	first: number;
	/** 这一秒最后一次调用到收到推送。 */
	last: number;
}

/**
 * 从运行事件流的一条 `metrics` 推送算端到端延迟。节点每次上报 `name` = 调用时刻（Unix 毫秒），Agent 按秒合并成
 * gauge：min 是这一秒第一次调用的时刻、value（最新值）是最后一次。first 是用户最多要等多久才看到这一秒的数据。
 */
export function pushLatencies(
	increment: { points: ReadonlyArray<{ name: string; time: string; value: number; min: number }> },
	name: string,
	receivedAtMs: number,
): PushLatency[] {
	return increment.points
		.filter((p) => p.name === name)
		.map((p) => ({
			second: Date.parse(p.time) / 1000,
			first: receivedAtMs - p.min,
			last: receivedAtMs - p.value,
		}));
}
