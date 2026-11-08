import { seriesKey } from "@sfly/schema";

export { seriesKey, sortedLabels } from "@sfly/schema";

/**
 * 序列的标签（#78）：一个任务里，一个指标在一组确定的标签值下的全部点构成一个序列。
 * 标签键在节点类型的元信息里声明（每个指标最多 3 个），值是不超过 128 个字符的非空字符串。
 */
export type Labels = Record<string, string>;

/** 标签值的最大长度（字符数，与 SDK 一致）。 */
export const MAX_LABEL_VALUE_CHARS = 128;

/**
 * 点的标签是否与声明的标签键（已排序）一致：键完全相同，值非空且不超过 {@link MAX_LABEL_VALUE_CHARS} 个字符。
 * 不一致的点被丢弃（例如旧版 Agent 不认识 labels 字段，带标签的点就会缺键），不同对象的数据不会混进同一个序列。
 */
export function labelsMatch(labels: Labels, keys: readonly string[]): boolean {
	const given = Object.keys(labels);
	if (given.length !== keys.length) return false;
	for (const key of keys) {
		const value = labels[key];
		if (value === undefined || value === "") return false;
		if (value.length > MAX_LABEL_VALUE_CHARS && [...value].length > MAX_LABEL_VALUE_CHARS) {
			return false;
		}
	}
	return true;
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
