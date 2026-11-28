import { OrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	agentInputs,
	documentWarnings,
	isAgentInput,
	type NodeTypeIo,
	type PackageCatalog,
	packageKey,
	referencedAgents,
} from "../src/index.js";

/** clean(source: AgentName, backup: AgentName | None = None, dir: str = "/")，sfly build 生成的输入 schema。 */
const cleanType: NodeTypeIo = {
	name: "clean",
	inputs: {
		type: "object",
		properties: {
			source: { type: "string", "x-sfly-type": "agent" },
			backup: {
				anyOf: [{ type: "string", "x-sfly-type": "agent" }, { type: "null" }],
				default: null,
			},
			dir: { type: "string", default: "/" },
		},
		required: ["source"],
		order: ["source", "backup", "dir"],
	},
	outputs: { type: "object", properties: {} },
};

describe("「Agent」类型的输入", () => {
	it("按 sfly build 的标记识别，可选的也算", () => {
		expect(isAgentInput({ type: "string", "x-sfly-type": "agent" })).toBe(true);
		expect(isAgentInput({ type: "string" })).toBe(false);
		expect(agentInputs(cleanType.inputs)).toEqual(["source", "backup"]);
	});

	it("引用的 Agent 是这些输入里不为空的字符串", () => {
		expect(
			referencedAgents(cleanType.inputs, { source: "a", backup: null, dir: "agent-b" }),
		).toEqual([{ input: "source", agent: "a" }]);
		expect(referencedAgents(cleanType.inputs, { source: "a", backup: "b" })).toEqual([
			{ input: "source", agent: "a" },
			{ input: "backup", agent: "b" },
		]);
	});
});

describe("「Agent」类型的输入的静态检查", () => {
	const catalog: PackageCatalog = new Map([[packageKey("demo", "1.0.0"), [cleanType]]]);
	const doc = (inputs: Record<string, unknown>) =>
		OrchestrationDocument.parse({
			default_agent: "agent-a",
			packages: { demo: "1.0.0" },
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "src", type: "string" }] },
				{ id: "c", kind: "package", package: "demo", node: "clean", inputs },
			],
			edges: [{ from: "entry", to: "c", kind: "chain" }],
		});
	const registered = new Set(["agent-a", "agent-b"]);
	const warnings = (inputs: Record<string, unknown>) =>
		documentWarnings(doc(inputs), catalog, { agents: registered }).filter((w) =>
			w.code.startsWith("agent_"),
		);

	it("常量不是已注册的 Agent 时警告，指出节点和参数", () => {
		expect(warnings({ source: "ghost", backup: "agent-b" })).toEqual([
			{
				code: "agent_input_not_registered",
				message: "节点 c 的输入 source 选择的 Agent ghost 还没有注册过",
				node_id: "c",
				input: "source",
			},
		]);
	});

	it("已注册的 Agent（不论是否在线）、引用入口参数、没有填写的可选参数都不警告", () => {
		expect(warnings({ source: "agent-a" })).toEqual([]);
		expect(warnings({ source: "${{ params.src }}", backup: null })).toEqual([]);
	});

	it("不知道已注册的 Agent 时不检查", () => {
		expect(
			documentWarnings(doc({ source: "ghost" }), catalog).filter((w) =>
				w.code.startsWith("agent_"),
			),
		).toEqual([]);
	});
});

describe("包节点派发到的 Agent 的静态检查（#500）", () => {
	const doc = OrchestrationDocument.parse({
		default_agent: "agent-a",
		packages: { demo: "1.0.0" },
		nodes: [
			{ id: "entry", kind: "entry", params: [] },
			{ id: "c", kind: "package", package: "demo", node: "clean", inputs: {} },
			{
				id: "d",
				kind: "package",
				package: "demo",
				node: "clean",
				agent: "other-team-box",
				inputs: {},
			},
		],
		edges: [
			{ from: "entry", to: "c", kind: "chain" },
			{ from: "c", to: "d", kind: "chain" },
		],
	});
	const nodeAgents = (agents: ReadonlySet<string>) =>
		documentWarnings(doc, new Map(), { agents, nodeAgents: true }).filter(
			(w) => w.code === "agent_not_registered",
		);

	it("节点另选的 Agent 和默认 Agent 不是这个项目里注册过的：各节点一条警告，说明和触发前的预检相同", () => {
		expect(nodeAgents(new Set(["agent-a"]))).toEqual([
			{
				code: "agent_not_registered",
				message: "节点 d 派发到的 Agent other-team-box 还没有注册过",
				node_id: "d",
			},
		]);
		expect(nodeAgents(new Set()).map((w) => w.node_id)).toEqual(["c", "d"]);
	});

	it("都注册过时不警告；不知道已注册的 Agent、或者没要求检查（画布）时不检查", () => {
		expect(nodeAgents(new Set(["agent-a", "other-team-box"]))).toEqual([]);
		expect(
			documentWarnings(doc, new Map()).filter((w) => w.code === "agent_not_registered"),
		).toEqual([]);
		expect(
			documentWarnings(doc, new Map(), { agents: new Set() }).filter(
				(w) => w.code === "agent_not_registered",
			),
		).toEqual([]);
	});
});
