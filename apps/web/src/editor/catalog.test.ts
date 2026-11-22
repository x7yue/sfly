import { packageKey } from "@sfly/orchestration";
import { type AgentView, DEV_VERSION, StoredOrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { devNodes, devReports, inspectorNodeType } from "./catalog";

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
