import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
	isRemovedNodeKind,
	keepRemovedNodeConfig,
	OrchestrationDocument,
	REMOVED_NODE_KINDS,
	removedKindOutputs,
	removedNodesIn,
	removedNodesMessage,
	StoredOrchestrationDocument,
	toJsonSchema,
} from "../src/index.js";

// 已移除的节点种类（ADR 0028）：历史版本里留着它们，读取时认得，保存时不收。

const notify = {
	id: "notify",
	kind: "feishu_notify",
	bot: "ops",
	text: "完成",
	position: { x: 0, y: 0 },
};
const document = { nodes: [{ id: "entry", kind: "entry" }, notify] };

describe("可以保存的文档里没有已移除的节点种类", () => {
	it("zod 拒绝它", () => {
		expect(OrchestrationDocument.safeParse(document).success).toBe(false);
	});

	it("导出给 Python 的 JSON Schema 里没有它，本地校验同样拒绝", () => {
		const schema = toJsonSchema(OrchestrationDocument);
		expect(JSON.stringify(schema)).not.toContain("feishu_notify");
		expect(new Ajv2020({ strict: false }).compile(schema)(document)).toBe(false);
	});
});

describe("读到的文档认得已移除的节点种类", () => {
	it("原样带着当时的配置，补上后来新增的字段的默认值", () => {
		const parsed = StoredOrchestrationDocument.parse(document);
		expect(parsed.annotations).toEqual([]);
		expect(parsed.sticky_notes).toEqual([]);
		const stored = keepRemovedNodeConfig(parsed, document);
		expect(stored.nodes[1]).toEqual(notify);
		// 其余节点是解析后的（补了默认值）。
		expect(stored.nodes[0]).toMatchObject({ id: "entry", kind: "entry", params: [] });
	});

	it("没有已移除节点的文档：和只按可以保存的文档解析一样", () => {
		const plain = { nodes: [{ id: "entry", kind: "entry" }] };
		expect(StoredOrchestrationDocument.parse(plain)).toEqual(OrchestrationDocument.parse(plain));
	});

	it("别的节点写错了还是不合法（已移除的种类不是通配）", () => {
		expect(
			StoredOrchestrationDocument.safeParse({ nodes: [{ id: "x", kind: "no_such_kind" }] }).success,
		).toBe(false);
	});
});

describe("已移除节点的清单与说明", () => {
	it("按文档里的顺序列出，带上替换办法", () => {
		expect(removedNodesIn(document)).toEqual([
			{
				id: "notify",
				kind: "feishu_notify",
				replacement: REMOVED_NODE_KINDS.feishu_notify.replacement,
			},
		]);
		expect(removedNodesIn({ nodes: [{ id: "entry", kind: "entry" }] })).toEqual([]);
		expect(isRemovedNodeKind("feishu_notify")).toBe(true);
		expect(isRemovedNodeKind("package")).toBe(false);
	});

	it("保存被拒绝的说明：哪些节点、种类名、怎么替换", () => {
		expect(removedNodesMessage(removedNodesIn(document))).toBe(
			"场景里有 1 个已不再支持的节点（notify），先删掉再保存。替换办法：已移除的节点类型 feishu_notify：在节点代码里用 ctx.notify 发飞书消息",
		);
	});

	it("原来有输出的种类登记了输出名，别的节点引用过它们的要一起改；没有输出的是空数组", () => {
		expect(removedKindOutputs("timer")).toEqual(["triggered_at", "late"]);
		expect(removedKindOutputs("sleep")).toEqual(["triggered_at"]);
		expect(removedKindOutputs("feishu_notify")).toEqual([]);
	});
});
