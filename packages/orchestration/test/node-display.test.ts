import type { OrchestrationNode } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	type NodeDisplayLookup,
	nameWithId,
	nodeCardText,
	nodeNameWithId,
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

describe("有显示名称时卡片上的写法", () => {
	it("标题是显示名称，原来的标题挪到头部种类名的位置，包括不重复种类名的情况", () => {
		const named = (n: Record<string, unknown> & { kind: OrchestrationNode["kind"] }) =>
			nodeCardText(node({ display_name: "创建测试用户", ...n }), lookup);
		expect(named({ kind: "package", package: "std", node: "shell" })).toEqual({
			title: "创建测试用户",
			caption: "Shell 命令",
		});
		expect(named({ kind: "package", package: "std", node: "gone" })).toEqual({
			title: "创建测试用户",
			caption: "gone",
		});
		expect(named({ kind: "sleep", duration: "30s" })).toEqual({
			title: "创建测试用户",
			caption: "等待 30s",
		});
		expect(named({ kind: "timer", at: "09:30:00" })).toEqual({
			title: "创建测试用户",
			caption: "等到 09:30:00",
		});
		expect(named({ kind: "stop_subflow", subflow: "mon" })).toEqual({
			title: "创建测试用户",
			caption: "停止「监控」",
		});
		expect(named({ kind: "stop_subflow" })).toEqual({
			title: "创建测试用户",
			caption: "停止子流程",
		});
		expect(named({ kind: "feishu_notify" })).toEqual({
			title: "创建测试用户",
			caption: "飞书通知",
		});
		expect(named({ kind: "async" })).toEqual({ title: "创建测试用户", caption: "异步任务" });
		expect(named({ kind: "entry" })).toEqual({ title: "创建测试用户", caption: "入口" });
	});

	it("显示名称里的空白不算：只有空白当作没写，首尾空白不显示", () => {
		const shell = { kind: "package", package: "std", node: "shell" } as const;
		expect(nodeCardText(node({ ...shell, display_name: "   " }), lookup)).toEqual({
			title: "Shell 命令",
			caption: undefined,
		});
		expect(nodeCardText(node({ ...shell, display_name: " 建数据 " }), lookup).title).toBe("建数据");
	});

	it("子流程入口节点没有显示名称，标题仍然是子流程名称", () => {
		expect(nodeCardText(node({ kind: "subflow_entry", id: "mon", name: "监控" }), lookup)).toEqual({
			title: "监控",
			caption: "子流程入口",
		});
	});
});

describe("「显示名称（节点 ID）」：卡片以外写节点的名字", () => {
	it("有显示名称时写显示名称，节点 ID 放在括号里；没有时只写节点 ID", () => {
		expect(nameWithId("http_request_1", "创建测试用户")).toBe("创建测试用户（http_request_1）");
		expect(nameWithId("http_request_1", undefined)).toBe("http_request_1");
		expect(nameWithId("http_request_1", "")).toBe("http_request_1");
		expect(nameWithId("http_request_1", "  ")).toBe("http_request_1");
	});

	it("显示名称和节点 ID 一样时不重复", () => {
		expect(nameWithId("legacy", "legacy")).toBe("legacy");
	});

	it("节点：读它的显示名称", () => {
		const shell = { kind: "package", package: "std", node: "shell" } as const;
		expect(nodeNameWithId(node({ ...shell, id: "shell_1", display_name: " 建数据 " }))).toBe(
			"建数据（shell_1）",
		);
		expect(nodeNameWithId(node({ ...shell, id: "shell_1" }))).toBe("shell_1");
	});

	it("子流程入口节点用子流程名称；没有名称字段的旧版本只写节点 ID，填了空名称写「未命名子流程」", () => {
		expect(nodeNameWithId(node({ kind: "subflow_entry", id: "mon", name: "监控" }))).toBe(
			"监控（mon）",
		);
		expect(nodeNameWithId(node({ kind: "subflow_entry", id: "legacy" }))).toBe("legacy");
		expect(nodeNameWithId(node({ kind: "subflow_entry", id: "blank", name: " " }))).toBe(
			"未命名子流程（blank）",
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
