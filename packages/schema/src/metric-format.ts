/** 指标值的写法：运行监控和关注项读数共用，同一个值在哪里看到都是同一个样子。 */

/** 指标值：`1.2M`、`12.3k`、`812`、`3.14`。 */
export function formatMetric(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
	if (abs >= 1e4) return `${(value / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`;
	if (Number.isInteger(value)) return String(value);
	return abs >= 100 ? value.toFixed(0) : abs >= 10 ? value.toFixed(1) : value.toFixed(2);
}
