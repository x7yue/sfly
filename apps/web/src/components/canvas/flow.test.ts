import { describe, expect, it } from "vitest";
import { type DocMeta, fromFlow, toFlow } from "./flow";

const meta: DocMeta = { packages: {}, annotations: [] };

describe("画布 → 场景文档", () => {
	it("生成的文档只有现在支持的顶层字段，没有已移除的 sticky_notes（保存新版本时不再带上便签）", () => {
		const { nodes, edges } = toFlow({
			nodes: [{ id: "entry", kind: "entry", params: [], position: { x: 0.4, y: 0.6 } }],
			edges: [],
			packages: {},
			annotations: [],
		});
		const doc = fromFlow(nodes, edges, meta);
		expect(Object.keys(doc).sort()).toEqual(["annotations", "edges", "nodes", "packages"]);
		expect(doc.nodes[0]?.position).toEqual({ x: 0, y: 1 });
	});
});
