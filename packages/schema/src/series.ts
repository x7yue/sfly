/**
 * 指标的序列（#78）：一个任务里，一个指标在一组确定的标签值下的全部点构成一个序列。
 * 控制面、前端共用这里的身份、排序与上限；SDK（sdk/python/src/sfly/context.py）的同名常量与这里一致。
 */

/** 标签：键 → 值；不带标签的序列为 `{}`。 */
export type Labels = Readonly<Record<string, string>>;

/** 单个任务所有指标的序列数上限（不带标签的指标各算 1 个），不开放配置。 */
export const MAX_SERIES = 1000;

/** 标签值的最大长度（字符数）。每个指标最多声明的标签键数见 package-metadata.ts 的 MAX_LABEL_KEYS。 */
export const MAX_LABEL_VALUE_CHARS = 128;

/** 按键排序的标签副本：内容相同的标签得到相同的 JSON（与 jsonb 的规范形式一样，比较时相等）。 */
export function sortedLabels(labels: Labels): Record<string, string> {
	return Object.fromEntries(
		Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
}

/**
 * 序列的身份（指标名 + 标签）：不带标签时就是指标名，带标签时是指标名、NUL 和键排序后的标签 JSON。
 * 指标名是标识符、不含 NUL，两种形式不会冲突；按它排序即先按指标名、再按标签排序。
 */
export function seriesKey(name: string, labels: Labels): string {
	for (const _ in labels) return `${name}\u0000${JSON.stringify(sortedLabels(labels))}`;
	return name;
}

/** 序列的排序：先按指标名，同一指标按标签（键排序后的 JSON）。 */
export function compareSeries(
	a: { name: string; labels: Labels },
	b: { name: string; labels: Labels },
): number {
	const x = seriesKey(a.name, a.labels);
	const y = seriesKey(b.name, b.labels);
	return x < y ? -1 : x > y ? 1 : 0;
}
