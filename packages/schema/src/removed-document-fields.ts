/**
 * 已移除的场景文档顶层字段（ADR 0028）：平台不再支持，但升级前保存的版本里还带着它们（例如便签 `sticky_notes`，
 * 每个 ADR 0026 之后保存的版本都有这一项，默认是空数组）。和已移除的节点种类（./removed-nodes.ts）不同，
 * 这些字段只用于显示、不影响执行，所以不占位显示：
 *
 * - 读取：认得并丢掉（{@link withoutRemovedFields}），旧版本照常能读，读到的文档里没有它们；
 * - 保存：空数组（或没有这个字段）接受并丢掉，新版本里没有它；里面有内容的被拒绝，错误信息写明有几条、怎么办
 *   （{@link removedFieldsWithContent}、{@link removedFieldsMessage}），有内容的数据不会不声不响地丢掉。
 *
 * 移除一个字段：在文档 schema（orchestration-document.ts）里把它改成只收空数组的写法，在这里登记它的名称和替换办法。
 */
export const REMOVED_DOCUMENT_FIELDS = {
	sticky_notes: {
		label: "便签",
		replacement: "要留的内容写进节点的备注或注释框的备注",
	},
} as const satisfies Record<string, { label: string; replacement: string }>;

export type RemovedDocumentField = keyof typeof REMOVED_DOCUMENT_FIELDS;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** 文档顶层带着的已移除字段（不论有没有内容），按登记的顺序。`raw` 不是对象时为空。 */
export function removedFieldsIn(raw: unknown): RemovedDocumentField[] {
	if (!isRecord(raw)) return [];
	return (Object.keys(REMOVED_DOCUMENT_FIELDS) as RemovedDocumentField[]).filter((field) =>
		Object.hasOwn(raw, field),
	);
}

/** 文档顶层已移除字段里有内容的一项：字段名和里面有几条（不是数组时算 1 条）。 */
export interface RemovedFieldContent {
	field: RemovedDocumentField;
	count: number;
}

/** 文档顶层已移除的字段里有内容的（不是空数组、`null` 和没有的），按登记的顺序；空数组不算，保存时直接丢掉。 */
export function removedFieldsWithContent(raw: unknown): RemovedFieldContent[] {
	if (!isRecord(raw)) return [];
	return removedFieldsIn(raw).flatMap((field) => {
		const value = raw[field];
		if (value === null || value === undefined) return [];
		const count = Array.isArray(value) ? value.length : 1;
		return count > 0 ? [{ field, count }] : [];
	});
}

/**
 * 去掉文档顶层的已移除字段（浅拷贝，不改传入的值）；没有时原样返回。读取旧版本、恢复浏览器里的本地草稿、
 * 比较两个文档、保存前（收下的空数组）先过一遍，再按现在的 schema 解析或存库。
 */
export function withoutRemovedFields<T>(raw: T): T {
	if (removedFieldsIn(raw).length === 0) return raw;
	const rest = { ...(raw as Record<string, unknown>) };
	for (const field of Object.keys(REMOVED_DOCUMENT_FIELDS)) delete rest[field];
	return rest as T;
}

/**
 * 保存时遇到已移除字段里有内容的说明：哪些字段、里面有几条、怎么办。控制面拒绝保存的错误信息和命令行的本地检查写同一句。
 */
export function removedFieldsMessage(contents: readonly RemovedFieldContent[]): string {
	const named = contents
		.map((c) => `${c.field}（${REMOVED_DOCUMENT_FIELDS[c.field].label}）有 ${c.count} 条内容`)
		.join("、");
	const advice = contents
		.map(
			(c) =>
				`${REMOVED_DOCUMENT_FIELDS[c.field].label}：${REMOVED_DOCUMENT_FIELDS[c.field].replacement}`,
		)
		.join("；");
	return `场景文档里的 ${named}，已不再支持，不能保存：先把要留的内容挪走，再把这一项删掉。替换办法：${advice}`;
}
