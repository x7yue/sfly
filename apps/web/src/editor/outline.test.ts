import type { Annotation, OrchestrationNode } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { canvasOutline } from "./outline";

// 画布的大纲：不在注释框里的节点在最前，每个注释框一组；按阅读顺序排；搜索按标题、节点 ID、注释框标题。

const node = (id: string, x: number, y: number, kind: OrchestrationNode["kind"] = "package") => ({
	id,
	kind,
	position: { x, y },
});
const doc = (annotations: Annotation[]) => ({
	nodes: [
		node("entry", 0, 0, "entry"),
		node("fetch", 252, 0),
		node("check", 504, 10),
		node("report", 0, 300),
		node("sub", 252, 300, "subflow_entry"),
		node("sub_ping", 504, 300),
	],
	edges: [{ from: "sub", to: "sub_ping", kind: "chain" as const }],
	annotations,
});
const TITLES: Record<string, string> = {
	entry: "入口",
	fetch: "拉取快照",
	check: "HTTP 检查",
	report: "发汇报",
	sub: "对账",
	sub_ping: "Ping",
};
const titleOf = (id: string) => TITLES[id] ?? id;
const ids = (list: { id: string }[]) => list.map((n) => n.id);

const annotations: Annotation[] = [
	{ id: "a1", title: "准备数据", nodes: ["check", "fetch"], subflows: [] },
	{ id: "a2", title: "对账子流程", nodes: ["check"], subflows: ["sub"] },
	{ id: "a3", title: "没有成员", nodes: ["gone"], subflows: [] },
];

describe("canvasOutline", () => {
	it("不在框里的在最前，每个注释框一组（子流程成员连同它链上的节点）；一个节点可以在几组里；按阅读顺序", () => {
		const outline = canvasOutline(doc(annotations), titleOf);
		expect(ids(outline.loose)).toEqual(["entry", "report"]);
		expect(outline.groups.map((g) => [g.annotation.id, ids(g.nodes)])).toEqual([
			["a1", ["fetch", "check"]],
			["a2", ["check", "sub", "sub_ping"]],
		]);
		expect(outline.loose[0]).toEqual({ id: "entry", kind: "entry", title: "入口" });
	});

	it("没有注释框时所有节点都在最前那组", () => {
		const outline = canvasOutline(doc([]), titleOf);
		expect(ids(outline.loose)).toEqual(["entry", "fetch", "check", "report", "sub", "sub_ping"]);
		expect(outline.groups).toEqual([]);
	});

	it("搜索：按标题或节点 ID，不分大小写；只留匹配的节点和有匹配节点的组", () => {
		const byTitle = canvasOutline(doc(annotations), titleOf, "ping");
		expect(ids(byTitle.loose)).toEqual([]);
		expect(byTitle.groups.map((g) => [g.annotation.id, ids(g.nodes)])).toEqual([
			["a2", ["sub_ping"]],
		]);
		const byId = canvasOutline(doc(annotations), titleOf, " FETCH ");
		expect(byId.groups.map((g) => ids(g.nodes))).toEqual([["fetch"]]);
		expect(canvasOutline(doc(annotations), titleOf, "汇报").loose.map((n) => n.id)).toEqual([
			"report",
		]);
	});

	it("搜索命中注释框的标题：整组都留下", () => {
		const outline = canvasOutline(doc(annotations), titleOf, "准备");
		expect(outline.groups.map((g) => [g.annotation.id, ids(g.nodes)])).toEqual([
			["a1", ["fetch", "check"]],
		]);
		expect(outline.loose).toEqual([]);
	});

	it("便签另成最后一组：写标题，没有标题时写正文的第一行；搜索按标题和正文", () => {
		const notes = {
			...doc([]),
			sticky_notes: [
				{ id: "s1", title: "跑之前确认", text: "- Agent 都在线" },
				{ id: "s2", text: "- 已知问题：重启慢\n第二行" },
			],
		};
		expect(canvasOutline(notes, titleOf).stickies).toEqual([
			{ id: "s1", label: "跑之前确认" },
			{ id: "s2", label: "已知问题：重启慢" },
		]);
		expect(canvasOutline(notes, titleOf, "agent").stickies.map((s) => s.id)).toEqual(["s1"]);
		expect(canvasOutline(notes, titleOf, "第二行").stickies.map((s) => s.id)).toEqual(["s2"]);
	});
});
