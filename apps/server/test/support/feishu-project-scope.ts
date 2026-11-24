// 飞书机器人按项目隔离的测试（#621）共用的：带「飞书机器人」类型输入的测试节点包、入口加一串包节点的场景文档。
import { packageMetadata } from "./package-archive.js";

/** alert(bot: FeishuBot)、pick() -> {bot}、plain()：sfly build 生成的元信息。 */
export const scopeMetadata = (name: string) =>
	packageMetadata({
		name,
		version: "1.0.0",
		nodes: [
			{
				name: "alert",
				title: "告警",
				entry: `${name.replace(/-/g, "_")}:alert`,
				inputs: {
					type: "object",
					properties: { bot: { type: "string", "x-sfly-type": "feishu_bot" } },
					required: ["bot"],
					order: ["bot"],
				},
				outputs: { type: "object", properties: {} },
			},
			{
				name: "pick",
				title: "选择",
				entry: `${name.replace(/-/g, "_")}:pick`,
				inputs: { type: "object", properties: {} },
				outputs: { type: "object", properties: { bot: { type: "string" } } },
			},
			{
				name: "plain",
				title: "普通",
				entry: `${name.replace(/-/g, "_")}:plain`,
				inputs: { type: "object", properties: {} },
				outputs: { type: "object", properties: {} },
			},
		],
	});

export interface Problem {
	code: string;
	message: string;
	node_id?: string;
}

export const node = (
	id: string,
	pkg: string,
	name: string,
	inputs: Record<string, unknown> = {},
) => ({
	id,
	kind: "package",
	package: pkg,
	node: name,
	inputs,
});

/** 入口（可带参数）→ 一串包节点。 */
export const chain = (
	nodes: Record<string, unknown>[],
	pkg = "alerts",
	params: { name: string; type: string }[] = [],
	agent = "runner",
) => ({
	default_agent: agent,
	nodes: [{ id: "entry", kind: "entry", params }, ...nodes],
	edges: nodes.map((n, i) => ({
		from: i === 0 ? "entry" : (nodes[i - 1] as { id: string }).id,
		to: n.id as string,
		kind: "chain",
	})),
	packages: { [pkg]: "1.0.0" },
});
