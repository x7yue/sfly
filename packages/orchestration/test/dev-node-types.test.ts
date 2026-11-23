import { DEV_VERSION, OrchestrationDocument, StoredOrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	type AgentDevReport,
	devNodeTypes,
	devPackageTargets,
	dispatchAgentOf,
	formNodeTypes,
	reportedNodeTypes,
} from "../src/index.js";

// 开发版本（包名@dev）的节点类型按「节点派发到的 Agent」取（docs/SEMANTICS.md §7 第 3 条）：控制面和画布共用这组纯函数，
// 查不到、对不齐时都当作不知道（不检查）。

const io = (properties: Record<string, Record<string, unknown>>) => ({
	type: "object" as const,
	properties,
	required: ["host"],
});
const OLD = [{ name: "tune", inputs: io({ host: { type: "string" } }), outputs: io({}) }];
const NEW = [
	{
		name: "tune",
		inputs: io({ host: { type: "string" }, extra: { type: "string" } }),
		outputs: io({}),
	},
];

const report = (
	name: string,
	online: boolean,
	loaded: Record<string, unknown> = {},
): AgentDevReport => ({ name, online, devPackages: new Map(Object.entries(loaded)) });

const node = (id: string, pkg = "tuner", agent?: string) => ({
	id,
	kind: "package",
	package: pkg,
	node: "tune",
	inputs: {},
	...(agent === undefined ? {} : { agent }),
});
const doc = (
	nodes: unknown[],
	packages: Record<string, string> = { tuner: DEV_VERSION },
	defaultAgent?: string,
) =>
	StoredOrchestrationDocument.parse({
		...(defaultAgent === undefined ? {} : { default_agent: defaultAgent }),
		nodes: [{ id: "entry", kind: "entry" }, ...nodes],
		edges: nodes.map((n, i) => ({
			from: i === 0 ? "entry" : (nodes[i - 1] as { id: string }).id,
			to: (n as { id: string }).id,
			kind: "chain",
		})),
		packages,
	});

const keys = (m: ReadonlyMap<string, unknown>) => [...m.keys()];

describe("派发到哪台 Agent", () => {
	it("节点另选的 Agent 优先，否则编排的默认 Agent，都没有时是 undefined", () => {
		expect(dispatchAgentOf({ default_agent: "a" }, { agent: "b" })).toBe("b");
		expect(dispatchAgentOf({ default_agent: "a" }, {})).toBe("a");
		expect(dispatchAgentOf({}, {})).toBeUndefined();
	});

	it("DEV_VERSION 是 dev", () => {
		expect(DEV_VERSION).toBe("dev");
	});
});

describe("devNodeTypes：只看用到这个包的节点派发到的 Agent", () => {
	it("别的 Agent 上加载的内容不同不影响：目标是 agent-a 按 agent-a，目标是 agent-b 按 agent-b", () => {
		const agents = [
			report("agent-a", true, { tuner: NEW }),
			report("agent-b", true, { tuner: OLD }),
		];
		expect(devNodeTypes(doc([node("t")], undefined, "agent-a"), agents).get("tuner")).toEqual(NEW);
		expect(
			devNodeTypes(doc([node("t", "tuner", "agent-b")], undefined, "agent-a"), agents).get("tuner"),
		).toEqual(OLD);
	});

	it("目标离线、别的在线 Agent 上是旧源码：不检查（不能拿旧的去拦新的）", () => {
		const agents = [
			report("agent-a", true, { tuner: OLD }),
			report("agent-b", false, { tuner: NEW }),
		];
		expect(
			keys(devNodeTypes(doc([node("t", "tuner", "agent-b")], undefined, "agent-a"), agents)),
		).toEqual([]);
	});

	it("目标在线但没加载这个包（别的 Agent 加载了）：不检查", () => {
		const agents = [report("agent-a", true, { tuner: NEW }), report("agent-b", true)];
		expect(
			keys(devNodeTypes(doc([node("t", "tuner", "agent-b")], undefined, "agent-a"), agents)),
		).toEqual([]);
	});

	it("目标不在列表里（没有注册过）：不检查", () => {
		const agents = [report("agent-a", true, { tuner: NEW })];
		expect(
			keys(devNodeTypes(doc([node("t", "tuner", "agent-x")], undefined, "agent-a"), agents)),
		).toEqual([]);
	});

	it("同一个包的几个节点派发到不同的 Agent：这几台都在线、都加载了、内容相同才用", () => {
		const two = doc([node("t1", "tuner", "agent-a"), node("t2", "tuner", "agent-b")]);
		expect(
			devNodeTypes(two, [
				report("agent-a", true, { tuner: NEW }),
				report("agent-b", true, { tuner: NEW }),
			]).get("tuner"),
		).toEqual(NEW);
		// 内容不同：整包不查。
		expect(
			keys(
				devNodeTypes(two, [
					report("agent-a", true, { tuner: NEW }),
					report("agent-b", true, { tuner: OLD }),
				]),
			),
		).toEqual([]);
	});

	it("同一个包的两个节点，一个派到在线加载了旧版的 Agent、另一个派到离线的或在线没加载的：整包不查（不能只比加载了的）", () => {
		const two = doc([node("t1", "tuner", "agent-a"), node("t2", "tuner", "agent-b")]);
		const loadedOld = report("agent-a", true, { tuner: OLD });
		// agent-b 离线，上次上报的是新版。
		expect(keys(devNodeTypes(two, [loadedOld, report("agent-b", false, { tuner: NEW })]))).toEqual(
			[],
		);
		// agent-b 在线但没有加载。
		expect(keys(devNodeTypes(two, [loadedOld, report("agent-b", true)]))).toEqual([]);
		// agent-b 不在列表里。
		expect(keys(devNodeTypes(two, [loadedOld]))).toEqual([]);
	});

	it("上报的内容不是合法的节点类型：不检查；合法但内容相同的几台：用", () => {
		const bad = { tuner: [{ name: "tune", inputs: "不是对象", outputs: io({}) }] };
		expect(
			keys(devNodeTypes(doc([node("t")], undefined, "agent-a"), [report("agent-a", true, bad)])),
		).toEqual([]);
		// 对象键的顺序不同、内容相同：算相同。
		const reordered = [{ outputs: io({}), inputs: io({ host: { type: "string" } }), name: "tune" }];
		const two = doc([node("t1", "tuner", "agent-a"), node("t2", "tuner", "agent-b")]);
		expect(
			devNodeTypes(two, [
				report("agent-a", true, { tuner: OLD }),
				report("agent-b", true, { tuner: reordered }),
			]).has("tuner"),
		).toBe(true);
	});

	it("节点没有确定的 Agent（没写、也没有默认 Agent）：这个包不查；别的开发包不受影响", () => {
		const d = doc([node("t1"), node("t2", "other", "agent-a")], {
			tuner: DEV_VERSION,
			other: DEV_VERSION,
		});
		const agents = [report("agent-a", true, { tuner: NEW, other: NEW })];
		expect(keys(devNodeTypes(d, agents))).toEqual(["other"]);
	});

	it("没有锁定开发版本的包：什么都不取；已发布的版本不看", () => {
		const published = doc([node("t", "tuner", "agent-a")], { tuner: "1.0.0" });
		expect(keys(devNodeTypes(published, [report("agent-a", true, { tuner: NEW })]))).toEqual([]);
		expect(keys(devPackageTargets(published))).toEqual([]);
	});

	it("别的开发包的目标离线，不影响这个包", () => {
		const d = doc([node("t1", "tuner", "agent-a"), node("t2", "other", "agent-b")], {
			tuner: DEV_VERSION,
			other: DEV_VERSION,
		});
		const agents = [
			report("agent-a", true, { tuner: NEW }),
			report("agent-b", false, { other: NEW }),
		];
		expect(keys(devNodeTypes(d, agents))).toEqual(["tuner"]);
	});

	it("子流程里的节点也算它的派发目标", () => {
		const d = StoredOrchestrationDocument.parse({
			default_agent: "agent-a",
			nodes: [
				{ id: "entry", kind: "entry" },
				{ id: "spawn", kind: "async" },
				{ id: "sub", kind: "subflow_entry", name: "子流程" },
				node("t", "tuner", "agent-b"),
			],
			edges: [
				{ from: "entry", to: "spawn", kind: "chain" },
				{ from: "spawn", to: "sub", kind: "dispatch" },
				{ from: "sub", to: "t", kind: "chain" },
			],
			packages: { tuner: DEV_VERSION },
		});
		expect([...(devPackageTargets(d).get("tuner") ?? [])]).toEqual(["agent-b"]);
	});
});

describe("reportedNodeTypes：上报的内容要合法", () => {
	it("合法的原样返回；缺名字、输入不是 JSON Schema 对象、说明不是字符串、不是数组都不合法", () => {
		expect(reportedNodeTypes(OLD)).toBe(OLD);
		expect(reportedNodeTypes(undefined)).toBeUndefined();
		expect(reportedNodeTypes({})).toBeUndefined();
		expect(reportedNodeTypes([null])).toBeUndefined();
		expect(reportedNodeTypes([{ inputs: io({}), outputs: io({}) }])).toBeUndefined();
		expect(reportedNodeTypes([{ name: "t", inputs: io({}) }])).toBeUndefined();
		expect(
			reportedNodeTypes([{ name: "t", inputs: io({}), outputs: io({}), description: 1 }]),
		).toBeUndefined();
		expect(
			reportedNodeTypes([{ name: "t", inputs: { type: "array" }, outputs: io({}) }]),
		).toBeUndefined();
	});
});

describe("formNodeTypes：参数表单用的尽力而为的类型（不是检查用的）", () => {
	it("优先取节点自己派发到的 Agent 上报的，在线与否都用", () => {
		const agents = [
			report("agent-a", true, { tuner: OLD }),
			report("agent-b", false, { tuner: NEW }),
		];
		const d = OrchestrationDocument.parse({
			default_agent: "agent-a",
			nodes: [],
			edges: [],
			packages: {},
		});
		expect(formNodeTypes(d, { package: "tuner", node: "tune", agent: "agent-b" }, agents)).toEqual({
			agent: "agent-b",
			nodes: NEW,
		});
		expect(formNodeTypes(d, { package: "tuner", node: "tune" }, agents)).toEqual({
			agent: "agent-a",
			nodes: OLD,
		});
	});

	it("目标没有加载时：在线的第一台，再其次是加载过的第一台；都没有是 undefined", () => {
		const d = OrchestrationDocument.parse({
			default_agent: "agent-a",
			nodes: [],
			edges: [],
			packages: {},
		});
		const target = report("agent-a", true);
		expect(
			formNodeTypes(d, { package: "tuner", node: "tune" }, [
				target,
				report("agent-b", false, { tuner: OLD }),
				report("agent-c", true, { tuner: NEW }),
			]),
		).toEqual({ agent: "agent-c", nodes: NEW });
		expect(
			formNodeTypes(d, { package: "tuner", node: "tune" }, [
				target,
				report("agent-b", false, { tuner: OLD }),
			]),
		).toEqual({ agent: "agent-b", nodes: OLD });
		expect(formNodeTypes(d, { package: "tuner", node: "tune" }, [target])).toBeUndefined();
		// 目标上报的不合法：退到下一台。
		const bad = report("agent-a", true, { tuner: "坏了" });
		expect(
			formNodeTypes(d, { package: "tuner", node: "tune" }, [
				bad,
				report("agent-c", true, { tuner: NEW }),
			]),
		).toEqual({ agent: "agent-c", nodes: NEW });
	});

	it("目标的上报合法、但里面没有这个节点类型（上次加载的源码里还没有这个新节点）：接着找下一台，别的 Agent 上有就用它的", () => {
		const d = OrchestrationDocument.parse({
			default_agent: "agent-a",
			nodes: [],
			edges: [],
			packages: {},
		});
		const other = [{ name: "other", inputs: io({ x: { type: "string" } }), outputs: io({}) }];
		const node = { package: "tuner", node: "tune", agent: "agent-b" };
		// 目标 agent-b（离线）上次加载的源码里只有 other；在线的 agent-a 上有 tune。
		expect(
			formNodeTypes(d, node, [
				report("agent-a", true, { tuner: NEW }),
				report("agent-b", false, { tuner: other }),
			]),
		).toEqual({ agent: "agent-a", nodes: NEW });
		// 目标在线、上报合法但没有这个节点类型：同样接着找，离线的也找。
		expect(
			formNodeTypes(d, node, [
				report("agent-b", true, { tuner: other }),
				report("agent-c", false, { tuner: OLD }),
			]),
		).toEqual({ agent: "agent-c", nodes: OLD });
		// 目标上报里有，就用目标的，不去看别人的。
		expect(
			formNodeTypes(d, node, [
				report("agent-a", true, { tuner: OLD }),
				report("agent-b", false, { tuner: NEW }),
			]),
		).toEqual({ agent: "agent-b", nodes: NEW });
	});

	it("所有合法的上报里都没有这个节点类型：返回第一份合法的上报（「找不到这个节点类型」和「还在加载」分得开）；上报都不合法是 undefined", () => {
		const d = OrchestrationDocument.parse({
			default_agent: "agent-a",
			nodes: [],
			edges: [],
			packages: {},
		});
		const other = [{ name: "other", inputs: io({}), outputs: io({}) }];
		const node = { package: "tuner", node: "tune" };
		expect(
			formNodeTypes(d, node, [
				report("agent-a", true, { tuner: other }),
				report("agent-b", true, { tuner: [{ name: "third", inputs: io({}), outputs: io({}) }] }),
			]),
		).toEqual({ agent: "agent-a", nodes: other });
		expect(
			formNodeTypes(d, node, [
				report("agent-a", true, { tuner: "坏了" }),
				report("agent-b", true, { tuner: 3 }),
			]),
		).toBeUndefined();
	});
});
