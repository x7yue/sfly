import { describe, expect, it } from "vitest";
import { appendProblem, freePosition, newDocNode, newSubflowNameProblem } from "./add-node";

describe("新建子流程入口时填写的名称", () => {
	const doc = {
		nodes: [
			{ id: "entry", kind: "entry" as const },
			{ id: "subflow", kind: "subflow_entry" as const, name: "监控" },
			// 没有名称字段的旧子流程以节点 ID 作为名称。
			{ id: "legacy", kind: "subflow_entry" as const },
		],
	};

	it("不能为空", () => {
		expect(newSubflowNameProblem("", doc)).toBe("请填写子流程名称");
		expect(newSubflowNameProblem("   ", doc)).toBe("请填写子流程名称");
	});

	it("不能与已有子流程重名（包括以节点 ID 作为名称的旧子流程）", () => {
		expect(newSubflowNameProblem(" 监控 ", doc)).toBe("子流程入口节点 subflow 已使用名称「监控」");
		expect(newSubflowNameProblem("legacy", doc)).toBe("子流程入口节点 legacy 已使用名称「legacy」");
	});

	it("唯一的名称可以使用，写入新节点时去掉首尾空白", () => {
		expect(newSubflowNameProblem("压测", doc)).toBeNull();
		expect(newDocNode({ kind: "subflow_entry", name: " 压测 " }, "subflow_1")).toEqual({
			id: "subflow_1",
			kind: "subflow_entry",
			name: "压测",
			params: [],
		});
	});
});

describe("新建停止子流程节点", () => {
	it("还没有选择子流程，always 默认关闭", () => {
		expect(newDocNode({ kind: "stop_subflow" }, "stop_subflow_1")).toEqual({
			id: "stop_subflow_1",
			kind: "stop_subflow",
			always: false,
		});
	});
});

describe("没有来源的新节点落在哪（视口中心或右键位置）", () => {
	// 节点卡片 208 × 112。
	it("落点空着就用它", () => {
		expect(freePosition({ x: 400, y: 300 }, [{ x: 0, y: 0 }])).toEqual({ x: 400, y: 300 });
		// 贴边不算重叠。
		expect(freePosition({ x: 208, y: 0 }, [{ x: 0, y: 0 }])).toEqual({ x: 208, y: 0 });
	});

	it("与已有节点重叠时按固定步长往右下错开，直到不压住任何节点", () => {
		expect(freePosition({ x: 10, y: 10 }, [{ x: 0, y: 0 }])).toEqual({ x: 138, y: 138 });
		// 错开一次后又压住另一个节点：继续错开。
		expect(
			freePosition({ x: 0, y: 0 }, [
				{ x: 0, y: 0 },
				{ x: 100, y: 100 },
			]),
		).toEqual({ x: 224, y: 224 });
	});
});

describe("能不能在某个节点后面追加节点", () => {
	const doc = {
		nodes: [
			{ id: "entry", kind: "entry" as const },
			{ id: "a", kind: "package" as const },
			{ id: "spawn", kind: "async" as const },
			{ id: "sub", kind: "subflow_entry" as const },
			{ id: "loose", kind: "sleep" as const },
		],
		edges: [
			{ from: "entry", to: "a", kind: "chain" as const },
			{ from: "a", to: "spawn", kind: "chain" as const },
			{ from: "spawn", to: "sub", kind: "dispatch" as const },
		],
	};

	it("没有链上出线的节点可以：链尾、只有调度连线的异步任务节点、游离节点", () => {
		expect(appendProblem(doc, "spawn")).toBeNull();
		expect(appendProblem(doc, "sub")).toBeNull();
		expect(appendProblem(doc, "loose")).toBeNull();
	});

	it("已有出线的节点不行（链不能分叉）", () => {
		expect(appendProblem(doc, "a")).toBe("节点 a 已有出线，链不能分叉");
	});
});
