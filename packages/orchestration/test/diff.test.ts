import { describe, expect, it } from "vitest";
import { diffDocuments, isEmptyDiff } from "../src/index.js";

const base = {
	default_agent: "agent-a",
	nodes: [
		{
			id: "entry",
			kind: "entry",
			params: [{ name: "url", type: "string", required: true, secret: false }],
			position: { x: 0, y: 0 },
		},
		{
			id: "check",
			kind: "package",
			package: "http",
			node: "check",
			always: false,
			inputs: { url: "${{ params.url }}", retries: 1 },
			position: { x: 280, y: 0 },
		},
		{
			id: "notify",
			kind: "package",
			package: "im",
			node: "send",
			always: false,
			inputs: {},
			position: { x: 560, y: 0 },
		},
	],
	edges: [
		{ from: "entry", to: "check", kind: "chain" },
		{ from: "check", to: "notify", kind: "chain" },
	],
	packages: { http: "1.0.0", im: "0.3.0" },
} as const;

describe("编排文档差异", () => {
	it("相同内容没有差异", () => {
		const diff = diffDocuments(base, JSON.parse(JSON.stringify(base)));
		expect(isEmptyDiff(diff)).toBe(true);
		expect(diff).toEqual({
			settings: [],
			nodes: { added: [], removed: [], changed: [] },
			edges: { added: [], removed: [] },
			moved: [],
			annotations: { added: [], removed: [], changed: [] },
		});
	});

	it("列出新增、删除的节点和连线", () => {
		const after = {
			...base,
			nodes: [base.nodes[0], base.nodes[1], { id: "stop_1", kind: "stop_subflow", always: false }],
			edges: [
				{ from: "entry", to: "check", kind: "chain" },
				{ from: "check", to: "stop_1", kind: "chain" },
			],
			packages: { http: "1.0.0" },
		};
		expect(diffDocuments(base, after)).toEqual({
			settings: [{ path: "packages.im", before: "0.3.0", after: undefined }],
			nodes: {
				added: [{ id: "stop_1", kind: "stop_subflow" }],
				removed: [{ id: "notify", kind: "package" }],
				changed: [],
			},
			edges: {
				added: [{ from: "check", to: "stop_1", kind: "chain" }],
				removed: [{ from: "check", to: "notify", kind: "chain" }],
			},
			moved: [],
			annotations: { added: [], removed: [], changed: [] },
		});
	});

	it("逐项列出节点参数、入口参数、Agent 与编排设置的变化", () => {
		const after = {
			...base,
			default_agent: "agent-b",
			nodes: [
				{
					...base.nodes[0],
					params: [
						{ name: "url", type: "string", required: false, secret: false },
						{ name: "token", type: "string", required: true, secret: true },
					],
				},
				{
					...base.nodes[1],
					agent: "agent-c",
					inputs: { url: "http://example.test", timeout_s: 5 },
				},
				base.nodes[2],
			],
			packages: { http: "1.1.0", im: "0.3.0" },
		};
		expect(diffDocuments(base, after)).toEqual({
			settings: [
				{ path: "default_agent", before: "agent-a", after: "agent-b" },
				{ path: "packages.http", before: "1.0.0", after: "1.1.0" },
			],
			nodes: {
				added: [],
				removed: [],
				changed: [
					{
						id: "entry",
						kind: "entry",
						changes: [
							{
								path: "params.url",
								before: { name: "url", type: "string", required: true, secret: false },
								after: { name: "url", type: "string", required: false, secret: false },
							},
							{
								path: "params.token",
								before: undefined,
								after: { name: "token", type: "string", required: true, secret: true },
							},
						],
					},
					{
						id: "check",
						kind: "package",
						changes: [
							{ path: "inputs.url", before: "${{ params.url }}", after: "http://example.test" },
							{ path: "inputs.retries", before: 1, after: undefined },
							{ path: "inputs.timeout_s", before: undefined, after: 5 },
							{ path: "agent", before: undefined, after: "agent-c" },
						],
					},
				],
			},
			edges: { added: [], removed: [] },
			moved: [],
			annotations: { added: [], removed: [], changed: [] },
		});
	});

	it("只移动了节点时差异只有布局", () => {
		const after = {
			...base,
			nodes: [base.nodes[0], { ...base.nodes[1], position: { x: 300, y: 40 } }, base.nodes[2]],
		};
		const diff = diffDocuments(base, after);
		expect(diff.moved).toEqual(["check"]);
		expect(isEmptyDiff(diff)).toBe(false);
		expect(isEmptyDiff(diff, { ignoreLayout: true })).toBe(true);
	});

	it("省略的字段按默认值比较", () => {
		const sparse = {
			default_agent: "agent-a",
			nodes: [
				{
					id: "entry",
					kind: "entry",
					params: [{ name: "url", type: "string", required: true }],
					position: { x: 0, y: 0 },
				},
				{
					id: "check",
					kind: "package",
					package: "http",
					node: "check",
					inputs: { url: "${{ params.url }}", retries: 1 },
					position: { x: 280, y: 0 },
				},
				{
					id: "notify",
					kind: "package",
					package: "im",
					node: "send",
					position: { x: 560, y: 0 },
				},
			],
			edges: base.edges,
			packages: base.packages,
		};
		expect(isEmptyDiff(diffDocuments(base, sparse))).toBe(true);
	});

	it("子流程名称的变化；没有名称字段的旧版本以节点 ID 作为名称比较", () => {
		const withSubflow = (name?: string) => ({
			...base,
			nodes: [
				...base.nodes,
				{ id: "spawn", kind: "async", params: {} },
				name === undefined
					? { id: "sub", kind: "subflow_entry", params: [] }
					: { id: "sub", kind: "subflow_entry", name, params: [] },
			],
		});
		expect(diffDocuments(withSubflow("监控"), withSubflow("压测监控")).nodes.changed).toEqual([
			{
				id: "sub",
				kind: "subflow_entry",
				changes: [{ path: "name", before: "监控", after: "压测监控" }],
			},
		]);
		expect(diffDocuments(withSubflow(), withSubflow("监控")).nodes.changed).toEqual([
			{
				id: "sub",
				kind: "subflow_entry",
				changes: [{ path: "name", before: "sub", after: "监控" }],
			},
		]);
		expect(isEmptyDiff(diffDocuments(withSubflow(), withSubflow("sub")))).toBe(true);
	});
	it("只改显示名称也算有修改：列出前后的名称；去掉首尾空白后相同的写法不算", () => {
		const named = (display_name?: string) => ({
			...base,
			nodes: base.nodes.map((n) => (n.id === "check" ? { ...n, display_name } : n)),
		});
		const diff = diffDocuments(named("创建测试用户"), named("查询测试用户"));
		expect(isEmptyDiff(diff)).toBe(false);
		expect(isEmptyDiff(diff, { ignoreLayout: true })).toBe(false);
		expect(diff.nodes.changed).toEqual([
			{
				id: "check",
				kind: "package",
				changes: [{ path: "display_name", before: "创建测试用户", after: "查询测试用户" }],
			},
		]);
		expect(diff.moved).toEqual([]);
		expect(diffDocuments(named(), named("创建测试用户")).nodes.changed[0]?.changes).toEqual([
			{ path: "display_name", before: undefined, after: "创建测试用户" },
		]);
		expect(isEmptyDiff(diffDocuments(named("创建测试用户"), named(" 创建测试用户 ")))).toBe(true);
		expect(isEmptyDiff(diffDocuments(named(), named("   ")))).toBe(true);
	});

	it("改注释框的颜色也算有修改；不写颜色和写 gray 都是灰色，不算修改", () => {
		const colored = (color?: string) => ({
			...base,
			annotations: [{ id: "a1", title: "检查", nodes: ["check"], ...(color ? { color } : {}) }],
		});
		expect(diffDocuments(colored(), colored("blue")).annotations.changed).toEqual([
			{ id: "a1", title: "检查", changes: [{ path: "color", before: undefined, after: "blue" }] },
		]);
		expect(diffDocuments(colored("blue"), colored("pink")).annotations.changed[0]?.changes).toEqual(
			[{ path: "color", before: "blue", after: "pink" }],
		);
		expect(isEmptyDiff(diffDocuments(colored(), colored("gray")))).toBe(true);
		expect(isEmptyDiff(diffDocuments(colored("gray"), colored()))).toBe(true);
	});

	it("升级前保存的文档带着已移除的顶层字段 sticky_notes（ADR 0028）：不参与比较，只差它的两份文档没有差异", () => {
		const withNotes = (...sticky_notes: ({ id: string } & Record<string, unknown>)[]) => ({
			...base,
			sticky_notes,
		});
		const before = withNotes({
			id: "s1",
			title: "跑之前",
			text: "- 一\n- 二",
			position: { x: 0, y: -200 },
		});
		const after = withNotes({ id: "s2", text: "已知问题", color: "blue" });
		const diff = diffDocuments(before, after);
		expect(diff).not.toHaveProperty("stickyNotes");
		expect(isEmptyDiff(diff)).toBe(true);
		expect(isEmptyDiff(diffDocuments(before, base))).toBe(true);
		// 别的差别照常列出来。
		const renamed = { ...after, default_agent: "agent-b" };
		expect(diffDocuments(before, renamed).settings).toEqual([
			{ path: "default_agent", before: "agent-a", after: "agent-b" },
		]);
	});

	it("已移除种类的节点（ADR 0028）：配置的差别照常列出来，只差它们的配置也不是空差异", () => {
		const withRemoved = (text: string) => ({
			...base,
			nodes: [
				...base.nodes,
				{
					id: "bot",
					kind: "feishu_notify",
					display_name: "通知群",
					bot: "ops",
					text,
					position: { x: 840, y: 0 },
				},
			],
			edges: [...base.edges, { from: "notify", to: "bot", kind: "chain" }],
		});
		const diff = diffDocuments(withRemoved("压测开始"), withRemoved("压测结束"));
		expect(diff.nodes.added).toEqual([]);
		expect(diff.nodes.removed).toEqual([]);
		expect(diff.nodes.changed).toEqual([
			{
				id: "bot",
				kind: "feishu_notify",
				changes: [{ path: "text", before: "压测开始", after: "压测结束" }],
			},
		]);
		expect(isEmptyDiff(diff)).toBe(false);
		expect(isEmptyDiff(diffDocuments(withRemoved("压测开始"), withRemoved("压测开始")))).toBe(true);
	});
});
