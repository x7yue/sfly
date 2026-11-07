import type { OrchestrationDocument, OrchestrationNode } from "@sfly/schema";

/**
 * 编排的结构规则（docs/SEMANTICS.md §1.2）。保存时只产生警告，触发时必须全部通过。
 * 只读取结构相关的字段，画布上的草稿和已保存的文档都可以直接传进来。
 */
export interface StructureDocument {
	default_agent?: string | undefined;
	nodes: readonly {
		id: string;
		kind: OrchestrationNode["kind"];
		agent?: string | undefined;
		/** 子流程入口的名称。 */
		name?: string | undefined;
		/** 停止子流程节点要停止的子流程（子流程入口的节点 ID）。 */
		subflow?: string | undefined;
	}[];
	edges: readonly Pick<OrchestrationDocument["edges"][number], "from" | "to" | "kind">[];
}

type StructureNode = StructureDocument["nodes"][number];
type StructureEdge = StructureDocument["edges"][number];

export type StructureWarningCode =
	| "entry_count"
	| "unknown_node"
	| "invalid_dispatch"
	| "multiple_outgoing"
	| "multiple_incoming"
	| "entry_incoming"
	| "cycle"
	| "async_without_dispatch"
	| "async_multiple_dispatch"
	| "subflow_not_triggered"
	| "subflow_multiple_triggers"
	| "subflow_name_empty"
	| "subflow_name_duplicate"
	| "stop_subflow_unset"
	| "stop_subflow_unknown"
	| "stop_subflow_before_trigger"
	| "stop_subflow_out_of_scope"
	| "nesting_too_deep"
	| "orphan_node"
	| "missing_agent";

export interface StructureWarning {
	code: StructureWarningCode;
	message: string;
	/** 警告所指的节点（连线问题指向连线的起点或不存在的端点）。 */
	node_id?: string;
}

/** 子流程嵌套深度上限（主链为第 0 层）。 */
export const MAX_NESTING_DEPTH = 3;

/**
 * 子流程的名称（GLOSSARY「子流程」）：子流程入口节点上填写的名称，去掉首尾空白；
 * 没有名称字段的旧版本以节点 ID 作为名称（ADR 0016）。填了空名称时为空字符串。
 */
export const subflowName = (node: { id: string; name?: string | undefined }): string =>
	node.name === undefined ? node.id : node.name.trim();

const isStart = (node: StructureNode) => node.kind === "entry" || node.kind === "subflow_entry";

/** 按连线种类索引的出线 / 入线。只统计两端都存在的连线。 */
function indexEdges(doc: StructureDocument) {
	const byId = new Map(doc.nodes.map((n) => [n.id, n]));
	const out = { chain: new Map<string, string[]>(), dispatch: new Map<string, string[]>() };
	const into = { chain: new Map<string, string[]>(), dispatch: new Map<string, string[]>() };
	for (const edge of doc.edges) {
		if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
		out[edge.kind].set(edge.from, [...(out[edge.kind].get(edge.from) ?? []), edge.to]);
		into[edge.kind].set(edge.to, [...(into[edge.kind].get(edge.to) ?? []), edge.from]);
	}
	return { byId, out, into };
}

/** 有效的调度连线：从异步任务节点连到子流程入口节点。 */
const isValidDispatch = (byId: Map<string, StructureNode>, edge: StructureEdge) =>
	byId.get(edge.from)?.kind === "async" && byId.get(edge.to)?.kind === "subflow_entry";

/** 从 start 沿链上的出线能否走到 target。 */
function reaches(out: Map<string, string[]>, start: string, target: string): boolean {
	const stack = [start];
	const seen = new Set<string>();
	while (stack.length > 0) {
		const id = stack.pop() as string;
		if (id === target) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		stack.push(...(out.get(id) ?? []));
	}
	return false;
}

/**
 * 画布上新增一条连线前的检查：链只允许单入单出，不分叉、不汇合、不成环；
 * 调度连线只能从异步任务节点连到子流程入口节点，两端各恰好一条。
 * 允许时返回 null，否则返回拒绝原因。
 */
export function checkConnection(doc: StructureDocument, edge: StructureEdge): string | null {
	const { byId, out, into } = indexEdges(doc);
	const from = byId.get(edge.from);
	const to = byId.get(edge.to);
	if (!from) return `节点 ${edge.from} 不存在`;
	if (!to) return `节点 ${edge.to} 不存在`;

	if (edge.kind === "dispatch") {
		if (from.kind !== "async") return "调度连线只能从异步任务节点连出";
		if (to.kind !== "subflow_entry") return "调度连线只能连到子流程入口节点";
		if ((out.dispatch.get(from.id) ?? []).length > 0) {
			return `异步任务节点 ${from.id} 已有调度连线`;
		}
		const trigger = (into.dispatch.get(to.id) ?? [])[0];
		if (trigger !== undefined) return `子流程入口节点 ${to.id} 已被异步任务节点 ${trigger} 触发`;
		return null;
	}

	if (from.id === to.id) return "节点不能连到自己";
	if (to.kind === "entry") return "入口节点不能有入线";
	if (to.kind === "subflow_entry") return "子流程入口节点只能由调度连线触发";
	if ((out.chain.get(from.id) ?? []).length > 0) return `节点 ${from.id} 已有出线，链不能分叉`;
	if ((into.chain.get(to.id) ?? []).length > 0) return `节点 ${to.id} 已有入线，链不能汇合`;
	if (reaches(out.chain, to.id, from.id)) return "连线会形成环";
	return null;
}

/** 结构检查：返回全部警告（顺序固定：按规则分类，同类按节点 / 连线在文档中的顺序）。 */
export function structureWarnings(doc: StructureDocument): StructureWarning[] {
	const warnings: StructureWarning[] = [];
	const warn = (code: StructureWarningCode, message: string, node_id?: string) =>
		warnings.push(node_id === undefined ? { code, message } : { code, message, node_id });
	const { byId, out, into } = indexEdges(doc);
	const count = (m: Map<string, string[]>, id: string) => (m.get(id) ?? []).length;

	const entries = doc.nodes.filter((n) => n.kind === "entry");
	if (entries.length !== 1) {
		warn("entry_count", `场景必须恰好有一个入口节点，当前有 ${entries.length} 个`);
	}

	for (const edge of doc.edges) {
		for (const id of [edge.from, edge.to]) {
			if (!byId.has(id))
				warn("unknown_node", `连线 ${edge.from} → ${edge.to} 指向不存在的节点 ${id}`, id);
		}
	}
	for (const edge of doc.edges) {
		if (edge.kind !== "dispatch" || !byId.has(edge.from) || !byId.has(edge.to)) continue;
		if (!isValidDispatch(byId, edge)) {
			warn(
				"invalid_dispatch",
				`调度连线 ${edge.from} → ${edge.to} 必须从异步任务节点连到子流程入口节点`,
				edge.from,
			);
		}
	}

	for (const node of doc.nodes) {
		if (count(out.chain, node.id) > 1) {
			warn("multiple_outgoing", `节点 ${node.id} 有多条出线，链不能分叉`, node.id);
		}
	}
	for (const node of doc.nodes) {
		if (!isStart(node) && count(into.chain, node.id) > 1) {
			warn("multiple_incoming", `节点 ${node.id} 有多条入线，链不能汇合`, node.id);
		}
	}
	for (const node of doc.nodes) {
		if (isStart(node) && count(into.chain, node.id) > 0) {
			warn(
				"entry_incoming",
				node.kind === "entry"
					? `入口节点 ${node.id} 不能有入线`
					: `子流程入口节点 ${node.id} 不能有链上的入线`,
				node.id,
			);
		}
	}

	// 环：沿链上的出线做深度优先搜索，遇到回边时在回边指向的节点上报告。
	const state = new Map<string, "visiting" | "done">();
	const cyclic = new Set<string>();
	const visit = (id: string) => {
		state.set(id, "visiting");
		for (const next of out.chain.get(id) ?? []) {
			const s = state.get(next);
			if (s === "visiting") cyclic.add(next);
			else if (s === undefined) visit(next);
		}
		state.set(id, "done");
	};
	for (const node of doc.nodes) if (!state.has(node.id)) visit(node.id);
	for (const node of doc.nodes) {
		if (cyclic.has(node.id)) warn("cycle", `链在节点 ${node.id} 处形成环`, node.id);
	}

	const validDispatch = (id: string, direction: "out" | "into") =>
		((direction === "out" ? out : into).dispatch.get(id) ?? []).filter((other) =>
			isValidDispatch(
				byId,
				direction === "out"
					? { from: id, to: other, kind: "dispatch" }
					: { from: other, to: id, kind: "dispatch" },
			),
		);
	for (const node of doc.nodes) {
		if (node.kind !== "async") continue;
		const n = validDispatch(node.id, "out").length;
		if (n === 0) {
			warn("async_without_dispatch", `异步任务节点 ${node.id} 没有连到子流程入口节点`, node.id);
		} else if (n > 1) {
			warn("async_multiple_dispatch", `异步任务节点 ${node.id} 只能连一个子流程入口节点`, node.id);
		}
	}
	for (const node of doc.nodes) {
		if (node.kind !== "subflow_entry") continue;
		const n = validDispatch(node.id, "into").length;
		if (n === 0) {
			warn("subflow_not_triggered", `子流程入口节点 ${node.id} 没有被异步任务节点触发`, node.id);
		} else if (n > 1) {
			warn(
				"subflow_multiple_triggers",
				`子流程入口节点 ${node.id} 只能被一个异步任务节点触发`,
				node.id,
			);
		}
	}

	// 子流程名称：非空、场景内唯一（停止子流程节点按名称选择子流程，SEMANTICS §4.1）。
	const subflows = doc.nodes.filter((n) => n.kind === "subflow_entry");
	const named = new Map<string, string[]>();
	for (const node of subflows) {
		const name = subflowName(node);
		if (name === "") continue;
		named.set(name, [...(named.get(name) ?? []), node.id]);
	}
	for (const node of subflows) {
		const name = subflowName(node);
		if (name === "") {
			warn("subflow_name_empty", `子流程入口节点 ${node.id} 没有填写名称`, node.id);
			continue;
		}
		const same = named.get(name) ?? [];
		if (same.length > 1) {
			warn(
				"subflow_name_duplicate",
				`子流程名称「${name}」重复（子流程入口节点 ${same.join("、")}）`,
				node.id,
			);
		}
	}

	// 停止子流程节点的引用（SEMANTICS §4.1 第 1 条）：只能停止本链在它之前触发的子流程及其下级子流程。
	const members = chainMembers(doc);
	for (const node of doc.nodes) {
		if (node.kind !== "stop_subflow") continue;
		if (!node.subflow) {
			warn("stop_subflow_unset", `停止子流程节点 ${node.id} 没有选择子流程`, node.id);
			continue;
		}
		const target = byId.get(node.subflow);
		if (target?.kind !== "subflow_entry") {
			warn(
				"stop_subflow_unknown",
				`停止子流程节点 ${node.id} 要停止的子流程 ${node.subflow} 不存在`,
				node.id,
			);
			continue;
		}
		const own = chainOf(members, node.id);
		// 不在任何链上的节点由孤立节点检查报告。
		if (!own || candidatesOf(doc, members, node.id).includes(target.id)) continue;
		const name = subflowName(target) || target.id;
		const trigger = validDispatch(target.id, "into").find((id) => own.includes(id));
		if (trigger !== undefined) {
			warn(
				"stop_subflow_before_trigger",
				`停止子流程节点 ${node.id} 在触发子流程「${name}」的异步任务节点 ${trigger} 之前`,
				node.id,
			);
		} else {
			warn(
				"stop_subflow_out_of_scope",
				`停止子流程节点 ${node.id} 只能停止本链触发的子流程，「${name}」不是`,
				node.id,
			);
		}
	}

	// 嵌套深度：从入口节点（第 0 层）出发，沿链走到异步任务节点，再沿调度连线进入下一层子流程。
	const depthOf = new Map<string, number>();
	const queue: [string, number][] = entries.map((e) => [e.id, 0]);
	while (queue.length > 0) {
		const [start, depth] = queue.shift() as [string, number];
		if (depthOf.has(start)) continue;
		depthOf.set(start, depth);
		const seen = new Set<string>();
		for (let id: string | undefined = start; id !== undefined && !seen.has(id); ) {
			seen.add(id);
			for (const sub of validDispatch(id, "out")) queue.push([sub, depth + 1]);
			id = (out.chain.get(id) ?? [])[0];
		}
	}
	for (const node of doc.nodes) {
		const depth = depthOf.get(node.id);
		if (node.kind === "subflow_entry" && depth !== undefined && depth > MAX_NESTING_DEPTH) {
			warn(
				"nesting_too_deep",
				`子流程 ${node.id} 嵌套在第 ${depth} 层，最多 ${MAX_NESTING_DEPTH} 层`,
				node.id,
			);
		}
	}

	// 孤立节点：从任何链的起点沿链上的出线都走不到的节点。
	const onChain = new Set<string>();
	const stack = doc.nodes.filter(isStart).map((n) => n.id);
	while (stack.length > 0) {
		const id = stack.pop() as string;
		if (onChain.has(id)) continue;
		onChain.add(id);
		stack.push(...(out.chain.get(id) ?? []));
	}
	for (const node of doc.nodes) {
		if (!onChain.has(node.id)) warn("orphan_node", `节点 ${node.id} 不在任何链上`, node.id);
	}

	for (const node of doc.nodes) {
		if (node.kind === "package" && !node.agent && !doc.default_agent) {
			warn("missing_agent", `节点 ${node.id} 没有选择 Agent，场景也没有默认 Agent`, node.id);
		}
	}
	return warnings;
}

/** 节点所在链的成员（chainMembers 的一项）；不在任何链上时为 undefined。 */
function chainOf(members: Map<string, string[]>, nodeId: string): string[] | undefined {
	for (const ids of members.values()) if (ids.includes(nodeId)) return ids;
	return undefined;
}

function candidatesOf(
	doc: StructureDocument,
	members: Map<string, string[]>,
	nodeId: string,
): string[] {
	const own = chainOf(members, nodeId);
	if (!own) return [];
	const { byId, out } = indexEdges(doc);
	const triggered = (id: string) =>
		(out.dispatch.get(id) ?? []).filter((to) =>
			isValidDispatch(byId, { from: id, to, kind: "dispatch" }),
		);
	const result: string[] = [];
	const queue = own.slice(0, own.indexOf(nodeId)).flatMap(triggered);
	while (queue.length > 0) {
		const sub = queue.shift() as string;
		if (result.includes(sub)) continue;
		result.push(sub);
		for (const id of members.get(sub) ?? []) queue.push(...triggered(id));
	}
	return result;
}

/**
 * 停止子流程节点可以停止的子流程（SEMANTICS §4.1 第 1 条）：本链上排在它前面的异步任务节点直接触发的子流程，
 * 以及这些子流程直接或间接触发的子流程；按触发的先后（广度优先）返回子流程入口的节点 ID。
 * 画布的子流程选择器只列出这些候选，结构检查对其余目标给出警告。
 */
export function stopCandidates(doc: StructureDocument, nodeId: string): string[] {
	return candidatesOf(doc, chainMembers(doc), nodeId);
}

/**
 * 每条链（主链和各个子流程）上的节点：起点节点 ID → 从起点沿链上的出线走到的节点 ID（按链上顺序，含起点）。
 * 画布按它画子流程区域，运行视图按它把节点对应到链实例。
 */
export function chainMembers(doc: StructureDocument): Map<string, string[]> {
	const { out } = indexEdges(doc);
	const members = new Map<string, string[]>();
	for (const start of doc.nodes.filter(isStart)) {
		const ids: string[] = [];
		const seen = new Set<string>();
		for (let id: string | undefined = start.id; id !== undefined && !seen.has(id); ) {
			seen.add(id);
			ids.push(id);
			id = (out.chain.get(id) ?? [])[0];
		}
		members.set(start.id, ids);
	}
	return members;
}
