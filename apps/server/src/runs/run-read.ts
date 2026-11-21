import { nodeNameBeforeId, subflowName } from "@sfly/orchestration";
import {
	type AttemptView,
	type CurrentAction,
	failuresInOrder,
	isActiveStatus,
	type NodeStatus,
	type RunListActiveNode,
	type RunView,
	type StoredNode,
	type StoredOrchestrationDocument,
} from "@sfly/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { currentActionOfTask } from "../actions/action-summary.js";
import { clockOffsetView } from "../agents/agent-clock.js";
import type { Db, Tx } from "../db/database.js";
import {
	type ChainStatus,
	chainInstances,
	feishuMessages,
	orchestrations,
	orchestrationVersions,
	runs,
	type TaskLogIssues,
	type TaskProgress,
	type TaskStatus,
	taskActionSummaries,
	tasks,
} from "../db/schema.js";
import { agentFor, chainsForReading } from "../engine/chain.js";
import { maskDeep, maskSecrets, secretValues } from "../logs/secrets.js";
import { taskProgressView } from "../logs/task-logs.js";
import { runPresetView } from "../presets/run-preset.js";
import { isUuid } from "../util/uuid.js";

/*
 * 运行的读取：一批运行的运行行、绑定的场景版本、链实例、每个节点的状态和尝试，一次读出。运行视图、运行列表、控制台、
 * 关注项读数和运行通知都从这里读，不各自查链实例和任务。
 *
 * - 查询次数与运行数无关；同一场景版本的链路只规划一次。
 * - 节点状态取这个节点在链实例上按 attempt 升序的最后一行任务（含占位，见 {@link isPlaceholderAttempt}），
 *   还没有任务行时为 pending；`attempts` 是真正的尝试，不含占位。
 * - 链实例按层级、开始时间、ID 排序；每个链实例只列出它那条链（主链或子流程）上的节点，按节点在链上的顺序。
 * - 用户内容（运行和链实例的参数、任务的输入、输出、错误信息、进度消息、正在做的动作）都已按这次运行此刻的 secret 值
 *   打码（src/logs/secrets.ts），读取方拿不到原文。ID、状态、时间等字段原样返回。
 */

/** `board` 只读状态和时间（运行列表、控制台、运行通知）；`full` 还读输入、输出、错误信息和运行通知的状态（运行视图、关注项读数）。 */
export type RunReadDetail = "board" | "full";

/** 节点的一次尝试（一个任务，不是占位）。 */
export interface RunAttempt {
	taskId: string;
	attempt: number;
	status: TaskStatus;
	/** 任务的 Agent（agent_name）；内置节点为 null。 */
	agent: string | null;
	queuedAt: Date;
	startedAt: Date | null;
	endedAt: Date | null;
	/** 最新进度，消息已打码。 */
	progress: TaskProgress | null;
}

/** `full` 读出的一次尝试：多了输入、输出、错误信息和日志里的 WARN / ERROR 等。 */
export interface RunAttemptDetail extends RunAttempt {
	inputs: Record<string, unknown> | null;
	outputs: Record<string, unknown> | null;
	/** 错误（错误类型和打码后的错误信息），同运行视图里尝试的 `error`；没有错误类型时为 null。 */
	error: AttemptView["error"];
	/** 打码后的错误信息（关注项按它判断失败和重试的原因）。 */
	errorMessage: string | null;
	logIssues: TaskLogIssues | null;
	startClockOffset: AttemptView["start_clock_offset"];
	endClockOffset: AttemptView["end_clock_offset"];
	/** 此刻正在做的动作（任务还在执行时），名称已打码。 */
	currentAction: CurrentAction | null;
}

export interface RunNode<A extends RunAttempt = RunAttempt> {
	node_id: string;
	/** 运行绑定版本里的显示名称（子流程入口节点是子流程名称）；没有时为 undefined。 */
	display_name: string | undefined;
	/** 运行绑定版本里的种类；已移除的种类（ADR 0028）是它当时的种类名，历史运行照常能看。 */
	kind: StoredNode["kind"];
	/** 节点包节点在这个版本里选的 Agent；内置节点为 null。 */
	agent: string | null;
	status: NodeStatus;
	/** 真正的尝试，按 attempt 升序。 */
	attempts: A[];
	/**
	 * 节点状态取的最后一行是没开始就被取消或停止的占位（节点的第一次尝试，或重试在排队时被取消、被停止）时，那一行的结束时间；
	 * 不是时为 null。这时状态和起止时间要取同一行：没开始（起点为空），结束是取消或停止的时间，不是上一次真正执行过的尝试的。
	 * 被跳过的占位不算。
	 */
	closedWhileQueued: { endedAt: Date | null } | null;
}

export interface RunChain<A extends RunAttempt = RunAttempt> {
	id: string;
	chain_id: string;
	/** 运行绑定版本里的子流程名称；主链为 undefined。 */
	subflow_name: string | undefined;
	/** 派发这个子流程实例的异步任务节点所在的链实例；主链为 null。 */
	parent_chain_instance_id: string | null;
	/** 派发这个子流程实例的异步任务节点；主链为 null。 */
	async_node_id: string | null;
	depth: number;
	status: ChainStatus;
	/** 链的参数，已打码。 */
	params: Record<string, unknown>;
	startedAt: Date;
	endedAt: Date | null;
	nodes: RunNode<A>[];
}

export interface RunRead<A extends RunAttempt = RunAttempt> {
	/** 运行行；`params` 已打码。 */
	run: typeof runs.$inferSelect;
	/** 运行绑定的场景版本。 */
	version: { id: string; number: number; document: StoredOrchestrationDocument };
	/** 场景此刻的名称和关注项（不属于场景版本）。 */
	scenario: Pick<typeof orchestrations.$inferSelect, "name" | "focusItems">;
	/**
	 * 按这次运行此刻的 secret 值给一段文字打码：读取方在读取结果之外拿到用户内容（任务动作摘要里的失败的动作等）时，
	 * 和读取结果里的用户内容用同一个口径。
	 */
	maskText: (text: string) => string;
	chains: RunChain<A>[];
	/** 进行中的节点（排队、准备中、执行中、等待），按链与链上的顺序。 */
	activeNodes: RunListActiveNode[];
	/**
	 * 最终失败的节点，按失败的先后（@sfly/schema 的 `failuresInOrder`，结束时间取节点最后一次尝试的结束时间）：
	 * 第一项是「第一个失败的节点」。
	 */
	failures: Array<{ chain: RunChain<A>; node: RunNode<A> }>;
}

export interface RunReadFull extends RunRead<RunAttemptDetail> {
	/** 运行通知的状态（#232）。 */
	runNotification: RunView["run_notification"];
}

/**
 * 读一批运行，按传入的运行 ID 原样作键返回（UUID 不分大小写；不存在或不是 UUID 的运行不在结果里）。`db` 可以是事务：运行通知在写入运行最终状态的事务里读，
 * 要看到这个事务里刚写下的节点状态；所有查询一个接一个地走 `db`，不从连接池另取连接。
 */
export async function readRuns(
	db: Db | Tx,
	runIds: readonly string[],
	detail?: "board",
): Promise<Map<string, RunRead>>;
export async function readRuns(
	db: Db | Tx,
	runIds: readonly string[],
	detail: "full",
): Promise<Map<string, RunReadFull>>;
export async function readRuns(
	db: Db | Tx,
	runIds: readonly string[],
	detail: RunReadDetail = "board",
): Promise<Map<string, RunRead | RunReadFull>> {
	const asked = runIds.filter(isUuid);
	// 数据库里的 UUID 是小写：按小写读，再按传入的写法作键，调用方用原来的 ID 就取得到。
	const reads = await readByIds(db, [...new Set(asked.map((id) => id.toLowerCase()))], detail);
	return new Map(
		asked.flatMap((id) => {
			const read = reads.get(id.toLowerCase());
			return read ? [[id, read] as const] : [];
		}),
	);
}

/** {@link readRuns} 的读取：`ids` 是小写、去重后的 UUID，结果按数据库里的运行 ID 作键。 */
async function readByIds(
	db: Db | Tx,
	ids: readonly string[],
	detail: RunReadDetail,
): Promise<Map<string, RunRead | RunReadFull>> {
	if (ids.length === 0) return new Map();
	const rows = await db
		.select({
			run: runs,
			version: {
				id: orchestrationVersions.id,
				number: orchestrationVersions.number,
				document: orchestrationVersions.document,
			},
			scenario: { name: orchestrations.name, focusItems: orchestrations.focusItems },
		})
		.from(runs)
		.innerJoin(orchestrationVersions, eq(orchestrationVersions.id, runs.orchestrationVersionId))
		.innerJoin(orchestrations, eq(orchestrations.id, runs.orchestrationId))
		.where(inArray(runs.id, ids));
	if (rows.length === 0) return new Map();
	const found = rows.map((r) => r.run.id);
	const chains = await db
		.select()
		.from(chainInstances)
		.where(inArray(chainInstances.runId, found))
		.orderBy(asc(chainInstances.depth), asc(chainInstances.startedAt), asc(chainInstances.id));

	if (detail === "board") {
		const taskRows = await db
			.select({
				id: tasks.id,
				runId: tasks.runId,
				chainInstanceId: tasks.chainInstanceId,
				nodeId: tasks.nodeId,
				attempt: tasks.attempt,
				agentName: tasks.agentName,
				status: tasks.status,
				queuedAt: tasks.queuedAt,
				startedAt: tasks.startedAt,
				endedAt: tasks.endedAt,
				progress: tasks.progress,
			})
			.from(tasks)
			.where(inArray(tasks.runId, found))
			.orderBy(asc(tasks.attempt));
		return assemble(rows, chains, taskRows, attemptOf, (read) => read);
	}

	const taskRows = (
		await db
			.select({ task: tasks, currentAction: taskActionSummaries.currentAction })
			.from(tasks)
			.leftJoin(taskActionSummaries, eq(taskActionSummaries.taskId, tasks.id))
			.where(inArray(tasks.runId, found))
			.orderBy(asc(tasks.attempt))
	).map(({ task, currentAction }) => ({ ...task, currentAction }));
	const notifications = await runNotificationStates(
		db,
		rows.map((r) => r.run),
	);
	return assemble(rows, chains, taskRows, attemptDetailOf, (read) => ({
		...read,
		runNotification: notifications.get(read.run.id) ?? null,
	}));
}

/** 一个运行的运行视图（契约见 @sfly/schema 的 runsApi）；运行不存在时为 undefined。 */
export async function getRunView(db: Db | Tx, runId: string): Promise<RunView | undefined> {
	const read = (await readRuns(db, [runId], "full")).get(runId);
	return read && runView(read);
}

/**
 * 这一行是不是占位，不是真正的一次尝试：被跳过的节点、还没开始就被取消或停止的尝试（例如子流程被停止时还在排队的重试）。
 * 运行的读取和指标目录都按它数尝试；节点状态仍取最后一行（含占位）。
 */
export const isPlaceholderAttempt = (t: { status: TaskStatus; startedAt: Date | null }): boolean =>
	t.status === "skipped" ||
	((t.status === "cancelled" || t.status === "stopped") && t.startedAt === null);

/** 链实例的子流程名称（链起点是子流程入口节点时，取自文档）；主链为 undefined。 */
export function subflowNameOf(
	document: StoredOrchestrationDocument,
	chainId: string,
): string | undefined {
	const start = document.nodes.find((n) => n.id === chainId);
	return start?.kind === "subflow_entry" ? subflowName(start) : undefined;
}

/** 运行绑定版本里节点的显示名称（同运行视图里节点的 `display_name`）；没有这个节点或没有名称时为 undefined。 */
export function nodeNameIn(
	document: StoredOrchestrationDocument,
	nodeId: string,
): string | undefined {
	const node = document.nodes.find((n) => n.id === nodeId);
	return node && nodeNameBeforeId(node);
}

type RunRow = typeof runs.$inferSelect;
type ChainRow = typeof chainInstances.$inferSelect;
interface TaskRowBase {
	runId: string;
	chainInstanceId: string;
	nodeId: string;
	status: TaskStatus;
	startedAt: Date | null;
	endedAt: Date | null;
}
type BoardTaskRow = TaskRowBase & {
	id: string;
	attempt: number;
	agentName: string | null;
	queuedAt: Date;
	endedAt: Date | null;
	progress: TaskProgress | null;
};
type FullTaskRow = typeof tasks.$inferSelect & { currentAction: CurrentAction | null };

/** 打码：只打用户内容。 */
interface Masker {
	text(value: string): string;
	deep<T>(value: T): T;
	secrets: readonly string[];
}

function masker(secrets: readonly string[]): Masker {
	return {
		text: (value) => maskSecrets(value, secrets),
		deep: (value) => maskDeep(value, secrets),
		secrets,
	};
}

function attemptOf(row: BoardTaskRow, mask: Masker): RunAttempt {
	return {
		taskId: row.id,
		attempt: row.attempt,
		status: row.status,
		agent: row.agentName,
		queuedAt: row.queuedAt,
		startedAt: row.startedAt,
		endedAt: row.endedAt,
		progress: row.progress && { ...row.progress, message: mask.text(row.progress.message) },
	};
}

function attemptDetailOf(row: FullTaskRow, mask: Masker): RunAttemptDetail {
	return {
		...attemptOf(row, mask),
		inputs: mask.deep(row.inputs),
		outputs: mask.deep(row.outputs),
		error: row.errorKind
			? {
					kind: row.errorKind,
					message: mask.text(row.errorMessage ?? ""),
					location: row.errorLocation === null ? null : mask.text(row.errorLocation),
				}
			: null,
		errorMessage: row.errorMessage === null ? null : mask.text(row.errorMessage),
		logIssues: row.logIssues,
		startClockOffset: clockOffsetView(row.startClockOffsetMs, row.startClockOffsetMeasuredAt),
		endClockOffset: clockOffsetView(row.endClockOffsetMs, row.endClockOffsetMeasuredAt),
		currentAction: currentActionOfTask(row.status, row.currentAction, mask.secrets),
	};
}

function assemble<T extends TaskRowBase, A extends RunAttempt, R extends RunRead<A>>(
	rows: ReadonlyArray<Pick<RunRead<A>, "run" | "version" | "scenario">>,
	chainRows: readonly ChainRow[],
	taskRows: readonly T[],
	toAttempt: (row: T, mask: Masker) => A,
	finish: (read: RunRead<A>) => R,
): Map<string, R> {
	const tasksOf = groupBy(taskRows, (t) => `${t.chainInstanceId}/${t.nodeId}`);
	const chainsOf = groupBy(chainRows, (c) => c.runId);
	const plans = new Map<string, (chainId: string) => readonly StoredNode[]>();
	const planOf = (version: RunRead["version"]) => {
		let plan = plans.get(version.id);
		if (!plan) {
			// 运行绑定的版本里可以有已移除种类的节点（ADR 0028）：历史运行照常读出它们。
			const chains = chainsForReading(version.document);
			plan = (chainId) => chains?.get(chainId) ?? [];
			plans.set(version.id, plan);
		}
		return plan;
	};

	const reads = new Map<string, R>();
	for (const { run, version, scenario } of rows) {
		const { document } = version;
		const runChains = chainsOf.get(run.id) ?? [];
		const mask = masker(secretValues(document, runChains));
		const nodesOf = planOf(version);
		const chains = runChains.map(
			(chain): RunChain<A> => ({
				id: chain.id,
				chain_id: chain.chainId,
				subflow_name: subflowNameOf(document, chain.chainId),
				parent_chain_instance_id: chain.parentChainInstanceId,
				async_node_id: chain.asyncNodeId,
				depth: chain.depth,
				status: chain.status,
				params: mask.deep(chain.params),
				startedAt: chain.startedAt,
				endedAt: chain.endedAt,
				nodes: nodesOf(chain.chainId).map((node) => {
					const rowsOfNode = tasksOf.get(`${chain.id}/${node.id}`) ?? [];
					const last = rowsOfNode.at(-1);
					return {
						node_id: node.id,
						display_name: nodeNameBeforeId(node),
						kind: node.kind,
						agent: node.kind === "package" ? agentFor(document, node) : null,
						status: last?.status ?? "pending",
						attempts: rowsOfNode
							.filter((row) => !isPlaceholderAttempt(row))
							.map((row) => toAttempt(row, mask)),
						closedWhileQueued:
							last && last.status !== "skipped" && isPlaceholderAttempt(last)
								? { endedAt: last.endedAt }
								: null,
					};
				}),
			}),
		);
		reads.set(
			run.id,
			finish({
				run: { ...run, params: mask.deep(run.params) },
				version,
				scenario,
				maskText: mask.text,
				chains,
				activeNodes: activeNodesOf(chains),
				failures: failuresInOrder(
					chains,
					(node) => node.attempts.at(-1)?.endedAt?.getTime() ?? null,
				),
			}),
		);
	}
	return reads;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const row of rows) {
		const k = key(row);
		const list = groups.get(k);
		if (list) list.push(row);
		else groups.set(k, [row]);
	}
	return groups;
}

function activeNodesOf(chains: readonly RunChain[]): RunListActiveNode[] {
	return chains.flatMap((chain) =>
		chain.nodes.flatMap(({ node_id, display_name, status, attempts }) => {
			// 进行中的节点的最后一行就是它最新的一次尝试（排队、准备、执行、等待都不是占位）。
			const last = attempts.at(-1);
			if (!last || !isActiveStatus(status)) return [];
			return {
				chain_instance_id: chain.id,
				node_id,
				display_name,
				status,
				attempt: last.attempt,
				agent: last.agent,
				started_at: last.startedAt?.toISOString() ?? null,
				progress: last.progress
					? { current: last.progress.current, total: last.progress.total }
					: null,
			};
		}),
	);
}

/**
 * 运行通知的状态（#232）：运行上记着发给了哪个机器人；队列里的消息给出排队中、已送达、失败、已丢弃，
 * 没进队列的是未发送。队列里的记录过了保留期被清理后什么也不剩，为 null。
 */
async function runNotificationStates(
	db: Db | Tx,
	runRows: readonly RunRow[],
): Promise<Map<string, RunView["run_notification"]>> {
	const states = new Map<string, RunView["run_notification"]>();
	const queued = runRows.filter(
		(r) => r.notificationBot !== null && r.notificationNotSent === null,
	);
	const messages =
		queued.length === 0
			? []
			: await db
					.select({
						runId: feishuMessages.runId,
						status: feishuMessages.status,
						lastError: feishuMessages.lastError,
					})
					.from(feishuMessages)
					.where(
						and(
							inArray(
								feishuMessages.runId,
								queued.map((r) => r.id),
							),
							eq(feishuMessages.source, "run_notification"),
						),
					);
	for (const run of runRows) {
		const bot = run.notificationBot;
		if (bot === null) continue;
		if (run.notificationNotSent !== null) {
			states.set(run.id, { status: "not_sent", bot, reason: run.notificationNotSent });
			continue;
		}
		const message = messages.find((m) => m.runId === run.id);
		if (!message) continue;
		const settled = message.status === "failed" || message.status === "discarded";
		states.set(run.id, { status: message.status, bot, reason: settled ? message.lastError : null });
	}
	return states;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** 运行视图：`full` 读取的投影。 */
function runView(read: RunReadFull): RunView {
	const { run, version } = read;
	return {
		id: run.id,
		orchestration_id: run.orchestrationId,
		orchestration_version: version.number,
		status: run.status,
		triggered_by: run.triggeredBy,
		triggered_via: run.triggeredVia,
		params: run.params,
		preset: runPresetView(run),
		started_at: run.startedAt.toISOString(),
		ended_at: iso(run.endedAt),
		run_notification: read.runNotification,
		cancel: run.cancelRequestedAt
			? {
					requested_by: run.cancelRequestedBy ?? "",
					requested_via: run.cancelRequestedVia,
					requested_at: run.cancelRequestedAt.toISOString(),
					forced_at: iso(run.cancelForcedAt),
				}
			: null,
		chains: read.chains.map((chain) => ({
			id: chain.id,
			chain_id: chain.chain_id,
			name: chain.subflow_name ?? null,
			parent_chain_instance_id: chain.parent_chain_instance_id,
			async_node_id: chain.async_node_id,
			depth: chain.depth,
			status: chain.status,
			params: chain.params,
			started_at: chain.startedAt.toISOString(),
			ended_at: iso(chain.endedAt),
			nodes: chain.nodes.map((node) => {
				const attempts = node.attempts.map(attemptView);
				const last = attempts.at(-1);
				return {
					node_id: node.node_id,
					display_name: node.display_name,
					kind: node.kind,
					status: node.status,
					agent: node.agent,
					outputs: last?.outputs ?? null,
					error: last?.error ?? null,
					attempts,
				};
			}),
		})),
	};
}

function attemptView(a: RunAttemptDetail): AttemptView {
	return {
		task_id: a.taskId,
		attempt: a.attempt,
		status: a.status,
		agent: a.agent,
		inputs: a.inputs,
		outputs: a.outputs,
		error: a.error,
		queued_at: a.queuedAt.toISOString(),
		started_at: iso(a.startedAt),
		ended_at: iso(a.endedAt),
		start_clock_offset: a.startClockOffset,
		end_clock_offset: a.endClockOffset,
		// 进度消息在读取时已打码。
		progress: a.progress ? taskProgressView(a.progress, []) : null,
		current_action: a.currentAction,
	};
}
