// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { OrchestrationDocument } from "@sfly/schema";
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
	OrchestrationDocument.parse({
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
			{ id: "wait_1", kind: "sleep", duration: "abc", display_name: "等一等" },
			{ id: "notify_1", kind: "feishu_notify", display_name: "通知群" },
			{ id: "stray", kind: "timer", at: "9点", tz: "Asia/Shanghai", display_name: "游离的定时" },
		],
		edges: [
			{ from: "entry", to: "fetch_1", kind: "chain" },
			{ from: "fetch_1", to: "wait_1", kind: "chain" },
			{ from: "wait_1", to: "notify_1", kind: "chain" },
		],
		packages: { demo: "1.0.0" },
	});

const messages = (doc: OrchestrationDocument, code?: string) =>
	documentWarnings(doc, catalog, { agents: new Set(["linux"]), feishuBots: new Set() })
		.filter((w) => code === undefined || w.code === code)
		.map((w) => w.message);

describe("警告里的节点写成「显示名称（节点 ID）」", () => {
	it("结构：不在任何链上的节点", () => {
		expect(messages(document(), "orphan_node")).toEqual(["节点 游离的定时（stray） 不在任何链上"]);
	});

	it("引用：输入里的引用不成立", () => {
		expect(messages(document(), "reference_unknown_param")).toEqual([
			"节点 创建测试用户（fetch_1） 的输入 url 引用的参数 missing 不是本链入口声明的参数",
		]);
	});

	it("输入：必填输入、Agent 类型的输入", () => {
		const doc = OrchestrationDocument.parse({
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

	it("定时、Sleep 节点的配置", () => {
		expect(messages(document(), "sleep_duration_invalid")).toEqual([
			'Sleep 节点 等一等（wait_1） 的时长 "abc" 无效：例如 30s、10m、1h、1h30m',
		]);
		expect(messages(document(), "timer_at_invalid")[0]).toContain(
			"定时节点 游离的定时（stray） 的时刻",
		);
	});

	it("飞书通知节点没有选择机器人", () => {
		expect(messages(document(), "feishu_bot_unset")).toEqual([
			"节点 通知群（notify_1） 没有选择飞书机器人",
		]);
	});

	it("没有显示名称的节点只写节点 ID，和以前一样", () => {
		const doc = OrchestrationDocument.parse({
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "wait_1", kind: "sleep", duration: "abc" },
			],
			edges: [{ from: "entry", to: "wait_1", kind: "chain" }],
		});
		expect(messages(doc, "sleep_duration_invalid")).toEqual([
			'Sleep 节点 wait_1 的时长 "abc" 无效：例如 30s、10m、1h、1h30m',
		]);
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

	it("连线被拒绝的原因也写出显示名称", () => {
		const doc = document();
		expect(checkConnection(doc, { from: "fetch_1", to: "notify_1", kind: "chain" })).toBe(
			"节点 创建测试用户（fetch_1） 已有出线，链不能分叉",
		);
	});
});
