import type { OrchestrationDocument, OrchestrationNode } from "@sfly/schema";

export type PackageNode = Extract<OrchestrationNode, { kind: "package" }>;
export type EntryNode = Extract<OrchestrationNode, { kind: "entry" }>;
export type SubflowEntryNode = Extract<OrchestrationNode, { kind: "subflow_entry" }>;
export type AsyncTaskNode = Extract<OrchestrationNode, { kind: "async" }>;
export type StopSubflowNode = Extract<OrchestrationNode, { kind: "stop_subflow" }>;

/** 执行用的链：从起点（入口节点或子流程入口节点）开始按顺序排列的节点。 */
export interface ChainPlan {
	entry: EntryNode | SubflowEntryNode;
	nodes: OrchestrationNode[];
}

/** 整个编排的执行计划：主链和每个子流程（按起点节点 ID）。 */
export interface RunPlan {
	main: ChainPlan;
	chains: ReadonlyMap<string, ChainPlan>;
	/** 异步任务节点 ID → 它的调度连线连到的子流程入口节点 ID。 */
	dispatch: ReadonlyMap<string, string>;
}

/** 本阶段引擎支持执行的节点种类；其余种类由后续票据加入。 */
const SUPPORTED_KINDS = new Set<OrchestrationNode["kind"]>([
	"entry",
	"subflow_entry",
	"async",
	"package",
	"timer",
	"sleep",
	"stop_subflow",
]);

/**
 * 排出主链和全部子流程，并做触发前必须满足的检查（单入单出、无环、节点种类受支持、
 * 包节点有 Agent 和锁定版本、异步任务节点连到一个子流程入口节点、停止子流程节点选择了一个子流程入口节点）。
 * 返回错误列表或执行计划。
 */
export function planRun(document: OrchestrationDocument): RunPlan | { errors: string[] } {
	const entries = document.nodes.filter((n): n is EntryNode => n.kind === "entry");
	if (entries.length !== 1) {
		return { errors: [`orchestration must have exactly one entry node, found ${entries.length}`] };
	}
	const errors: string[] = [];
	const chains = new Map<string, ChainPlan>();
	const starts = document.nodes.filter(
		(n): n is EntryNode | SubflowEntryNode => n.kind === "entry" || n.kind === "subflow_entry",
	);
	for (const start of starts) {
		const plan = planChain(document, start);
		if ("errors" in plan) errors.push(...plan.errors);
		else chains.set(start.id, plan);
	}
	const dispatch = new Map<string, string>();
	for (const edge of document.edges) {
		if (edge.kind !== "dispatch") continue;
		if (dispatch.has(edge.from)) errors.push(`node ${edge.from} has more than one dispatch edge`);
		dispatch.set(edge.from, edge.to);
	}
	for (const node of document.nodes) {
		if (node.kind !== "async") continue;
		const target = dispatch.get(node.id);
		if (!target || document.nodes.find((n) => n.id === target)?.kind !== "subflow_entry") {
			errors.push(`node ${node.id}: async task node must dispatch to a subflow entry node`);
		}
	}
	for (const node of document.nodes) {
		if (node.kind !== "stop_subflow") continue;
		if (document.nodes.find((n) => n.id === node.subflow)?.kind !== "subflow_entry") {
			errors.push(`node ${node.id}: stop subflow node must select a subflow entry node`);
		}
	}
	if (errors.length > 0) return { errors };
	return { main: chains.get((entries[0] as EntryNode).id) as ChainPlan, chains, dispatch };
}

/** 从起点沿 chain 连线排出一条链。 */
export function planChain(
	document: OrchestrationDocument,
	entry: EntryNode | SubflowEntryNode,
): ChainPlan | { errors: string[] } {
	const errors: string[] = [];
	const byId = new Map(document.nodes.map((n) => [n.id, n]));
	const outgoing = new Map<string, string[]>();
	const incoming = new Map<string, number>();
	for (const edge of document.edges) {
		if (edge.kind !== "chain") continue;
		outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
		incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
	}

	const nodes: OrchestrationNode[] = [];
	const seen = new Set<string>();
	let current: OrchestrationNode | undefined = entry;
	while (current) {
		if (seen.has(current.id)) {
			errors.push(`chain contains a cycle at node ${current.id}`);
			break;
		}
		seen.add(current.id);
		nodes.push(current);
		if ((incoming.get(current.id) ?? 0) > (current === entry ? 0 : 1)) {
			errors.push(`node ${current.id} has more than one incoming chain edge`);
		}
		const next: string[] = outgoing.get(current.id) ?? [];
		if (next.length > 1) {
			errors.push(`node ${current.id} has more than one outgoing chain edge`);
			break;
		}
		const nextId: string | undefined = next[0];
		current = nextId === undefined ? undefined : byId.get(nextId);
		if (nextId !== undefined && !current)
			errors.push(`chain edge points to unknown node ${nextId}`);
	}

	for (const node of nodes) {
		if (!SUPPORTED_KINDS.has(node.kind)) {
			errors.push(`node ${node.id}: kind '${node.kind}' is not supported yet`);
		}
		if (node.kind === "package") {
			if (!(node.agent ?? document.default_agent)) {
				errors.push(
					`node ${node.id}: no agent selected and the orchestration has no default agent`,
				);
			}
			if (!document.packages[node.package]) {
				errors.push(`node ${node.id}: package ${node.package} has no locked version`);
			}
		}
	}
	return errors.length > 0 ? { errors } : { entry, nodes };
}

/** 包节点派发到的 Agent：节点另选的 Agent 优先，否则用编排的默认 Agent。 */
export function agentFor(document: OrchestrationDocument, node: PackageNode): string {
	return (node.agent ?? document.default_agent) as string;
}
