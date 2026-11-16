import type { RunFocusItem } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { focusPreview } from "./focus-preview";

type Item = Pick<RunFocusItem, "chart" | "anomaly">;

const warn = { kind: "log", level: "warn", at: "2026-01-01T00:00:00.000Z", message: "慢" } as const;
const item = (chart: string, anomaly: Item["anomaly"] = null): Item => ({ chart, anomaly });

/** 控制面排好的读数：有异常的在最前，其余按作者的顺序。 */
const ITEMS = [
	item("内存使用率", warn),
	item("下单延迟", warn),
	item("母单量"),
	item("CPU"),
	item("子单量"),
	item("拒单数"),
];

describe("只放得下几项时显示哪几项", () => {
	it("按读数的顺序取前两项（有异常的已经排在最前），其余只计数，有异常的项数含没显示出来的", () => {
		const preview = focusPreview(ITEMS);
		expect(preview.shown.map((i) => i.chart)).toEqual(["内存使用率", "下单延迟"]);
		expect(preview.more).toBe(4);
		expect(preview.attention).toBe(2);
	});

	it("不到两项时全部显示，没有「还有 N 个」", () => {
		const preview = focusPreview([item("CPU")]);
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
});
