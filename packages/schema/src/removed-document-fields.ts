/**
 * 已移除的场景文档顶层字段（ADR 0028）：平台不再支持，但升级前保存的版本里还带着它们（例如便签 `sticky_notes`，
 * 每个 ADR 0026 之后保存的版本都有这一项，默认是空数组）。和已移除的节点种类（./removed-nodes.ts）不同，
 * 这些字段只用于显示、不影响执行，所以不占位显示：
 *
 * - 读取：认得并丢掉（{@link withoutRemovedFields}），旧版本照常能读，读到的文档里没有它们；
 * - 保存：文档 schema 里没有它们，带着它们保存被拒绝，说明写明怎么办（{@link removedFieldsMessage}）。
 *
 * 移除一个字段：在文档 schema（orchestration-document.ts）里删掉它的定义，在这里登记它的名称和替换办法。
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

/** 文档顶层带着的已移除字段，按登记的顺序。`raw` 不是对象时为空。 */
export function removedFieldsIn(raw: unknown): RemovedDocumentField[] {
	if (!isRecord(raw)) return [];
	return (Object.keys(REMOVED_DOCUMENT_FIELDS) as RemovedDocumentField[]).filter((field) =>
		Object.hasOwn(raw, field),
	);
}

/**
 * 去掉文档顶层的已移除字段（浅拷贝，不改传入的值）；没有时原样返回。读取旧版本、恢复浏览器里的本地草稿、
 * 比较两个文档时先过一遍，再按现在的 schema 解析。
 */
export function withoutRemovedFields<T>(raw: T): T {
	if (removedFieldsIn(raw).length === 0) return raw;
	const rest = { ...(raw as Record<string, unknown>) };
	for (const field of Object.keys(REMOVED_DOCUMENT_FIELDS)) delete rest[field];
	return rest as T;
}

/** 保存时遇到已移除字段的说明：哪些字段、怎么办。控制面拒绝保存的错误信息和命令行的本地检查写同一句。 */
export function removedFieldsMessage(fields: readonly RemovedDocumentField[]): string {
	const named = fields.map((f) => `${f}（${REMOVED_DOCUMENT_FIELDS[f].label}）`).join("、");
	const advice = fields
		.map((f) => `${REMOVED_DOCUMENT_FIELDS[f].label}：${REMOVED_DOCUMENT_FIELDS[f].replacement}`)
		.join("；");
	return `场景文档里的 ${named}已不再支持，先把这一项删掉再保存。替换办法：${advice}`;
}
