import { describe, expect, it } from "vitest";
import { type ActiveNode, activeDetail, activeOrder } from "./active-node";

const NOW = Date.parse("2026-01-01T00:10:00.000Z");
const node = (patch: Partial<ActiveNode>): ActiveNode => ({
	status: "running",
	agent: "agent-a",
	attempt: 2,
	started_at: "2026-01-01T00:08:55.000Z",
	...patch,
});

describe("进行中的节点那一行", () => {
	it("执行中：Agent、尝试号、已执行时长（整秒）", () => {
		expect(activeDetail(node({ started_at: "2026-01-01T00:09:54.600Z" }), NOW)).toBe(
			"agent-a · 第 2 次尝试 · 5s",
		);
		expect(activeDetail(node({}), NOW)).toBe("agent-a · 第 2 次尝试 · 1m 05s");
	});

	it("还没开始执行（准备中、排队中）时长处写状态，不从排队算起", () => {
		expect(activeDetail(node({ status: "dispatched", started_at: null }), NOW)).toBe(
			"agent-a · 第 2 次尝试 · 准备中",
		);
		expect(activeDetail(node({ status: "queued", started_at: null }), NOW)).toBe(
			"agent-a · 第 2 次尝试 · 排队中",
		);
	});

	it("不在 Agent 上的节点（等待子流程停止的停止子流程节点）只写状态", () => {
		expect(activeDetail(node({ status: "waiting", agent: null, started_at: null }), NOW)).toBe(
			"等待中",
		);
	});

	it("先执行中和准备中，再排队，最后等待；同一类保持原来的顺序", () => {
		const list = [
			{ id: "nap", status: "waiting" },
			{ id: "q", status: "queued" },
			{ id: "run", status: "running" },
			{ id: "prep", status: "dispatched" },
		];
		expect([...list].sort((a, b) => activeOrder(a) - activeOrder(b)).map((n) => n.id)).toEqual([
			"run",
			"prep",
			"q",
			"nap",
		]);
	});
});
