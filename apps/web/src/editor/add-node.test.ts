import { describe, expect, it } from "vitest";
import { newDocNode, newSubflowNameProblem } from "./add-node";

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
