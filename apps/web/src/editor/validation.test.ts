import { type PackageCatalog, packageKey } from "@sfly/orchestration";
import type { OrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { checkSummary, documentFieldErrors, undeclaredInputNotes } from "./validation";

const base: OrchestrationDocument = {
	nodes: [
		{
			id: "entry",
			kind: "entry",
			params: [{ name: "url", type: "string", required: true, secret: false }],
		},
		{ id: "wait", kind: "sleep", always: false, duration: "5s" },
	],
	edges: [{ from: "entry", to: "wait", kind: "chain" }],
	packages: {},
};

describe("保存前的字段校验", () => {
	it("合法的文档没有字段错误；静态检查的警告（例如缺少 Agent）不算字段错误", () => {
		expect(documentFieldErrors(base)).toEqual([]);
	});

	it("参数名不合法或重复时指出所在节点和字段", () => {
		const doc: OrchestrationDocument = {
			...base,
			nodes: [
				{
					id: "entry",
					kind: "entry",
					params: [
						{ name: "1st", type: "string", required: false, secret: false },
						{ name: "url", type: "string", required: false, secret: false },
						{ name: "url", type: "number", required: false, secret: false },
					],
				},
				base.nodes[1] as OrchestrationDocument["nodes"][number],
			],
		};
		expect(documentFieldErrors(doc)).toEqual([
			{
				nodeId: "entry",
				field: "params.0.name",
				message: "参数名只能包含字母、数字和下划线，不能以数字开头",
				typed: true,
			},
			{ nodeId: "entry", field: "params.2.name", message: "参数名 url 重复", typed: true },
		]);
	});

	it("不符合场景文档格式的配置（例如空的 Sleep 时长）是字段错误", () => {
		const doc: OrchestrationDocument = {
			...base,
			nodes: [
				base.nodes[0] as OrchestrationDocument["nodes"][number],
				{ id: "wait", kind: "sleep", always: false, duration: "" },
			],
		};
		expect(documentFieldErrors(doc)).toEqual([
			{ nodeId: "wait", field: "duration", message: "不能为空", typed: true },
		]);
	});

	it("别的字段的错误不是边输入边改的文本框：不等字段交互过，一出现就显示", () => {
		const doc: OrchestrationDocument = {
			...base,
			default_agent: "",
		};
		expect(documentFieldErrors(doc)).toEqual([
			{ nodeId: undefined, field: "default_agent", message: "不能为空", typed: false },
		]);
	});
});

describe("提醒：节点类型没有声明的输入", () => {
	const doc: OrchestrationDocument = {
		...base,
		nodes: [
			...base.nodes,
			{
				id: "fetch",
				kind: "package",
				always: false,
				package: "demo",
				node: "http_check",
				inputs: { url: "x", token: "t" },
			},
		],
		packages: { demo: "1.0.0" },
	};
	const type = {
		name: "http_check",
		inputs: { type: "object", properties: { url: { type: "string" } } },
		outputs: { type: "object", properties: {} },
	};

	it("节点类型加载后列出没有声明的输入；还没加载时不算", () => {
		const loaded = new Map([[packageKey("demo", "1.0.0"), [type]]]) as unknown as PackageCatalog;
		expect(undeclaredInputNotes(doc, loaded)).toEqual([
			{ node_id: "fetch", input: "token", message: "fetch 的输入 token 没有在节点类型中声明" },
		]);
		expect(undeclaredInputNotes(doc, new Map())).toEqual([]);
	});

	it("检查结果：字段错误最先，其次警告，没有警告时带上提醒条数", () => {
		expect(checkSummary(0, 2, 1)).toEqual({ kind: "warn", label: "2 条警告" });
		expect(checkSummary(0, 0, 1)).toEqual({ kind: "ok", label: "检查通过 · 1 条提醒" });
		expect(checkSummary(0, 0, 0)).toEqual({ kind: "ok", label: "检查通过" });
		expect(checkSummary(1, 2, 1)).toEqual({ kind: "failed", label: "1 处字段错误" });
	});
});
