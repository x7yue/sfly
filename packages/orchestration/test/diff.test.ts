// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
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
			stickyNotes: { added: [], removed: [], changed: [], moved: [] },
		});
	});

	it("列出新增、删除的节点和连线", () => {
		const after = {
			...base,
			nodes: [
				base.nodes[0],
				base.nodes[1],
				{ id: "sleep_1", kind: "sleep", always: false, duration: "30s" },
			],
			edges: [
				{ from: "entry", to: "check", kind: "chain" },
				{ from: "check", to: "sleep_1", kind: "chain" },
			],
			packages: { http: "1.0.0" },
		};
		expect(diffDocuments(base, after)).toEqual({
			settings: [{ path: "packages.im", before: "0.3.0", after: undefined }],
			nodes: {
				added: [{ id: "sleep_1", kind: "sleep" }],
				removed: [{ id: "notify", kind: "package" }],
				changed: [],
			},
			edges: {
				added: [{ from: "check", to: "sleep_1", kind: "chain" }],
				removed: [{ from: "check", to: "notify", kind: "chain" }],
			},
			moved: [],
			annotations: { added: [], removed: [], changed: [] },
			stickyNotes: { added: [], removed: [], changed: [], moved: [] },
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
			stickyNotes: { added: [], removed: [], changed: [], moved: [] },
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

	it("便签：新增、删除、改了标题 / 正文 / 颜色各自列出；只挪了位置、改了大小算布局；不写颜色和写 yellow 都是黄色", () => {
		const withNotes = (...sticky_notes: ({ id: string } & Record<string, unknown>)[]) => ({
			...base,
			sticky_notes,
		});
		const before = withNotes(
			{ id: "s1", title: "跑之前", text: "- 一\n- 二", position: { x: 0, y: -200 } },
			{ id: "s2", text: "已知问题", position: { x: 300, y: -200 } },
		);
		const after = withNotes(
			{
				id: "s1",
				title: "跑之前确认",
				text: "- 一\n- 二",
				color: "blue",
				position: { x: 0, y: -200 },
			},
			{ id: "s3", text: "待办：补监控\n第二行", position: { x: 600, y: -200 } },
		);
		const diff = diffDocuments(before, after);
		expect(diff.stickyNotes.added).toEqual([{ id: "s3", label: "待办：补监控" }]);
		expect(diff.stickyNotes.removed).toEqual([{ id: "s2", label: "已知问题" }]);
		expect(diff.stickyNotes.changed).toEqual([
			{
				id: "s1",
				label: "跑之前确认",
				changes: [
					{ path: "title", before: "跑之前", after: "跑之前确认" },
					{ path: "color", before: undefined, after: "blue" },
				],
			},
		]);
		expect(diff.stickyNotes.moved).toEqual([]);

		const moved = diffDocuments(
			before,
			withNotes(
				{ id: "s1", title: "跑之前", text: "- 一\n- 二", position: { x: 40, y: -200 } },
				{
					id: "s2",
					text: "已知问题",
					position: { x: 300, y: -200 },
					size: { width: 300, height: 200 },
				},
			),
		);
		expect(moved.stickyNotes.changed).toEqual([]);
		expect(moved.stickyNotes.moved).toEqual(["s1", "s2"]);
		expect(isEmptyDiff(moved)).toBe(false);
		expect(isEmptyDiff(moved, { ignoreLayout: true })).toBe(true);

		const yellow = (color?: string) =>
			withNotes({ id: "s1", text: "x", ...(color ? { color } : {}) });
		expect(isEmptyDiff(diffDocuments(yellow(), yellow("yellow")))).toBe(true);
		expect(isEmptyDiff(diffDocuments(base, withNotes()))).toBe(true);
	});
});
