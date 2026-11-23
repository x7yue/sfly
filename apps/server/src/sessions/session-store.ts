import { randomUUID } from "node:crypto";
import {
	PERSISTED_SESSION_EVENT_TYPES,
	type PersistedSessionEvent,
	SESSION_HISTORY_PAGE,
	SESSION_LIST_LIMIT,
	type SessionEvent,
	SessionEventBody,
	type SessionListItem,
	type SessionStatus,
	TurnOutcome,
} from "@sfly/schema";
import { and, asc, desc, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db, Tx } from "../db/database.js";
import { projects, sessionEvents, sessions } from "../db/schema.js";
import type { ProjectId } from "../projects/project-id.js";
import { Topics } from "../sse/topics.js";
import { isUuid } from "../util/uuid.js";
import { type FollowSink, follow } from "./follow.js";

/** 库里的一个会话。 */
export type SessionRow = typeof sessions.$inferSelect;

const PERSISTED: ReadonlySet<string> = new Set(PERSISTED_SESSION_EVENT_TYPES);

/** 事件类型是不是持久的（落库的）。 */
export const isPersistedType = (type: string): boolean => PERSISTED.has(type);

/** 会话在列表里的样子：`queuePosition` 是排队中的会话排第几（从 1 起），不在排队时不给（null）。 */
export function toListItem(
	row: SessionRow,
	lastTurnOutcome: TurnOutcome | null,
	queuePosition: number | null = null,
): SessionListItem {
	return {
		id: row.id,
		title: row.title,
		status: row.status,
		created_by: row.createdBy,
		created_at: row.createdAt.toISOString(),
		last_activity_at: row.lastActivityAt.toISOString(),
		queue_position: row.status === "queued" ? queuePosition : null,
		last_turn_outcome: lastTurnOutcome,
	};
}

type EventRow = typeof sessionEvents.$inferSelect;

/** 库里的一行事件 → 读事件的一方看到的形状：`payload` 是事件里除 `type` 以外的字段，加上 `seq` 和 `at`。 */
function toEvent(row: EventRow): PersistedSessionEvent {
	return {
		...row.payload,
		type: row.type,
		seq: row.seq,
		at: row.createdAt.toISOString(),
	} as PersistedSessionEvent;
}

/** 同一个项目里已经有一个在做（`running`）的会话：同一时刻只跑一轮（`sessions_one_running_per_project`）。 */
export class ProjectBusyError extends Error {
	constructor(readonly project: string) {
		super(`项目 ${project} 里已经有一个会话在做`);
	}
}

/** 违反了一个唯一约束（沿着 `cause` 找：drizzle 把数据库错误包了一层）。 */
function violates(error: unknown, constraint: string): boolean {
	for (let e: unknown = error; e instanceof Error; e = e.cause) {
		const fields = e as { code?: unknown; constraint?: unknown };
		if (fields.code === "23505" && fields.constraint === constraint) return true;
	}
	return false;
}

/** 持久事件的内容要过 schema，不持久的类型不能落库。 */
function parsePersistent(body: SessionEventBody): SessionEventBody {
	if (!isPersistedType(body.type)) {
		throw new Error(`会话事件 ${body.type} 不持久，不能落库（用 publish 推送）`);
	}
	return SessionEventBody.parse(body);
}

/** 会话此刻在做的那一轮：在做的会话没有记过轮次（旧数据、测试里直接写库造的）时当作第 1 轮。 */
export const effectiveTurn = (session: Pick<SessionRow, "currentTurn">): number =>
	Math.max(1, session.currentTurn);

/** 提示里引用一句话的原文：太长的截断（按字符，不切开代理对）。 */
function clip(text: string, max = 40): string {
	const chars = [...text];
	return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/** 事务里记一条持久事件的结果：落库（或已有）的事件，以及是不是重复的（这一轮已经有 `turn_end`）。 */
interface Inserted {
	event: PersistedSessionEvent;
	duplicate: boolean;
	/** 这条 `turn_end` 把会话从「在做」改回了空闲（这个项目的位置空出来了，排队的可以开始）。 */
	endedTurn: boolean;
	project: ProjectId;
}

/** 助手服务发来的事件为什么不收：会话不存在、不在做、不是此刻在做的那一轮。 */
export type DropReason = "unknown_session" | "not_running" | "other_turn";

function dropReason(
	session: Pick<SessionRow, "status" | "currentTurn">,
	turn: number,
): DropReason | undefined {
	if (session.status !== "running") return "not_running";
	return turn === effectiveTurn(session) ? undefined : "other_turn";
}

/**
 * 项目里有没有**别的**会话占着位置：在做的（`running`），或者排队的（`queued`：排队的先来，新来的不能插队）。
 * 事务里查；并发的两个请求可能同时看到没有，那时由唯一约束（`sessions_one_running_per_project`）裁判，输的排队。
 */
async function occupied(tx: Tx, project: ProjectId, exceptId: string): Promise<boolean> {
	const [row] = await tx
		.select({ id: sessions.id })
		.from(sessions)
		.where(
			and(
				eq(sessions.projectId, project),
				ne(sessions.id, exceptId),
				inArray(sessions.status, ["running", "queued"]),
			),
		)
		.limit(1);
	return row !== undefined;
}

/** 事务里锁住会话那一行并取出它；不存在时抛 {@link SessionNotFoundError}。 */
async function lockSession(tx: Tx, sessionId: string): Promise<SessionRow> {
	const [session] = await tx
		.select()
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.for("update");
	if (!session) throw new SessionNotFoundError(sessionId);
	return session;
}

/** 写事件时会话不存在。 */
export class SessionNotFoundError extends Error {
	constructor(readonly sessionId: string) {
		super(`会话 ${sessionId} 不存在`);
	}
}

export interface SessionStoreDeps {
	db: Db;
	clock: Clock;
	/**
	 * 测试用的缝：一条持久事件提交之后、发布之前调用（并等它），用来在这两步之间停住，验证发布顺序和
	 * 「补发不会读到提交了但还没发布的事件」。生产里不传。
	 */
	afterCommit?: (sessionId: string, event: PersistedSessionEvent) => Promise<void>;
	/**
	 * 测试用的缝：{@link SessionStore.detail} 读到会话那一行之后、读事件之前调用（并等它），用来在这两步之间让这个会话
	 * 提交别的事件，验证读到的三样东西来自同一个快照。生产里不传。
	 */
	afterDetailRow?: (sessionId: string) => Promise<void>;
}

/**
 * 会话和它的事件（GLOSSARY「会话」，ADR 0027，类型在 `@sfly/schema` 的 `sessions.ts`）：读写 `sessions`、`session_events`，
 * 并把事件发布给订阅这个会话的 SSE 连接。只存持久的几类事件（{@link PERSISTED_SESSION_EVENT_TYPES}），
 * 增量（文字、工具输出、思考、排队状态、快照）只发布不存。
 *
 * 这个模块在 `src/sessions/` 下，不碰 `src/actions/`（那是性能关键路径）。
 */
export class SessionStore {
	/** 按会话 ID 发布的事件：持久的已经落库（带 `seq`、`at`），不持久的只在这里。 */
	readonly #live = new Topics<SessionEvent>();
	/** 每个会话一条 Promise 链：这个会话的「落库加发布」和事件流补发的读库依次执行，见 {@link SessionStore.append}。 */
	readonly #chains = new Map<string, Promise<unknown>>();

	/** 一轮结束、项目的位置空出来之后调用（见 {@link SessionStore.onTurnEnd}）。 */
	#turnEndListener: ((project: ProjectId) => void) | undefined;

	/**
	 * 每个会话此刻这一轮里「确认送到」的插话（协议「插话」一节）：助手服务的 `steer_queue`（还没送到的完整列表）里出现过，
	 * 之后又收到过一份不含它的。助手服务决定结束一轮之后不再发 `steer_queue`，所以「不含它」只可能是送到了。只放内存：
	 * 控制面重启之后这一轮由兜底结束，没有确认的都按没有确认送到处理（保守）。
	 */
	readonly #steerSeen = new Map<
		string,
		{ turn: number; listed: Set<string>; delivered: Set<string> }
	>();

	constructor(private readonly deps: SessionStoreDeps) {}

	/**
	 * 登记「一轮结束了」的监听（只有一个，会话服务用它让排队的会话开始）：`turn_end` 把会话从在做改回空闲、事务提交并发布
	 * 之后调用，参数是项目；**不等它**（它在后台做事，抛的错自己处理）。不论这条 `turn_end` 是助手服务带回来的、控制面补的
	 * （停止、兜底）还是重复的，只要这一刻会话是从「在做」改回空闲的，都算。
	 */
	onTurnEnd(listener: (project: ProjectId) => void): void {
		this.#turnEndListener = listener;
	}

	#turnEnded(project: ProjectId): void {
		try {
			this.#turnEndListener?.(project);
		} catch {
			// 监听自己处理错误；这里不能因为它让落库的调用失败。
		}
	}

	/**
	 * 在这个会话的链上依次执行：前一个（不论成败）结束了才开始。进程内的这个会话，「落库加发布」一次一个，
	 * 发布的先后就是提交的先后（也就是 `seq` 的先后）；补发读库也排在这条链上，所以读到的不会有「已经提交、
	 * 但还没发布」的事件。控制面只有一个进程（不是多副本）时成立；多副本要换成数据库的通知（那时再说）。
	 */
	#serial<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
		const previous = this.#chains.get(sessionId) ?? Promise.resolve();
		const result = previous.then(run, run);
		const tail = result.catch(() => undefined);
		this.#chains.set(sessionId, tail);
		// 链尾没有后来者时清掉，不让每个会话在 Map 里留一条。
		void tail.then(() => {
			if (this.#chains.get(sessionId) === tail) this.#chains.delete(sessionId);
		});
		return result;
	}

	/** 项目存不存在（路径里的项目标识）。 */
	async projectExists(project: ProjectId): Promise<boolean> {
		const [row] = await this.deps.db
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.id, project));
		return row !== undefined;
	}

	/** 一个会话；ID 不是 UUID 或不存在时为 undefined。 */
	async find(id: string): Promise<SessionRow | undefined> {
		if (!isUuid(id)) return undefined;
		const [row] = await this.deps.db.select().from(sessions).where(eq(sessions.id, id));
		return row;
	}

	/**
	 * 项目里的会话：在做和排队中的在前，其余按最近活动倒序（#551 的写法）；带上一轮的结局，排队中的带排第几。
	 * 同样活跃的按 ID 排，顺序固定。最多 {@link SESSION_LIST_LIMIT} 个，超出的更早的会话不返回，`truncated` 为 true。
	 */
	async list(project: ProjectId): Promise<{ sessions: SessionListItem[]; truncated: boolean }> {
		const { db } = this.deps;
		const found = await db
			.select()
			.from(sessions)
			.where(eq(sessions.projectId, project))
			.orderBy(
				sql`case when ${sessions.status} in ('running', 'queued') then 0 else 1 end`,
				desc(sessions.lastActivityAt),
				desc(sessions.id),
			)
			// 多取一个：多出来了就是被截断了（`truncated`），页面据此提示。
			.limit(SESSION_LIST_LIMIT + 1);
		const rows = found.slice(0, SESSION_LIST_LIMIT);
		const outcomes = await this.#lastOutcomes(rows.map((row) => row.id));
		// 排队中的会话排第几：按排队的先后（和轮到谁开始的顺序一致），不是列表里的顺序。
		const positions = new Map<string, number>();
		if (rows.some((row) => row.status === "queued")) {
			for (const [index, row] of (await this.queued(project)).entries()) {
				positions.set(row.id, index + 1);
			}
		}
		return {
			sessions: rows.map((row) =>
				toListItem(row, outcomes.get(row.id) ?? null, positions.get(row.id) ?? null),
			),
			truncated: found.length > SESSION_LIST_LIMIT,
		};
	}

	/** 在做（`running`）、但最近一次活动早于 `before` 的会话。 */
	async staleRunning(before: Date): Promise<SessionRow[]> {
		return this.deps.db
			.select()
			.from(sessions)
			.where(and(eq(sessions.status, "running"), lt(sessions.lastActivityAt, before)));
	}

	/** 一个会话上一轮的结局（最近一条 `turn_end`）；没有结束过的一轮时为 null。 */
	async lastOutcome(sessionId: string): Promise<TurnOutcome | null> {
		return (await this.#lastOutcomes([sessionId])).get(sessionId) ?? null;
	}

	async #lastOutcomes(
		ids: string[],
		db: Db | Tx = this.deps.db,
	): Promise<Map<string, TurnOutcome>> {
		const outcomes = new Map<string, TurnOutcome>();
		if (ids.length === 0) return outcomes;
		const rows = await db
			.selectDistinctOn([sessionEvents.sessionId], {
				sessionId: sessionEvents.sessionId,
				outcome: sql<string | null>`${sessionEvents.payload}->>'outcome'`,
			})
			.from(sessionEvents)
			// type 写成字面量：它要和部分索引 session_events_turn_end 的谓词对上（参数化的值规划时不一定用得上）。
			.where(and(inArray(sessionEvents.sessionId, ids), sql`${sessionEvents.type} = 'turn_end'`))
			.orderBy(sessionEvents.sessionId, desc(sessionEvents.seq));
		for (const row of rows) {
			const parsed = TurnOutcome.safeParse(row.outcome);
			if (parsed.success) outcomes.set(row.sessionId, parsed.data);
		}
		return outcomes;
	}

	/**
	 * 一页持久事件（序号升序）：没有 `before` 时是最新的一页，有时是序号比它小的最新一页（往前翻页）；
	 * `hasMore` 为 true 表示更早的还有。
	 */
	async page(
		sessionId: string,
		before?: number,
		db: Db | Tx = this.deps.db,
	): Promise<{ events: PersistedSessionEvent[]; hasMore: boolean }> {
		const rows = await db
			.select()
			.from(sessionEvents)
			.where(
				and(
					eq(sessionEvents.sessionId, sessionId),
					before === undefined ? undefined : lt(sessionEvents.seq, before),
				),
			)
			.orderBy(desc(sessionEvents.seq))
			.limit(SESSION_HISTORY_PAGE + 1);
		return {
			events: rows.slice(0, SESSION_HISTORY_PAGE).reverse().map(toEvent),
			hasMore: rows.length > SESSION_HISTORY_PAGE,
		};
	}

	/**
	 * 读一个会话（`GET /sessions/:id`）：会话那一行、最近的一页持久事件（{@link page}）和上一轮的结局，**取自同一个快照**
	 * （一个 `REPEATABLE READ` 的只读事务）。分开读的话，读到会话那一行之后、读事件之前这一轮结束了，响应里就是「状态在做」
	 * 加上已经带着 `turn_end` 的事件：页面用响应里的状态当时间线的状态（不从事件里重算），事件流又从这页最大的序号之后接，
	 * 这条 `turn_end` 不会再来，页面就永远停在「在做」。会话不存在时为 undefined。
	 */
	async detail(
		sessionId: string,
		before?: number,
	): Promise<
		| {
				row: SessionRow;
				events: PersistedSessionEvent[];
				hasMore: boolean;
				lastOutcome: TurnOutcome | null;
		  }
		| undefined
	> {
		if (!isUuid(sessionId)) return undefined;
		return this.deps.db.transaction(
			async (tx) => {
				const [row] = await tx.select().from(sessions).where(eq(sessions.id, sessionId));
				if (!row) return undefined;
				await this.deps.afterDetailRow?.(sessionId);
				const { events, hasMore } = await this.page(sessionId, before, tx);
				const lastOutcome = (await this.#lastOutcomes([sessionId], tx)).get(sessionId) ?? null;
				return { row, events, hasMore, lastOutcome };
			},
			{ isolationLevel: "repeatable read", accessMode: "read only" },
		);
	}

	/** 序号大于 `after` 的持久事件，序号升序，最多 `limit` 条。 */
	async after(sessionId: string, after: number, limit: number): Promise<PersistedSessionEvent[]> {
		const rows = await this.deps.db
			.select()
			.from(sessionEvents)
			.where(and(eq(sessionEvents.sessionId, sessionId), sql`${sessionEvents.seq} > ${after}`))
			.orderBy(asc(sessionEvents.seq))
			.limit(limit);
		return rows.map(toEvent);
	}

	/**
	 * 新建一个空的会话（没有事件，不开始任何一轮；测试和以后的排队用）。`created_by_user_id` 是发起人的用户，
	 * #494 之前的请求没有用户。同一个项目已经有一个 `running` 的会话时，建一个 `running` 的会话抛 {@link ProjectBusyError}
	 * （数据库的唯一约束 `sessions_one_running_per_project`，并发的两个请求只有一个写得成）。
	 * 带第一轮的新建用 {@link createWithTurn}。
	 */
	async create(input: {
		project: ProjectId;
		title: string;
		status: SessionStatus;
		createdBy: string;
		createdByUserId: string | null;
	}): Promise<SessionRow> {
		const now = this.deps.clock.now();
		try {
			const [row] = await this.deps.db
				.insert(sessions)
				.values({
					id: randomUUID(),
					projectId: input.project,
					title: input.title,
					status: input.status,
					createdBy: input.createdBy,
					createdByUserId: input.createdByUserId,
					createdAt: now,
					lastActivityAt: now,
					queuedAt: input.status === "queued" ? now : null,
				})
				.returning();
			return row as SessionRow;
		} catch (error) {
			if (violates(error, "sessions_one_running_per_project")) {
				throw new ProjectBusyError(input.project);
			}
			throw error;
		}
	}

	/**
	 * 新建一个会话并开始它的第一轮：建会话、写 `user_message`、（项目里没有别的会话在做、也没有排队的时）写 `turn_started`，
	 * **在一个事务里**：不会有「在做、但这一轮没有开始」的会话。项目里已经有别的会话在做（`running`）或在排队（`queued`，
	 * 排队的先来，新来的不能插队）时，这个会话排队：状态是 `queued`、记下 `queued_at`、只写 `user_message`，结果是
	 * `queued`（#544）；两个并发的请求撞上唯一约束，输的那个排队。事件写不进去时整个事务回滚，不留下行。
	 * `user` 是这一轮开头用户的话（`user_message`），`turn_started` 由这里写。
	 */
	async createWithTurn(
		input: { project: ProjectId; title: string; createdBy: string; createdByUserId: string | null },
		user: SessionEventBody,
	): Promise<{ session: SessionRow; events: PersistedSessionEvent[]; queued: boolean }> {
		const id = randomUUID();
		return this.#serial(id, async () => {
			const now = this.deps.clock.now();
			const attempt = (forceQueue: boolean) =>
				this.deps.db.transaction(async (tx) => {
					const queue = forceQueue || (await occupied(tx, input.project, id));
					const [row] = await tx
						.insert(sessions)
						.values({
							id,
							projectId: input.project,
							title: input.title,
							status: queue ? "queued" : "running",
							createdBy: input.createdBy,
							createdByUserId: input.createdByUserId,
							createdAt: now,
							lastActivityAt: now,
							currentTurn: queue ? 0 : 1,
							queuedAt: queue ? now : null,
						})
						.returning();
					const session = row as SessionRow;
					const events: PersistedSessionEvent[] = [
						(await this.#insert(tx, session, parsePersistent(user), now)).event,
					];
					if (!queue) {
						const started = { type: "turn_started" as const, turn: 1 };
						events.push((await this.#insert(tx, session, parsePersistent(started), now)).event);
					}
					return { session, events, queued: queue };
				});
			let created: Awaited<ReturnType<typeof attempt>>;
			try {
				created = await attempt(false);
			} catch (error) {
				if (!violates(error, "sessions_one_running_per_project")) throw error;
				created = await attempt(true);
			}
			await this.#publishCommitted(id, created.events);
			return created;
		});
	}

	/** 项目里在做（`running`）的会话；没有时为 undefined（至多一个）。 */
	async running(project: ProjectId): Promise<SessionRow | undefined> {
		const [row] = await this.deps.db
			.select()
			.from(sessions)
			.where(and(eq(sessions.projectId, project), eq(sessions.status, "running")));
		return row;
	}

	/**
	 * 项目里排队的会话（最早的在前，同一时刻的按 ID）和它们各自排第几（从 1 起）。
	 */
	async queued(project: ProjectId): Promise<SessionRow[]> {
		return this.deps.db
			.select()
			.from(sessions)
			.where(and(eq(sessions.projectId, project), eq(sessions.status, "queued")))
			.orderBy(asc(sessions.queuedAt), asc(sessions.id));
	}

	/** 排队中的会话排第几（从 1 起）；不在排队时为 null。 */
	async queuePosition(row: SessionRow): Promise<number | null> {
		if (row.status !== "queued") return null;
		const ahead = await this.queued(row.projectId);
		const index = ahead.findIndex((other) => other.id === row.id);
		return index < 0 ? null : index + 1;
	}

	/** 有排队的会话、却没有会话在做的项目（控制面启动时和每分钟的兜底里开始它们的最早一个）。 */
	async projectsWaitingForTurn(): Promise<ProjectId[]> {
		const rows = await this.deps.db
			.selectDistinct({ project: sessions.projectId })
			.from(sessions)
			.where(
				and(
					eq(sessions.status, "queued"),
					sql`not exists (select 1 from ${sessions} as running where running.project_id = ${sessions.projectId} and running.status = 'running')`,
				),
			);
		return rows.map((row) => row.project);
	}

	/** 会话最近的一句用户的话（排队中的会话轮到它时，要交给助手服务的就是它）；没有时为 undefined。 */
	async lastUserMessage(sessionId: string): Promise<
		| {
				message_id: string;
				text: string;
				steer: boolean;
				author: string;
				author_user_id: string | null;
		  }
		| undefined
	> {
		const [row] = await this.deps.db
			.select({ payload: sessionEvents.payload })
			.from(sessionEvents)
			.where(
				and(eq(sessionEvents.sessionId, sessionId), sql`${sessionEvents.type} = 'user_message'`),
			)
			.orderBy(desc(sessionEvents.seq))
			.limit(1);
		if (!row) return undefined;
		const parsed = SessionEventBody.safeParse({ type: "user_message", ...row.payload });
		return parsed.success && parsed.data.type === "user_message" ? parsed.data : undefined;
	}

	/**
	 * 一个会话开始新的一轮：先看项目里有没有别的会话在做或在排队，在**一个事务里**（锁住这个会话那一行）：
	 * - 空闲的会话：项目里没有别的会话在做（`running`）、也没有排队的（`queued`，排队的先来）时，`idle` → `running`、轮次
	 *   加一、写 `user`（用户的话）和 `turn_started`，结果是 `started`；否则 `idle` → `queued`、记下 `queued_at`、只写 `user`，
	 *   结果是 `queued`（#544：同一个项目同一时刻只跑一轮，其余排队）。两个并发的请求撞上唯一约束
	 *   （`sessions_one_running_per_project`），输的那个排队。
	 * - 已经在做、排队、结束的会话：什么也没有改，结果是 `refused` 和当时的状态。在做时的发话是插话，见 {@link steer}。
	 * 要么这一轮完整地开始了（或完整地排上了队），要么什么都没有变。两个并发的请求对同一个会话只有一个成功。
	 */
	async beginTurn(
		sessionId: string,
		project: ProjectId,
		user: SessionEventBody,
	): Promise<
		| { outcome: "started"; turn: number; events: PersistedSessionEvent[] }
		| { outcome: "queued"; events: PersistedSessionEvent[] }
		| { outcome: "refused"; status: SessionStatus }
	> {
		return this.#serial(sessionId, async () => {
			const now = this.deps.clock.now();
			const attempt = (forceQueue: boolean) =>
				this.deps.db.transaction(async (tx) => {
					const session = await lockSession(tx, sessionId);
					if (session.status !== "idle") {
						return { outcome: "refused" as const, status: session.status };
					}
					const touched = sql`greatest(${sessions.lastActivityAt}, ${now.toISOString()}::timestamptz)`;
					if (forceQueue || (await occupied(tx, project, sessionId))) {
						const [row] = await tx
							.update(sessions)
							.set({ status: "queued", queuedAt: now, lastActivityAt: touched })
							.where(eq(sessions.id, sessionId))
							.returning();
						const queued = (await this.#insert(tx, row as SessionRow, parsePersistent(user), now))
							.event;
						return { outcome: "queued" as const, events: [queued] };
					}
					const [row] = await tx
						.update(sessions)
						.set({
							status: "running",
							currentTurn: sql`${sessions.currentTurn} + 1`,
							lastActivityAt: touched,
						})
						.where(eq(sessions.id, sessionId))
						.returning();
					const running = row as SessionRow;
					const started = { type: "turn_started" as const, turn: running.currentTurn };
					const events = [
						(await this.#insert(tx, running, parsePersistent(user), now)).event,
						(await this.#insert(tx, running, parsePersistent(started), now)).event,
					];
					return { outcome: "started" as const, turn: running.currentTurn, events };
				});
			let begun: Awaited<ReturnType<typeof attempt>>;
			try {
				begun = await attempt(false);
			} catch (error) {
				if (!violates(error, "sessions_one_running_per_project")) throw error;
				begun = await attempt(true);
			}
			if (begun.outcome !== "refused") await this.#publishCommitted(sessionId, begun.events);
			return begun;
		});
	}

	/**
	 * 在做的会话里用户插话：写 `user_message`（`steer` 为 true），在**一个事务里**核对会话此刻在做（不在做时什么也不写，
	 * 返回当时的状态，调用方按空闲的会话处理）。返回这一轮的轮次和写下的事件。
	 */
	async steer(
		sessionId: string,
		user: SessionEventBody,
	): Promise<
		| { steered: true; turn: number; event: PersistedSessionEvent }
		| { steered: false; status: SessionStatus }
	> {
		return this.#serial(sessionId, async () => {
			const now = this.deps.clock.now();
			const result = await this.deps.db.transaction(async (tx) => {
				const session = await lockSession(tx, sessionId);
				if (session.status !== "running")
					return { steered: false as const, status: session.status };
				const { event } = await this.#insert(tx, session, parsePersistent(user), now);
				return { steered: true as const, turn: effectiveTurn(session), event };
			});
			if (result.steered) await this.#publishCommitted(sessionId, [result.event]);
			return result;
		});
	}

	/**
	 * 排队中的会话轮到它了：项目里没有会话在做时，把排队时间最早的那个会话改成在做（`queued` → `running`、轮次加一、
	 * 写 `turn_started`，一个事务），返回它、这一轮的轮次和它排队时说的那句话（要交给助手服务的）。没有排队的、或者项目里
	 * 有会话在做（撞上唯一约束）时为 undefined。重复调用无害：谁先开始、谁在做，都是数据库说了算。
	 */
	async promoteNext(project: ProjectId): Promise<
		| {
				session: SessionRow;
				turn: number;
				message: {
					message_id: string;
					text: string;
					author: string;
					author_user_id: string | null;
				};
		  }
		| undefined
	> {
		for (let tries = 0; tries < 5; tries++) {
			const [next] = await this.deps.db
				.select({ id: sessions.id })
				.from(sessions)
				.where(and(eq(sessions.projectId, project), eq(sessions.status, "queued")))
				.orderBy(asc(sessions.queuedAt), asc(sessions.id))
				.limit(1);
			if (!next) return undefined;
			const promoted = await this.#serial(next.id, async () => {
				const now = this.deps.clock.now();
				let result: { session: SessionRow; event: PersistedSessionEvent } | undefined;
				try {
					result = await this.deps.db.transaction(async (tx) => {
						const session = await lockSession(tx, next.id);
						// 排队的这一个在这之间被停止或结束了：换下一个。
						if (session.status !== "queued") return undefined;
						const [row] = await tx
							.update(sessions)
							.set({
								status: "running",
								queuedAt: null,
								currentTurn: sql`${sessions.currentTurn} + 1`,
								lastActivityAt: sql`greatest(${sessions.lastActivityAt}, ${now.toISOString()}::timestamptz)`,
							})
							.where(eq(sessions.id, next.id))
							.returning();
						const running = row as SessionRow;
						const started = { type: "turn_started" as const, turn: running.currentTurn };
						return {
							session: running,
							event: (await this.#insert(tx, running, parsePersistent(started), now)).event,
						};
					});
				} catch (error) {
					// 项目里别的会话已经在做了：位置不是空的，什么也不做。
					if (violates(error, "sessions_one_running_per_project")) return "occupied" as const;
					throw error;
				}
				if (!result) return undefined;
				await this.#publishCommitted(next.id, [result.event]);
				return result;
			});
			if (promoted === "occupied") return undefined;
			if (!promoted) continue;
			const message = await this.lastUserMessage(promoted.session.id);
			if (!message) {
				// 排队的会话没有用户的话（库里被改过）：不该有。这一轮没有东西可交，按失败结束，让下一个有机会。
				await this.append(promoted.session.id, {
					type: "turn_end",
					turn: promoted.session.currentTurn,
					outcome: "failed",
					reason: "排队的会话里找不到它说的那句话，这一轮没有开始",
					steps: 0,
					model_calls: 0,
					duration_ms: 0,
				});
				continue;
			}
			return { session: promoted.session, turn: promoted.session.currentTurn, message };
		}
		return undefined;
	}

	/**
	 * 排队中的会话被停止：移出队列、回到空闲（`queued` → `idle`、清掉 `queued_at`），给排队时说的那句话写一条
	 * `queue_cancelled` 的提示（带这句话的 `message_id`），一个事务。不在排队时什么也不改，返回当时的状态。
	 */
	async cancelQueued(
		sessionId: string,
	): Promise<
		{ cancelled: true; event: PersistedSessionEvent } | { cancelled: false; status: SessionStatus }
	> {
		return this.#serial(sessionId, async () => {
			const now = this.deps.clock.now();
			const result = await this.deps.db.transaction(async (tx) => {
				const session = await lockSession(tx, sessionId);
				if (session.status !== "queued") {
					return { cancelled: false as const, status: session.status };
				}
				const [row] = await tx
					.update(sessions)
					.set({ status: "idle", queuedAt: null })
					.where(eq(sessions.id, sessionId))
					.returning();
				const [said] = await tx
					.select({ payload: sessionEvents.payload })
					.from(sessionEvents)
					.where(
						and(
							eq(sessionEvents.sessionId, sessionId),
							sql`${sessionEvents.type} = 'user_message'`,
						),
					)
					.orderBy(desc(sessionEvents.seq))
					.limit(1);
				const messageId = said?.payload.message_id;
				const notice: SessionEventBody = {
					type: "notice",
					kind: "queue_cancelled",
					message: "这句话排队时被取消了，没有交给助手",
					...(typeof messageId === "string" ? { message_id: messageId } : {}),
				};
				const { event } = await this.#insert(tx, row as SessionRow, parsePersistent(notice), now);
				return { cancelled: true as const, event };
			});
			if (result.cancelled) await this.#publishCommitted(sessionId, [result.event]);
			return result;
		});
	}

	/**
	 * 结束会话：`idle` 或 `queued` → `ended`（清掉 `queued_at`）、写 `session_ended`（`by` 是结束它的人的昵称），一个事务。
	 * 已经结束的什么也不写（`already`）；还在做（`running`）的不能结束，要先停止（返回 `running`）。
	 */
	async end(
		sessionId: string,
		by: string,
	): Promise<
		{ ended: true; event: PersistedSessionEvent } | { ended: false; status: "ended" | "running" }
	> {
		return this.#serial(sessionId, async () => {
			const now = this.deps.clock.now();
			const result = await this.deps.db.transaction(async (tx) => {
				const session = await lockSession(tx, sessionId);
				if (session.status === "ended") return { ended: false as const, status: "ended" as const };
				if (session.status === "running")
					return { ended: false as const, status: "running" as const };
				const [row] = await tx
					.update(sessions)
					.set({ status: "ended", queuedAt: null })
					.where(eq(sessions.id, sessionId))
					.returning();
				const { event } = await this.#insert(
					tx,
					row as SessionRow,
					parsePersistent({ type: "session_ended", by }),
					now,
				);
				return { ended: true as const, event };
			});
			if (result.ended) await this.#publishCommitted(sessionId, [result.event]);
			return result;
		});
	}

	/** 删除一个会话和它的事件（建会话时助手服务没接住第一轮：不留下会话）。 */
	async delete(sessionId: string): Promise<void> {
		await this.deps.db.delete(sessions).where(eq(sessions.id, sessionId));
	}

	/**
	 * 记一条持久事件，返回落库后的事件（带 `seq`、`at`）并发布给订阅这个会话的连接。序号在会话内严格递增、不重复：
	 * 在同一个事务里锁住会话那一行再取下一个，并发写同一个会话的几条事件依次执行。落库的同时更新会话的
	 * `last_activity_at`（用控制面的时钟，不倒退）。发布在事务提交之后：订阅的一方收到时，库里一定读得到它。
	 * `at` 是事件**产生**的时间，不是落库的时间：助手服务产生的事件传它盖的时间（`AssistantStreamRecord.at`），
	 * 控制面自己产生的不传，用控制面的时钟（#538 的约定）；它只是事件上的时间，**不影响** `last_activity_at`。
	 * 一轮结束（`turn_end`）时：这一轮是会话此刻在做的那一轮，会话回到空闲（`running` → `idle`），和这条事件在同一个
	 * 事务里（页面看到一轮结束时，接着发的话一定能开始新的一轮）；不是此刻在做的那一轮（迟到的、重复的）不动状态。
	 * **同一轮的 `turn_end` 只记一条**：这一轮已经有 `turn_end` 时（比如停止时控制面先补了一条，助手服务的结局晚到），
	 * 后到的不记、不发布，返回已有的那条；但**去重不吞状态转换**：会话还在做这一轮（状态和事件不一致）时，照样改回空闲。
	 * **同一个会话的「落库加发布」在进程内依次执行**（{@link SessionStore.#serial}）：发布的顺序等于提交的顺序，
	 * 事件流的实时阶段看到的序号一定是递增的。
	 * 事件的内容要过 `@sfly/schema` 的 `SessionEventBody`；不持久的类型不能用它记（用 {@link publish}）。
	 */
	async append(
		sessionId: string,
		body: SessionEventBody,
		at: Date = this.deps.clock.now(),
	): Promise<PersistedSessionEvent> {
		const parsed = parsePersistent(body);
		return this.#serial(sessionId, async () => {
			const stored = await this.deps.db.transaction(async (tx) => {
				const session = await lockSession(tx, sessionId);
				return this.#insert(tx, session, parsed, at);
			});
			if (!stored.duplicate) await this.#publishCommitted(sessionId, [stored.event]);
			if (stored.endedTurn) {
				this.#steerSeen.delete(sessionId);
				this.#turnEnded(stored.project);
			}
			return stored.event;
		});
	}

	/**
	 * 助手服务发来的持久事件：落库之前核对**会话存在、在做、`turn` 是会话此刻在做的那一轮**，核对和落库在同一个事务里；
	 * 不符合的不记、不发布、不改状态，返回为什么（调用方记日志）。上一轮迟到的事件（停止之后助手服务才发来）、空闲或
	 * 已结束的会话收到的事件都是这样丢掉的。
	 */
	async appendFromAssistant(
		sessionId: string,
		turn: number,
		body: SessionEventBody,
		at: Date,
	): Promise<{ stored: PersistedSessionEvent } | { dropped: DropReason }> {
		const parsed = parsePersistent(body);
		return this.#serial(sessionId, async () => {
			const result = await this.deps.db.transaction(
				async (tx): Promise<{ dropped: DropReason } | { stored: Inserted }> => {
					const [session] = await tx
						.select()
						.from(sessions)
						.where(eq(sessions.id, sessionId))
						.for("update");
					if (!session) return { dropped: "unknown_session" };
					const dropped = dropReason(session, turn);
					if (dropped !== undefined) return { dropped };
					return { stored: await this.#insert(tx, session, parsed, at) };
				},
			);
			if ("dropped" in result) return { dropped: result.dropped };
			if (!result.stored.duplicate) await this.#publishCommitted(sessionId, [result.stored.event]);
			if (result.stored.endedTurn) {
				this.#steerSeen.delete(sessionId);
				this.#turnEnded(result.stored.project);
			}
			return { stored: result.stored.event };
		});
	}

	/** 助手服务发来的不持久事件（增量、思考、工具输出……）：同样核对会话在做、轮次对，对才发布；排在这个会话的链上。 */
	async publishFromAssistant(
		sessionId: string,
		turn: number,
		body: SessionEventBody,
	): Promise<{ published: true } | { dropped: DropReason }> {
		if (isPersistedType(body.type)) {
			throw new Error(`会话事件 ${body.type} 是持久的，要落库（用 appendFromAssistant）`);
		}
		const parsed = SessionEventBody.parse(body) as SessionEvent;
		return this.#serial(sessionId, async () => {
			const [session] = await this.deps.db
				.select()
				.from(sessions)
				.where(eq(sessions.id, sessionId));
			const dropped = session ? dropReason(session, turn) : "unknown_session";
			if (dropped !== undefined) return { dropped };
			if (parsed.type === "steer_queue") this.#trackSteerQueue(sessionId, turn, parsed);
			this.#live.publish(sessionId, parsed);
			return { published: true as const };
		});
	}

	/** 记下一份 `steer_queue`：里面的都算「出现过」，出现过又不在这一份里的算「确认送到」。 */
	#trackSteerQueue(sessionId: string, turn: number, event: SessionEvent): void {
		if (event.type !== "steer_queue") return;
		let seen = this.#steerSeen.get(sessionId);
		if (!seen || seen.turn !== turn) {
			seen = { turn, listed: new Set(), delivered: new Set() };
			this.#steerSeen.set(sessionId, seen);
		}
		const now = new Set(event.messages.map((m) => m.message_id));
		for (const id of seen.listed) if (!now.has(id)) seen.delivered.add(id);
		for (const id of now) seen.listed.add(id);
	}

	/**
	 * 控制面自己补一轮的结局（助手服务没有回话、停止等不到结局、兜底、这一轮没有交到助手服务手上）：和一般的 {@link append}
	 * 一样写这条 `turn_end`，**之前**先为这一轮里没有确认送到、也还没有 `steer_dropped` 的每一句插话各写一条 `steer_dropped`
	 * （`message` 写「没有确认送到」），全部在一个事务里。助手服务的结局晚到时这一轮已经结束，它的 `steer_dropped` 和 `turn_end`
	 * 被丢掉，所以每句插话要么确认送到、要么恰有控制面或助手服务写的 `steer_dropped`（协议的不变式）。「这一轮里的插话」是这一轮
	 * `turn_started` 之后写的 `user_message`（`steer` 为 true）；这一轮已经有 `turn_end` 的（重复）不补。
	 */
	async appendTurnEnd(
		sessionId: string,
		body: SessionEventBody,
		at: Date = this.deps.clock.now(),
	): Promise<PersistedSessionEvent> {
		const parsed = parsePersistent(body);
		if (parsed.type !== "turn_end") throw new Error("appendTurnEnd 只记 turn_end");
		const turn = parsed.turn;
		return this.#serial(sessionId, async () => {
			const stored = await this.deps.db.transaction(async (tx) => {
				const session = await lockSession(tx, sessionId);
				const drops: Inserted[] = [];
				for (const message of await this.#unconfirmedSteers(tx, session, turn)) {
					const dropped = {
						type: "notice" as const,
						kind: "steer_dropped" as const,
						message: `这句插话没有确认送到（这一轮由控制面结束，助手服务没有带回结局）：「${clip(message.text)}」，需要的话再说一次`,
						message_id: message.message_id,
					};
					drops.push(await this.#insert(tx, session, parsePersistent(dropped), at));
				}
				return { drops, end: await this.#insert(tx, session, parsed, at) };
			});
			for (const drop of stored.drops) await this.#publishCommitted(sessionId, [drop.event]);
			if (!stored.end.duplicate) await this.#publishCommitted(sessionId, [stored.end.event]);
			if (stored.end.endedTurn) this.#turnEnded(stored.end.project);
			this.#steerSeen.delete(sessionId);
			return stored.end.event;
		});
	}

	/** 这一轮里还没有确认送到、也还没有 `steer_dropped` 的插话（按说的先后）；这一轮已经有 `turn_end` 时没有。 */
	async #unconfirmedSteers(
		tx: Tx,
		session: SessionRow,
		turn: number,
	): Promise<Array<{ message_id: string; text: string }>> {
		const [ended] = await tx
			.select({ seq: sessionEvents.seq })
			.from(sessionEvents)
			.where(
				and(
					eq(sessionEvents.sessionId, session.id),
					sql`${sessionEvents.type} = 'turn_end'`,
					sql`${sessionEvents.payload}->>'turn' = ${String(turn)}`,
				),
			)
			.limit(1);
		if (ended) return [];
		const [started] = await tx
			.select({ seq: sessionEvents.seq })
			.from(sessionEvents)
			.where(
				and(
					eq(sessionEvents.sessionId, session.id),
					sql`${sessionEvents.type} = 'turn_started'`,
					sql`${sessionEvents.payload}->>'turn' = ${String(turn)}`,
				),
			)
			.limit(1);
		const rows = await tx
			.select()
			.from(sessionEvents)
			.where(
				and(
					eq(sessionEvents.sessionId, session.id),
					gt(sessionEvents.seq, started?.seq ?? 0),
					or(
						and(
							sql`${sessionEvents.type} = 'user_message'`,
							sql`${sessionEvents.payload}->>'steer' = 'true'`,
						),
						and(
							sql`${sessionEvents.type} = 'notice'`,
							sql`${sessionEvents.payload}->>'kind' = 'steer_dropped'`,
						),
					),
				),
			)
			.orderBy(asc(sessionEvents.seq));
		const seen = this.#steerSeen.get(session.id);
		const delivered = seen?.turn === turn ? seen.delivered : new Set<string>();
		const dropped = new Set<string>();
		const steers: Array<{ message_id: string; text: string }> = [];
		for (const row of rows) {
			const payload = row.payload as { message_id?: string; text?: string };
			if (row.type === "notice" && payload.message_id) dropped.add(payload.message_id);
			if (row.type === "user_message" && payload.message_id) {
				steers.push({ message_id: payload.message_id, text: payload.text ?? "" });
			}
		}
		return steers.filter((m) => !dropped.has(m.message_id) && !delivered.has(m.message_id));
	}

	/** 提交之后按顺序发布（测试缝 `afterCommit` 在每条发布之前）。 */
	async #publishCommitted(sessionId: string, events: PersistedSessionEvent[]): Promise<void> {
		for (const event of events) {
			await this.deps.afterCommit?.(sessionId, event);
			this.#live.publish(sessionId, event);
		}
	}

	/**
	 * 事务里记一条持久事件（会话那一行已经锁住）。`last_activity_at` 取控制面的时钟；`turn_end` 的规则见 {@link append}：
	 * 这一轮已经有 `turn_end` 时不再写，但此刻在做的正是这一轮的话照样改回空闲。
	 */
	async #insert(
		tx: Tx,
		session: SessionRow,
		parsed: SessionEventBody,
		at: Date,
	): Promise<Inserted> {
		const { type, ...payload } = parsed;
		const now = this.deps.clock.now();
		const touched = sql`greatest(${sessions.lastActivityAt}, ${now.toISOString()}::timestamptz)`;
		const endsCurrent =
			parsed.type === "turn_end" &&
			session.status === "running" &&
			parsed.turn === effectiveTurn(session);
		// 结束的是「此刻在做的那一轮」：会话回到空闲，`current_turn` 也抬到这一轮。在做、但一条 `turn_started` 都没有的
		// 旧数据（迁移回填成 0，`effectiveTurn` 当作第 1 轮）不抬的话，下一轮又是第 1 轮，那一轮真正的 `turn_end`
		// 会被当作第 1 轮的重复吞掉。
		const endsTurn = {
			status: "idle" as const,
			currentTurn: sql`greatest(${sessions.currentTurn}, ${parsed.type === "turn_end" ? parsed.turn : 0})`,
		};
		if (parsed.type === "turn_end") {
			const [existing] = await tx
				.select()
				.from(sessionEvents)
				.where(
					and(
						eq(sessionEvents.sessionId, session.id),
						sql`${sessionEvents.type} = 'turn_end'`,
						sql`${sessionEvents.payload}->>'turn' = ${String(parsed.turn)}`,
					),
				)
				.limit(1);
			if (existing) {
				if (endsCurrent) {
					await tx.update(sessions).set(endsTurn).where(eq(sessions.id, session.id));
				}
				return {
					event: toEvent(existing),
					duplicate: true,
					endedTurn: endsCurrent,
					project: session.projectId,
				};
			}
		}
		const [last] = await tx
			.select({ seq: sql<number>`coalesce(max(${sessionEvents.seq}), 0)::int` })
			.from(sessionEvents)
			.where(eq(sessionEvents.sessionId, session.id));
		const [row] = await tx
			.insert(sessionEvents)
			.values({
				sessionId: session.id,
				seq: (last?.seq ?? 0) + 1,
				type,
				payload,
				createdAt: at,
			})
			.returning();
		await tx
			.update(sessions)
			.set({ lastActivityAt: touched, ...(endsCurrent && endsTurn) })
			.where(eq(sessions.id, session.id));
		return {
			event: toEvent(row as EventRow),
			duplicate: false,
			endedTurn: endsCurrent,
			project: session.projectId,
		};
	}

	/** 推送一条不持久的事件（文字增量、工具输出、思考、排队状态、快照）：不落库，没有 `seq`，不推进续传的位置。 */
	publish(sessionId: string, body: SessionEventBody): void {
		if (isPersistedType(body.type)) {
			throw new Error(`会话事件 ${body.type} 是持久的，要落库（用 append）`);
		}
		this.#live.publish(sessionId, SessionEventBody.parse(body) as SessionEvent);
	}

	/**
	 * 实时推送一个会话的事件（`GET /sessions/:id/events`）：先订阅、再从库里补发，补发完接上实时的。
	 * 不重不漏、持久和不持久的先后、慢客户端的背压和缓冲上限见 {@link follow}。
	 * 返回取消订阅的函数；读库出错或缓冲溢出时调用 `onError`，之后不再推送。
	 */
	follow(
		sessionId: string,
		after: number,
		sink: FollowSink,
		onError: (error: unknown) => void,
	): () => void {
		return follow(
			{
				subscribe: (listener) => this.#live.subscribe(sessionId, listener),
				// 补发读库排在这个会话的链上：读到的事件一定已经发布过，缓冲里排在它前面的增量才判断得了先后。
				read: (from, limit) => this.#serial(sessionId, () => this.after(sessionId, from, limit)),
			},
			after,
			sink,
			onError,
		);
	}
}
