import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDraft } from "./draft";

const NODES = [{ id: "entry", kind: "entry", params: [], position: { x: 0, y: 0 } }];
const STICKY_NOTES = [
	{ id: "sticky_1", title: "跑之前确认", text: "- Agent 都在线\n- 升级包已放好" },
	{ id: "sticky_2", text: "已知问题", color: "pink", position: { x: 320, y: -260 } },
];

/** 把一份草稿原文放进假的 localStorage（单测跑在 node 里，没有浏览器）。 */
function storeDraft(orchestrationId: string, draft: unknown) {
	const items = new Map([[`sfly.draft.${orchestrationId}`, JSON.stringify(draft)]]);
	vi.stubGlobal("window", { localStorage: { getItem: (key: string) => items.get(key) ?? null } });
}

afterEach(() => vi.unstubAllGlobals());

describe("恢复本地草稿", () => {
	it("升级前存下的草稿带着 sticky_notes：草稿内容和编辑起点的内容里都不再有它，其余原样", () => {
		const document = {
			nodes: [{ ...NODES[0], display_name: "改过的入口" }],
			edges: [],
			packages: {},
			annotations: [],
			sticky_notes: STICKY_NOTES,
		};
		storeDraft("s1", {
			base_version: 3,
			base_author: "旧人",
			base_document: { ...document, nodes: NODES },
			document,
			updated_at: "2026-01-01T00:00:00.000Z",
		});

		const draft = loadDraft("s1");
		expect(draft).not.toBeNull();
		expect(draft?.document).not.toHaveProperty("sticky_notes");
		expect(draft?.base_document).not.toHaveProperty("sticky_notes");
		expect(draft?.document.nodes).toEqual(document.nodes);
		expect(draft?.base_document.nodes).toEqual(NODES);
		expect(draft?.base_version).toBe(3);
	});

	it("草稿里本来就没有已移除的字段时内容不变", () => {
		const document = { nodes: NODES, edges: [], packages: {}, annotations: [] };
		storeDraft("s2", {
			base_version: 1,
			base_author: null,
			base_document: document,
			document,
			updated_at: "2026-01-01T00:00:00.000Z",
		});
		expect(loadDraft("s2")?.document).toEqual(document);
	});
});
