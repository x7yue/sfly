import { packageKey } from "@sfly/orchestration";
import { type AgentView, DEV_VERSION, StoredOrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	completionCatalog,
	devNodes,
	devReports,
	inspectorNodeType,
	uncheckedInputs,
} from "./catalog";

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

describe("completionCatalog：引用补全和「复制输出引用」用的目录", () => {
	const withOut = (outputs: Record<string, unknown>) => [
		{ name: "tune", inputs: io({ host: {} }), outputs: io(outputs) },
	];
	/** 节点 t 派发到 agent-b（离线，声明了输出 out），u 派发到 agent-a（在线，旧源码，没有输出）：内容不同，检查整包跳过。 */
	const twoNodes = StoredOrchestrationDocument.parse({
		default_agent: "agent-a",
		nodes: [
			{ id: "entry", kind: "entry" },
			{ id: "t", kind: "package", package: "tuner", node: "tune", inputs: {}, agent: "agent-b" },
			{ id: "u", kind: "package", package: "tuner", node: "tune", inputs: {}, agent: "agent-a" },
		],
		edges: [
			{ from: "entry", to: "t", kind: "chain" },
			{ from: "t", to: "u", kind: "chain" },
		],
		packages: { tuner: DEV_VERSION },
	});
	const agents = [
		agent("agent-a", "online", withOut({})),
		agent("agent-b", "offline", withOut({ out: { type: "string" } })),
	];

	it("检查跳过的开发版本包：用表单那份补上，上游节点 t 的输出（out）列得出来；检查用的目录本身不变", () => {
		const catalog = new Map();
		const filled = completionCatalog(twoNodes, catalog, agents);
		const types = filled.get(packageKey("tuner", "dev")) ?? [];
		expect(types.map((n) => n.name)).toEqual(["tune"]);
		// t 派发到 agent-b：它声明的输出在补上的那份里（同一个节点类型名，先到先得，取 t 的）。
		expect(Object.keys(types[0]?.outputs.properties ?? {})).toEqual(["out"]);
		expect(catalog.size).toBe(0);
	});

	it("检查用的目录里已经有这个包：原样返回（同一个对象），不重算", () => {
		const catalog = new Map([[packageKey("tuner", "dev"), NEW]]);
		expect(completionCatalog(twoNodes, catalog as never, agents)).toBe(catalog);
	});

	it("没有 Agent 加载它、或不是开发版本：原样返回", () => {
		const catalog = new Map();
		expect(completionCatalog(twoNodes, catalog, [agent("agent-a", "online")])).toBe(catalog);
		const published = StoredOrchestrationDocument.parse({
			...twoNodes,
			packages: { tuner: "1.0.0" },
		});
		expect(completionCatalog(published, catalog, agents)).toBe(catalog);
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
