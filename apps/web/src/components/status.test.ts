import { NodeStatus, RunStatus } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { RUN_STATUS_LABEL } from "#/lib/copy";
import { nodeStatusView, runStatusView } from "./status";

describe("状态显示（各页面共用一张表）", () => {
	it("每个运行状态都有颜色与文字", () => {
		for (const status of RunStatus.options) {
			expect(runStatusView(status).label).toBe(RUN_STATUS_LABEL[status]);
		}
		expect(runStatusView("running")).toEqual({ kind: "running", label: "运行中" });
	});

	it("每个节点状态的样式与中文标签", () => {
		expect(Object.fromEntries(NodeStatus.options.map((s) => [s, nodeStatusView(s)]))).toEqual({
			pending: { kind: "pending", label: "待执行" },
			queued: { kind: "queued", label: "排队中" },
			dispatched: { kind: "running", label: "准备中" },
			running: { kind: "running", label: "执行中" },
			waiting: { kind: "warn", label: "等待中" },
			success: { kind: "ok", label: "成功" },
			failed: { kind: "failed", label: "失败" },
			skipped: { kind: "skipped", label: "已跳过" },
			cancelled: { kind: "cancelled", label: "已取消" },
			stopped: { kind: "stopped", label: "已停止" },
		});
		// 不认识的状态按待执行的样式显示原文。
		expect(nodeStatusView("mystery")).toEqual({ kind: "pending", label: "mystery" });
	});

	it("已请求取消、还没结束的运行显示为取消中，不是运行中（故事 70）", () => {
		expect(runStatusView("running", { cancelling: true })).toEqual({
			kind: "cancelled",
			label: "取消中",
		});
		expect(runStatusView("running", { cancelling: true, forced: true })).toEqual({
			kind: "cancelled",
			label: "强制终止中",
		});
		// 已经结束的运行按结束状态显示。
		expect(runStatusView("cancelled", { cancelling: true }).label).toBe("已取消");
	});
});
