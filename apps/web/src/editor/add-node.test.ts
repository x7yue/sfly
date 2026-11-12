import { describe, expect, it } from "vitest";
import { BUILTIN_ITEMS, newDocNode, newSubflowNameProblem } from "./add-node";

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

describe("新建飞书通知节点", () => {
	it("还没有选择机器人，格式是文本，文本为空，不@所有人，always 默认关闭；卡片的标题和正文为空、蓝色", () => {
		expect(newDocNode({ kind: "feishu_notify" }, "feishu_notify_1")).toEqual({
			id: "feishu_notify_1",
			kind: "feishu_notify",
			always: false,
			format: "text",
			text: "",
			at_all: false,
			title: "",
			color: "blue",
			markdown: "",
		});
	});

	it("出现在添加节点菜单的内置节点里", () => {
		expect(BUILTIN_ITEMS.map((item) => item.kind)).toContain("feishu_notify");
	});
});
