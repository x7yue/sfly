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
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db, Tx } from "../db/database.js";
import { projects, sessionEvents, sessions } from "../db/schema.js";
import type { ProjectId } from "../projects/project-id.js";
import { Topics } from "../sse/topics.js";
import { isUuid } from "../util/uuid.js";
import { type FollowSink, follow, REPLAY_BATCH } from "./follow.js";

/** 推送指针（{@link SessionStore.#cursors}）多到这个数时，顺手清掉闲置的（{@link SessionStoreDeps.cursorSweepSize}）。 */
const CURSOR_SWEEP_SIZE = 1_000;
/** 闲置多久（毫秒）的推送指针可以清掉：写事务最长也只等 {@link DEFAULT_SESSION_WRITE_LOCK_TIMEOUT_MS}，远小于它（{@link SessionStoreDeps.cursorIdleMs}）。 */
const CURSOR_IDLE_MS = 10 * 60_000;

/** 库里的一个会话。 */
export type SessionRow = typeof sessions.$inferSelect;

const PERSISTED: ReadonlySet<string> = new Set(PERSISTED_SESSION_EVENT_TYPES);

/** 事件类型是不是持久的（落库的）。 */
export const isPersistedType = (type: string): boolean => PERSISTED.has(type);

/** 会话在列表里的样子：`queue_position` 在 #544 之前总是 null（没有排队）。 */
export function toListItem(row: SessionRow, lastTurnOutcome: TurnOutcome | null): SessionListItem {
	return {
		id: row.id,
		title: row.title,
		status: row.status,
		created_by: row.createdBy,
		created_at: row.createdAt.toISOString(),
		last_activity_at: row.lastActivityAt.toISOString(),
		queue_position: null,
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

/** 事务里记一条持久事件的结果：落库（或已有）的事件，以及是不是重复的（这一轮已经有 `turn_end`）。 */
interface Inserted {
	event: PersistedSessionEvent;
	duplicate: boolean;
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
 * 事务里锁住会话那一行并取出它；不存在时抛 {@link SessionNotFoundError}。**锁的强度是 `FOR NO KEY UPDATE`**，不是 `FOR UPDATE`：
 * 记着会话引用的行（`runs.session_id`、`orchestration_versions.session_id`、`api_tokens` 的组合外键）插入时，外键检查给会话那一行
 * 加 `FOR KEY SHARE`，一直持有到事务结束；`FOR UPDATE` 和它冲突，`FOR NO KEY UPDATE` 不冲突，同一个会话的事件之间仍然互斥
 * （序号靠它串行）。这一把是每条路径上最后拿的一把数据库锁（docs/ARCHITECTURE.md「会话令牌」的锁顺序）。
 */
async function lockSession(tx: Tx, sessionId: string): Promise<SessionRow> {
	const [session] = await tx
		.select()
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.for("no key update");
	if (!session) throw new SessionNotFoundError(sessionId);
	return session;
}

/**
 * 会话令牌的写（触发、保存、恢复、复制）的事务里，等行锁最多等多久（毫秒）：超时这一次请求以明确的错误结束、事务回滚
 * （{@link isLockTimeout}，HTTP 503），不让任何一种没想到的等待变成永远卡住。正常时这些路径只等别的事务提交，毫秒级。
 */
export const DEFAULT_SESSION_WRITE_LOCK_TIMEOUT_MS = 5_000;

/** 这个错误是不是「等锁超时」（PostgreSQL 的 `lock_not_available`，沿着 `cause` 找：drizzle 把数据库错误包了一层）。 */
export function isLockTimeout(error: unknown): boolean {
	for (let e: unknown = error; e instanceof Error; e = e.cause) {
		if ((e as { code?: unknown }).code === "55P03") return true;
	}
	return false;
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
	/** 不该抛出去、只记日志的错误（平台记录发布失败）。 */
	onError?: (what: string, error: unknown) => void;
	/** 会话令牌的写的事务里等行锁最多等多久（毫秒），默认 {@link DEFAULT_SESSION_WRITE_LOCK_TIMEOUT_MS}；测试里调小。 */
	writeLockTimeoutMs?: number;
	/** 推送指针多到这个数时顺手清掉闲置的，默认 1000；测试里调小，验证清理只清闲置的、不清还在用的。 */
	cursorSweepSize?: number;
	/** 推送指针闲置多久（毫秒）可以清掉，默认 10 分钟（写事务最长也只等锁等待的上限，远小于它）；测试里调小。 */
	cursorIdleMs?: number;
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
	/**
	 * 每个会话「已经推送到的持久事件序号」，见 {@link SessionStore.#publishInOrder}。只在这个会话有写在途时才有意义：
	 * 在事务里拿到会话那一行的锁、分配序号的那一刻登记（{@link SessionStore.#begin}），闲置很久的由 `#begin` 顺手清掉。
	 */
	readonly #cursors = new Map<string, { published: number; usedAt: number }>();
	/** 上一次清理闲置推送指针的时间（毫秒）。 */
	#sweptAt = 0;

	constructor(private readonly deps: SessionStoreDeps) {}

	/**
	 * 在这个会话的链上依次执行：前一个（不论成败）结束了才开始。助手事件的路径（{@link append}、{@link appendFromAssistant}、
	 * 不持久事件的发布、补发读库……）在上面依次执行：一件的「落库加发布」做完，下一件才开始，不持久的增量和持久的事件在事件流里的先后
	 * 就是它们到的先后。**不要在拿着数据库连接或开着事务的时候等这条链**（docs/ARCHITECTURE.md「会话令牌」）：链上的任务要
	 * 自己去拿连接、拿行锁，等链的一方又占着连接或行锁，就是数据库看不见的死锁。持久事件**推送的顺序**不靠这条链保证，靠
	 * {@link SessionStore.#publishInOrder}（见那里）。控制面只有一个进程（不是多副本）时成立；多副本要换成数据库的通知（那时再说）。
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

	/**
	 * 会话令牌的写（触发、保存、恢复、复制）的事务里设置等行锁的上限（`SET LOCAL lock_timeout`，只在这个事务里有效）：超时这一次
	 * 请求以明确的错误结束、事务回滚（{@link isLockTimeout}，HTTP 503）。放在事务的第一条语句。
	 */
	async limitWriteLockWait(tx: Tx): Promise<void> {
		const ms = this.deps.writeLockTimeoutMs ?? DEFAULT_SESSION_WRITE_LOCK_TIMEOUT_MS;
		await tx.execute(sql`select set_config('lock_timeout', ${`${ms}ms`}, true)`);
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
	 * 项目里的会话：在做和排队中的在前，其余按最近活动倒序（#551 的写法）；带上一轮的结局。
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
		return {
			sessions: rows.map((row) => toListItem(row, outcomes.get(row.id) ?? null)),
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
	 * 新建一个会话并开始它的第一轮：建会话（`running`，第 1 轮）、写 `user_message`、写 `turn_started`，**在一个事务里**：
	 * 不会有「在做、但这一轮没有开始」的会话。项目里已经有在做的会话时抛 {@link ProjectBusyError}（整个事务回滚，
	 * 不留下行）。`opening` 给出这一轮开头要写的事件（第 1 轮）。
	 */
	async createWithTurn(
		input: { project: ProjectId; title: string; createdBy: string; createdByUserId: string | null },
		opening: (turn: number) => SessionEventBody[],
	): Promise<{ session: SessionRow; events: PersistedSessionEvent[] }> {
		const id = randomUUID();
		return this.#serial(id, async () => {
			const now = this.deps.clock.now();
			let created: { session: SessionRow; events: PersistedSessionEvent[] };
			try {
				created = await this.deps.db.transaction(async (tx) => {
					const [row] = await tx
						.insert(sessions)
						.values({
							id,
							projectId: input.project,
							title: input.title,
							status: "running",
							createdBy: input.createdBy,
							createdByUserId: input.createdByUserId,
							createdAt: now,
							lastActivityAt: now,
							currentTurn: 1,
						})
						.returning();
					const session = row as SessionRow;
					const events: PersistedSessionEvent[] = [];
					for (const body of opening(1)) {
						events.push((await this.#insert(tx, session, parsePersistent(body), now)).event);
					}
					return { session, events };
				});
			} catch (error) {
				if (violates(error, "sessions_one_running_per_project")) {
					throw new ProjectBusyError(input.project);
				}
				throw error;
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
	 * 一个空闲的会话开始新的一轮：`idle` → `running`、轮次加一、写 `opening` 给出的事件（`user_message`、
	 * `turn_started`），**在一个事务里**：要么这一轮完整地开始了，要么什么都没有变，不会停在「在做、但这一轮没有开始」。
	 * 已经在做（`running`）、排队（`queued`）或已结束（`ended`）时返回当时的状态，什么也没有改。项目里已经有别的会话
	 * 在做时抛 {@link ProjectBusyError}。两个并发的请求对同一个会话只有一个成功。
	 */
	async beginTurn(
		sessionId: string,
		project: ProjectId,
		opening: (turn: number) => SessionEventBody[],
	): Promise<
		| { started: true; turn: number; events: PersistedSessionEvent[] }
		| { started: false; status: SessionStatus }
	> {
		return this.#serial(sessionId, async () => {
			const now = this.deps.clock.now();
			let begun:
				| { started: true; turn: number; events: PersistedSessionEvent[] }
				| { started: false; status: SessionStatus };
			try {
				begun = await this.deps.db.transaction(async (tx) => {
					const [row] = await tx
						.update(sessions)
						.set({
							status: "running",
							currentTurn: sql`${sessions.currentTurn} + 1`,
							lastActivityAt: sql`greatest(${sessions.lastActivityAt}, ${now.toISOString()}::timestamptz)`,
						})
						.where(and(eq(sessions.id, sessionId), eq(sessions.status, "idle")))
						.returning();
					if (!row) {
						const [current] = await tx
							.select({ status: sessions.status })
							.from(sessions)
							.where(eq(sessions.id, sessionId));
						if (!current) throw new SessionNotFoundError(sessionId);
						return { started: false as const, status: current.status };
					}
					const events: PersistedSessionEvent[] = [];
					for (const body of opening(row.currentTurn)) {
						events.push((await this.#insert(tx, row, parsePersistent(body), now)).event);
					}
					return { started: true as const, turn: row.currentTurn, events };
				});
			} catch (error) {
				if (violates(error, "sessions_one_running_per_project")) {
					throw new ProjectBusyError(project);
				}
				throw error;
			}
			if (begun.started) await this.#publishCommitted(sessionId, begun.events);
			return begun;
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
						.for("no key update");
					if (!session) return { dropped: "unknown_session" };
					const dropped = dropReason(session, turn);
					if (dropped !== undefined) return { dropped };
					return { stored: await this.#insert(tx, session, parsed, at) };
				},
			);
			if ("dropped" in result) return { dropped: result.dropped };
			if (!result.stored.duplicate) await this.#publishCommitted(sessionId, [result.stored.event]);
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
			this.#live.publish(sessionId, parsed);
			return { published: true as const };
		});
	}

	/**
	 * 在调用方的事务里给会话记一条平台记录：助手用会话令牌触发了运行、保存了场景版本（#547）。`turn` 是会话最近的一轮
	 * （`current_turn`）：会话在做时就是正在做的那一轮；空闲时记在最近一轮的结局之后；从没开始过一轮的（`current_turn` 为 0，
	 * 产品里造不出带令牌的这种会话）按第 1 轮。已结束的会话，它的令牌无效，到不了这里。
	 *
	 * **调用方的事务里，这是最后一件事**：先做慢的（引擎的锁、场景那一行的锁、运行和版本的写入），最后才来这里——给会话那一行
	 * 加锁（`FOR NO KEY UPDATE`）、在锁下分配序号、写记录，然后立即提交。这是这条路径上最后拿的一把数据库锁，占着它的时间是毫秒级，
	 * 别的会话的事件、同一个会话的助手事件都不被拖住。**这里不等任何进程里的锁**：事务开着、拿着连接的时候不去排会话的链。
	 * 返回的事件在事务提交之后交给 {@link announce}。
	 */
	async recordPlatform(
		tx: Tx,
		sessionId: string,
		record:
			| { kind: "run"; run_id: string; scenario_name: string }
			| { kind: "scenario_version"; scenario_id: string; name: string; version: number },
	): Promise<PersistedSessionEvent> {
		const session = await lockSession(tx, sessionId);
		const parsed = parsePersistent({
			type: "platform",
			turn: effectiveTurn(session),
			...record,
		});
		return (await this.#insert(tx, session, parsed, this.deps.clock.now())).event;
	}

	/**
	 * 把已经提交的平台记录推送给订阅这个会话的连接（{@link recordPlatform} 的收尾），在事务提交**之后**调用。排到这个会话的链上
	 * 推送，但**不等它**：调用方（引擎的锁里、请求的处理函数里）不被链上的事件拖住，推送在后台做。推送的顺序等于序号的顺序
	 * （{@link SessionStore.#publishInOrder}），不论它和助手事件谁先提交、谁先排到链上。
	 * 推送失败只记日志，不抛出去：记录已经提交了，不能让它把已经提交的运行变成 500、挡住后面的派发；没有推出去的这一条，
	 * 下一条持久事件推送的时候会从库里补上（订阅的一方看到的序号仍然连续），重连的订阅从库里补发。
	 */
	announce(sessionId: string, event: PersistedSessionEvent): void {
		void this.#serial(sessionId, () => this.#publishCommitted(sessionId, [event])).catch(
			(error) => {
				this.deps.onError?.(
					`session ${sessionId}: platform record ${event.seq} not published:`,
					error,
				);
			},
		);
	}

	/** 登记：这个会话有一条序号为 `seq` 的持久事件在事务里（会话那一行已经锁住）。 */
	#begin(sessionId: string, seq: number): void {
		const now = Date.now();
		const cursor = this.#cursors.get(sessionId);
		// 第一次登记：比它小的事件要么已经推送过，要么就是这一条之前的写（它们登记过，指针已经在）。
		if (cursor === undefined) this.#cursors.set(sessionId, { published: seq - 1, usedAt: now });
		else cursor.usedAt = now;
		// 多了才清，而且至多每分钟扫一遍（写路径上不为它多花时间）。
		if (
			this.#cursors.size > (this.deps.cursorSweepSize ?? CURSOR_SWEEP_SIZE) &&
			now - this.#sweptAt > 60_000
		) {
			this.#sweptAt = now;
			const idleMs = this.deps.cursorIdleMs ?? CURSOR_IDLE_MS;
			for (const [id, c] of this.#cursors) {
				if (now - c.usedAt > idleMs) this.#cursors.delete(id);
			}
		}
	}

	/** 提交之后按顺序推送（测试缝 `afterCommit` 在每条推送之前）。要在这个会话的链上调用。 */
	async #publishCommitted(sessionId: string, events: PersistedSessionEvent[]): Promise<void> {
		for (const event of events) {
			await this.deps.afterCommit?.(sessionId, event);
			await this.#publishInOrder(sessionId, event);
		}
	}

	/**
	 * 推送一条已经提交的持久事件，**推送的顺序等于序号的顺序，不漏、不重**。每个会话记着「已经推送到的序号」（`published`）：
	 * - 序号正好是 `published + 1`：直接推；
	 * - 序号不大于 `published`：已经被前面的一次补推推过了，不再推（下面的循环不执行）；
	 * - 序号更大：比它小的别的事件已经提交（会话那一行的行锁保证：提交的先后就是序号的先后）、还没推——比如先提交的平台记录
	 *   还没轮到推送——从库里读 `published` 之后已经提交的事件，按序号推到这一条为止。
	 * 事件流的实时阶段按 `seq` 去重，先推了大的序号，后到的小序号就被当作「已经发过」丢掉，所以顺序不能乱。
	 * 推送中途失败时指针不前进：下一条事件推送的时候从库里补上没推出去的。进程停了，没推出去的事件已经在库里，
	 * 订阅的一方重连读库补发。要在这个会话的链上调用（同一个会话的推送一次一个）。
	 */
	async #publishInOrder(sessionId: string, event: PersistedSessionEvent): Promise<void> {
		const cursor = this.#cursors.get(sessionId) ?? { published: event.seq - 1, usedAt: Date.now() };
		this.#cursors.set(sessionId, cursor);
		cursor.usedAt = Date.now();
		if (event.seq === cursor.published + 1) {
			this.#live.publish(sessionId, event);
			cursor.published = event.seq;
			return;
		}
		while (cursor.published < event.seq) {
			const batch = await this.after(sessionId, cursor.published, REPLAY_BATCH);
			if (batch.length === 0) {
				// 已经提交的事件读不到：不该发生。不空转，把这一条推出去（序号有跳跃，客户端按 seq 去重不受影响）。
				this.#live.publish(sessionId, event);
				cursor.published = event.seq;
				return;
			}
			for (const found of batch) {
				if (found.seq > event.seq) return;
				this.#live.publish(sessionId, found);
				cursor.published = found.seq;
			}
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
				return { event: toEvent(existing), duplicate: true };
			}
		}
		const [last] = await tx
			.select({ seq: sql<number>`coalesce(max(${sessionEvents.seq}), 0)::int` })
			.from(sessionEvents)
			.where(eq(sessionEvents.sessionId, session.id));
		// 序号是在会话那一行的行锁下取的：提交的先后就是序号的先后。登记之后，这条事件的推送从指针算起。
		this.#begin(session.id, (last?.seq ?? 0) + 1);
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
		return { event: toEvent(row as EventRow), duplicate: false };
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
