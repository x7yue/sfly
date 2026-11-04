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
});
