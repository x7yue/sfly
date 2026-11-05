import type { OrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { documentFieldErrors } from "./validation";

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
			},
			{ nodeId: "entry", field: "params.2.name", message: "参数名 url 重复" },
		]);
	});

	it("不符合编排文档格式的配置（例如空的 Sleep 时长）是字段错误", () => {
		const doc: OrchestrationDocument = {
			...base,
			nodes: [
				base.nodes[0] as OrchestrationDocument["nodes"][number],
				{ id: "wait", kind: "sleep", always: false, duration: "" },
			],
		};
		expect(documentFieldErrors(doc)).toEqual([
			{ nodeId: "wait", field: "duration", message: "不能为空" },
		]);
	});
});
