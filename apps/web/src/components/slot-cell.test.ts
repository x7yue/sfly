import { describe, expect, it } from "vitest";
import { idleSlotCount, slotLabel, taskChainLabel } from "./slot-cell";

describe("槽位格", () => {
	it("空闲槽位数：占用数超过槽位数（Agent 重连后槽位变少）时为 0，不出现负数", () => {
		expect(idleSlotCount(8, 2)).toBe(6);
		expect(idleSlotCount(4, 4)).toBe(0);
		expect(idleSlotCount(2, 3)).toBe(0);
	});

	it("所在的链：主链写「主链」，子流程写「子流程 <名称>」，名称为空的子流程写「未命名子流程」", () => {
		expect(taskChainLabel({ chain_name: null })).toBe("主链");
		expect(taskChainLabel({ chain_name: "巡检子流程" })).toBe("子流程 巡检子流程");
		expect(taskChainLabel({ chain_name: "" })).toBe("子流程 未命名子流程");
	});

	it("可访问名称：节点（有显示名称时带节点 ID）、场景，以及调用方补充的说明", () => {
		const task = { node_id: "load", orchestration_name: "撮合浸泡" };
		expect(slotLabel(task)).toBe("节点 load，场景 撮合浸泡");
		expect(slotLabel({ ...task, display_name: "下单压测" })).toBe(
			"节点 下单压测（load），场景 撮合浸泡",
		);
		expect(slotLabel(task, "正在 保持 4 小时")).toBe("节点 load，场景 撮合浸泡，正在 保持 4 小时");
	});
});
