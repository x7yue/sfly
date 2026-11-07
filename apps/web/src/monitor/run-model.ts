import type {
	ChainRunView,
	NodeRunView,
	OrchestrationDocument,
	OrchestrationNode,
	ProgressEvent,
	RunView,
} from "@sfly/schema";
import { subflowLabel } from "#/components/canvas/node-display";
import { runStatusView } from "#/components/status";
import { chainLabel as chainName } from "#/lib/copy";
import type { NodeRef } from "./monitor-state";

/** 运行监控页对运行视图的整理：状态显示、链实例的层级顺序、节点标题与取消的影响。 */

/** 运行的状态；取消后等待清理的运行显示为「取消中」，不是「运行中」。 */
export const runStatus = (run: Pick<RunView, "status" | "cancel">) =>
	runStatusView(run.status, { cancelling: run.cancel !== null, forced: !!run.cancel?.forced_at });

/** 链实例的状态；运行取消后还没结束的链同样显示为「取消中」。 */
export const chainRunStatus = (chain: ChainRunView, cancelling: boolean) =>
	runStatusView(chain.status, { cancelling });

/** 链实例按层级排列：主链在前，每个子流程实例紧跟在派发它的链后面（同级按开始时间）。 */
export function orderedChains(run: RunView): ChainRunView[] {
	const children = new Map<string | null, ChainRunView[]>();
	for (const chain of run.chains) {
		const parent = chain.parent_chain_instance_id;
		children.set(parent, [...(children.get(parent) ?? []), chain]);
	}
	const out: ChainRunView[] = [];
	const visit = (parent: string | null) => {
		const list = [...(children.get(parent) ?? [])].sort(
			(a, b) => Date.parse(a.started_at) - Date.parse(b.started_at),
		);
		for (const chain of list) {
			out.push(chain);
			visit(chain.id);
		}
	};
	visit(null);
	// 父链不在视图里的实例（不应出现）放在最后，不丢。
	for (const chain of run.chains) if (!out.includes(chain)) out.push(chain);
	return out;
}

/** 链实例的名称：主链，或「子流程 <名称> · <实例短 ID>」。 */
export const chainLabel = (chain: ChainRunView) =>
	chainName({ chain_id: chain.chain_id, subflow: chain.depth > 0, name: chain.name }, chain.id);

const KIND_TITLE: Record<OrchestrationNode["kind"], string> = {
	entry: "入口",
	subflow_entry: "子流程入口",
	async: "异步任务",
	timer: "定时",
	sleep: "Sleep",
	stop_subflow: "停止子流程",
	package: "包节点",
};

/** 节点 ID → 文档里的节点（标题、always 标记、引用了哪些参数）。 */
export const documentNodes = (doc: OrchestrationDocument | undefined) =>
	new Map((doc?.nodes ?? []).map((n) => [n.id, n]));

/**
 * 节点的说明文字：包节点是 `包/节点类型`，停止子流程节点带上它要停止的子流程名称（故事 23：看得出在等哪个子流程），
 * 其余内置节点是类型名。
 */
export function nodeTitle(
	node: NodeRunView,
	decl: OrchestrationNode | undefined,
	decls?: ReturnType<typeof documentNodes>,
): string {
	if (decl?.kind === "package") return `${decl.package}/${decl.node}`;
	const target = stopTarget(decl, decls);
	if (target) return `${KIND_TITLE.stop_subflow}「${target}」`;
	return KIND_TITLE[node.kind] ?? node.kind;
}

/** 停止子流程节点停止的子流程（按子流程入口 ID）在运行里的名称（每次运行每个子流程最多一个实例）。 */
export function stoppedSubflowLabel(run: RunView, subflowId: string): string {
	const chain = run.chains.find((c) => c.chain_id === subflowId);
	return chainName({ chain_id: subflowId, subflow: true, name: chain?.name ?? null });
}

/** 停止子流程节点要停止的子流程的显示名称；不是停止子流程节点、没有选择或目标不在文档里时为 undefined。 */
export function stopTarget(
	decl: OrchestrationNode | undefined,
	decls: ReturnType<typeof documentNodes> | undefined,
): string | undefined {
	if (decl?.kind !== "stop_subflow" || !decl.subflow) return undefined;
	const target = decls?.get(decl.subflow);
	return target?.kind === "subflow_entry" ? subflowLabel(target) : undefined;
}

export const isAlways = (decl: OrchestrationNode | undefined) =>
	!!decl && "always" in decl && decl.always === true;

export function findNode(run: RunView, ref: NodeRef | null): NodeRunView | undefined {
	if (!ref) return undefined;
	return run.chains
		.find((c) => c.id === ref.chainInstanceId)
		?.nodes.find((n) => n.node_id === ref.nodeId);
}

/** 打开运行时默认选中的节点：失败的节点，其次是执行中的节点；都没有时不选。 */
export function focusNode(run: RunView, nodeId?: string): NodeRef | null {
	const all = orderedChains(run).flatMap((c) =>
		c.nodes.map((n) => ({ chainInstanceId: c.id, nodeId: n.node_id, status: n.status })),
	);
	const pick =
		(nodeId ? all.find((n) => n.nodeId === nodeId) : undefined) ??
		all.find((n) => n.status === "failed") ??
		all.find((n) => ["running", "dispatched", "waiting", "queued"].includes(n.status));
	return pick ? { chainInstanceId: pick.chainInstanceId, nodeId: pick.nodeId } : null;
}

/** 取消整个运行的影响（docs/SEMANTICS.md §3.4），在取消确认弹窗里列出。 */
export function cancelImpact(run: RunView, doc: OrchestrationDocument | undefined) {
	const decls = documentNodes(doc);
	const nodes = run.chains.flatMap((c) => c.nodes);
	const notStarted = (n: NodeRunView) => n.status === "pending" || n.status === "queued";
	return {
		/** 正在执行（或派发中、等待中）的节点：先优雅终止。 */
		running: nodes.filter((n) => ["running", "dispatched", "waiting"].includes(n.status)),
		/** 还没开始的 always 节点：照常执行清理。 */
		always: nodes.filter((n) => notStarted(n) && isAlways(decls.get(n.node_id))),
		/** 还没开始的普通节点：标记为已取消。 */
		cancelled: nodes.filter((n) => notStarted(n) && !isAlways(decls.get(n.node_id))),
	};
}

/** 入口参数和子流程入口参数中标记为敏感的参数名。 */
export function secretParams(doc: OrchestrationDocument | undefined): Set<string> {
	return new Set(
		(doc?.nodes ?? [])
			.flatMap((n) =>
				n.kind === "entry" || n.kind === "subflow_entry" ? n.params.filter((p) => p.secret) : [],
			)
			.map((p) => p.name),
	);
}

/**
 * 输入里引用了敏感参数的键：控制面已把 secret 的值替换成掩码，这里再把整个值打码
 * （值可能是由敏感参数拼出来的）。
 */
export function secretInputKeys(
	decl: OrchestrationNode | undefined,
	secrets: ReadonlySet<string>,
): Set<string> {
	if (secrets.size === 0 || !decl) return new Set();
	const values = decl.kind === "package" ? decl.inputs : decl.kind === "async" ? decl.params : {};
	return new Set(
		Object.entries(values)
			.filter(([, v]) =>
				[...secrets].some((s) => new RegExp(`params\\.${s}\\b`).test(JSON.stringify(v))),
			)
			.map(([k]) => k),
	);
}

export const MASK = "••••••";

/**
 * 缓存里已有的运行视图和新到的视图之间该保留哪一份（#47）。运行视图有多个来源——事件流推送、
 * 取消与触发的响应、重新获取——到达顺序不一定是生成顺序：运行结束前生成、结束后才到达的响应会把最终状态
 * 改回「运行中」，而运行已经结束，事件流不会再推送，界面就停在旧状态。运行结束后不会再回到运行中，
 * 所以已结束的视图不被「运行中」的视图覆盖。运行中的视图之间谁新谁旧无法判断，但没有关系：
 * 运行中事件流会继续推送，下一次变化就会纠正。
 */
export const latestRunView = (current: RunView | undefined, next: RunView): RunView =>
	current !== undefined && current.status !== "running" && next.status === "running"
		? current
		: next;

/** 把一条进度推送合并进运行视图（只改对应尝试的 progress）。 */
export function applyProgress(run: RunView | undefined, event: ProgressEvent): RunView | undefined {
	if (!run) return run;
	return {
		...run,
		chains: run.chains.map((chain) =>
			chain.id !== event.chain_instance_id
				? chain
				: {
						...chain,
						nodes: chain.nodes.map((node) =>
							node.node_id !== event.node_id
								? node
								: {
										...node,
										attempts: node.attempts.map((a) =>
											a.task_id === event.task_id ? { ...a, progress: event.progress } : a,
										),
									},
						),
					},
		),
	};
}
