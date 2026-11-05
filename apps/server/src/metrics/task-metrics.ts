import type { AgentMessage, MetricBatch } from "@sfly/proto";
import type {
	MetricIncrement,
	MetricPointView,
	MetricSummary,
	OrchestrationDocument,
	RunMetricSummary,
} from "@sfly/schema";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import type { AgentConnection } from "../agents/agent-hub.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { metricSeries, orchestrationVersions, runs, tasks } from "../db/schema.js";
import { Topics } from "../sse/topics.js";
import { isUuid } from "../util/uuid.js";
import { nodeTypeOf } from "./node-types.js";

/**
 * 指标上报与存储（#29，ADR 0009）。
 *
 * ## 接收
 * Agent 按「任务 × 指标 × 秒」合并后以 `MetricBatch` 上报（每个任务每秒最多一批）。只接受任务所在 Agent、
 * attempt 一致的批次；节点类型没有声明的指标名（兜底，SDK 已经丢弃过一次）和非有限数值被丢弃；
 * 同一指标不晚于已收到的最后一秒的点视为重复而忽略（幂等）。
 *
 * ## 分段表 `metric_segments`
 * 按天分区（`start_at`），一行 = 一个任务一个指标的一段：时间偏移（秒，相对 start_at）、值、每秒最小 / 最大值的
 * 类型化数组 + 段摘要 + 预留的 ext（jsonb）。分区在第一次写入那一天的数据时创建（之后 #32 提前创建、到期整天删除）。
 *
 * 段的大小按实测确定：PostgreSQL 只在一行超过约 2 KB（TOAST_TUPLE_THRESHOLD，与 toast_tuple_target 无关）时
 * 才尝试压缩，每点 4 个数组元素约 28 字节，所以一段攒满 {@link SEGMENT_POINTS} 个点（约 3.4 KB）才关闭；
 * 分区设置 `toast_tuple_target = 128`，触发后所有数组都在行内（STORAGE MAIN）压缩，而不是压到 2 KB 以下就停。
 * 为了让控制面崩溃时最多丢失约 10 秒的点，还没攒满的当前段每约 {@link FLUSH_AFTER_MS} 毫秒把已有的点整段重写一次
 * （按 task_id + metric + start_at upsert）；攒满后关闭，之后不再修改。任务结束时立即写入。
 *
 * ## 摘要
 * 每个「任务 × 指标」一行 `metric_series`（点数、最小、最大、总和、最新值、首尾时间），与段在同一个事务里更新；
 * 任务行记录已写入的点数、截断标记和 Agent 丢弃的点数。
 *
 * ## 上限
 * 单任务所有指标合计最多 `limitBytes / 28` 个点（默认约 50 MB）；超出后不再写入，`tasks.metric_truncated` 置为 true。
 *
 * 与日志一样不经过引擎的互斥锁；同一个任务的处理按到达顺序串行执行。
 */

/** 一段最多的点数（约 3.4 KB，保证超过压缩门槛）。 */
export const SEGMENT_POINTS = 120;
/** 当前段有未写入的点时，最长多久写一次（按注入的时钟）。 */
export const FLUSH_AFTER_MS = 10_000;
/** 每个点在段里的大小：时间偏移 int4 + 值 / 最小值 / 最大值 3 × float8。 */
export const BYTES_PER_POINT = 4 + 3 * 8;
/** 单个任务指标数据的默认上限：50 MB。 */
export const DEFAULT_METRIC_LIMIT_BYTES = 50 * 1024 * 1024;
/** 没有未写入数据、这么久没收到上报的任务状态从内存中移除。 */
const IDLE_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

/** 合并后的一个点（一个指标一秒一个）。 */
export interface Point {
	/** Unix 秒。 */
	t: number;
	value: number;
	min: number;
	max: number;
}

interface Series {
	name: string;
	/** 摘要（含尚未写入的点）；没有点时 points 为 0。 */
	points: number;
	min: number;
	max: number;
	sum: number;
	last: number;
	/** Unix 秒。 */
	firstAt: number;
	lastAt: number;
	/** 当前（未关闭的）段的全部点，包括已经写入过的。 */
	segment: Point[];
	/** 已经攒满、还没写入的段。 */
	closed: Point[][];
	/** 当前段第一次有未写入的点的时刻（时钟毫秒）；没有未写入的点时为 undefined。 */
	dirtySince: number | undefined;
}

interface TaskState {
	taskId: string;
	runId: string;
	chainInstanceId: string;
	nodeId: string;
	attempt: number;
	agentName: string | null;
	/** 节点类型声明的指标名。 */
	declared: Set<string>;
	/** 已接受的点数（所有指标合计，含尚未写入的）。 */
	points: number;
	truncated: boolean;
	dropped: number;
	/** 截断标记或丢弃计数还没写入。 */
	countersDirty: boolean;
	series: Map<string, Series>;
	lastSeen: number;
}

export class TaskMetrics {
	#states = new Map<string, Promise<TaskState | undefined>>();
	#queues = new Map<string, Promise<void>>();
	#partitions = new Map<string, Promise<void>>();

	/**
	 * 新接受的点（#31），主题 = 运行 ID：运行事件流以 `metrics` 事件推送。每批上报最多一条，
	 * 被丢弃的点（重复、未声明、非有限、超出上限）不推送。
	 */
	readonly increments = new Topics<MetricIncrement>();

	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			/** 单个任务指标数据的上限（字节，按每点 28 字节折算成点数），默认 {@link DEFAULT_METRIC_LIMIT_BYTES}。 */
			limitBytes?: number;
		},
	) {}

	get #limitPoints(): number {
		return Math.floor((this.deps.limitBytes ?? DEFAULT_METRIC_LIMIT_BYTES) / BYTES_PER_POINT);
	}

	/** 这条 Agent 消息是否由这里处理（指标）。 */
	handles(message: AgentMessage): boolean {
		return message.body.case === "metrics";
	}

	async onMessage(conn: AgentConnection, message: AgentMessage): Promise<void> {
		if (message.body.case === "metrics") await this.ingest(conn.name, message.body.value);
	}

	/** 接收一批指标点（只接受任务所在 Agent 上报的）；攒满一段时写入。 */
	ingest(agentName: string, batch: MetricBatch): Promise<void> {
		if (!isUuid(batch.taskId)) return Promise.resolve();
		return this.#serial(batch.taskId, async () => {
			const state = await this.#stateFor(batch.taskId, agentName);
			if (!state || state.attempt !== batch.attempt) return;
			const now = this.deps.clock.now().getTime();
			state.lastSeen = now;
			if (batch.droppedPoints > 0n) {
				state.dropped += Number(batch.droppedPoints);
				state.countersDirty = true;
			}
			const full = new Set<Series>();
			const accepted: MetricPointView[] = [];
			for (const p of batch.points) {
				if (!state.declared.has(p.name)) continue;
				if (![p.value, p.min, p.max].every(Number.isFinite)) continue;
				const t = Number(p.timeUnixS);
				let series = state.series.get(p.name);
				if (series && series.points > 0 && t <= series.lastAt) continue;
				if (state.truncated) continue;
				if (state.points >= this.#limitPoints) {
					state.truncated = true;
					state.countersDirty = true;
					continue;
				}
				if (!series) {
					series = emptySeries(p.name);
					state.series.set(p.name, series);
				}
				const point = {
					t,
					value: p.value,
					min: Math.min(p.min, p.value),
					max: Math.max(p.max, p.value),
				};
				addPoint(series, point);
				accepted.push({
					name: p.name,
					time: new Date(t * 1000).toISOString(),
					value: point.value,
					min: point.min,
					max: point.max,
				});
				series.dirtySince ??= now;
				state.points++;
				if (series.segment.length >= SEGMENT_POINTS) {
					series.closed.push(series.segment);
					series.segment = [];
					full.add(series);
				}
			}
			if (accepted.length > 0) {
				this.increments.publish(state.runId, {
					task_id: state.taskId,
					chain_instance_id: state.chainInstanceId,
					node_id: state.nodeId,
					attempt: state.attempt,
					points: accepted,
				});
			}
			if (full.size > 0 || state.countersDirty) await this.#write(state, [...full]);
		});
	}

	/** 周期扫描：写入已经攒了约 10 秒的当前段，移除长时间没有上报的任务状态。 */
	async flushDue(): Promise<void> {
		const now = this.deps.clock.now().getTime();
		for (const [taskId, pending] of [...this.#states]) {
			const state = await pending.catch(() => undefined);
			if (!state) continue;
			await this.#serial(taskId, async () => {
				const due = [...state.series.values()].filter(
					(s) => s.dirtySince !== undefined && now - s.dirtySince >= FLUSH_AFTER_MS,
				);
				if (due.length > 0 || state.countersDirty) await this.#write(state, due);
				const dirty = [...state.series.values()].some((s) => s.dirtySince !== undefined);
				if (!dirty && now - state.lastSeen >= IDLE_MS && this.#states.get(taskId) === pending) {
					this.#states.delete(taskId);
				}
			});
		}
	}

	/** 任务结束：立即写入它尚未写入的点，并释放内存中的状态。 */
	flushTask(taskId: string): Promise<void> {
		const pending = this.#states.get(taskId);
		if (!pending) return Promise.resolve();
		return this.#serial(taskId, async () => {
			const state = await pending.catch(() => undefined);
			if (!state) return;
			await this.#flushAll(state);
			if (this.#states.get(taskId) === pending) this.#states.delete(taskId);
		});
	}

	/** 写入全部尚未写入的点（控制面正常关闭时）。 */
	async close(): Promise<void> {
		await Promise.all([...this.#states.keys()].map((id) => this.flushTask(id)));
	}

	/**
	 * 内存里可能还没写库（或库里只是较早版本）的点：每个指标已攒满还没写入的段和当前段，按时间升序。
	 * 序列查询用它们覆盖库里同一时间范围的数据。不会为此从库里加载任务状态。
	 */
	async unwritten(taskId: string): Promise<Map<string, Point[]>> {
		const state = await this.#states.get(taskId)?.catch(() => undefined);
		const points = new Map<string, Point[]>();
		for (const s of state?.series.values() ?? []) {
			const list = [...s.closed.flat(), ...s.segment].map((p) => ({ ...p }));
			if (list.length > 0) points.set(s.name, list);
		}
		return points;
	}

	/** 运行的指标摘要；运行不存在时为 undefined。 */
	async summary(runId: string): Promise<RunMetricSummary | undefined> {
		if (!isUuid(runId)) return undefined;
		const [run] = await this.deps.db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId));
		if (!run) return undefined;
		const taskRows = await this.deps.db
			.select({
				id: tasks.id,
				chainInstanceId: tasks.chainInstanceId,
				nodeId: tasks.nodeId,
				attempt: tasks.attempt,
				truncated: tasks.metricTruncated,
				dropped: tasks.metricDropped,
			})
			.from(tasks)
			.where(
				and(
					eq(tasks.runId, runId),
					or(
						gt(tasks.metricPoints, 0),
						eq(tasks.metricTruncated, true),
						gt(tasks.metricDropped, 0),
					),
				),
			)
			.orderBy(asc(tasks.seq));
		const seriesRows = await this.deps.db
			.select()
			.from(metricSeries)
			.where(eq(metricSeries.runId, runId))
			.orderBy(asc(metricSeries.metric));
		const byTask = new Map<string, MetricSummary[]>();
		for (const row of seriesRows) {
			const list = byTask.get(row.taskId) ?? [];
			list.push({
				name: row.metric,
				points: row.points,
				min: row.min,
				max: row.max,
				avg: row.sum / row.points,
				last: row.last,
				first_time: row.firstAt.toISOString(),
				last_time: row.lastAt.toISOString(),
			});
			byTask.set(row.taskId, list);
		}
		return {
			run_id: runId,
			tasks: taskRows.map((t) => ({
				task_id: t.id,
				chain_instance_id: t.chainInstanceId,
				node_id: t.nodeId,
				attempt: t.attempt,
				truncated: t.truncated,
				dropped_points: t.dropped,
				metrics: byTask.get(t.id) ?? [],
			})),
		};
	}

	async #flushAll(state: TaskState): Promise<void> {
		const dirty = [...state.series.values()].filter((s) => s.dirtySince !== undefined);
		if (dirty.length > 0 || state.countersDirty) await this.#write(state, dirty);
	}

	/** 写入这些指标攒满的段、当前段与摘要，以及任务的计数。 */
	async #write(state: TaskState, list: Series[]): Promise<void> {
		const segments = list.flatMap((s) =>
			[...s.closed, s.segment]
				.filter((points) => points.length > 0)
				.map((points) => ({ s, points })),
		);
		for (const { points } of segments) await this.#ensurePartition((points[0] as Point).t);
		await this.deps.db.transaction(async (tx) => {
			for (const { s, points: segment } of segments) {
				const start = segment[0];
				const end = segment[segment.length - 1];
				if (!start || !end) continue;
				const values = segment.map((p) => p.value);
				const mins = segment.map((p) => p.min);
				const maxs = segment.map((p) => p.max);
				const startAt = new Date(start.t * 1000);
				await tx.execute(sql`
					insert into metric_segments
						(run_id, task_id, metric, start_at, end_at, offsets, "values", mins, maxs, points, min, max, avg, last)
					values (
						${state.runId}, ${state.taskId}, ${s.name}, ${startAt.toISOString()}, ${new Date(end.t * 1000).toISOString()},
						${sql.param(segment.map((p) => p.t - start.t))}::int4[], ${sql.param(values)}::float8[],
						${sql.param(mins)}::float8[], ${sql.param(maxs)}::float8[],
						${segment.length}, ${Math.min(...mins)}, ${Math.max(...maxs)},
						${values.reduce((a, b) => a + b, 0) / values.length}, ${end.value}
					)
					on conflict (task_id, metric, start_at) do update set
						end_at = excluded.end_at, offsets = excluded.offsets, "values" = excluded."values",
						mins = excluded.mins, maxs = excluded.maxs, points = excluded.points,
						min = excluded.min, max = excluded.max, avg = excluded.avg, last = excluded.last`);
			}
			for (const s of list) {
				const summary = {
					points: s.points,
					min: s.min,
					max: s.max,
					sum: s.sum,
					last: s.last,
					firstAt: new Date(s.firstAt * 1000),
					lastAt: new Date(s.lastAt * 1000),
				};
				await tx
					.insert(metricSeries)
					.values({ taskId: state.taskId, runId: state.runId, metric: s.name, ...summary })
					.onConflictDoUpdate({ target: [metricSeries.taskId, metricSeries.metric], set: summary });
			}
			await tx
				.update(tasks)
				.set({
					metricPoints: [...state.series.values()].reduce((n, s) => n + s.points, 0),
					metricTruncated: state.truncated,
					metricDropped: state.dropped,
				})
				.where(eq(tasks.id, state.taskId));
		});
		state.countersDirty = false;
		for (const s of list) {
			s.dirtySince = undefined;
			s.closed = [];
		}
	}

	/** 确保 Unix 秒 t 所在那一天（UTC）的分区存在。 */
	#ensurePartition(t: number): Promise<void> {
		const from = new Date(Math.floor((t * 1000) / DAY_MS) * DAY_MS);
		const name = `metric_segments_${from.toISOString().slice(0, 10).replaceAll("-", "")}`;
		let created = this.#partitions.get(name);
		if (!created) {
			const to = new Date(from.getTime() + DAY_MS);
			created = this.deps.db
				.execute(
					sql.raw(
						`create table if not exists "${name}" partition of metric_segments ` +
							`for values from ('${from.toISOString()}') to ('${to.toISOString()}') ` +
							"with (toast_tuple_target = 128)",
					),
				)
				.then(() => {});
			this.#partitions.set(name, created);
			created.catch(() => this.#partitions.delete(name));
		}
		return created;
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

	/** 任务所在 Agent 是 agentName 时的状态；缓存里的可能是派发之前读到的，不一致时重新读取一次。 */
	async #stateFor(taskId: string, agentName: string): Promise<TaskState | undefined> {
		let state = await this.#state(taskId);
		if (state && state.agentName !== agentName && state.points === 0) {
			this.#states.delete(taskId);
			state = await this.#state(taskId);
		}
		return state?.agentName === agentName ? state : undefined;
	}

	#state(taskId: string): Promise<TaskState | undefined> {
		let state = this.#states.get(taskId);
		if (!state) {
			state = this.#load(taskId);
			this.#states.set(taskId, state);
			// 没找到的任务不缓存（可能稍后才创建）。
			void state.then(
				(s) => {
					if (!s) this.#states.delete(taskId);
				},
				() => this.#states.delete(taskId),
			);
		}
		return state;
	}

	async #load(taskId: string): Promise<TaskState | undefined> {
		const [row] = await this.deps.db
			.select({ task: tasks, document: orchestrationVersions.document })
			.from(tasks)
			.innerJoin(runs, eq(runs.id, tasks.runId))
			.innerJoin(orchestrationVersions, eq(orchestrationVersions.id, runs.orchestrationVersionId))
			.where(eq(tasks.id, taskId));
		if (!row) return undefined;
		const { task } = row;
		const declared = await this.#declared(row.document, task.nodeId, task.agentName);
		const rows = await this.deps.db
			.select()
			.from(metricSeries)
			.where(eq(metricSeries.taskId, taskId));
		const series = new Map<string, Series>();
		for (const r of rows) {
			series.set(r.metric, {
				name: r.metric,
				points: r.points,
				min: r.min,
				max: r.max,
				sum: r.sum,
				last: r.last,
				firstAt: r.firstAt.getTime() / 1000,
				lastAt: r.lastAt.getTime() / 1000,
				// 重启前没关闭的段不再续写：之后的点从新的一段开始。
				segment: [],
				closed: [],
				dirtySince: undefined,
			});
		}
		return {
			taskId,
			runId: task.runId,
			chainInstanceId: task.chainInstanceId,
			nodeId: task.nodeId,
			attempt: task.attempt,
			agentName: task.agentName,
			declared,
			points: task.metricPoints,
			truncated: task.metricTruncated,
			dropped: task.metricDropped,
			countersDirty: false,
			series,
			lastSeen: this.deps.clock.now().getTime(),
		};
	}

	/** 任务的节点类型声明的指标名：锁定的节点包版本；开发版本取任务所在 Agent 上报的元信息。 */
	async #declared(
		document: OrchestrationDocument,
		nodeId: string,
		agentName: string | null,
	): Promise<Set<string>> {
		const ref = await nodeTypeOf(this.deps.db, document, nodeId, agentName);
		return new Set((ref?.type?.metrics ?? []).map((m) => m.name));
	}
}

function emptySeries(name: string): Series {
	return {
		name,
		points: 0,
		min: Number.POSITIVE_INFINITY,
		max: Number.NEGATIVE_INFINITY,
		sum: 0,
		last: 0,
		firstAt: 0,
		lastAt: 0,
		segment: [],
		closed: [],
		dirtySince: undefined,
	};
}

function addPoint(series: Series, p: Point): void {
	if (series.points === 0) series.firstAt = p.t;
	series.points++;
	series.min = Math.min(series.min, p.min);
	series.max = Math.max(series.max, p.max);
	series.sum += p.value;
	series.last = p.value;
	series.lastAt = p.t;
	series.segment.push(p);
}
