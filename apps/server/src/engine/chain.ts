import type { OrchestrationDocument, OrchestrationNode } from "@sfly/schema";

export type PackageNode = Extract<OrchestrationNode, { kind: "package" }>;
export type EntryNode = Extract<OrchestrationNode, { kind: "entry" }>;

/** 执行用的链：从起点开始按顺序排列的节点。 */
export interface ChainPlan {
	entry: EntryNode;
	nodes: OrchestrationNode[];
}

/** 本阶段引擎支持执行的节点种类；其余种类由后续票据加入。 */
const SUPPORTED_KINDS = new Set<OrchestrationNode["kind"]>(["entry", "package"]);

/**
 * 从入口节点沿 chain 连线排出主链，并做触发前必须满足的检查
 * （单入单出、无环、节点种类受支持、包节点有 Agent 和锁定版本）。返回错误列表或执行计划。
 */
export function planMainChain(document: OrchestrationDocument): ChainPlan | { errors: string[] } {
	const errors: string[] = [];
	const entries = document.nodes.filter((n): n is EntryNode => n.kind === "entry");
	if (entries.length !== 1) {
		return { errors: [`orchestration must have exactly one entry node, found ${entries.length}`] };
	}
	const entry = entries[0] as EntryNode;
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
