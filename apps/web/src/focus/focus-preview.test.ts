import type { RunFocus, RunFocusItem } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { focusPreview, nodeFocusItems } from "./focus-preview";

type Item = Pick<RunFocusItem, "node_id" | "chart" | "anomaly">;

const warn = { kind: "log", level: "warn", at: "2026-01-01T00:00:00.000Z", message: "慢" } as const;
const item = (node_id: string, chart: string, anomaly: Item["anomaly"] = null): Item => ({
	node_id,
	chart,
	anomaly,
});

/** 控制面排好的读数：有异常的在最前，其余按作者的顺序。 */
const ITEMS = [
	item("sys_mon", "内存使用率", warn),
	item("load", "下单延迟", warn),
	item("load", "母单量"),
	item("proc_mon", "CPU"),
	item("load", "子单量"),
	item("load", "拒单数"),
];

const focusOf = (mode: RunFocus["mode"], items: Item[]) => ({ mode, items });

describe("只放得下几项时显示哪几项", () => {
	it("节点卡片和槽位格按读数的顺序取前两项（有异常的已经排在最前），其余只计数，有异常的项数含没显示出来的", () => {
		const preview = focusPreview(nodeFocusItems(focusOf("focus", ITEMS), "load"));
		expect(preview.shown.map((i) => i.chart)).toEqual(["下单延迟", "母单量"]);
		expect(preview.more).toBe(2);
		expect(preview.attention).toBe(1);
	});

	it("不到两项时全部显示，没有「还有 N 个」", () => {
		const preview = focusPreview(nodeFocusItems(focusOf("focus", ITEMS), "proc_mon"));
		expect(preview.shown.map((i) => i.chart)).toEqual(["CPU"]);
		expect(preview.more).toBe(0);
		expect(preview.attention).toBe(0);
	});

	it("可以按位置给出别的上限（控制台的运行块按宽度放 3 或 4 格）", () => {
		const preview = focusPreview(ITEMS, 4);
		expect(preview.shown.map((i) => i.chart)).toEqual(["内存使用率", "下单延迟", "母单量", "CPU"]);
		expect(preview.more).toBe(2);
		expect(preview.attention).toBe(2);
	});

	it("场景没设关注项时读数是执行中节点的主指标，不算任何节点的关注项", () => {
		expect(nodeFocusItems(focusOf("primary", ITEMS), "load")).toEqual([]);
		expect(nodeFocusItems(undefined, "load")).toEqual([]);
	});
});
