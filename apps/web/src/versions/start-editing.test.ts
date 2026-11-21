import type { OrchestrationHeadView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { startEditing } from "./useVersionedDraft";

describe("开始编辑最新版本", () => {
	it("最新版本的文档里还带着 sticky_notes（升级前保存的）：画布的起点和比较基准里都没有它", () => {
		const head = {
			orchestration_id: "s1",
			number: 4,
			author: "旧人",
			author_via: null,
			created_at: "2026-01-01T00:00:00Z",
			document: {
				nodes: [{ id: "entry", kind: "entry", params: [], position: { x: 0, y: 0 } }],
				edges: [],
				packages: {},
				annotations: [],
				sticky_notes: [{ id: "sticky_1", text: "跑之前确认" }],
			},
		} as unknown as OrchestrationHeadView;

		const start = startEditing("s1", head);
		expect(start.fromDraft).toBe(false);
		expect(start.document).not.toHaveProperty("sticky_notes");
		expect(start.base.document).not.toHaveProperty("sticky_notes");
		expect(start.document.nodes.map((n) => n.id)).toEqual(["entry"]);
	});
});
