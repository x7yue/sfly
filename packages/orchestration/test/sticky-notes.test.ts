import { type OrchestrationNode, STICKY_NOTE_SIZE } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	ANNOTATION_GAP,
	ANNOTATION_PADDING,
	ANNOTATION_TITLE_SPACE,
	REGION_PADDING,
	STICKY_ROW_GAP,
	stickyHeadline,
	stickyNoteRow,
	withStickyNotePositions,
} from "../src/index.js";

// 便签的位置（ADR 0026）：整理布局时按 sticky_notes 的顺序排成一行，放在内容（节点、子流程区域、注释框和它的标题）
// 的上方、和内容左边对齐；不写位置的便签（命令行写的）也放到这一行里。

const node = (id: string, x: number, y: number, kind: OrchestrationNode["kind"] = "package") => ({
	id,
	kind,
	position: { x, y },
});

const doc = {
	nodes: [node("entry", 0, 0, "entry"), node("fetch", 252, 0)],
	edges: [{ from: "entry", to: "fetch", kind: "chain" as const }],
};

describe("便签那一行", () => {
	it("按顺序从左到右排，上边对齐，放在节点上方、和最左边的节点对齐；没写大小的按默认大小", () => {
		const notes = [
			{ id: "a", size: { width: 300, height: 200 } },
			{ id: "b" },
			{ id: "c", size: { width: 200, height: 120 } },
		];
		const row = stickyNoteRow({ ...doc, sticky_notes: notes });
		const top = 0 - STICKY_ROW_GAP - 200;
		expect(Object.fromEntries(row)).toEqual({
			a: { x: 0, y: top },
			b: { x: 300 + ANNOTATION_GAP, y: top },
			c: { x: 300 + ANNOTATION_GAP + STICKY_NOTE_SIZE.width + ANNOTATION_GAP, y: top },
		});
	});

	it("让开注释框和它框外的标题、子流程区域：从它们的最上沿、最左沿算起", () => {
		const row = stickyNoteRow({
			...doc,
			annotations: [{ id: "x", nodes: ["entry"], subflows: [] }],
			sticky_notes: [{ id: "a" }],
		});
		const boxTop = -ANNOTATION_PADDING.top - ANNOTATION_TITLE_SPACE;
		expect(row.get("a")).toEqual({
			x: -ANNOTATION_PADDING.left,
			y: boxTop - STICKY_ROW_GAP - STICKY_NOTE_SIZE.height,
		});

		const sub = stickyNoteRow({
			nodes: [node("s", 100, 50, "subflow_entry")],
			edges: [],
			sticky_notes: [{ id: "a" }],
		});
		expect(sub.get("a")).toEqual({
			x: 100 - REGION_PADDING.left,
			y: 50 - REGION_PADDING.top - STICKY_ROW_GAP - STICKY_NOTE_SIZE.height,
		});
	});

	it("没有节点时从原点上方开始；没有便签时结果为空", () => {
		expect(stickyNoteRow({ nodes: [], edges: [], sticky_notes: [{ id: "a" }] }).get("a")).toEqual({
			x: 0,
			y: -STICKY_ROW_GAP - STICKY_NOTE_SIZE.height,
		});
		expect(stickyNoteRow({ ...doc, sticky_notes: [] }).size).toBe(0);
	});
});

describe("补便签的位置", () => {
	it("只给没写位置的便签补上它在那一行里的位置，写了的不动；都有位置时原样返回", () => {
		const placed = { id: "a", text: "x", position: { x: 900, y: 900 } };
		const filled = withStickyNotePositions({
			...doc,
			sticky_notes: [placed, { id: "b", text: "y" }] as {
				id: string;
				text: string;
				position?: { x: number; y: number };
			}[],
		});
		expect(filled.sticky_notes[0]).toBe(placed);
		expect(filled.sticky_notes[1]?.position).toEqual({
			x: STICKY_NOTE_SIZE.width + ANNOTATION_GAP,
			y: -STICKY_ROW_GAP - STICKY_NOTE_SIZE.height,
		});
		const complete = { ...doc, sticky_notes: [placed] };
		expect(withStickyNotePositions(complete)).toBe(complete);
	});
});

describe("stickyHeadline", () => {
	it("有标题时是标题，没有时是正文的第一行（去掉列表的「- 」）", () => {
		expect(stickyHeadline({ title: " 跑之前确认 ", text: "- 一" })).toBe("跑之前确认");
		expect(stickyHeadline({ text: "\n- Agent 都在线\n- 二" })).toBe("Agent 都在线");
		expect(stickyHeadline({ title: "  ", text: "已知问题\n第二行" })).toBe("已知问题");
	});
});
