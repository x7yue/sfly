import { UNNAMED_SUBFLOW_LABEL } from "@sfly/orchestration";
import type {
	AttemptView,
	ChainRunView,
	LogOrigin,
	NodeRunView,
	OrchestrationDocument,
	OrchestrationNode,
	ProgressEvent,
	RunLogScope,
	RunView,
	TaskProgressView,
} from "@sfly/schema";
import { KIND_META } from "#/components/canvas/node-display";
import { runStatusView, type StatusKind } from "#/components/status";
import { chainLabel as chainName, subflowLabel } from "#/lib/copy";
import { type NodeRef, nodeKey } from "./monitor-state";

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
	if (target) return `${KIND_META.stop_subflow.label}「${target}」`;
	return KIND_META[node.kind].label;
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

/**
 * 合并日志里一行的来源节点（#220）：「子流程名 / 节点 ID #尝试序号」。主链省略子流程名；节点只有一次尝试时
 * 省略尝试序号（运行视图里还没有新的尝试时，按这一行自己的序号判断）。
 */
export function logOrigin(run: RunView, origin: LogOrigin): string {
	const node = findNode(run, { chainInstanceId: origin.chain_instance_id, nodeId: origin.node_id });
	const retried = origin.attempt > 1 || (node?.attempts.length ?? 0) > 1;
	const subflow = origin.subflow === null ? "" : `${origin.subflow || UNNAMED_SUBFLOW_LABEL} / `;
	return `${subflow}${origin.node_id}${retried ? ` #${origin.attempt}` : ""}`;
}

/**
 * 日志页签合并视图的节点范围（#224）：节点筛选里勾选的、运行里有的节点，没有筛选时是全部节点（undefined）。
 * 平台自带图表的键和还不在运行里的键不是节点；清空筛选是没有任何节点（空范围），不是全部节点。
 */
export function logScope(
	run: RunView,
	filter: ReadonlySet<string> | null,
): RunLogScope | undefined {
	if (!filter) return undefined;
	return run.chains.flatMap((chain) =>
		chain.nodes
			.filter((node) => filter.has(nodeKey({ chainInstanceId: chain.id, nodeId: node.node_id })))
			.map((node) => ({ chain_instance_id: chain.id, node_id: node.node_id })),
	);
}

const nodeRefs = (run: RunView) =>
	orderedChains(run).flatMap((c) =>
		c.nodes.map((n) => ({ chainInstanceId: c.id, nodeId: n.node_id, status: n.status })),
	);

const toRef = (pick: { chainInstanceId: string; nodeId: string } | undefined): NodeRef | null =>
	pick ? { chainInstanceId: pick.chainInstanceId, nodeId: pick.nodeId } : null;

/**
 * 监控页打开运行时默认选中的节点：链接里给的节点，其次第一个失败的节点（按链的层级与节点顺序）；都没有时不选，
 * 底部面板显示全部节点合并后的日志。执行中的节点不默认选中：会把日志范围收窄到一个可能还没输出的节点，
 * 而别的节点正在写日志。
 */
export function initialSelection(run: RunView, linkedNode?: string): NodeRef | null {
	const all = nodeRefs(run);
	return toRef(
		(linkedNode ? all.find((n) => n.nodeId === linkedNode) : undefined) ??
			all.find((n) => n.status === "failed"),
	);
}

/** 运行抽屉的摘要要看最近日志的节点：{@link initialSelection} 选中的节点，其次是还在进行的节点（运行抽屉没有「不选」）。 */
export function focusNode(run: RunView, nodeId?: string): NodeRef | null {
	return (
		initialSelection(run, nodeId) ??
		toRef(
			nodeRefs(run).find((n) => ["running", "dispatched", "waiting", "queued"].includes(n.status)),
		)
	);
}

/**
 * 节点最新一次尝试的进度（ctx.progress），如 `308/3000`；没有进度为 null。
 * 进度只跟着尝试走，节点结束后仍保留最后一次上报的值。
 */
export function progressLabel(node: NodeRunView): string | null {
	const progress = node.attempts.at(-1)?.progress;
	if (!progress) return null;
	return progress.total === null ? `${progress.current}` : `${progress.current}/${progress.total}`;
}

/** 失败运行的摘要：第一个失败的节点（按链的层级与节点顺序）、它的第几次尝试与错误信息的第一行。 */
export interface RunFailure {
	ref: NodeRef;
	nodeId: string;
	/** 失败的那次尝试的序号；节点没有尝试记录时为 null。 */
	attempt: number | null;
	/** 错误信息的第一行（不含堆栈）；没有错误信息时为空字符串。 */
	message: string;
}

/** 第一个失败的节点；没有失败的节点时为 null（运行中也可能已有失败的节点）。 */
export function runFailure(run: RunView): RunFailure | null {
	for (const chain of orderedChains(run)) {
		const node = chain.nodes.find((n) => n.status === "failed");
		if (!node) continue;
		const attempt = [...node.attempts].reverse().find((a) => a.error) ?? node.attempts.at(-1);
		const error = node.error ?? attempt?.error ?? null;
		return {
			ref: { chainInstanceId: chain.id, nodeId: node.node_id },
			nodeId: node.node_id,
			attempt: attempt?.attempt ?? null,
			message: (error?.message ?? "").trim().split("\n")[0]?.trim() ?? "",
		};
	}
	return null;
}

/** 失败的那次尝试：「（第 2 次）」；节点没有尝试记录时为空。 */
export const failureAttempt = (failure: RunFailure): string =>
	failure.attempt === null ? "" : `（第 ${failure.attempt} 次）`;

/** 错误信息前的分隔：紧跟全角括号时不再加空格。 */
export const failureMessageSeparator = (failure: RunFailure): string =>
	failure.attempt === null ? " · " : "· ";

/**
 * 失败摘要：「失败于 verify（第 2 次）· AssertionError: 仍然漏拦」。
 * 监控页顶栏（悬停提示）与运行结束的通知共用这一份文字。
 */
export function failureSummary(failure: RunFailure): string {
	const message = failure.message ? `${failureMessageSeparator(failure)}${failure.message}` : "";
	return `失败于 ${failure.nodeId}${failureAttempt(failure)}${message}`;
}

/** 浏览器标签页标题前的状态符号（标题只能是文字）。 */
const TITLE_MARK: Partial<Record<StatusKind, string>> = {
	running: "●",
	ok: "✓",
	failed: "✕",
	cancelled: "○",
};

/** 运行监控页的浏览器标签页标题：「● 运行中 · 日终数据处理 · sfly」。 */
export function runDocumentTitle(run: Pick<RunView, "status" | "cancel">, name: string): string {
	const status = runStatus(run);
	const mark = TITLE_MARK[status.kind];
	return `${mark ? `${mark} ` : ""}${status.label} · ${name} · sfly`;
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
 * 运行中事件流会继续推送，下一次变化就会纠正——进度除外，见 {@link keepNewerProgress}；运行通知的投递状态也不会回退，
 * 见 {@link keepSettledNotification}。
 */
export function latestRunView(current: RunView | undefined, next: RunView): RunView {
	if (current === undefined) return next;
	if (current.status !== "running" && next.status === "running") return current;
	return keepSettledNotification(current, keepNewerProgress(current, next));
}

/**
 * 运行通知的投递状态只会从排队中变成有结果（已送达、投递失败、已丢弃），不会回到排队中（#258）。运行结束时
 * 事件流推送的视图和重新获取的响应都带着「排队中」，而结果只在投递之后的视图里：投递之前生成、之后才到达的
 * 响应（慢的重新获取）会把缓存里已有的结果改回排队中，要等下一次定时重新获取才纠正。所以缓存里已有结果、
 * 新视图仍是排队中时保留缓存里的通知状态，视图的其余部分用新到的。
 */
function keepSettledNotification(current: RunView, next: RunView): RunView {
	const settled = current.run_notification;
	if (
		settled === null ||
		settled.status === "queued" ||
		next.run_notification?.status !== "queued"
	) {
		return next;
	}
	return { ...next, run_notification: settled };
}

/**
 * 进度不在运行视图的推送条件里：只走 progress 事件，不触发新的 run 推送。所以进度推送之前查询、之后才到达的
 * 运行视图（例如事件流连上时那一次推送、重新获取的响应）会把刚推来的进度改回旧值，而之后不一定还有推送来纠正，
 * 界面就停在旧进度上（#110）。进度只会更新、不会清空，所以按尝试保留时间更新的那一份。
 */
function keepNewerProgress(current: RunView, next: RunView): RunView {
	const known = new Map<string, TaskProgressView>();
	for (const chain of current.chains)
		for (const node of chain.nodes)
			for (const a of node.attempts) if (a.progress) known.set(a.task_id, a.progress);
	const newer = (a: AttemptView) => {
		const kept = known.get(a.task_id);
		return kept && (!a.progress || progressOrder(kept) > progressOrder(a.progress))
			? kept
			: undefined;
	};
	if (!next.chains.some((c) => c.nodes.some((n) => n.attempts.some(newer)))) return next;
	return {
		...next,
		chains: next.chains.map((chain) => ({
			...chain,
			nodes: chain.nodes.map((node) => ({
				...node,
				attempts: node.attempts.map((a) => {
					const progress = newer(a);
					return progress ? { ...a, progress } : a;
				}),
			})),
		})),
	};
}

/**
 * 进度的先后：按控制面时间比（ADR 0018，Agent 时间可能倒退）；升级之前保存的进度没有控制面时间，退回 Agent 时间。
 */
const progressOrder = (p: TaskProgressView) => Date.parse(p.time ?? p.agent_time ?? "") || 0;

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
