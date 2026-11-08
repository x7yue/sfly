import { type Labels, MAX_LABEL_VALUE_CHARS } from "@sfly/schema";

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
