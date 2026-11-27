import { describe, expect, it } from "vitest";
import { statusLegend } from "./status-legend";

describe("概览链路的状态图例", () => {
	it("只列出现过的状态，顺序和时间线的图例一致", () => {
		expect(
			statusLegend(["pending", "success", "failed", "cancelled", "success", "queued"]),
		).toEqual([
			{ kind: "ok", label: "成功" },
			{ kind: "failed", label: "失败" },
			{ kind: "queued", label: "排队中" },
			{ kind: "cancelled", label: "已取消" },
			{ kind: "pending", label: "待执行" },
		]);
	});

	it("准备中和执行中是同一个圆点：合成一项，执行中在前；只有一种时只写那一种", () => {
		expect(statusLegend(["running", "dispatched"])).toEqual([
			{ kind: "running", label: "执行中、准备中" },
		]);
		expect(statusLegend(["dispatched", "running"])).toEqual([
			{ kind: "running", label: "执行中、准备中" },
		]);
		expect(statusLegend(["dispatched"])).toEqual([{ kind: "running", label: "准备中" }]);
		expect(statusLegend(["running"])).toEqual([{ kind: "running", label: "执行中" }]);
	});

	it("等待、跳过、停止各一项", () => {
		expect(statusLegend(["waiting", "skipped", "stopped"]).map((e) => e.label)).toEqual([
			"等待中",
			"已停止",
			"已跳过",
		]);
	});

	it("没有节点：没有图例", () => {
		expect(statusLegend([])).toEqual([]);
	});
});
