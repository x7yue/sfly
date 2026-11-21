import {
	isRemovedNodeKind,
	type OrchestrationNode,
	removedKindLabel,
	type StoredNode,
} from "@sfly/schema";
import { subflowLabel } from "./chain-label.js";

/**
 * 一个节点显示成什么：画布卡片、检查器、版本查看画布和运行监控页共用，不各算各的。
 * 分两种写法：卡片上（{@link nodeCardText}，标题加头部种类名）和卡片以外（{@link nodeOutsideCardText}，
 * 一句说明文字）。节点有显示名称时，卡片上显示名称是标题；卡片以外写节点的名字时写成「显示名称（节点 ID）」
 * （{@link nodeNameWithId}、{@link nameWithId}）。
 */

export type NodeKind = OrchestrationNode["kind"];

/** 历史记录里可能出现的节点种类：现在支持的，加上已移除的（ADR 0028）。 */
export type StoredNodeKind = StoredNode["kind"];

/** 节点种类的名称。 */
export const NODE_KIND_LABEL: Readonly<Record<NodeKind, string>> = {
	entry: "入口",
	package: "包节点",
	async: "异步任务",
	subflow_entry: "子流程入口",
	stop_subflow: "停止子流程",
};

/**
 * 历史记录里的节点种类的名称：已移除的种类写成「已移除的节点类型」加它当时的种类名（ADR 0028），
 * 运行监控、时间线、日志里的这类节点不报错。
 */
export const nodeKindLabel = (kind: StoredNodeKind): string =>
	isRemovedNodeKind(kind) ? removedKindLabel(kind) : NODE_KIND_LABEL[kind];

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

/**
 * 不带显示名称时的卡片标题（节点类型标题、子流程名称……）：清掉显示名称后卡片上写的就是它，
 * 所以改名输入框和检查器的显示名称输入框拿它做占位提示。
 */
export function nodeDefaultTitle(node: StoredNode, lookup: NodeDisplayLookup): string {
	switch (node.kind) {
		case "subflow_entry":
			return subflowLabel(node);
		case "package":
			return lookup.titleOf?.(node.package, node.node) ?? node.node;
		case "stop_subflow":
			// 卡片标题显示要停止的子流程名称（故事 9）；目标不存在时显示节点 ID，由校验面板提示。
			return node.subflow
				? `停止「${lookup.subflowLabelOf?.(node.subflow) ?? node.subflow}」`
				: NODE_KIND_LABEL.stop_subflow;
		default:
			return nodeKindLabel(node.kind);
	}
}

/**
 * 卡片头部 ID 旁的种类名：包节点不显示（标题就是节点类型），标题已经说明种类时也不重复
 * （入口节点标题「入口」、异步任务节点标题「异步任务」）。
 */
function cardCaption(kind: StoredNodeKind, title: string): string | undefined {
	if (kind === "package") return undefined;
	const label = nodeKindLabel(kind);
	return title.includes(label) ? undefined : label;
}

/** 节点的显示名称（去掉首尾空白）；没写、只有空白、子流程入口节点（没有这个字段）时为 undefined。 */
export const nodeDisplayName = (
	node: StoredNode | { display_name?: string | undefined },
): string | undefined =>
	("display_name" in node ? node.display_name?.trim() : undefined) || undefined;

/**
 * 卡片上的写法：`title` 是卡片标题，`caption` 是头部 ID 旁的种类名（不需要时为 undefined）。
 * 有显示名称时标题是显示名称，原来的标题（节点类型标题、「等待 30s」……）挪到 `caption`。
 */
export function nodeCardText(
	node: StoredNode,
	lookup: NodeDisplayLookup,
): { title: string; caption: string | undefined } {
	const title = nodeDefaultTitle(node, lookup);
	const named = nodeDisplayName(node);
	if (named !== undefined) return { title: named, caption: title };
	return { title, caption: cardCaption(node.kind, title) };
}

/**
 * 卡片以外写在节点 ID 前面的名字：去掉首尾空白的显示名称；没有、只有空白或者就是节点 ID 时为 undefined。
 */
export function nameBeforeId(id: string, displayName: string | undefined): string | undefined {
	const name = displayName?.trim();
	return name && name !== id ? name : undefined;
}

/**
 * 卡片以外写节点的名字：「显示名称（节点 ID）」；没有显示名称时只写节点 ID。
 * 命令行的运行输出（`run start --wait`、`run show`、`run artifacts`）节点 ID 在前（`链:节点「显示名称」`，
 * 因为这些输出常被拿去拼下一条命令），由 Python 的 `with_display_name` 写，不用这个函数；
 * `scenario show` 不是运行输出，和这里一样写「显示名称（节点 ID）」，由 Python 的 `name_with_id` 写。
 */
export function nameWithId(id: string, displayName: string | undefined): string {
	const name = nameBeforeId(id, displayName);
	return name ? `${name}（${id}）` : id;
}

type NamedNode = {
	id: string;
	kind: string;
	display_name?: string | undefined;
	name?: string | undefined;
};

/**
 * {@link nameBeforeId} 读节点的显示名称；子流程入口节点没有显示名称，用子流程名称
 * （没有名称字段的旧版本没有名字）。控制面把它作为运行里节点的 `display_name`。
 */
export const nodeNameBeforeId = (node: NamedNode): string | undefined =>
	nameBeforeId(node.id, node.kind === "subflow_entry" ? subflowLabel(node) : nodeDisplayName(node));

/** {@link nameWithId} 读节点（{@link nodeNameBeforeId}）。接受只有 `id` 和 `kind` 的节点。 */
export const nodeNameWithId = (node: NamedNode): string =>
	nameWithId(node.id, nodeNameBeforeId(node));

/**
 * 卡片以外的写法（运行监控页时间线）：包节点是 `包名/节点类型名`，停止子流程节点带上它要停止的子流程名称
 * （看得出在等哪个子流程），其余是种类名。`declared` 是场景里的声明；运行里的节点在场景里查不到声明时
 * 只按运行里的种类 `kind` 写种类名。
 */
export function nodeOutsideCardText(
	declared: StoredNode | undefined,
	kind: StoredNodeKind,
	lookup: NodeDisplayLookup,
): string {
	if (declared?.kind === "package") return `${declared.package}/${declared.node}`;
	if (declared?.kind === "stop_subflow" && declared.subflow) {
		const target = lookup.subflowLabelOf?.(declared.subflow);
		if (target) return `${NODE_KIND_LABEL.stop_subflow}「${target}」`;
	}
	return nodeKindLabel(declared?.kind ?? kind);
}
