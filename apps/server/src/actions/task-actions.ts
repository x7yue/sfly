import type { ActionBatch, ActionSummary, AgentMessage } from "@sfly/proto";
import {
	ACTION_LIMITS,
	type ActionDetailView,
	type ActionNameCount,
	type ActionPage,
	type ActionSummaryView,
	isActiveStatus,
	type TaskStatus,
} from "@sfly/schema";
import { and, asc, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { AgentConnection } from "../agents/agent-hub.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import {
	runs,
	type StoredActionSummary,
	taskActionNames,
	taskActionSummaries,
	taskActions,
	tasks,
} from "../db/schema.js";
import type { TaskLogs } from "../logs/task-logs.js";
import { Topics } from "../sse/topics.js";
import { isUuid } from "../util/uuid.js";
import {
	type ActionCursor,
	type BatchPlan,
	countOnlyPeriods,
	type DetailEnd,
	type DroppedDetails,
	detailView,
	encodeActionCursor,
	planBatch,
	prepareEvents,
	type StoredDetail,
	startedNames,
	type TaskEnd,
	taskEndOf,
} from "./action-details.js";
import {
	actionSummaryView,
	isDoing,
	parseActionSummary,
	sameCurrentAction,
	summaryOfTask,
} from "./action-summary.js";

/** 写入的明细和存下的摘要，按任务发布给实时推送（{@link TaskActions.follow}）。 */
type Published =
	| { kind: "actions"; rev: number; rows: StoredDetail[] }
	| { kind: "summary"; summary: StoredActionSummary }
	/** 控制面第一次兜底丢弃这个任务的明细：摘要的 `control_plane_capped` 变了。 */
	| { kind: "capped" };

/**
 * 实时推送的一条：`actions` 的 `rev` 是这些明细的修订号；`summary` 的 `rev` 是这条流已经推送到的修订号。
 * 两者都用作事件 ID（断线后按 Last-Event-ID 接上）。
 */
export type ActionLiveEvent =
	| { kind: "summary"; summary: ActionSummaryView; rev: number }
	| { kind: "actions"; actions: ActionDetailView[]; rev: number };

/** 明细的一页查询（契约见 @sfly/schema 的 ActionPageQuery，游标已经解出）。 */
export interface ActionPageRequest {
	before?: ActionCursor;
	limit: number;
	name?: string;
	failed?: boolean;
}

/** 补发、记为未结束时每次从库里读的行数。 */
const REPLAY_PAGE = 1000;

/** 控制面兜底第一次丢弃明细时写进任务日志的警告（每个任务一次）。 */
const CAPPED_WARNING =
	`动作和标记的明细超过了控制面的上限（每个任务 ${ACTION_LIMITS.total} 个，每种名称 ${ACTION_LIMITS.perName} 个，` +
	"失败的动作不受每种名称的限制），超出的明细不再保存";

/**
 * 任务的动作（规格 #345，docs/ARCHITECTURE.md §6.3）：Agent 转发的动作摘要（ActionSummary）和明细（ActionBatch）。
 *
 * - 摘要只保留最新的一份（`task_action_summaries`），连同从里面选出的此刻在做的动作。此刻在做的动作变了（换了一个，
 *   或者没有了）时发布这次运行的变化（`runChanges`，引擎的同一个主题）：运行的事件流重新推送运行视图，尝试上带着新的
 *   `current_action`。它只在最外层、开始得最早的那个动作换了时才变。
 * - 明细每个动作、标记一行（`task_actions`），控制面兜底的上限见 action-details.ts，第一次丢弃时在任务日志里写一行
 *   警告。每写入一批，任务的修订号（`tasks.action_rev`）加一，这一批写入或结束的行记下它，实时推送按它接续。
 * - 都只接受任务所在 Agent 上报的；运行已过保留期以后迟到的不再写回。
 *
 * 和日志、进度一样不经过引擎的互斥锁（不改变运行状态）。同一个任务的摘要和明细在这里依次处理（控制面是单实例），
 * 重连时新旧连接重叠也不会交错，发布的先后就是修订号的先后；任务行只在每批事务的最后一步更新，引擎锁任务行时
 * 不用等整批写完。
 */
export class TaskActions {
	readonly #published = new Topics<Published>();
	#queues = new Map<string, Promise<void>>();

	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			logs: Pick<TaskLogs, "runSecrets" | "appendSystem">;
			/** 运行的变化（主题 = 运行 ID）：运行的事件流订阅它，这里发布此刻在做的动作的变化、订阅任务的结束。 */
			runChanges: Topics<string>;
		},
	) {}

	/** 这条 Agent 消息是否由这里处理（动作摘要、明细）。 */
	handles(message: AgentMessage): boolean {
		return message.body.case === "actionSummary" || message.body.case === "actions";
	}

	onMessage(conn: AgentConnection, message: AgentMessage): Promise<void> {
		// 收到的时刻在这里取（之后同一任务的写入要排队）：没有单调时钟读数时用它作控制面时间。
		const receivedAt = this.deps.clock.now();
		const controlPlaneTime = (monotonicMs: bigint | number) =>
			conn.clock.controlPlaneTime(monotonicMs, receivedAt);
		const { body } = message;
		if (body.case === "actionSummary") {
			return this.#serial(body.value.taskId, () =>
				this.#storeSummary(conn.name, body.value, controlPlaneTime),
			);
		}
		if (body.case === "actions") {
			return this.#serial(body.value.taskId, () =>
				this.#storeBatch(conn.name, body.value, controlPlaneTime),
			);
		}
		return Promise.resolve();
	}

	/**
	 * 存下一份摘要。不是合法的摘要时丢弃：同版本的 SDK 写的总是合法的（ADR 0014），这里不再写日志。
	 */
	async #storeSummary(
		agentName: string,
		{ taskId, eventJson }: ActionSummary,
		controlPlaneTime: (monotonicMs: number) => Date,
	): Promise<void> {
		const event = parseActionSummary(eventJson);
		if (!event || !isUuid(taskId)) return;
		const [task] = await this.deps.db
			.select({
				runId: tasks.runId,
				agentName: tasks.agentName,
				status: tasks.status,
				purgedAt: runs.purgedAt,
				current: taskActionSummaries.currentAction,
			})
			.from(tasks)
			.innerJoin(runs, eq(runs.id, tasks.runId))
			.leftJoin(taskActionSummaries, eq(taskActionSummaries.taskId, tasks.id))
			.where(eq(tasks.id, taskId));
		// 任务已经不在执行时不再更新（和明细一样，之后才到的只可能是断线补发）：摘要停在任务结束前的最后一份。
		// 这里先看一眼省掉打码，写入前在事务里再确认一次。
		if (!task || task.agentName !== agentName || task.purgedAt !== null || !isDoing(task.status))
			return;
		const { summary, current } = actionSummaryView(
			event,
			controlPlaneTime,
			await this.deps.logs.runSecrets(task.runId),
		);
		// 和明细一样在事务里锁住任务行再确认还在执行：和结束任务的写入互斥，任务结束之后不会再写进一份。
		const stored = await this.deps.db.transaction(async (tx) => {
			const [locked] = await tx
				.select({ status: tasks.status })
				.from(tasks)
				.where(eq(tasks.id, taskId))
				.for("update");
			if (!locked || !isDoing(locked.status)) return false;
			await tx
				.insert(taskActionSummaries)
				.values({ taskId, summary, currentAction: current })
				.onConflictDoUpdate({
					target: taskActionSummaries.taskId,
					set: { summary, currentAction: current },
				});
			return true;
		});
		if (!stored) return;
		this.#published.publish(taskId, { kind: "summary", summary });
		if (!sameCurrentAction(task.current, current)) {
			this.deps.runChanges.publish(task.runId, task.runId);
		}
	}

	/**
	 * 写入一批明细：读出任务已存的条数和这一批涉及的名称已存的个数，排好（{@link planBatch}），在一个事务里插入新的行、
	 * 补上更早的行的结束、更新计数和修订号。重复的明细被忽略，计数按真正插入的算。提交以后发布这一批的明细；
	 * 第一次因为兜底上限丢弃明细时在任务日志里写一行警告。任务已经不在执行时整批丢弃（规格 #345：未结束定格在任务结束的那一刻）。
	 */
	async #storeBatch(
		agentName: string,
		{ taskId, events }: ActionBatch,
		controlPlaneTime: (monotonicMs: bigint) => Date,
	): Promise<void> {
		if (!isUuid(taskId) || events.length === 0) return;
		const { db } = this.deps;
		const [task] = await db
			.select({
				runId: tasks.runId,
				agentName: tasks.agentName,
				purgedAt: runs.purgedAt,
				details: tasks.actionDetails,
				rev: tasks.actionRev,
				capped: tasks.actionCapped,
			})
			.from(tasks)
			.innerJoin(runs, eq(runs.id, tasks.runId))
			.where(eq(tasks.id, taskId));
		if (!task || task.agentName !== agentName || task.purgedAt !== null) return;
		const prepared = prepareEvents(
			events,
			controlPlaneTime,
			await this.deps.logs.runSecrets(task.runId),
		);
		const names = startedNames(prepared);
		const stored =
			names.length === 0
				? []
				: await db
						.select({ name: taskActionNames.name, stored: taskActionNames.stored })
						.from(taskActionNames)
						.where(
							and(
								eq(taskActionNames.taskId, taskId),
								sql`${taskActionNames.name} = any(${sql.param(names)}::text[])`,
							),
						);
		const rev = task.rev + 1;
		const plan = planBatch(taskId, rev, prepared, {
			details: task.details,
			stored: new Map(stored.map((n) => [n.name, n.stored])),
		});
		if (plan.inserts.length + plan.ends.length + plan.dropped.size === 0) return;
		const capping = plan.dropped.size > 0 && !task.capped;
		const written = await db.transaction(async (tx): Promise<StoredDetail[] | undefined> => {
			// 任务已经不在执行（成功、失败、取消、agent_lost）：还没结束的动作定格为未结束（detailView），这一批不再写。
			// Agent 在结果之前发完明细（ADR 0015），之后才到的只可能是断线补发。锁住任务行，和结束任务的写入互斥。
			const [locked] = await tx
				.select({ status: tasks.status })
				.from(tasks)
				.where(eq(tasks.id, taskId))
				.for("update");
			if (!locked || !isDoing(locked.status)) return undefined;
			const inserted = await insertDetails(tx, plan.inserts);
			// 库里已经有的动作在这一批里重复开始又结束：插入被忽略，结束补到已有的行上。
			const kept = new Set(inserted);
			const repeated = plan.inserts.flatMap((i) => (!kept.has(i) && i.end ? [i.end] : []));
			const ended = await endDetails(tx, taskId, rev, [...plan.ends, ...repeated]);
			await countNames(tx, taskId, inserted, plan.dropped);
			const changed = inserted.length + ended.length > 0;
			if (changed || capping) {
				await tx
					.update(tasks)
					.set({
						actionDetails: sql`${tasks.actionDetails} + ${inserted.length}`,
						...(changed ? { actionRev: rev } : {}),
						...(capping ? { actionCapped: true } : {}),
					})
					.where(eq(tasks.id, taskId));
			}
			return [...inserted.map((i) => i.row), ...ended];
		});
		if (written === undefined) return;
		if (written.length > 0)
			this.#published.publish(taskId, { kind: "actions", rev, rows: written });
		if (capping) {
			this.#published.publish(taskId, { kind: "capped" });
			await this.deps.logs.appendSystem(taskId, "warn", CAPPED_WARNING);
		}
	}

	/** 一个任务的动作摘要（任务结束后正在做的动作为空）；任务不存在时为 undefined。 */
	async summary(taskId: string): Promise<ActionSummaryView | undefined> {
		if (!isUuid(taskId)) return undefined;
		const [row] = await this.deps.db
			.select({
				status: tasks.status,
				actionCapped: tasks.actionCapped,
				summary: taskActionSummaries.summary,
			})
			.from(tasks)
			.leftJoin(taskActionSummaries, eq(taskActionSummaries.taskId, tasks.id))
			.where(eq(tasks.id, taskId));
		return row && summaryOfTask(row, row.summary);
	}

	/**
	 * 一个任务的一页明细，按开始时间从新到旧（开始时间相同时 ID 大的在前），带上起点落在这一页范围里的只计数的段；
	 * 任务不存在时为 undefined。修订号在读明细之前读：之后写入的明细可能也在这一页里（实时推送会再送一次），
	 * 但不会漏掉。运行已过保留期时是空页。
	 */
	async page(taskId: string, request: ActionPageRequest): Promise<ActionPage | undefined> {
		if (!isUuid(taskId)) return undefined;
		const { db } = this.deps;
		const [task] = await db
			.select({
				...TASK_END_COLUMNS,
				rev: tasks.actionRev,
				purgedAt: runs.purgedAt,
				names: sql<ActionNameCount[] | null>`${taskActionSummaries.summary} -> 'names'`,
				cappedAt: sql<string | null>`${taskActionSummaries.summary} ->> 'capped_at'`,
			})
			.from(tasks)
			.innerJoin(runs, eq(runs.id, tasks.runId))
			.leftJoin(taskActionSummaries, eq(taskActionSummaries.taskId, tasks.id))
			.where(eq(tasks.id, taskId));
		if (!task) return undefined;
		const empty = { task_id: taskId, actions: [], before: null, count_only: [], rev: task.rev };
		if (task.purgedAt !== null) return { ...empty, expired: true };
		const { before, limit, name, failed } = request;
		const [rows, dropped] = await Promise.all([
			db
				.select()
				.from(taskActions)
				.where(
					and(
						eq(taskActions.taskId, taskId),
						name === undefined ? undefined : eq(taskActions.name, name),
						failed ? eq(taskActions.result, "failed") : undefined,
						before &&
							sql`(${taskActions.startedAt}, ${taskActions.id}) < (${new Date(before.startedAtMs).toISOString()}::timestamptz, ${before.id})`,
					),
				)
				.orderBy(desc(taskActions.startedAt), desc(taskActions.id))
				.limit(limit + 1),
			db
				.select({
					name: taskActionNames.name,
					dropped: taskActionNames.dropped,
					droppedFrom: taskActionNames.droppedFrom,
					agentDroppedFrom: taskActionNames.agentDroppedFrom,
				})
				.from(taskActionNames)
				.where(
					and(
						eq(taskActionNames.taskId, taskId),
						gt(taskActionNames.dropped, 0),
						name === undefined ? undefined : eq(taskActionNames.name, name),
					),
				),
		]);
		const shown = rows.slice(0, limit);
		const earliest = rows.length > limit ? shown.at(-1) : undefined;
		const end = taskEndOf(task);
		return {
			...empty,
			actions: shown.map((row) => detailView(row, end)),
			before: earliest ? encodeActionCursor(earliest) : null,
			count_only: countOnlyPeriods(
				{ names: task.names ?? [], cappedAt: task.cappedAt, dropped, to: task.endedAt },
				{ name, failed },
				{
					from: earliest ? earliest.startedAt.getTime() : null,
					until: before ? before.startedAtMs : null,
				},
			),
			expired: false,
		};
	}

	/** 任务所在的运行；任务不存在时为 undefined。 */
	async runOf(taskId: string): Promise<string | undefined> {
		if (!isUuid(taskId)) return undefined;
		const [row] = await this.deps.db
			.select({ runId: tasks.runId })
			.from(tasks)
			.where(eq(tasks.id, taskId));
		return row?.runId;
	}

	/**
	 * 实时推送（`GET /tasks/:id/actions/events`）：先订阅再读，订阅之后发布的都排在读完之后、按修订号去重。
	 *
	 * 1. 先发一份摘要；运行已过保留期时之后只发摘要。
	 * 2. 补发修订号大于 `after` 的明细（之后写入或结束的），按修订号分页读，每个修订号一个事件。
	 * 3. 任务已经不在执行时，修订号不大于 `after` 的、记为未结束的明细再推送一次（浏览器之前看到的是还在做）。
	 * 4. 之后每写入一批推送一批，每存一份摘要推送一份；任务结束时推送一份正在做的为空的摘要和记为未结束的明细
	 *    （订阅这次运行的变化，任务结束以后不再订阅）。
	 *
	 * 同一个修订号的明细总在一个事件里，所以按事件 ID 接续不重复也不遗漏；记为未结束的明细带着已推送到的修订号，
	 * 断线后接上时任务已经结束，会整份再推送一次。
	 */
	follow(
		task: { taskId: string; runId: string },
		after: number,
		emit: (event: ActionLiveEvent) => void,
		onError: (error: unknown) => void,
	): () => void {
		const { taskId, runId } = task;
		let stopped = false;
		let queue = Promise.resolve();
		const serial = (work: () => Promise<void> | void) => {
			queue = queue
				.then(() => (stopped ? undefined : work()))
				.catch((error) => {
					if (stopped) return;
					stopped = true;
					onError(error);
				});
		};
		let sent = after;
		let state: { status: TaskStatus; end: TaskEnd | null } | undefined;
		let summary: StoredActionSummary | null = null;
		let actionCapped = false;
		let expired = false;
		let checking = false;
		const sendSummary = (status: TaskStatus) =>
			emit({
				kind: "summary",
				summary: summaryOfTask({ status, actionCapped }, summary),
				rev: sent,
			});
		const sendRows = (rows: StoredDetail[], rev: number, end: TaskEnd | null) =>
			emit({ kind: "actions", actions: rows.map((row) => detailView(row, end)), rev });
		const sendUnfinished = async (upTo: number, end: TaskEnd) => {
			for await (const rows of this.#unfinished(taskId, upTo)) sendRows(rows, sent, end);
		};

		serial(async () => {
			const read = await this.#followState(taskId);
			if (!read) return;
			state = read;
			summary = read.summary;
			actionCapped = read.actionCapped;
			expired = read.expired;
			if (!isActiveStatus(read.status)) unsubscribeRun();
			sendSummary(read.status);
			if (expired) return;
			for await (const { rev, rows } of this.#changedSince(taskId, sent)) {
				sent = rev;
				sendRows(rows, rev, read.end);
			}
			if (read.end) await sendUnfinished(after, read.end);
		});
		const unsubscribe = this.#published.subscribe(taskId, (event) =>
			serial(() => {
				if (!state) return;
				if (event.kind === "summary") {
					summary = event.summary;
					sendSummary(state.status);
				} else if (event.kind === "capped") {
					actionCapped = true;
					sendSummary(state.status);
				} else if (!expired && event.rev > sent) {
					sent = event.rev;
					sendRows(event.rows, event.rev, state.end);
				}
			}),
		);
		const unsubscribeRun = this.deps.runChanges.subscribe(runId, () => {
			if (checking) return;
			checking = true;
			serial(async () => {
				checking = false;
				if (!state) return;
				const now = await this.#taskEnd(taskId);
				const ended = state.end === null && now.end !== null;
				state = now;
				if (ended && now.end && !expired) {
					sendSummary(now.status);
					await sendUnfinished(sent, now.end);
				}
				if (!isActiveStatus(now.status)) unsubscribeRun();
			});
		});
		return () => {
			stopped = true;
			unsubscribe();
			unsubscribeRun();
		};
	}

	/** 实时推送连上时读的状态：任务怎么结束的、存下的摘要、运行是否已过保留期。 */
	async #followState(taskId: string) {
		const [row] = await this.deps.db
			.select({
				...TASK_END_COLUMNS,
				actionCapped: tasks.actionCapped,
				purgedAt: runs.purgedAt,
				summary: taskActionSummaries.summary,
			})
			.from(tasks)
			.innerJoin(runs, eq(runs.id, tasks.runId))
			.leftJoin(taskActionSummaries, eq(taskActionSummaries.taskId, tasks.id))
			.where(eq(tasks.id, taskId));
		return (
			row && {
				status: row.status,
				end: taskEndOf(row),
				summary: row.summary,
				actionCapped: row.actionCapped,
				expired: row.purgedAt !== null,
			}
		);
	}

	async #taskEnd(taskId: string): Promise<{ status: TaskStatus; end: TaskEnd | null }> {
		const [row] = await this.deps.db
			.select(TASK_END_COLUMNS)
			.from(tasks)
			.where(eq(tasks.id, taskId));
		if (!row) throw new Error(`task ${taskId} disappeared`);
		return { status: row.status, end: taskEndOf(row) };
	}

	/** 修订号大于 `after` 的明细，按修订号分页读，每次给出一个修订号的全部明细。 */
	async *#changedSince(
		taskId: string,
		after: number,
	): AsyncGenerator<{ rev: number; rows: StoredDetail[] }> {
		let cursor = { rev: after, id: Number.MAX_SAFE_INTEGER };
		let group: { rev: number; rows: StoredDetail[] } | undefined;
		for (;;) {
			const rows = await this.deps.db
				.select()
				.from(taskActions)
				.where(
					and(
						eq(taskActions.taskId, taskId),
						sql`(${taskActions.rev}, ${taskActions.id}) > (${cursor.rev}, ${cursor.id})`,
					),
				)
				.orderBy(asc(taskActions.rev), asc(taskActions.id))
				.limit(REPLAY_PAGE);
			for (const row of rows) {
				if (group && group.rev !== row.rev) {
					yield group;
					group = undefined;
				}
				group ??= { rev: row.rev, rows: [] };
				group.rows.push(row);
			}
			const last = rows.at(-1);
			if (!last || rows.length < REPLAY_PAGE) break;
			cursor = { rev: last.rev, id: last.id };
		}
		if (group) yield group;
	}

	/** 修订号不大于 `upTo`、还没有结束的动作，按 ID 分页读。 */
	async *#unfinished(taskId: string, upTo: number): AsyncGenerator<StoredDetail[]> {
		let after = -1;
		for (;;) {
			const rows = await this.deps.db
				.select()
				.from(taskActions)
				.where(
					and(
						eq(taskActions.taskId, taskId),
						eq(taskActions.kind, "action"),
						isNull(taskActions.result),
						lte(taskActions.rev, upTo),
						gt(taskActions.id, after),
					),
				)
				.orderBy(asc(taskActions.id))
				.limit(REPLAY_PAGE);
			const last = rows.at(-1);
			if (!last) return;
			yield rows;
			if (rows.length < REPLAY_PAGE) return;
			after = last.id;
		}
	}

	#serial(taskId: string, work: () => Promise<void>): Promise<void> {
		const previous = this.#queues.get(taskId) ?? Promise.resolve();
		const next = previous.then(work, work);
		const settled = next.catch(() => {});
		this.#queues.set(taskId, settled);
		void settled.then(() => {
			if (this.#queues.get(taskId) === settled) this.#queues.delete(taskId);
		});
		return next;
	}
}

/** 判断任务怎么结束的要读的列（{@link taskEndOf}）。 */
const TASK_END_COLUMNS = {
	status: tasks.status,
	endedAt: tasks.endedAt,
	startClockOffsetMs: tasks.startClockOffsetMs,
	endClockOffsetMs: tasks.endClockOffsetMs,
};

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const iso = (d: Date | null) => d?.toISOString() ?? null;
const json = (v: Record<string, string> | null) => (v === null ? null : JSON.stringify(v));

/**
 * 插入新的行，一条语句、每列一个数组参数（一批最多 1000 行，参数个数不随行数增长）；已有同一个 ID 的被忽略。
 * 返回真正插入的。
 */
async function insertDetails(tx: Tx, inserts: BatchPlan["inserts"]): Promise<BatchPlan["inserts"]> {
	if (inserts.length === 0) return [];
	const rows = inserts.map((i) => i.row);
	const column = <T>(pick: (row: StoredDetail) => T) => sql.param(rows.map(pick));
	const [first] = rows as [StoredDetail];
	const { rows: ids } = await tx.execute<{ id: string }>(sql`
		insert into task_actions
			(task_id, id, kind, parent, depth, name, fields, started_at, agent_started_at, start_mono,
			 ended_at, agent_ended_at, duration_ms, result, reason, rev)
		select ${first.taskId}::uuid, v.*, ${first.rev}::int8 from unnest(
			${column((r) => r.id)}::int8[], ${column((r) => r.kind)}::text[], ${column((r) => r.parent)}::int8[],
			${column((r) => r.depth)}::int4[], ${column((r) => r.name)}::text[], ${column((r) => json(r.fields))}::json[],
			${column((r) => iso(r.startedAt))}::timestamptz[], ${column((r) => iso(r.agentStartedAt))}::timestamptz[],
			${column((r) => r.startMono)}::int8[], ${column((r) => iso(r.endedAt))}::timestamptz[],
			${column((r) => iso(r.agentEndedAt))}::timestamptz[], ${column((r) => r.durationMs)}::int8[],
			${column((r) => r.result)}::text[], ${column((r) => r.reason)}::text[]
		) as v
		on conflict do nothing
		returning id`);
	const kept = new Set(ids.map((r) => Number(r.id)));
	return inserts.filter((i) => kept.has(i.row.id));
}

/** 补上更早的行的结束（只对还没结束的动作生效），一条语句；返回结束了的行。 */
async function endDetails(
	tx: Tx,
	taskId: string,
	rev: number,
	ends: readonly DetailEnd[],
): Promise<StoredDetail[]> {
	if (ends.length === 0) return [];
	const column = <T>(pick: (end: DetailEnd) => T) => sql.param(ends.map(pick));
	return tx
		.update(taskActions)
		.set({
			endedAt: sql`v.ended_at`,
			agentEndedAt: sql`v.agent_ended_at`,
			durationMs: sql`greatest(0, v.end_mono - ${taskActions.startMono})`,
			result: sql`v.result`,
			reason: sql`v.reason`,
			noted: sql`v.noted`,
			rev,
		})
		.from(
			sql`unnest(
				${column((e) => e.id)}::int8[], ${column((e) => iso(e.at))}::timestamptz[],
				${column((e) => iso(e.agentAt))}::timestamptz[], ${column((e) => e.mono)}::int8[],
				${column((e) => e.result)}::text[], ${column((e) => e.reason)}::text[], ${column((e) => json(e.noted))}::json[]
			) as v(id, ended_at, agent_ended_at, end_mono, result, reason, noted)`,
		)
		.where(
			and(
				eq(taskActions.taskId, taskId),
				sql`${taskActions.id} = v.id`,
				eq(taskActions.kind, "action"),
				isNull(taskActions.result),
			),
		)
		.returning();
}

/**
 * 每种名称新存下的个数（不含补发的）和被丢弃的明细记进 `task_action_names`，一条语句。被丢弃的明细的起点取最早的
 * 开始（补发的失败动作开始得比之前的明细早）。
 */
async function countNames(
	tx: Tx,
	taskId: string,
	inserted: BatchPlan["inserts"],
	dropped: BatchPlan["dropped"],
): Promise<void> {
	const counts = new Map<string, { stored: number; dropped?: DroppedDetails }>();
	for (const { row, late } of inserted) {
		if (late) continue;
		const c = counts.get(row.name) ?? { stored: 0 };
		c.stored += 1;
		counts.set(row.name, c);
	}
	for (const [name, d] of dropped)
		counts.set(name, { stored: counts.get(name)?.stored ?? 0, dropped: d });
	if (counts.size === 0) return;
	const entries = [...counts];
	const column = <T>(pick: (entry: (typeof entries)[number]) => T) => sql.param(entries.map(pick));
	await tx.execute(sql`
		insert into task_action_names as n (task_id, name, stored, dropped, dropped_from, agent_dropped_from)
		select ${taskId}::uuid, v.* from unnest(
			${column(([name]) => name)}::text[], ${column(([, c]) => c.stored)}::int4[],
			${column(([, c]) => c.dropped?.count ?? 0)}::int4[], ${column(([, c]) => iso(c.dropped?.from ?? null))}::timestamptz[],
			${column(([, c]) => iso(c.dropped?.agentFrom ?? null))}::timestamptz[]
		) as v
		on conflict (task_id, name) do update set
			stored = n.stored + excluded.stored,
			dropped = n.dropped + excluded.dropped,
			dropped_from = case when n.dropped_from is null or excluded.dropped_from < n.dropped_from
				then excluded.dropped_from else n.dropped_from end,
			agent_dropped_from = case when n.dropped_from is null or excluded.dropped_from < n.dropped_from
				then excluded.agent_dropped_from else n.agent_dropped_from end`);
}
