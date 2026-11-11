import { describe, expect, it } from "vitest";
import { companionSubflow } from "./add-subflow";

describe("随异步任务节点一起新建的子流程", () => {
	it("子流程入口放在异步任务节点右下方（与整理布局相同），名称去掉首尾空白，连一条调度连线", () => {
		expect(companionSubflow({ id: "async_1", position: { x: 504, y: 0 } }, " 压测 ", [])).toEqual({
			node: {
				id: "subflow_1",
				type: "subflow_entry",
				position: { x: 714, y: 256 },
				data: { node: { id: "subflow_1", kind: "subflow_entry", name: "压测", params: [] } },
				deletable: true,
			},
			edge: { from: "async_1", to: "subflow_1", kind: "dispatch" },
		});
	});

	it("ID 不与已有节点重复；落点压住已有节点时错开", () => {
		const made = companionSubflow({ id: "async_2", position: { x: 0, y: 0 } }, "监控", [
			{ id: "subflow_1", position: { x: 210, y: 256 } },
		]);
		expect(made.node.id).toBe("subflow_2");
		expect(made.node.position).toEqual({ x: 338, y: 384 });
	});
});
