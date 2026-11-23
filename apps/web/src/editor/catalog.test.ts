import { declaredOutputs, packageKey } from "@sfly/orchestration";
import {
	type AgentView,
	DEV_VERSION,
	type StoredNode,
	StoredOrchestrationDocument,
} from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	completionTypes,
	devNodes,
	devReports,
	formSourceNote,
	inspectorNodeType,
	uncheckedInputs,
} from "./catalog";
import { referenceChoices } from "./inspector/reference-completion";

// 画布上开发版本的节点类型：检查用的（和控制面同一套取法，按节点派发到的 Agent）和参数表单用的（尽力而为）是两份：
// 检查跳过时表单也要有字段，而「没有声明 / 移除」只按检查用的，不会让人删掉目标 Agent 其实声明了的输入。

const io = (properties: Record<string, unknown>) => ({
	type: "object",
	properties,
	required: ["host"],
});
const OLD = [{ name: "tune", inputs: io({ host: {} }), outputs: io({}) }];
const NEW = [{ name: "tune", inputs: io({ host: {}, extra: {} }), outputs: io({}) }];

const agent = (name: string, status: "online" | "offline", nodes?: unknown): AgentView =>
	({
		name,
		status,
		dev_packages: nodes === undefined ? [] : [{ name: "tuner", source: "/s", metadata: { nodes } }],
	}) as unknown as AgentView;

const doc = (agentOfNode?: string) =>
	StoredOrchestrationDocument.parse({
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry" },
			{
				id: "t",
				kind: "package",
				package: "tuner",
				node: "tune",
				inputs: { host: "h", extra: "x" },
				...(agentOfNode === undefined ? {} : { agent: agentOfNode }),
			},
		],
		edges: [{ from: "entry", to: "t", kind: "chain" }],
		packages: { tuner: DEV_VERSION },
	});
const node = { package: "tuner", node: "tune" };

describe("inspectorNodeType：检查用的和表单用的", () => {
	it("检查用的目录里有（目标在线、加载了）：两份一样", () => {
		const catalog = new Map([[packageKey("tuner", "dev"), NEW]]);
		const d = doc();
		const { checked, form } = inspectorNodeType(d, node, catalog as never, []);
		expect(checked?.name).toBe("tune");
		expect(form).toBe(checked);
	});

	it("检查跳过（目录里没有）：checked 是 undefined，不报「没有声明」；表单优先取节点派发到的 Agent（离线也用）", () => {
		const agents = [agent("agent-a", "online", OLD), agent("agent-b", "offline", NEW)];
		const d = doc("agent-b");
		const { checked, form } = inspectorNodeType(
			d,
			{ ...node, agent: "agent-b" },
			new Map(),
			agents,
		);
		expect(checked).toBeUndefined();
		expect(Object.keys(form?.inputs.properties ?? {})).toEqual(["host", "extra"]);
	});

	it("表单：目标没加载时退到在线的、再到离线的；没有 Agent 加载时还是 undefined（和以前一样「加载中」）；找不到这个节点是 null", () => {
		const d = doc();
		expect(
			inspectorNodeType(d, node, new Map(), [
				agent("agent-a", "online"),
				agent("agent-c", "online", NEW),
			]).form?.inputs.properties,
		).toHaveProperty("extra");
		expect(
			inspectorNodeType(d, node, new Map(), [agent("agent-a", "online")]).form,
		).toBeUndefined();
		const other = [{ name: "other", inputs: io({}), outputs: io({}) }];
		expect(
			inspectorNodeType(d, node, new Map(), [agent("agent-a", "online", other)]).form,
		).toBeNull();
	});

	it("已发布的版本不受影响：目录里没有就是还在加载", () => {
		const published = StoredOrchestrationDocument.parse({ ...doc(), packages: { tuner: "1.0.0" } });
		expect(
			inspectorNodeType(published, node, new Map(), [agent("agent-a", "online", NEW)]),
		).toEqual({
			checked: undefined,
			form: undefined,
		});
	});
});

describe("inspectorNodeType：目标的上报里没有这个节点类型时接着找下一台", () => {
	it("目标（离线）上次加载的源码里只有别的节点类型，在线的别的 Agent 上有：表单用它的，不显示「找不到这个节点类型」", () => {
		const other = [{ name: "other", inputs: io({ x: {} }), outputs: io({}) }];
		const agents = [agent("agent-a", "online", NEW), agent("agent-b", "offline", other)];
		const { checked, form } = inspectorNodeType(
			doc("agent-b"),
			{ ...node, agent: "agent-b" },
			new Map(),
			agents,
		);
		expect(checked).toBeUndefined();
		expect(form?.name).toBe("tune");
		expect(Object.keys(form?.inputs.properties ?? {})).toEqual(["host", "extra"]);
	});
});

describe("uncheckedInputs：检查跳过时，节点上填了、表单那份里没有的输入", () => {
	const nodeWith = (inputs: Record<string, unknown>) => ({ package: "tuner", inputs });
	const old = OLD[0] as never;

	it("开发版本检查跳过：表单那份没有的输入列出来（extra），表单有的不列", () => {
		expect(
			uncheckedInputs(doc(), nodeWith({ host: "h", extra: "x" }), {
				checked: undefined,
				form: old,
			}),
		).toEqual(["extra"]);
	});

	it("表单是 null（找不到这个节点类型）或 undefined（没有 Agent 加载）：节点上填的每个输入都列出来", () => {
		const inputs = nodeWith({ host: "h", extra: "x" });
		expect(uncheckedInputs(doc(), inputs, { checked: undefined, form: null })).toEqual([
			"host",
			"extra",
		]);
		expect(uncheckedInputs(doc(), inputs, { checked: undefined, form: undefined })).toEqual([
			"host",
			"extra",
		]);
	});

	it("检查做了（checked 有）、或者是已发布的版本：不列（前者由「没有声明」管，后者的目录还在加载）", () => {
		const inputs = nodeWith({ host: "h", extra: "x" });
		expect(uncheckedInputs(doc(), inputs, { checked: old, form: old })).toEqual([]);
		expect(uncheckedInputs(doc(), inputs, { checked: null, form: null })).toEqual([]);
		const published = StoredOrchestrationDocument.parse({
			...doc(),
			packages: { tuner: "1.0.0" },
		});
		expect(uncheckedInputs(published, inputs, { checked: undefined, form: undefined })).toEqual([]);
	});

	it("原型链上的名字不算表单有（constructor）：节点上填了 constructor，表单没声明它，就列出来", () => {
		expect(
			uncheckedInputs(doc(), nodeWith({ host: "h", constructor: "x" }), {
				checked: undefined,
				form: old,
			}),
		).toEqual(["constructor"]);
	});
});

describe("completionTypes：引用补全和「复制输出引用」按每个上游节点自己的声明取", () => {
	const withOut = (outputs: Record<string, unknown>) => [
		{ name: "tune", inputs: io({ host: {} }), outputs: io(outputs) },
	];
	const pkgNode = (id: string, agentName: string) => ({
		id,
		kind: "package",
		package: "tuner",
		node: "tune",
		inputs: {},
		agent: agentName,
	});
	/**
	 * 同一个包、同一个节点类型的三个节点：t 派发到 agent-b（离线，声明了输出 out），u 派发到 agent-a（在线，旧源码，没有输出），
	 * 链是 entry → t → u → w（w 派发到 agent-a）。两台内容不同，检查整包跳过。`nodes` 数组的顺序由调用方决定。
	 */
	const chainDoc = (order: readonly string[]) => {
		const byId: Record<string, unknown> = {
			entry: { id: "entry", kind: "entry" },
			t: pkgNode("t", "agent-b"),
			u: pkgNode("u", "agent-a"),
			w: pkgNode("w", "agent-a"),
		};
		return StoredOrchestrationDocument.parse({
			default_agent: "agent-a",
			nodes: order.map((id) => byId[id]),
			edges: [
				{ from: "entry", to: "t", kind: "chain" },
				{ from: "t", to: "u", kind: "chain" },
				{ from: "u", to: "w", kind: "chain" },
			],
			packages: { tuner: DEV_VERSION },
		});
	};
	const agents = [
		agent("agent-a", "online", withOut({})),
		agent("agent-b", "offline", withOut({ out: { type: "string" } })),
	];
	const ORDERS = [
		["entry", "t", "u", "w"],
		["entry", "u", "t", "w"], // 下游的节点先建
		["w", "u", "t", "entry"],
	] as const;
	const outputsOfChoices = (d: StoredOrchestrationDocument, at: string) =>
		referenceChoices(d, at, completionTypes(d, new Map(), agents))
			.filter((c) => c.kind === "output")
			.map((c) => c.expression);
	const menuOutputs = (d: StoredOrchestrationDocument, id: string) =>
		declaredOutputs(
			d,
			d.nodes.find((n) => n.id === id) as StoredNode,
			completionTypes(d, new Map(), agents),
		);

	it.each(
		ORDERS,
	)("同一个节点类型的两个节点派发到不同的 Agent：各列各的输出（nodes 顺序 %s %s %s %s）", (...order) => {
		const d = chainDoc(order);
		// w 的补全：t 用 agent-b 的声明（有 out），u 用 agent-a 的（没有输出）。
		expect(outputsOfChoices(d, "w")).toEqual(["nodes.t.outputs.out"]);
		// u 的补全只能看到上游的 t。
		expect(outputsOfChoices(d, "u")).toEqual(["nodes.t.outputs.out"]);
		// 「复制输出引用」同理：t 有输出，u 没有。
		expect(menuOutputs(d, "t")).toEqual(["out"]);
		expect(menuOutputs(d, "u")).toEqual([]);
	});

	it("nodes 数组顺序倒过来，每个节点列出的输出不变", () => {
		const results = ORDERS.map((order) => {
			const d = chainDoc(order);
			return [outputsOfChoices(d, "w"), menuOutputs(d, "t"), menuOutputs(d, "u")];
		});
		expect(results[1]).toEqual(results[0]);
		expect(results[2]).toEqual(results[0]);
	});

	it("补全不改检查：检查用的目录不变，节点类型查不到时 checked 仍是 undefined（警告和控制面一致）", () => {
		const d = chainDoc(ORDERS[0]);
		const t = d.nodes.find((n) => n.id === "t") as { package: string; node: string; agent: string };
		expect(inspectorNodeType(d, t, new Map(), agents).checked).toBeUndefined();
	});

	it("检查用的目录里有这个包：用目录的（同 checked）", () => {
		const d = chainDoc(ORDERS[0]);
		const catalog = new Map([[packageKey("tuner", "dev"), withOut({ other: {} })]]);
		const lookup = completionTypes(d, catalog as never, agents);
		expect(
			Object.keys(lookup({ package: "tuner", node: "tune" })?.outputs.properties ?? {}),
		).toEqual(["other"]);
	});

	it("没有 Agent 加载它：查不到（undefined）；不是开发版本：按目录（目录里没有也是 undefined）", () => {
		const d = chainDoc(ORDERS[0]);
		expect(
			completionTypes(d, new Map(), [agent("agent-a", "online")])({
				package: "tuner",
				node: "tune",
			}),
		).toBeUndefined();
		const published = StoredOrchestrationDocument.parse({ ...d, packages: { tuner: "1.0.0" } });
		expect(
			completionTypes(published, new Map(), agents)({ package: "tuner", node: "tune" }),
		).toBeUndefined();
	});
});

describe("formSourceNote：表单的声明取自别的 Agent 时说明字段是哪台上报的", () => {
	it("inspectorNodeType 的 from：表单取自别的 Agent 才有值；取自节点派发到的那台、取自检查用的目录时没有", () => {
		const other = [{ name: "other", inputs: io({ x: {} }), outputs: io({}) }];
		const target = { ...node, agent: "agent-b" };
		// 目标 agent-b（离线）上次加载的源码里没有 tune：表单取自 agent-a。
		const fallback = inspectorNodeType(doc("agent-b"), target, new Map(), [
			agent("agent-a", "online", NEW),
			agent("agent-b", "offline", other),
		]);
		expect(fallback.from).toBe("agent-a");
		// 目标自己上报了：不用说明。
		const own = inspectorNodeType(doc("agent-b"), target, new Map(), [
			agent("agent-a", "online", OLD),
			agent("agent-b", "offline", NEW),
		]);
		expect(own.from).toBeUndefined();
		// 检查用的目录里有：不用说明。
		const catalog = new Map([[packageKey("tuner", "dev"), NEW]]);
		expect(inspectorNodeType(doc(), node, catalog as never, []).from).toBeUndefined();
		// 找不到这个节点类型（form 是 null）：没有字段可说明。
		const missing = inspectorNodeType(doc(), node, new Map(), [agent("agent-a", "online", other)]);
		expect(missing.form).toBeNull();
		expect(missing.from).toBeUndefined();
	});

	it("说明写明字段取自哪台、节点派发到的是哪台；没有确定的 Agent 时说没有确定的 Agent；from 没有值时没有说明", () => {
		const d = doc("agent-b");
		expect(formSourceNote(d, { agent: "agent-b" }, "agent-a")).toBe(
			"表单按 agent-a 上报的声明生成；节点派发到的 agent-b 的声明查不到，没有检查。",
		);
		const noDefault = StoredOrchestrationDocument.parse({ ...d, default_agent: undefined });
		expect(formSourceNote(noDefault, {}, "agent-a")).toBe(
			"表单按 agent-a 上报的声明生成；这个节点没有确定的 Agent，没有检查。",
		);
		expect(formSourceNote(d, { agent: "agent-b" }, undefined)).toBeUndefined();
	});
});

describe("devReports：Agent 列表 → 给 @sfly/orchestration 里按派发目标取节点类型的纯函数（控制面用的是同一个）", () => {
	it("在线与否、加载了哪些开发包都带上，没有上报元信息的开发包是 undefined", () => {
		const reports = devReports([
			agent("agent-a", "online", OLD),
			agent("agent-b", "offline"),
			agent("agent-c", "online"),
		]);
		expect(reports.map((r) => [r.name, r.online, [...r.devPackages.keys()]])).toEqual([
			["agent-a", true, ["tuner"]],
			["agent-b", false, []],
			["agent-c", true, []],
		]);
		expect(reports[0]?.devPackages.get("tuner")).toBe(OLD);
	});
});

describe("devNodes：「添加节点」菜单用的", () => {
	it("加载了这个包的 Agent 里第一台（在线的优先）上报的，不合法的是 undefined", () => {
		expect(
			devNodes([agent("agent-a", "offline", OLD), agent("agent-b", "online", NEW)], "tuner"),
		).toEqual(NEW);
		expect(devNodes([agent("agent-a", "online", "坏了")], "tuner")).toBeUndefined();
		expect(devNodes([agent("agent-a", "online")], "tuner")).toBeUndefined();
	});
});
