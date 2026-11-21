import { describe, expect, it } from "vitest";
import {
	OrchestrationDocument,
	REMOVED_DOCUMENT_FIELDS,
	removedFieldsIn,
	removedFieldsMessage,
	removedFieldsWithContent,
	StoredOrchestrationDocument,
	toJsonSchema,
	withoutRemovedFields,
} from "../src/index.js";

// 已移除的文档顶层字段（便签 sticky_notes，ADR 0028）：升级前保存的版本里还带着它们（默认是空数组，也可能有内容）。

const entry = { id: "entry", kind: "entry" };
const notes = [
	{ id: "sticky_1", title: "跑之前", text: "- 确认 Agent 在线", color: "blue" },
	{ id: "sticky_2", text: "已知问题" },
];
const legacy = { nodes: [entry], sticky_notes: notes };

describe("保存请求里的文档：sticky_notes 只收空数组", () => {
	it("没有这个字段、或者是空数组：接受（读出来改一处再存回去的常见写法）", () => {
		expect(OrchestrationDocument.safeParse({ nodes: [entry] }).success).toBe(true);
		expect(OrchestrationDocument.safeParse({ nodes: [entry], sticky_notes: [] }).success).toBe(
			true,
		);
	});

	it("数组里有内容：拒绝，不能悄悄丢掉", () => {
		expect(OrchestrationDocument.safeParse(legacy).success).toBe(false);
		expect(OrchestrationDocument.safeParse({ nodes: [entry], sticky_notes: [{}] }).success).toBe(
			false,
		);
		expect(OrchestrationDocument.safeParse({ nodes: [entry], sticky_notes: "x" }).success).toBe(
			false,
		);
	});

	it("别的顶层字段照旧不收（文档对象仍是封闭的）", () => {
		expect(OrchestrationDocument.safeParse({ nodes: [entry], legacy_field: 1 }).success).toBe(
			false,
		);
	});

	it("导出给 Python 的 JSON Schema 里 sticky_notes 只能是空数组，命令行的本地校验和控制面一致", () => {
		const schema = toJsonSchema(OrchestrationDocument) as {
			properties: Record<string, { maxItems?: number; type?: string }>;
		};
		expect(schema.properties.sticky_notes).toMatchObject({ type: "array", maxItems: 0 });
	});

	it("接受空数组的字段和登记的已移除字段一一对应", () => {
		const schema = toJsonSchema(OrchestrationDocument) as {
			properties: Record<string, { maxItems?: number }>;
		};
		const acceptsOnlyEmpty = Object.entries(schema.properties)
			.filter(([, property]) => property.maxItems === 0)
			.map(([name]) => name);
		expect(acceptsOnlyEmpty.sort()).toEqual(Object.keys(REMOVED_DOCUMENT_FIELDS).sort());
	});
});

describe("读到的文档认得并丢掉便签", () => {
	it("读到的文档的 schema 里没有这个字段：先去掉再解析，旧版本读得出，读到的文档里没有 sticky_notes", () => {
		expect(StoredOrchestrationDocument.safeParse(legacy).success).toBe(false);
		const parsed = StoredOrchestrationDocument.parse(withoutRemovedFields(legacy));
		expect(parsed).not.toHaveProperty("sticky_notes");
		expect(parsed.nodes.map((n) => n.id)).toEqual(["entry"]);
	});

	it("去掉的是浅拷贝，传入的值不变；没有已移除字段时原样返回同一个对象", () => {
		const stripped = withoutRemovedFields(legacy);
		expect(stripped).toEqual({ nodes: [entry] });
		expect(legacy.sticky_notes).toHaveLength(2);
		const plain = { nodes: [entry] };
		expect(withoutRemovedFields(plain)).toBe(plain);
	});

	it("不是对象的东西原样返回，不抛错", () => {
		for (const value of [null, undefined, 3, "x", [1, 2]]) {
			expect(withoutRemovedFields(value)).toBe(value);
			expect(removedFieldsIn(value)).toEqual([]);
			expect(removedFieldsWithContent(value)).toEqual([]);
		}
	});
});

describe("保存时已移除的字段里有内容", () => {
	it("认得文档顶层 sticky_notes 里有几条；空数组、null、没有的不算，嵌套里的同名键也不算", () => {
		expect(removedFieldsWithContent(legacy)).toEqual([{ field: "sticky_notes", count: 2 }]);
		expect(removedFieldsWithContent({ nodes: [entry], sticky_notes: [] })).toEqual([]);
		expect(removedFieldsWithContent({ nodes: [entry], sticky_notes: null })).toEqual([]);
		expect(removedFieldsWithContent({ nodes: [entry] })).toEqual([]);
		expect(removedFieldsWithContent({ nodes: [{ ...entry, sticky_notes: [1] }] })).toEqual([]);
		// 不是数组的值算 1 条（保存时会因为类型不对被拒绝，说明也要写得出来）。
		expect(removedFieldsWithContent({ nodes: [entry], sticky_notes: "x" })).toEqual([
			{ field: "sticky_notes", count: 1 },
		]);
	});

	it("说明写明哪个字段、里面有几条、怎么办", () => {
		expect(removedFieldsMessage([{ field: "sticky_notes", count: 2 }])).toBe(
			`场景文档里的 sticky_notes（便签）有 2 条内容，已不再支持，不能保存：先把要留的内容挪走，再把这一项删掉。替换办法：便签：${REMOVED_DOCUMENT_FIELDS.sticky_notes.replacement}`,
		);
	});
});
