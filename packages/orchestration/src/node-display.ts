import type { OrchestrationNode } from "@sfly/schema";
import { subflowLabel } from "./chain-label.js";

/**
 * 一个节点显示成什么：画布卡片、检查器、版本查看画布和运行监控页共用，不各算各的。
 * 分两种写法：卡片上（{@link nodeCardText}，标题加头部种类名）和卡片以外（{@link nodeOutsideCardText}，
 * 一句说明文字）。
 */

export type NodeKind = OrchestrationNode["kind"];

/** 节点种类的名称。 */
export const NODE_KIND_LABEL: Readonly<Record<NodeKind, string>> = {
	entry: "入口",
	package: "包节点",
	timer: "定时",
	sleep: "Sleep",
	async: "异步任务",
	subflow_entry: "子流程入口",
	stop_subflow: "停止子流程",
	feishu_notify: "飞书通知",
};

/** 显示规则要查的场景和节点包信息；调用方手上没有的不给，对应的节点按查不到写。 */
export interface NodeDisplayLookup {
	/** 包节点类型的标题（来自节点包元信息）。 */
	titleOf?(pkg: string, node: string): string | undefined;
	/** 子流程入口节点 ID → 子流程的显示名称；不是子流程入口时为 undefined。 */
	subflowLabelOf?(id: string): string | undefined;
}

/** 文档里子流程入口节点 ID → 显示名称的查找（{@link NodeDisplayLookup.subflowLabelOf}）。 */
export function subflowLabels(doc: {
	nodes: readonly { id: string; kind: string; name?: string | undefined }[];
}): (id: string) => string | undefined {
	const labels = new Map(
		doc.nodes.filter((n) => n.kind === "subflow_entry").map((n) => [n.id, subflowLabel(n)]),
	);
	return (id) => labels.get(id);
}

function cardTitle(node: OrchestrationNode, lookup: NodeDisplayLookup): string {
	switch (node.kind) {
		case "subflow_entry":
			return subflowLabel(node);
		case "package":
			return lookup.titleOf?.(node.package, node.node) ?? node.node;
		case "timer":
			return `等到 ${node.at}`;
		case "sleep":
			return `等待 ${node.duration}`;
		case "stop_subflow":
			// 卡片标题显示要停止的子流程名称（故事 9）；目标不存在时显示节点 ID，由校验面板提示。
			return node.subflow
				? `停止「${lookup.subflowLabelOf?.(node.subflow) ?? node.subflow}」`
				: NODE_KIND_LABEL.stop_subflow;
		default:
			return NODE_KIND_LABEL[node.kind];
	}
}

/**
 * 卡片头部 ID 旁的种类名：包节点不显示（标题就是节点类型），标题已经说明种类时也不重复
 * （入口节点标题「入口」、异步任务节点标题「异步任务」）。
 */
function cardCaption(kind: NodeKind, title: string): string | undefined {
	if (kind === "package") return undefined;
	const label = NODE_KIND_LABEL[kind];
	return title.includes(label) ? undefined : label;
}

/** 卡片上的写法：`title` 是卡片标题，`caption` 是头部 ID 旁的种类名（不需要时为 undefined）。 */
export function nodeCardText(
	node: OrchestrationNode,
	lookup: NodeDisplayLookup,
): { title: string; caption: string | undefined } {
	const title = cardTitle(node, lookup);
	return { title, caption: cardCaption(node.kind, title) };
}

/**
 * 卡片以外的写法（运行监控页时间线）：包节点是 `包名/节点类型名`，停止子流程节点带上它要停止的子流程名称
 * （看得出在等哪个子流程），其余是种类名。运行里的节点在场景里已经没有声明时只给种类，写种类名。
 */
export function nodeOutsideCardText(
	node: OrchestrationNode | { kind: NodeKind },
	lookup: NodeDisplayLookup,
): string {
	const declared = "id" in node ? node : undefined;
	if (declared?.kind === "package") return `${declared.package}/${declared.node}`;
	if (declared?.kind === "stop_subflow" && declared.subflow) {
		const target = lookup.subflowLabelOf?.(declared.subflow);
		if (target) return `${NODE_KIND_LABEL.stop_subflow}「${target}」`;
	}
	return NODE_KIND_LABEL[node.kind];
}
