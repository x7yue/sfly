import { describe, expect, it } from "vitest";
import {
	BUILTIN_ITEMS,
	freeCardAt,
	freePosition,
	newDocNode,
	newSubflowNameProblem,
} from "./add-node";

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

describe("按卡片中心放置（视口中心、右键处、粘贴）", () => {
	it("卡片中心落在给定的点上，坐标取整；压住已有节点时同样错开", () => {
		expect(freeCardAt({ x: 104.4, y: 56.6 }, [])).toEqual({ x: 0, y: 1 });
		expect(freeCardAt({ x: 104, y: 56 }, [{ x: 0, y: 0 }])).toEqual({ x: 128, y: 128 });
	});
});
