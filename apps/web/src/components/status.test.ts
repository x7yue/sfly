import { NodeStatus, RunStatus } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { NODE_STATUS_LABEL, RUN_STATUS_LABEL } from "#/lib/copy";
import { nodeStatusView, runStatusView } from "./status";

describe("状态显示（各页面共用一张表）", () => {
	it("每个运行状态、节点状态都有颜色与文字", () => {
		for (const status of RunStatus.options) {
			expect(runStatusView(status).label).toBe(RUN_STATUS_LABEL[status]);
		}
		for (const status of NodeStatus.options) {
			expect(nodeStatusView(status).label).toBe(NODE_STATUS_LABEL[status]);
		}
		expect(runStatusView("running")).toEqual({ kind: "running", label: "运行中" });
		expect(nodeStatusView("dispatched")).toEqual({ kind: "running", label: "准备中" });
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
