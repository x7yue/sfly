import { OrchestrationDocument, StoredOrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	checkConnection,
	documentWarnings,
	type NodeTypeIo,
	type PackageCatalog,
	packageKey,
} from "../src/index.js";

// 警告说到节点时写成「显示名称（节点 ID）」，没有显示名称时只写节点 ID（#307）。

const catalog: PackageCatalog = new Map<string, NodeTypeIo[]>([
	[
		packageKey("demo", "1.0.0"),
		[
			{
				name: "fetch",
				inputs: {
					type: "object",
					properties: {
						url: { type: "string" },
						agent: { type: "string", "x-sfly-type": "agent" },
					},
					required: ["url"],
				},
				outputs: { type: "object", properties: { body: {}, status: { type: "integer" } } },
			},
		],
	],
]);

const document = () =>
	StoredOrchestrationDocument.parse({
		default_agent: "linux",
		nodes: [
			{ id: "entry", kind: "entry" },
			{
				id: "fetch_1",
				kind: "package",
				package: "demo",
				node: "fetch",
				display_name: "创建测试用户",
				inputs: { agent: "ghost", url: "${{ params.missing }}" },
			},
			{ id: "stop_1", kind: "stop_subflow", display_name: "停一停" },
			{ id: "notify_1", kind: "feishu_notify", display_name: "通知群" },
			{ id: "stray", kind: "async", display_name: "游离的异步任务" },
		],
		edges: [
			{ from: "entry", to: "fetch_1", kind: "chain" },
			{ from: "fetch_1", to: "stop_1", kind: "chain" },
			{ from: "stop_1", to: "notify_1", kind: "chain" },
		],
		packages: { demo: "1.0.0" },
	});

const messages = (doc: StoredOrchestrationDocument, code?: string) =>
	documentWarnings(doc, catalog, { agents: new Set(["linux"]), feishuBots: new Set() })
		.filter((w) => code === undefined || w.code === code)
		.map((w) => w.message);

describe("警告里的节点写成「显示名称（节点 ID）」", () => {
	it("结构：不在任何链上的节点", () => {
		expect(messages(document(), "orphan_node")).toEqual([
			"节点 游离的异步任务（stray） 不在任何链上",
		]);
	});

	it("引用：输入里的引用不成立", () => {
		expect(messages(document(), "reference_unknown_param")).toEqual([
			"节点 创建测试用户（fetch_1） 的输入 url 引用的参数 missing 不是本链入口声明的参数",
		]);
	});

	it("输入：必填输入、Agent 类型的输入", () => {
		const doc = StoredOrchestrationDocument.parse({
			...document(),
			nodes: document().nodes.map((n) =>
				n.id === "fetch_1" && n.kind === "package" ? { ...n, inputs: { agent: "ghost" } } : n,
			),
		});
		expect(messages(doc, "input_required")).toEqual([
			"节点 创建测试用户（fetch_1） 的必填输入 url 没有填写",
		]);
		expect(messages(doc, "agent_input_not_registered")).toEqual([
			"节点 创建测试用户（fetch_1） 的输入 agent 选择的 Agent ghost 还没有注册过",
		]);
	});

	it.each([
		[
			"feishu_notify",
			{ bot: "ops", text: "完成" },
			"飞书通知",
			"在节点代码里用 ctx.notify 发飞书消息",
			"",
		],
		[
			"timer",
			{ at: "09:30:00", tz: "Asia/Shanghai" },
			"定时",
			"在节点代码里等到那个时刻，或把场景拆成两次运行",
			"。别的节点引用了它的输出（triggered_at、late）的，也要一起改。",
		],
		[
			"sleep",
			{ duration: "30s" },
			"Sleep",
			"在节点代码里等待，或把场景拆成两次运行",
			"。别的节点引用了它的输出（triggered_at）的，也要一起改。",
		],
	] as const)("已移除种类的节点 %s（ADR 0028）：写出节点、当时的种类和替换办法；原来有输出的提醒引用它输出的节点也要改", (kind, config, label, replacement, referenced) => {
		const doc = StoredOrchestrationDocument.parse({
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "old_1", kind, display_name: "老节点", ...config },
			],
			edges: [{ from: "entry", to: "old_1", kind: "chain" }],
		});
		expect(messages(doc, "node_kind_removed")).toEqual([
			`节点 老节点（old_1） 的类型（已移除的节点类型 ${kind}，原来的「${label}」）已不再支持，不能运行。替换办法：${replacement}${referenced}`,
		]);
		expect(
			documentWarnings(doc, catalog)
				.filter((w) => w.code === "node_kind_removed")
				.map((w) => w.node_id),
		).toEqual(["old_1"]);
	});

	it("没有显示名称的节点只写节点 ID，和以前一样", () => {
		const doc = OrchestrationDocument.parse({
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "stop_1", kind: "stop_subflow" },
			],
			edges: [{ from: "entry", to: "stop_1", kind: "chain" }],
		});
		expect(messages(doc, "stop_subflow_unset")).toEqual(["停止子流程节点 stop_1 没有选择子流程"]);
	});

	it("每条警告仍然指向节点 ID：node_id 不变", () => {
		const warnings = documentWarnings(document(), catalog);
		expect(warnings.find((w) => w.code === "orphan_node")?.node_id).toBe("stray");
		expect(warnings.find((w) => w.code === "reference_unknown_param")?.node_id).toBe("fetch_1");
	});

	it("子流程入口节点用子流程名称；填了空名称的警告只写节点 ID", () => {
		const doc = OrchestrationDocument.parse({
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "mon", kind: "subflow_entry", name: "监控" },
				{ id: "blank", kind: "subflow_entry", name: " " },
			],
			edges: [],
		});
		expect(messages(doc, "subflow_not_triggered")).toEqual([
			"子流程入口节点 监控（mon） 没有被异步任务节点触发",
			"子流程入口节点 未命名子流程（blank） 没有被异步任务节点触发",
		]);
		expect(messages(doc, "subflow_name_empty")).toEqual(["子流程入口节点 blank 没有填写名称"]);
	});

	it("引用：被引用的节点写成「显示名称（节点 ID）」", () => {
		const fetch = (id: string, url: string, displayName?: string) => ({
			id,
			kind: "package",
			package: "demo",
			node: "fetch",
			inputs: { url },
			...(displayName === undefined ? {} : { display_name: displayName }),
		});
		const doc = OrchestrationDocument.parse({
			default_agent: "linux",
			nodes: [
				{ id: "entry", kind: "entry" },
				fetch("first", "x", "造数据"),
				fetch("second", "${{ nodes.first.outputs.nope }}", "查结果"),
				fetch("third", "${{ nodes.fourth.outputs.body }}"),
				fetch("fourth", "x", "清理"),
			],
			edges: [
				{ from: "entry", to: "first", kind: "chain" },
				{ from: "first", to: "second", kind: "chain" },
				{ from: "second", to: "third", kind: "chain" },
				{ from: "third", to: "fourth", kind: "chain" },
			],
			packages: { demo: "1.0.0" },
		});
		expect(messages(doc, "reference_unknown_output")).toEqual([
			"节点 查结果（second） 的输入 url 引用的输出键 nope 没有在节点 造数据（first） 的节点类型中声明",
		]);
		expect(messages(doc, "reference_not_earlier")).toEqual([
			"节点 third 的输入 url 引用的节点 清理（fourth） 不在本链上它的前面",
		]);
	});

	describe("异步任务节点和子流程", () => {
		const subflowDocument = (extra: object[] = [], edges: object[] = []) =>
			OrchestrationDocument.parse({
				nodes: [
					{ id: "entry", kind: "entry" },
					{ id: "spawn", kind: "async", display_name: "派发汇报", params: { extra: "1" } },
					{
						id: "sub",
						kind: "subflow_entry",
						name: "汇报",
						params: [{ name: "run", type: "string", required: true }],
					},
					...extra,
				],
				edges: [
					{ from: "entry", to: "spawn", kind: "chain" },
					{ from: "spawn", to: "sub", kind: "dispatch" },
					...edges,
				],
			});

		it("子流程参数的警告写出子流程名称和入口节点 ID", () => {
			expect(messages(subflowDocument(), "subflow_param_unknown")).toEqual([
				"节点 派发汇报（spawn） 映射的参数 extra 不是子流程 汇报（sub） 声明的参数",
			]);
			expect(messages(subflowDocument(), "subflow_param_missing")).toEqual([
				"节点 派发汇报（spawn） 没有映射子流程 汇报（sub） 的必填参数 run",
			]);
		});

		it("停止子流程节点排在触发它的异步任务节点之前：异步任务节点写出显示名称", () => {
			const doc = OrchestrationDocument.parse({
				nodes: [
					{ id: "entry", kind: "entry" },
					{ id: "stop", kind: "stop_subflow", subflow: "sub" },
					{ id: "spawn", kind: "async", display_name: "派发汇报" },
					{ id: "sub", kind: "subflow_entry", name: "汇报" },
				],
				edges: [
					{ from: "entry", to: "stop", kind: "chain" },
					{ from: "stop", to: "spawn", kind: "chain" },
					{ from: "spawn", to: "sub", kind: "dispatch" },
				],
			});
			expect(messages(doc, "stop_subflow_before_trigger")).toEqual([
				"停止子流程节点 stop 在触发子流程「汇报」的异步任务节点 派发汇报（spawn） 之前",
			]);
		});

		it("再连一条调度连线被拒绝的原因：已经触发它的异步任务节点写出显示名称", () => {
			const doc = subflowDocument([{ id: "again", kind: "async" }]);
			expect(checkConnection(doc, { from: "again", to: "sub", kind: "dispatch" })).toBe(
				"子流程入口节点 汇报（sub） 已被异步任务节点 派发汇报（spawn） 触发",
			);
		});

		it("调度连线不合规：两端写出显示名称", () => {
			const doc = subflowDocument(
				[{ id: "stop", kind: "stop_subflow", display_name: "收尾" }],
				[{ from: "stop", to: "sub", kind: "dispatch" }],
			);
			expect(messages(doc, "invalid_dispatch")).toEqual([
				"调度连线 收尾（stop） → 汇报（sub） 必须从异步任务节点连到子流程入口节点",
			]);
		});
	});

	it("连线指向不存在的节点：存在的一端写出显示名称，不存在的一端写节点 ID", () => {
		const doc = OrchestrationDocument.parse({
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "stop", kind: "stop_subflow", display_name: "收尾" },
			],
			edges: [
				{ from: "entry", to: "stop", kind: "chain" },
				{ from: "stop", to: "ghost", kind: "chain" },
			],
		});
		expect(messages(doc, "unknown_node")).toEqual([
			"连线 收尾（stop） → ghost 指向不存在的节点 ghost",
		]);
	});

	it("连线被拒绝的原因也写出显示名称", () => {
		const doc = document();
		expect(checkConnection(doc, { from: "fetch_1", to: "notify_1", kind: "chain" })).toBe(
			"节点 创建测试用户（fetch_1） 已有出线，链不能分叉",
		);
	});
});
