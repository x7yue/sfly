import type { OrchestrationNode } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	type NodeDisplayLookup,
	nodeCardText,
	nodeOutsideCardText,
	subflowLabels,
} from "../src/index.js";

const doc = {
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "mon", kind: "subflow_entry", name: "监控" },
		{ id: "legacy", kind: "subflow_entry" },
		{ id: "blank", kind: "subflow_entry", name: " " },
		{ id: "sleep_1", kind: "sleep" },
	],
};

const lookup: NodeDisplayLookup = {
	titleOf: (pkg, node) => (`${pkg}/${node}` === "std/shell" ? "Shell 命令" : undefined),
	subflowLabelOf: subflowLabels(doc),
};

const node = (n: Record<string, unknown> & { kind: OrchestrationNode["kind"] }) =>
	({ id: "n1", ...n }) as OrchestrationNode;

describe("卡片上的标题和头部种类名", () => {
	it("包节点：标题是节点类型的标题，头部不写种类名；节点包里没有这个节点类型时标题是节点类型名", () => {
		const shell = node({ kind: "package", package: "std", node: "shell" });
		expect(nodeCardText(shell, lookup)).toEqual({ title: "Shell 命令", caption: undefined });
		const unknown = node({ kind: "package", package: "std", node: "gone" });
		expect(nodeCardText(unknown, lookup)).toEqual({ title: "gone", caption: undefined });
		expect(nodeCardText(unknown, {})).toEqual({ title: "gone", caption: undefined });
	});

	it("Sleep 节点、定时节点：标题写出等待时长和时间点，头部是种类名", () => {
		expect(nodeCardText(node({ kind: "sleep", duration: "30s" }), lookup)).toEqual({
			title: "等待 30s",
			caption: "Sleep",
		});
		expect(nodeCardText(node({ kind: "timer", at: "09:30:00" }), lookup)).toEqual({
			title: "等到 09:30:00",
			caption: "定时",
		});
	});

	it("停止子流程节点：标题写出要停止的子流程名称，头部是种类名", () => {
		expect(nodeCardText(node({ kind: "stop_subflow", subflow: "mon" }), lookup)).toEqual({
			title: "停止「监控」",
			caption: "停止子流程",
		});
	});

	it("停止子流程节点没有选择目标时标题就是种类名，头部不重复", () => {
		expect(nodeCardText(node({ kind: "stop_subflow" }), lookup)).toEqual({
			title: "停止子流程",
			caption: undefined,
		});
	});

	it("停止子流程节点的目标不在场景里时标题写目标的节点 ID", () => {
		expect(nodeCardText(node({ kind: "stop_subflow", subflow: "removed" }), lookup)).toEqual({
			title: "停止「removed」",
			caption: "停止子流程",
		});
		expect(nodeCardText(node({ kind: "stop_subflow", subflow: "sleep_1" }), lookup).title).toBe(
			"停止「sleep_1」",
		);
	});

	it("子流程入口节点：标题是子流程名称，头部是种类名", () => {
		expect(nodeCardText(node({ kind: "subflow_entry", id: "mon", name: "监控" }), lookup)).toEqual({
			title: "监控",
			caption: "子流程入口",
		});
	});

	it("子流程入口节点没有名称时：旧版本显示节点 ID，填了空名称显示「未命名子流程」", () => {
		expect(nodeCardText(node({ kind: "subflow_entry", id: "legacy" }), lookup)).toEqual({
			title: "legacy",
			caption: "子流程入口",
		});
		expect(nodeCardText(node({ kind: "subflow_entry", id: "blank", name: " " }), lookup)).toEqual({
			title: "未命名子流程",
			caption: "子流程入口",
		});
	});

	it("名称里已经有种类名时头部不重复", () => {
		const named = node({ kind: "subflow_entry", id: "mon", name: "子流程入口备份" });
		expect(nodeCardText(named, lookup).caption).toBeUndefined();
	});

	it("飞书通知节点、异步任务节点、入口节点：标题就是种类名，头部不重复", () => {
		expect(nodeCardText(node({ kind: "feishu_notify" }), lookup)).toEqual({
			title: "飞书通知",
			caption: undefined,
		});
		expect(nodeCardText(node({ kind: "async" }), lookup)).toEqual({
			title: "异步任务",
			caption: undefined,
		});
		expect(nodeCardText(node({ kind: "entry" }), lookup)).toEqual({
			title: "入口",
			caption: undefined,
		});
	});

	it("不给查找时子流程入口以外都照常显示；停止子流程节点的目标按节点 ID 写", () => {
		expect(nodeCardText(node({ kind: "sleep", duration: "5m" }), {}).title).toBe("等待 5m");
		expect(nodeCardText(node({ kind: "stop_subflow", subflow: "mon" }), {}).title).toBe(
			"停止「mon」",
		);
	});
});

describe("卡片以外的写法", () => {
	it("包节点写 `包名/节点类型名`，不查节点类型的标题", () => {
		const shell = node({ kind: "package", package: "std", node: "shell" });
		expect(nodeOutsideCardText(shell, lookup)).toBe("std/shell");
	});

	it("停止子流程节点写出要停止的子流程名称；没有选择或目标不在场景里时只写种类名", () => {
		expect(nodeOutsideCardText(node({ kind: "stop_subflow", subflow: "mon" }), lookup)).toBe(
			"停止子流程「监控」",
		);
		expect(nodeOutsideCardText(node({ kind: "stop_subflow" }), lookup)).toBe("停止子流程");
		expect(nodeOutsideCardText(node({ kind: "stop_subflow", subflow: "removed" }), lookup)).toBe(
			"停止子流程",
		);
		expect(nodeOutsideCardText(node({ kind: "stop_subflow", subflow: "sleep_1" }), lookup)).toBe(
			"停止子流程",
		);
	});

	it("其余节点写种类名，不写等待时长、时间点和子流程名称", () => {
		expect(nodeOutsideCardText(node({ kind: "sleep", duration: "30s" }), lookup)).toBe("Sleep");
		expect(nodeOutsideCardText(node({ kind: "timer", at: "09:30:00" }), lookup)).toBe("定时");
		expect(
			nodeOutsideCardText(node({ kind: "subflow_entry", id: "mon", name: "监控" }), lookup),
		).toBe("子流程入口");
		expect(nodeOutsideCardText(node({ kind: "feishu_notify" }), lookup)).toBe("飞书通知");
		expect(nodeOutsideCardText(node({ kind: "async" }), lookup)).toBe("异步任务");
		expect(nodeOutsideCardText(node({ kind: "entry" }), lookup)).toBe("入口");
	});

	it("场景里已经没有这个节点、只知道种类时写种类名", () => {
		expect(nodeOutsideCardText({ kind: "package" }, lookup)).toBe("包节点");
		expect(nodeOutsideCardText({ kind: "stop_subflow" }, lookup)).toBe("停止子流程");
		expect(nodeOutsideCardText({ kind: "sleep" }, lookup)).toBe("Sleep");
	});
});

describe("子流程名称的查找", () => {
	it("按子流程入口节点 ID 查名称；其他节点和不存在的 ID 查不到", () => {
		const labelOf = subflowLabels(doc);
		expect(labelOf("mon")).toBe("监控");
		expect(labelOf("legacy")).toBe("legacy");
		expect(labelOf("blank")).toBe("未命名子流程");
		expect(labelOf("entry")).toBeUndefined();
		expect(labelOf("missing")).toBeUndefined();
	});
});
