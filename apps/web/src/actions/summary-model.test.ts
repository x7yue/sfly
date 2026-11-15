import type { ActionNameCount, RunningActionView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { countOnlyNames, failedTotal, runningRows } from "./summary-model";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const running = (
	id: number,
	parent: number | null,
	depth: number,
	name: string,
	startedMs: number,
): RunningActionView => ({
	id,
	parent,
	depth,
	name,
	fields: {},
	started_at: new Date(T0 + startedMs).toISOString(),
	agent_started_at: new Date(T0 + startedMs).toISOString(),
});
const shown = (rows: ReturnType<typeof runningRows>) =>
	rows.map((row) => `${row.level}:${row.action.name}`);

describe("正在做的动作排成树", () => {
	it("子动作紧跟在父动作下面，同一层按开始的先后排，不按 ID", () => {
		const rows = runningRows([
			running(1, null, 0, "保持", 100),
			running(2, 1, 1, "下单 B", 400),
			running(3, null, 0, "预热", 50),
			running(4, 1, 1, "下单 A", 300),
			running(5, 4, 2, "回报", 350),
		]);
		expect(shown(rows)).toEqual(["0:预热", "0:保持", "1:下单 A", "2:回报", "1:下单 B"]);
	});

	it("最多缩进 3 层，更深的画在第 3 层", () => {
		const rows = runningRows([
			running(1, null, 0, "a", 1),
			running(2, 1, 1, "b", 2),
			running(3, 2, 2, "c", 3),
			running(4, 3, 3, "d", 4),
			running(5, 4, 4, "e", 5),
		]);
		expect(shown(rows)).toEqual(["0:a", "1:b", "2:c", "2:d", "2:e"]);
	});

	it("父动作不在列表里（已经结束，或列满 50 个被挤掉）时，从它自己的层级起排", () => {
		const rows = runningRows([running(7, 3, 1, "下单", 10), running(1, null, 0, "保持", 5)]);
		expect(shown(rows)).toEqual(["0:保持", "1:下单"]);
	});

	it("父子关系成环（被改过的 SDK）也不丢动作", () => {
		const rows = runningRows([running(1, 2, 1, "甲", 1), running(2, 1, 1, "乙", 2)]);
		expect(shown(rows).sort()).toEqual(["1:乙", "1:甲"]);
	});
});

const count = (name: string, cappedAt: string | null, failed = 0): ActionNameCount => ({
	name,
	total: 10,
	failed,
	reported: 5,
	capped_at: cappedAt,
	agent_capped_at: cappedAt,
});

describe("上限说明和失败的个数", () => {
	it("只列出只计数的名称，先超出的在前", () => {
		const names = [
			count("下单", "2026-01-01T09:19:12.000Z"),
			count("预热", null),
			count("撤单", "2026-01-01T09:10:00.000Z"),
		];
		expect(countOnlyNames(names)).toEqual([
			{ name: "撤单", since: "2026-01-01T09:10:00.000Z" },
			{ name: "下单", since: "2026-01-01T09:19:12.000Z" },
		]);
		expect(countOnlyNames([count("预热", null)])).toEqual([]);
	});

	it("失败的个数是各个名称的失败数之和", () => {
		expect(
			failedTotal([count("下单", null, 17), count("撤单", null, 3), count("预热", null)]),
		).toBe(20);
		expect(failedTotal([])).toBe(0);
	});
});
