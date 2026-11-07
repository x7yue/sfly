import { NODE_DEFAULTS } from "@sfly/orchestration";
import { subflowLabel } from "#/lib/copy";
import type { CanvasInfo } from "./context";
import type { DocNode } from "./flow";

/** 节点种类的名称与卡片上的两字母代号（原型 KIND）。 */
export const KIND_META: Record<DocNode["kind"], { label: string; code: string }> = {
	entry: { label: "入口", code: "IN" },
	package: { label: "包节点", code: "PK" },
	timer: { label: "定时", code: "TM" },
	sleep: { label: "Sleep", code: "SL" },
	async: { label: "异步任务", code: "AS" },
	subflow_entry: { label: "子流程入口", code: "SE" },
	stop_subflow: { label: "停止子流程", code: "ST" },
};

/** 文档里子流程入口节点 ID → 显示名称的查找（CanvasInfo.subflowLabelOf）。 */
export function subflowLabels(doc: {
	nodes: readonly { id: string; kind: string; name?: string | undefined }[];
}): (id: string) => string | undefined {
	const labels = new Map(
		doc.nodes.filter((n) => n.kind === "subflow_entry").map((n) => [n.id, subflowLabel(n)]),
	);
	return (id) => labels.get(id);
}

export function nodeTitle(node: DocNode, info: CanvasInfo): string {
	switch (node.kind) {
		case "subflow_entry":
			return subflowLabel(node);
		case "package":
			return info.titleOf(node.package, node.node) ?? node.node;
		case "timer":
			return `等到 ${node.at}`;
		case "sleep":
			return `等待 ${node.duration}`;
		case "stop_subflow":
			// 卡片标题显示要停止的子流程名称（故事 9）；目标不存在时显示节点 ID，由校验面板提示。
			return node.subflow
				? `停止「${info.subflowLabelOf(node.subflow) ?? node.subflow}」`
				: KIND_META.stop_subflow.label;
		default:
			return KIND_META[node.kind].label;
	}
}

const summarizeValue = (value: unknown): string => {
	if (typeof value === "string") {
		const ref = /^\$\{\{\s*(.*?)\s*\}\}$/.exec(value);
		return ref ? `← ${ref[1]}` : `= ${value}`;
	}
	return `= ${JSON.stringify(value)}`;
};

/** 卡片底部摘要槽的文字（编辑模式）：节点最主要的配置。 */
export function nodeSlot(node: DocNode): string {
	switch (node.kind) {
		case "entry":
		case "subflow_entry":
			return node.params.length === 0
				? "没有参数"
				: node.params.map((p) => (p.secret ? `${p.name}*` : p.name)).join(" · ");
		case "async": {
			const keys = Object.keys(node.params);
			return keys.length === 0 ? "没有参数映射" : `映射 ${keys.join(" · ")}`;
		}
		case "timer":
			return `${node.at} · ${node.tz}`;
		case "sleep":
			return node.duration;
		case "stop_subflow":
			return node.subflow ? `子流程入口 ${node.subflow}` : "未选择子流程";
		case "package": {
			const [first] = Object.entries(node.inputs);
			return first ? `${first[0]} ${summarizeValue(first[1])}` : `${node.package}/${node.node}`;
		}
	}
}

/** 卡片右上角的标签：always、另选的 Agent、重试次数。 */
export function nodeTags(node: DocNode): string[] {
	const tags: string[] = [];
	if (node.kind === "package") {
		if (node.retries !== undefined && node.retries !== NODE_DEFAULTS.retries) {
			tags.push(`重试 ${node.retries}`);
		}
		if (node.agent) tags.push(node.agent);
	}
	if ("always" in node && node.always) tags.push("always");
	return tags;
}
