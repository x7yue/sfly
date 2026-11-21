import { randomUUID } from "node:crypto";
import {
	PERSISTED_SESSION_EVENT_TYPES,
	type PersistedSessionEvent,
	SESSION_HISTORY_PAGE,
	type SessionEvent,
	SessionEventBody,
	type SessionListItem,
	type SessionStatus,
	TurnOutcome,
} from "@sfly/schema";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { projects, sessionEvents, sessions } from "../db/schema.js";
import type { ProjectId } from "../projects/project-id.js";
import { Topics } from "../sse/topics.js";
import { isUuid } from "../util/uuid.js";

/** 库里的一个会话。 */
export type SessionRow = typeof sessions.$inferSelect;

const PERSISTED: ReadonlySet<string> = new Set(PERSISTED_SESSION_EVENT_TYPES);

/** 事件类型是不是持久的（落库的）。 */
export const isPersistedType = (type: string): boolean => PERSISTED.has(type);

/** 补发时一次从库里读多少条事件。 */
const REPLAY_BATCH = 200;

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

/** 写事件时会话不存在。 */
export class SessionNotFoundError extends Error {
	constructor(readonly sessionId: string) {
		super(`会话 ${sessionId} 不存在`);
	}
}

export interface SessionStoreDeps {
	db: Db;
	clock: Clock;
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

	constructor(private readonly deps: SessionStoreDeps) {}

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
	 * 同样活跃的按 ID 排，顺序固定。
	 */
	async list(project: ProjectId): Promise<SessionListItem[]> {
		const { db } = this.deps;
		const rows = await db
			.select()
			.from(sessions)
			.where(eq(sessions.projectId, project))
			.orderBy(
				sql`case when ${sessions.status} in ('running', 'queued') then 0 else 1 end`,
				desc(sessions.lastActivityAt),
				desc(sessions.id),
			);
		const outcomes = await this.#lastOutcomes(rows.map((row) => row.id));
		return rows.map((row) => toListItem(row, outcomes.get(row.id) ?? null));
	}

	/** 一个会话上一轮的结局（最近一条 `turn_end`）；没有结束过的一轮时为 null。 */
	async lastOutcome(sessionId: string): Promise<TurnOutcome | null> {
		return (await this.#lastOutcomes([sessionId])).get(sessionId) ?? null;
	}

	async #lastOutcomes(ids: string[]): Promise<Map<string, TurnOutcome>> {
		const outcomes = new Map<string, TurnOutcome>();
		if (ids.length === 0) return outcomes;
		const rows = await this.deps.db
			.selectDistinctOn([sessionEvents.sessionId], {
				sessionId: sessionEvents.sessionId,
				outcome: sql<string | null>`${sessionEvents.payload}->>'outcome'`,
			})
			.from(sessionEvents)
			.where(and(inArray(sessionEvents.sessionId, ids), eq(sessionEvents.type, "turn_end")))
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
	): Promise<{ events: PersistedSessionEvent[]; hasMore: boolean }> {
		const rows = await this.deps.db
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
	 * 新建一个会话（`created_by_user_id` 是发起人的用户，#494 之前的请求没有用户）。同一个项目已经有一个 `running`
	 * 的会话时，建一个 `running` 的会拿到数据库的唯一约束错误（`sessions_one_running_per_project`），由调用方
	 * 先查一遍、再把冲突的情况翻译成 409。
	 */
	async create(input: {
		project: ProjectId;
		title: string;
		status: SessionStatus;
		createdBy: string;
		createdByUserId: string | null;
	}): Promise<SessionRow> {
		const now = this.deps.clock.now();
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
	}

	/**
	 * 记一条持久事件，返回落库后的事件（带 `seq`、`at`）并发布给订阅这个会话的连接。序号在会话内严格递增、不重复：
	 * 在同一个事务里锁住会话那一行再取下一个，并发写同一个会话的几条事件依次执行。落库的同时更新会话的
	 * `last_activity_at`。发布在事务提交之后：订阅的一方收到时，库里一定读得到它。
	 * `at` 是事件**产生**的时间，不是落库的时间：助手服务产生的事件传它盖的时间（`AssistantStreamRecord.at`），
	 * 控制面自己产生的不传，用控制面的时钟（#538 的约定）。
	 * 事件的内容要过 `@sfly/schema` 的 `SessionEventBody`；不持久的类型不能用它记（用 {@link publish}）。
	 */
	async append(
		sessionId: string,
		body: SessionEventBody,
		at: Date = this.deps.clock.now(),
	): Promise<PersistedSessionEvent> {
		if (!isPersistedType(body.type)) {
			throw new Error(`会话事件 ${body.type} 不持久，不能落库（用 publish 推送）`);
		}
		const parsed = SessionEventBody.parse(body);
		const { type, ...payload } = parsed;
		const event = await this.deps.db.transaction(async (tx) => {
			const [session] = await tx
				.select({ id: sessions.id })
				.from(sessions)
				.where(eq(sessions.id, sessionId))
				.for("update");
			if (!session) throw new SessionNotFoundError(sessionId);
			const [last] = await tx
				.select({ seq: sql<number>`coalesce(max(${sessionEvents.seq}), 0)::int` })
				.from(sessionEvents)
				.where(eq(sessionEvents.sessionId, sessionId));
			const [row] = await tx
				.insert(sessionEvents)
				.values({
					sessionId,
					seq: (last?.seq ?? 0) + 1,
					type,
					payload,
					createdAt: at,
				})
				.returning();
			// 事件的时间来自另一个时钟时可能比会话已有的最近活动还早：最近活动不倒退。
			await tx
				.update(sessions)
				.set({
					lastActivityAt: sql`greatest(${sessions.lastActivityAt}, ${at.toISOString()}::timestamptz)`,
				})
				.where(eq(sessions.id, sessionId));
			return toEvent(row as EventRow);
		});
		this.#live.publish(sessionId, event);
		return event;
	}

	/** 推送一条不持久的事件（文字增量、工具输出、思考、排队状态、快照）：不落库，没有 `seq`，不推进续传的位置。 */
	publish(sessionId: string, body: SessionEventBody): void {
		if (isPersistedType(body.type)) {
			throw new Error(`会话事件 ${body.type} 是持久的，要落库（用 append）`);
		}
		this.#live.publish(sessionId, SessionEventBody.parse(body) as SessionEvent);
	}

	/**
	 * 实时推送一个会话的事件（`GET /sessions/:id/events`）：先订阅再从库里补发，订阅之后发布的排在补发之后，
	 * 持久的事件按 `seq` 去重，所以按事件 ID 接续不重复也不遗漏。`after` 是已经收到的最大序号（0 表示从头开始）；
	 * 不持久的事件没有序号，不推进它。返回取消订阅的函数；读库出错时调用 `onError`，之后不再推送。
	 */
	follow(
		sessionId: string,
		after: number,
		emit: (event: SessionEvent) => void,
		onError: (error: unknown) => void,
	): () => void {
		let stopped = false;
		let ready = false;
		let sent = after;
		const pending: SessionEvent[] = [];
		const deliver = (event: SessionEvent) => {
			if (stopped) return;
			if ("seq" in event) {
				if (event.seq <= sent) return;
				sent = event.seq;
			}
			emit(event);
		};
		const unsubscribe = this.#live.subscribe(sessionId, (event) => {
			if (ready) deliver(event);
			else pending.push(event);
		});
		const replay = async () => {
			for (;;) {
				const batch = await this.after(sessionId, sent, REPLAY_BATCH);
				if (stopped) return;
				for (const event of batch) deliver(event);
				if (batch.length < REPLAY_BATCH) break;
			}
			ready = true;
			for (const event of pending.splice(0)) deliver(event);
		};
		replay().catch((error) => {
			if (stopped) return;
			stopped = true;
			unsubscribe();
			onError(error);
		});
		return () => {
			stopped = true;
			unsubscribe();
		};
	}
}
