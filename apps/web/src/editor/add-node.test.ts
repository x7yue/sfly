import type { PackageSummary } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	availableBuiltins,
	BUILTIN_ITEMS,
	builtinValue,
	itemValue,
	MAX_RECENT,
	newDocNode,
	newSubflowNameProblem,
	type PackageGroup,
	packageGroups,
	packageValue,
	pushRecent,
	recentItems,
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

describe("添加节点菜单的分组与「最近使用」", () => {
	const pkg = (name: string, version: string, nodes: string[]): PackageSummary => ({
		name,
		versions: [
			{
				version,
				sha256: "0".repeat(64),
				size: 1,
				published_at: "2026-01-01T00:00:00.000Z",
				nodes: nodes.map((n) => ({ name: n, title: n })),
				locked_orchestrations: 0,
			},
		],
	});
	const packages = [
		pkg("alpha-tools", "0.1.0", ["scan"]),
		pkg("demo-checks", "1.2.0", ["ping", "http_check"]),
		pkg("zeta", "2.0.0", ["probe"]),
	];

	it("本场景已锁定的包排在前面，其余保持原顺序", () => {
		const names = (locked: Record<string, string>) =>
			packageGroups(packages, [], locked).map((g) => g.name);
		expect(names({})).toEqual(["alpha-tools", "demo-checks", "zeta"]);
		expect(names({ zeta: "2.0.0" })).toEqual(["zeta", "alpha-tools", "demo-checks"]);
		expect(names({ zeta: "2.0.0", "demo-checks": "1.2.0" })).toEqual([
			"demo-checks",
			"zeta",
			"alpha-tools",
		]);
	});

	it("最近使用：新的在最前，重复的移到最前不重复出现，最多保留 5 项", () => {
		expect(pushRecent(["builtin:sleep", "builtin:timer"], "builtin:timer")).toEqual([
			"builtin:timer",
			"builtin:sleep",
		]);
		const many = ["a", "b", "c", "d", "e"].reduce<string[]>((list, v) => pushRecent(list, v), []);
		expect(many).toEqual(["e", "d", "c", "b", "a"]);
		expect(pushRecent(many, "f")).toHaveLength(MAX_RECENT);
		expect(pushRecent(many, "f")).toEqual(["f", "e", "d", "c", "b"]);
	});

	it("身份只记内置种类或包名与节点名，不记版本", () => {
		expect(itemValue({ kind: "sleep" })).toBe("builtin:sleep");
		expect(
			itemValue({
				kind: "package",
				package: "demo-checks",
				version: "1.2.0",
				node: "ping",
				title: "p",
			}),
		).toBe("package:demo-checks/ping");
	});

	it("最近使用按当前可以添加的节点解析：包下架、版本里没有这个节点的项丢掉", () => {
		const groups: PackageGroup[] = packageGroups(packages, [], {});
		const recent = [
			packageValue({ package: "demo-checks", node: "ping" }),
			builtinValue("sleep"),
			packageValue({ package: "gone", node: "x" }),
			packageValue({ package: "demo-checks", node: "removed_in_this_version" }),
		];
		const items = recentItems(recent, availableBuiltins(false), groups);
		expect(items.map((i) => i.value)).toEqual(["package:demo-checks/ping", "builtin:sleep"]);
		expect(items[0]?.entry).toMatchObject({
			kind: "package",
			package: "demo-checks",
			node: "ping",
		});
		expect(items[1]?.entry.kind).toBe("sleep");
	});

	it("有来源节点时不列子流程入口，最近使用里的子流程入口也随之丢掉", () => {
		expect(availableBuiltins(false).map((b) => b.kind)).toContain("subflow_entry");
		expect(availableBuiltins(true).map((b) => b.kind)).not.toContain("subflow_entry");
		const recent = [builtinValue("subflow_entry"), builtinValue("async")];
		expect(recentItems(recent, availableBuiltins(false), []).map((i) => i.value)).toEqual(recent);
		expect(recentItems(recent, availableBuiltins(true), []).map((i) => i.value)).toEqual([
			"builtin:async",
		]);
	});
});
