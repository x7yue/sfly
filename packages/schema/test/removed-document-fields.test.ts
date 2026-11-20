import { describe, expect, it } from "vitest";
import {
	OrchestrationDocument,
	REMOVED_DOCUMENT_FIELDS,
	removedFieldsIn,
	removedFieldsMessage,
	StoredOrchestrationDocument,
	toJsonSchema,
	withoutRemovedFields,
} from "../src/index.js";

// 已移除的文档顶层字段（便签 sticky_notes，ADR 0028）：升级前保存的版本里还带着它们。

const entry = { id: "entry", kind: "entry" };
const legacy = {
	nodes: [entry],
	sticky_notes: [{ id: "sticky_1", title: "跑之前", text: "- 确认 Agent 在线", color: "blue" }],
};

describe("可以保存的文档里没有便签", () => {
	it("带着 sticky_notes（空的也一样）被拒绝", () => {
		expect(OrchestrationDocument.safeParse(legacy).success).toBe(false);
		expect(OrchestrationDocument.safeParse({ nodes: [entry], sticky_notes: [] }).success).toBe(
			false,
		);
		expect(OrchestrationDocument.safeParse({ nodes: [entry] }).success).toBe(true);
	});

	it("导出给 Python 的 JSON Schema 里没有它", () => {
		const schema = toJsonSchema(OrchestrationDocument) as { properties: Record<string, unknown> };
		expect(Object.keys(schema.properties)).not.toContain("sticky_notes");
	});
});

describe("读到的文档认得并丢掉便签", () => {
	it("先去掉已移除的字段再解析：旧版本读得出，读到的文档里没有 sticky_notes", () => {
		expect(StoredOrchestrationDocument.safeParse(legacy).success).toBe(false);
		const parsed = StoredOrchestrationDocument.parse(withoutRemovedFields(legacy));
		expect(parsed).not.toHaveProperty("sticky_notes");
		expect(parsed.nodes.map((n) => n.id)).toEqual(["entry"]);
	});

	it("去掉的是浅拷贝，传入的值不变；没有已移除字段时原样返回同一个对象", () => {
		const stripped = withoutRemovedFields(legacy);
		expect(stripped).toEqual({ nodes: [entry] });
		expect(legacy.sticky_notes).toHaveLength(1);
		const plain = { nodes: [entry] };
		expect(withoutRemovedFields(plain)).toBe(plain);
	});

	it("不是对象的东西原样返回，不抛错", () => {
		for (const value of [null, undefined, 3, "x", [1, 2]]) {
			expect(withoutRemovedFields(value)).toBe(value);
			expect(removedFieldsIn(value)).toEqual([]);
		}
	});
});

describe("保存时遇到已移除的字段", () => {
	it("认得文档顶层的 sticky_notes（空数组也算），嵌套里的同名键不算", () => {
		expect(removedFieldsIn(legacy)).toEqual(["sticky_notes"]);
		expect(removedFieldsIn({ nodes: [entry], sticky_notes: [] })).toEqual(["sticky_notes"]);
		expect(removedFieldsIn({ nodes: [{ ...entry, sticky_notes: [] }] })).toEqual([]);
	});

	it("说明写明哪些字段、怎么办", () => {
		expect(removedFieldsMessage(["sticky_notes"])).toBe(
			`场景文档里的 sticky_notes（便签）已不再支持，先把这一项删掉再保存。替换办法：便签：${REMOVED_DOCUMENT_FIELDS.sticky_notes.replacement}`,
		);
	});
});
