import type { StoredOrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { checkSummary, documentFieldErrors, warningsSummary } from "./validation";

const base: StoredOrchestrationDocument = {
	nodes: [
		{
			id: "entry",
			kind: "entry",
			params: [{ name: "url", type: "string", required: true, secret: false }],
		},
		{ id: "stop", kind: "stop_subflow", always: false },
	],
	edges: [{ from: "entry", to: "stop", kind: "chain" }],
	packages: {},
	annotations: [],
};

describe("保存前的字段校验", () => {
	it("合法的文档没有字段错误；静态检查的警告（例如缺少 Agent）不算字段错误", () => {
		expect(documentFieldErrors(base)).toEqual([]);
	});

	it("显示名称超过 40 个字符或带换行时指出所在节点和字段；空白的显示名称不算错", () => {
		const withName = (display_name: string): StoredOrchestrationDocument => ({
			...base,
			nodes: base.nodes.map((n) => (n.id === "stop" ? { ...n, display_name } : n)),
		});
		expect(documentFieldErrors(withName("😀".repeat(40)))).toEqual([]);
		expect(documentFieldErrors(withName("   "))).toEqual([]);
		expect(documentFieldErrors(withName("😀".repeat(41)))).toEqual([
			{ nodeId: "stop", field: "display_name", message: "最多 40 个字符", typed: false },
		]);
		expect(documentFieldErrors(withName("第一行\n第二行"))).toEqual([
			{ nodeId: "stop", field: "display_name", message: "只能写一行", typed: false },
		]);
	});

	it("参数名不合法或重复时指出所在节点和字段", () => {
		const doc: StoredOrchestrationDocument = {
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
				base.nodes[1] as StoredOrchestrationDocument["nodes"][number],
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

	it("不符合场景文档格式的配置（例如空的要停止的子流程）是字段错误", () => {
		const doc: StoredOrchestrationDocument = {
			...base,
			nodes: [
				base.nodes[0] as StoredOrchestrationDocument["nodes"][number],
				{ id: "stop", kind: "stop_subflow", always: false, subflow: "" },
			],
		};
		expect(documentFieldErrors(doc)).toEqual([
			{ nodeId: "stop", field: "subflow", message: "不能为空", typed: false },
		]);
	});

	it("别的字段的错误不是边输入边改的文本框：不等字段交互过，一出现就显示", () => {
		const doc: StoredOrchestrationDocument = {
			...base,
			default_agent: "",
		};
		expect(documentFieldErrors(doc)).toEqual([
			{ nodeId: undefined, field: "default_agent", message: "不能为空", typed: false },
		]);
	});
});

describe("已移除种类的节点（ADR 0028）", () => {
	const REMOVED = [
		["feishu_notify", { bot: "ops", text: "完成" }, "在节点代码里用 ctx.notify 发飞书消息"],
		[
			"timer",
			{ at: "09:30:00", tz: "Asia/Shanghai" },
			"在节点代码里等到那个时刻，或把场景拆成两次运行",
		],
		["sleep", { duration: "30s" }, "在节点代码里等待，或把场景拆成两次运行"],
	] as const;
	const removedNode = (kind: string, config: object) =>
		({ id: "old", kind, ...config }) as unknown as StoredOrchestrationDocument["nodes"][number];
	const withRemoved = (node: StoredOrchestrationDocument["nodes"][number]) => ({
		...base,
		nodes: [...base.nodes, node],
		edges: [...base.edges, { from: "stop", to: node.id, kind: "chain" as const }],
	});

	it.each(
		REMOVED,
	)("%s 是字段错误：不能保存，错误指出节点和替换办法", (kind, config, replacement) => {
		expect(documentFieldErrors(withRemoved(removedNode(kind, config)))).toEqual([
			{
				nodeId: "old",
				field: "kind",
				message: `已不再支持，不能保存。替换办法：${replacement}`,
			},
		]);
	});

	it.each(
		REMOVED,
	)("%s：其余节点的错误照常指向对的节点（位置按去掉已移除节点之后算）", (kind, config) => {
		const doc: StoredOrchestrationDocument = {
			...withRemoved(removedNode(kind, config)),
			nodes: [
				base.nodes[0] as StoredOrchestrationDocument["nodes"][number],
				removedNode(kind, config),
				{ id: "stop", kind: "stop_subflow", always: false, subflow: "" },
			],
		};
		expect(documentFieldErrors(doc).map((e) => [e.nodeId, e.field])).toEqual([
			["old", "kind"],
			["stop", "subflow"],
		]);
	});

	it("删掉它之后没有字段错误", () => {
		expect(documentFieldErrors(base)).toEqual([]);
	});
});

describe("检查结果", () => {
	it("字段错误最先，其次警告，都没有时是检查通过", () => {
		expect(checkSummary(0, 2)).toEqual({ kind: "warn", label: "2 条警告" });
		expect(checkSummary(0, 0)).toEqual({ kind: "ok", label: "检查通过" });
		expect(checkSummary(1, 2)).toEqual({ kind: "failed", label: "1 处字段错误" });
	});

	it("保存后的提示：只有注释框的警告时说明不影响触发运行；混着时说清有几条要处理", () => {
		const annotation = {
			code: "annotation_no_members",
			message: "…",
			annotation_id: "annotation_1",
		};
		const other = { code: "orphan_node", message: "…", node_id: "stray" };
		expect(warningsSummary([other, other])).toBe("2 条警告，触发运行前需要处理");
		expect(warningsSummary([annotation])).toBe("1 条警告，不影响触发运行");
		expect(warningsSummary([annotation, other, annotation])).toBe(
			"3 条警告，其中 1 条触发运行前需要处理",
		);
	});
});
