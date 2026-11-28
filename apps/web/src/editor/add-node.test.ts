import type { AgentView, PackageSummary } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	type AddItem,
	availableBuiltins,
	BUILTIN_ITEMS,
	builtinValue,
	itemValue,
	MAX_RECENT,
	newDocNode,
	newSubflowNameProblem,
	type PackageGroup,
	type PackageItem,
	packageGroups,
	packageValue,
	pushRecent,
	recentItems,
	withRunStateInputs,
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

describe("添加节点菜单的内置节点", () => {
	it.each(["feishu_notify", "timer", "sleep"])("已移除的节点种类 %s 不再出现在菜单里", (kind) => {
		expect(BUILTIN_ITEMS.map((item) => item.kind)).not.toContain(kind);
	});
});

describe("添加节点菜单的分组与「最近使用」", () => {
	const pkg = (name: string, version: string, nodes: string[]): PackageSummary => ({
		name,
		latest_version: version,
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
		expect(pushRecent(["builtin:async", "builtin:stop_subflow"], "builtin:stop_subflow")).toEqual([
			"builtin:stop_subflow",
			"builtin:async",
		]);
		const many = ["a", "b", "c", "d", "e"].reduce<string[]>((list, v) => pushRecent(list, v), []);
		expect(many).toEqual(["e", "d", "c", "b", "a"]);
		expect(pushRecent(many, "f")).toHaveLength(MAX_RECENT);
		expect(pushRecent(many, "f")).toEqual(["f", "e", "d", "c", "b"]);
	});

	it("身份只记内置种类或包名与节点名，不记版本", () => {
		expect(itemValue({ kind: "stop_subflow" })).toBe("builtin:stop_subflow");
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
			builtinValue("stop_subflow"),
			packageValue({ package: "gone", node: "x" }),
			packageValue({ package: "demo-checks", node: "removed_in_this_version" }),
		];
		const items = recentItems(recent, availableBuiltins(false), groups);
		expect(items.map((i) => i.value)).toEqual(["package:demo-checks/ping", "builtin:stop_subflow"]);
		expect(items[0]?.entry).toMatchObject({
			kind: "package",
			package: "demo-checks",
			node: "ping",
		});
		expect(items[1]?.entry.kind).toBe("stop_subflow");
	});

	it("最近使用里存着已移除节点（定时、Sleep、飞书通知）的旧项时丢掉，不报错", () => {
		const recent = ["builtin:timer", "builtin:async", "builtin:sleep", "builtin:feishu_notify"];
		expect(recentItems(recent, availableBuiltins(false), []).map((i) => i.value)).toEqual([
			"builtin:async",
		]);
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

describe("新建包节点时预填「运行状态」类型的输入", () => {
	const item = (extra: Partial<PackageItem> = {}): AddItem => ({
		kind: "package",
		package: "demo",
		version: "1.0.0",
		node: "summarize",
		title: "汇总",
		...extra,
	});

	it("节点类型里有「运行状态」类型的输入：新节点把它预填成 ${{ run.state }}", () => {
		expect(newDocNode(item({ runStateInputs: ["run"] }), "summarize_1")).toEqual({
			id: "summarize_1",
			kind: "package",
			package: "demo",
			node: "summarize",
			always: false,
			inputs: { run: "${{ run.state }}" },
		});
	});

	it("有几个这样的输入就预填几个，别的输入不动", () => {
		const node = newDocNode(item({ runStateInputs: ["before", "after"] }), "summarize_1");
		expect(node).toMatchObject({
			inputs: { before: "${{ run.state }}", after: "${{ run.state }}" },
		});
	});

	it("没有这样的输入（没带，或是空的）：和以前一样，inputs 是空对象", () => {
		expect(newDocNode(item(), "summarize_1")).toMatchObject({ inputs: {} });
		expect(newDocNode(item({ runStateInputs: [] }), "summarize_1")).toMatchObject({ inputs: {} });
	});
});

describe("添加节点菜单里节点类型的「运行状态」类型的输入", () => {
	const marked = { type: "object", "x-sfly-type": "run_state" };
	const io = (properties: Record<string, Record<string, unknown>>) => ({
		type: "object" as const,
		properties,
		order: Object.keys(properties),
		required: [],
	});
	const dev = (nodes: unknown[]): AgentView =>
		({
			name: "dev-agent",
			status: "online",
			dev_packages: [{ name: "demo", source: "/src/demo", metadata: { nodes } }],
		}) as unknown as AgentView;

	it("dev 版本：取 Agent 上报的元信息，必填的、可选的（RunState | None）都算", () => {
		const groups = packageGroups(
			[],
			[
				dev([
					{
						name: "summarize",
						inputs: io({ run: marked, title: { type: "string" } }),
						outputs: io({}),
					},
					{
						name: "maybe",
						inputs: io({ run: { anyOf: [marked, { type: "null" }], default: null } }),
						outputs: io({}),
					},
					{ name: "plain", inputs: io({ n: { type: "integer" } }), outputs: io({}) },
				]),
			],
			{},
		);
		const items = groups.flatMap((g) => g.items);
		expect(items.map((i) => [i.node, i.runStateInputs])).toEqual([
			["summarize", ["run"]],
			["maybe", ["run"]],
			["plain", []],
		]);
		const [first] = items;
		expect(newDocNode(first as PackageItem, "summarize_1")).toMatchObject({
			inputs: { run: "${{ run.state }}" },
		});
	});

	it("已发布版本的菜单摘要里没有输入 schema：选中时到版本的元信息里取", async () => {
		const published: PackageItem = {
			kind: "package",
			package: "demo",
			version: "1.0.0",
			node: "summarize",
			title: "汇总",
		};
		const calls: string[] = [];
		const load = async (it: PackageItem) => {
			calls.push(`${it.package}@${it.version}/${it.node}`);
			return io({ run: marked, n: { type: "integer" } });
		};
		const resolved = await withRunStateInputs(published, load);
		expect(calls).toEqual(["demo@1.0.0/summarize"]);
		expect(resolved).toMatchObject({ kind: "package", runStateInputs: ["run"] });
		expect(newDocNode(resolved as PackageItem, "summarize_1")).toMatchObject({
			inputs: { run: "${{ run.state }}" },
		});
	});

	it("没有这样的输入、读不到元信息、读取失败：节点照常添加，inputs 为空", async () => {
		const published: PackageItem = {
			kind: "package",
			package: "demo",
			version: "1.0.0",
			node: "plain",
			title: "p",
		};
		const none = await withRunStateInputs(published, async () => io({ n: { type: "integer" } }));
		expect(none).toMatchObject({ runStateInputs: [] });
		const missing = await withRunStateInputs(published, async () => undefined);
		expect(missing).toEqual(published);
		const failed = await withRunStateInputs(published, async () => {
			throw new Error("network");
		});
		expect(failed).toEqual(published);
		expect(newDocNode(failed as PackageItem, "plain_1")).toMatchObject({ inputs: {} });
	});

	it("已经知道的（dev 版本）不再去读；内置节点原样返回", async () => {
		const known: PackageItem = {
			kind: "package",
			package: "demo",
			version: "dev",
			node: "summarize",
			title: "汇总",
			runStateInputs: ["run"],
		};
		const load = async () => {
			throw new Error("不该被调用");
		};
		expect(await withRunStateInputs(known, load)).toBe(known);
		const stop: AddItem = { kind: "stop_subflow" };
		expect(await withRunStateInputs(stop, load)).toBe(stop);
	});
});
