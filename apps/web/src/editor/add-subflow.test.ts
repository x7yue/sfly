import { describe, expect, it } from "vitest";
import { companionSubflow, dispatchProblem } from "./add-subflow";

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

describe("能不能从异步任务节点的调度端口新建子流程", () => {
	const doc = {
		edges: [
			{ from: "a", to: "spawn", kind: "chain" as const },
			{ from: "spawn", to: "sub", kind: "dispatch" as const },
		],
	};

	it("还没有调度连线的异步任务节点可以", () => {
		expect(dispatchProblem(doc, "idle")).toBeNull();
		// 只有链上出线不影响。
		expect(dispatchProblem(doc, "a")).toBeNull();
	});

	it("已有调度连线时不行（一个异步任务节点只调度一个子流程）", () => {
		expect(dispatchProblem(doc, "spawn")).toBe("异步任务节点 spawn 已有调度连线");
	});
});
