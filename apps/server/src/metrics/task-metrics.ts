import type { AgentMessage, MetricBatch } from "@sfly/proto";
import {
	compareSeries,
	isLabeled,
	type Labels,
	MAX_SERIES,
	type MetricDataLoss,
	type MetricDeclaration,
	type MetricIncrement,
	type MetricPointView,
	type MetricSummary,
	type OrchestrationDocument,
	type RunMetricSummary,
	seriesKey,
	sortedLabels,
} from "@sfly/schema";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { type ConnectionClock, recordableAgentTimeMs } from "../agents/agent-clock.js";
import type { AgentConnection } from "../agents/agent-hub.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { metricSeries, orchestrationVersions, runs, tasks } from "../db/schema.js";
import { Topics } from "../sse/topics.js";
import { isUuid } from "../util/uuid.js";
import { labelsMatch } from "./labels.js";
import { type MetricRetention, purgeRunMetrics } from "./metric-retention.js";
import { nodeTypeOf } from "./node-types.js";

/**
 * 指标上报与存储（#29，ADR 0009）。
 *
 * ## 接收
 * Agent 按「任务 × 序列 × 秒」合并后以 `MetricBatch` 上报（每个任务每秒最多一批）。序列是指标名加标签（#78）。
 * 只接受任务所在 Agent、attempt 一致的批次；节点类型没有声明的指标名（兜底，SDK 已经丢弃过一次）和非有限数值被丢弃；
 * 标签与声明的标签键不一致（见 {@link labelsMatch}）的点被丢弃并计入任务的丢弃数；
 *
 * ## 两种时间（ADR 0018，#174）
 * 每个点有两个时间。**控制面时间**是这个点在 Agent 上发生的时刻：Agent 打的单调时钟读数（`monotonic_ms`，
 * 合并的那一秒的起点）按连接的对应关系折算（{@link ConnectionClock}），按秒取整。序列内的顺序与去重、
 * 可接收范围、分区和保留期都只看它，所以断线期间排队的点重连后落在发生的时刻。**Agent 时间**（`time_unix_s`）
 * 原样保存，不做范围检查，不参与排序：它快 613 天、是 1970 年或中途倒退，点都照常接收，曲线连续。
 * - 同一序列里，单调时钟读数不晚于已收到的最后一个点的视为重复而忽略（幂等）；控制面重启后不记得上一个点的读数，
 *   这时折算出的时间不晚于最后一个点的视为重复。去重不看 Agent 时间。
 * - 不是重复、控制面时间却不晚于序列最后一个点时（重连后对应关系重新建立，误差是一次网络延迟；或者没有读数的点
 *   在同一秒收到），紧接着排在它后一秒，不丢弃。
 * - 旧版本 Agent 的点不带读数（{@link ArrivalTimes}），控制面时间按收到这一批的时刻排，没法判断重复，全部接收。
 *   一批通常每个序列一个点，就是收到的时刻。断线后补发的一大批里同一序列有多个点：Agent 时间最新的点取收到的
 *   时刻，其余的按与它的 Agent 时间间隔往前排，不挤在同一秒；间隔不可信时（同一序列里 Agent 时间没有递增，或往前
 *   排会超出可接收范围：Agent 时间中途跳变过）整批改按到达顺序排，每个序列的最后一个点取收到的时刻，前面的每秒
 *   一个往前排。Agent 时间取什么值都不会让点被丢弃或排错顺序。
 * - 序列里已有的点是升级之前写入的（只有 Agent 时间）时，新点不与它们比较：不去重，也不往后排。
 * - 控制面时间超出可接收范围（保留期内到最后一个提前创建的分区为止，见 src/metrics/metric-retention.ts）的点被丢弃。
 *
 * ## 分段表 `metric_segments`
 * 按天分区（`start_at`，控制面时间），一行 = 一个任务一个序列（指标名 + 标签 `labels`）的一段：时间偏移（秒，相对 start_at）、
 * 值、每秒最小 / 最大值的类型化数组 + 段摘要，以及每个点的「Agent 时间 − 控制面时间」（秒，`agent_offsets`）。
 * 这个差值在一段里通常不变，全段相同时只存一个元素（一段多十几个字节）；Agent 时间中途被改动、或合并的那一秒
 * 正好跨过 Agent 时间的整秒时才逐点存（120 个点约 1 KB，值只有两三种，随整行一起压缩）。
 * 升级之前写入的段没有这一列（NULL）：它的时间列是 Agent 时间，控制面时间没有记录。
 * 分区的创建与到期删除见 src/metrics/metric-retention.ts（#32）。
 *
 * 段的大小按实测确定：PostgreSQL 只在一行超过约 2 KB（TOAST_TUPLE_THRESHOLD，与 toast_tuple_target 无关）时
 * 才尝试压缩，每点 4 个数组元素约 28 字节，所以一段攒满 {@link SEGMENT_POINTS} 个点（约 3.4 KB）才关闭；
 * 分区设置 `toast_tuple_target = 128`，触发后所有数组都在行内（STORAGE MAIN）压缩，而不是压到 2 KB 以下就停。
 * 为了让控制面崩溃时最多丢失约 10 秒的点，还没攒满的当前段每约 {@link FLUSH_AFTER_MS} 毫秒把已有的点整段重写一次
 * （按 task_id + metric + labels + start_at upsert）；攒满后关闭，之后不再修改。任务结束时立即写入。
 *
 * ## 摘要
 * 每个「任务 × 序列」一行 `metric_series`（点数、最小、最大、总和、最新值、首尾的控制面时间和 Agent 时间），与段在同一个事务里更新；
 * 任务行记录已写入的点数（不含内存里还没写库的点，崩溃后与摘要一致）、截断标记和 Agent 丢弃的点数。
 *
 * ## 上限
 * 单任务所有序列合计最多 `limitBytes / 28` 个点（默认约 50 MB）；超出后不再写入，`tasks.metric_truncated` 置为 true。
 *
 * 单任务所有指标合计最多 {@link MAX_SERIES} 个序列（SDK 已经执行过一次，这里兜底）：不带标签的指标各占 1 个名额
 * （按声明预留，总是能写入），带标签的新序列在名额用完后被拒绝——点计入丢弃数，`tasks.metric_series_capped` 置为 true；
 * 已有序列照常写入。两个上限互不影响：被拒的序列不占点数，点数截断也不影响序列名额。
 *
 * 与日志一样不经过引擎的互斥锁；同一个任务的处理按到达顺序串行执行。
 */

/** 一段最多的点数（约 3.4 KB，保证超过压缩门槛）。 */
export const SEGMENT_POINTS = 120;
/** 当前段有未写入的点时，最长多久写一次（按注入的时钟）。 */
export const FLUSH_AFTER_MS = 10_000;
/** 每个点在段里的大小：时间偏移 int4 + 值 / 最小值 / 最大值 3 × float8（Agent 时间的差值通常全段只存一个，不计）。 */
export const BYTES_PER_POINT = 4 + 3 * 8;
/** 单个任务指标数据的默认上限：50 MB。 */
export const DEFAULT_METRIC_LIMIT_BYTES = 50 * 1024 * 1024;
/** 没有未写入数据、这么久没收到上报的任务状态从内存中移除。 */
const IDLE_MS = 5 * 60_000;

/** 上报的 Agent 时间（Unix 秒，任意值）→ 能记录的 Unix 秒（超出范围的按边界值记录，点照常接收）。 */
const agentSeconds = (timeUnixS: bigint): number =>
	Math.floor(recordableAgentTimeMs(Number(timeUnixS) * 1000) / 1000);

/** 一批指标的来源：上报它的 Agent，以及这次连接的「单调时钟读数 → 控制面时间」对应关系。 */
export interface MetricSource {
	name: string;
	clock: ConnectionClock;
}

/** 合并后的一个点（一个序列一秒一个）。 */
export interface Point {
	/** 控制面时间（Unix 秒）：序列内严格递增。 */
	t: number;
	/** Agent 时间（Unix 秒）：原样记录，可能倒退或与 t 相差很远。 */
	agentT: number;
	value: number;
	min: number;
	max: number;
}

/** 内存里还没写库的一个序列的点（序列查询用）。 */
export interface UnwrittenSeries {
	name: string;
	labels: Labels;
	/** 按时间升序。 */
	points: Point[];
}

interface Series {
	name: string;
	/** 键已排序；不带标签时为 `{}`。 */
	labels: Labels;
	/** 摘要（含尚未写入的点）；没有点时 points 为 0。 */
	points: number;
	/** 其中已经写库的点数（`tasks.metric_points` 只计这些，与 `metric_series` 一致）。 */
	written: number;
	min: number;
	max: number;
	sum: number;
	last: number;
	/**
	 * 首尾的控制面时间（Unix 秒）。升级之前写入的序列（只有 Agent 时间）：firstAt 是 Agent 时间，新点更早时改成
	 * 新点的时间；lastAt 在收到新点之前是负无穷，新点不与旧数据的 Agent 时间比较。
	 */
	firstAt: number;
	lastAt: number;
	/** 首尾的 Agent 时间（Unix 秒）。 */
	firstAgentAt: number;
	lastAgentAt: number;
	/** 已收到的最后一个点的单调时钟读数（去重用）；重启后、或最后一个点来自旧版本 Agent 时为 undefined。 */
	lastMono: number | undefined;
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
	/** 节点类型声明的指标名 → 声明的标签键（已排序，没有时为空）。 */
	declared: Map<string, string[]>;
	/** 已接受的点数（所有序列合计，含尚未写入的）。 */
	points: number;
	truncated: boolean;
	/** 序列数超过上限，拒绝过新序列。 */
	seriesCapped: boolean;
	/** 带标签的序列最多这么多个：{@link MAX_SERIES} 减去声明的不带标签的指标数。 */
	maxLabeledSeries: number;
	/** 已有的带标签的序列数。 */
	labeledSeries: number;
	dropped: number;
	/** 截断标记、序列超限标记或丢弃计数还没写入。 */
	countersDirty: boolean;
	/** 序列键（{@link seriesKey}）→ 序列。 */
	series: Map<string, Series>;
	lastSeen: number;
	/** 运行已过指标保留期（#32）：之后收到的点直接丢弃，不再写库。 */
	expired: boolean;
}

export class TaskMetrics {
	#states = new Map<string, Promise<TaskState | undefined>>();
	#queues = new Map<string, Promise<void>>();

	/**
	 * 新接受的点（#31），主题 = 运行 ID：运行事件流以 `metrics` 事件推送。每批上报最多一条，
	 * 被丢弃的点（重复、未声明、非有限、超出上限）不推送。
	 */
	readonly increments = new Topics<MetricIncrement>();

	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			/** 保留期与分区（#32）：写入前确保分区存在。 */
			retention: MetricRetention;
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
		if (message.body.case === "metrics") await this.ingest(conn, message.body.value);
	}

	/** 接收一批指标点（只接受任务所在 Agent 上报的）；攒满一段时写入。 */
	ingest(source: MetricSource, batch: MetricBatch): Promise<void> {
		if (!isUuid(batch.taskId)) return Promise.resolve();
		return this.#serial(batch.taskId, async () => {
			const state = await this.#stateFor(batch.taskId, source.name);
			if (!state || state.attempt !== batch.attempt || state.expired) return;
			const now = this.deps.clock.now().getTime();
			state.lastSeen = now;
			const arrival = new ArrivalTimes(source.clock, batch, now, this.deps.retention);
			if (batch.droppedPoints > 0n) {
				state.dropped += Number(batch.droppedPoints);
				state.countersDirty = true;
			}
			const full = new Set<Series>();
			const accepted: MetricPointView[] = [];
			for (const [i, p] of batch.points.entries()) {
				const keys = state.declared.get(p.name);
				if (keys === undefined) continue;
				if (!labelsMatch(p.labels, keys)) {
					state.dropped++;
					state.countersDirty = true;
					continue;
				}
				if (![p.value, p.min, p.max].every(Number.isFinite)) continue;
				const agentT = agentSeconds(p.timeUnixS);
				// 能折算的读数（去重用）和控制面时间；没有读数的点（旧版本 Agent）按收到的时刻排。
				const occurredAt = source.clock.occurredAt(p.monotonicMs);
				const mono = occurredAt && Number(p.monotonicMs);
				let t = occurredAt ? Math.floor(occurredAt.getTime() / 1000) : arrival.of(i);
				const key = seriesKey(p.name, p.labels);
				let series = state.series.get(key);
				if (series && series.points > 0) {
					if (isDuplicate(series, t, mono)) continue;
					if (t <= series.lastAt) t = series.lastAt + 1;
				}
				// 控制面时间超出可接收范围的丢弃（例如排队太久、已经过了保留期的点），不为它建分区（#32）。
				if (!this.deps.retention.accepts(t)) continue;
				if (state.truncated) continue;
				if (state.points >= this.#limitPoints) {
					state.truncated = true;
					state.countersDirty = true;
					continue;
				}
				if (!series && keys.length > 0) {
					if (state.labeledSeries >= state.maxLabeledSeries) {
						state.dropped++;
						state.seriesCapped = true;
						state.countersDirty = true;
						continue;
					}
					state.labeledSeries++;
				}
				if (!series) {
					series = emptySeries(p.name, sortedLabels(p.labels));
					state.series.set(key, series);
				}
				const point = {
					t,
					agentT,
					value: p.value,
					min: Math.min(p.min, p.value),
					max: Math.max(p.max, p.value),
				};
				addPoint(series, point);
				series.lastMono = mono;
				accepted.push({
					name: p.name,
					labels: series.labels,
					time: new Date(t * 1000).toISOString(),
					agent_time: new Date(agentT * 1000).toISOString(),
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
	 * 内存里可能还没写库（或库里只是较早版本）的点：每个序列已攒满还没写入的段和当前段，按时间升序；
	 * 键是 {@link seriesKey}。序列查询用它们覆盖库里同一时间范围的数据。不会为此从库里加载任务状态。
	 */
	async unwritten(taskId: string): Promise<Map<string, UnwrittenSeries>> {
		const state = await this.#states.get(taskId)?.catch(() => undefined);
		const result = new Map<string, UnwrittenSeries>();
		for (const [key, s] of state?.series ?? []) {
			const points = [...s.closed.flat(), ...s.segment].map((p) => ({ ...p }));
			if (points.length > 0) result.set(key, { name: s.name, labels: s.labels, points });
		}
		return result;
	}

	/** 运行的指标摘要；运行不存在时为 undefined，已过保留期（#32）时 expired 为 true、没有任务。 */
	async summary(runId: string): Promise<RunMetricSummary | undefined> {
		if (!isUuid(runId)) return undefined;
		const [run] = await this.deps.db
			.select({ id: runs.id, expiredAt: runs.metricsPurgedAt })
			.from(runs)
			.where(eq(runs.id, runId));
		if (!run) return undefined;
		if (run.expiredAt) return { run_id: runId, expired: true, tasks: [] };
		const taskRows = await this.deps.db
			.select({
				id: tasks.id,
				chainInstanceId: tasks.chainInstanceId,
				nodeId: tasks.nodeId,
				attempt: tasks.attempt,
				metricTruncated: tasks.metricTruncated,
				metricSeriesCapped: tasks.metricSeriesCapped,
				metricDropped: tasks.metricDropped,
			})
			.from(tasks)
			.where(
				and(
					eq(tasks.runId, runId),
					or(
						gt(tasks.metricPoints, 0),
						eq(tasks.metricTruncated, true),
						eq(tasks.metricSeriesCapped, true),
						gt(tasks.metricDropped, 0),
					),
				),
			)
			.orderBy(asc(tasks.seq));
		const byTask = await seriesSummaries(this.deps.db, runId);
		return {
			run_id: runId,
			expired: false,
			tasks: taskRows.map((t) => ({
				task_id: t.id,
				chain_instance_id: t.chainInstanceId,
				node_id: t.nodeId,
				attempt: t.attempt,
				...dataLossOf(t),
				metrics: byTask.get(t.id) ?? [],
			})),
		};
	}

	async #flushAll(state: TaskState): Promise<void> {
		const dirty = [...state.series.values()].filter((s) => s.dirtySince !== undefined);
		if (dirty.length > 0 || state.countersDirty) await this.#write(state, dirty);
	}

	/** 写入这些序列攒满的段、当前段与摘要，以及任务的计数。 */
	async #write(state: TaskState, list: Series[]): Promise<void> {
		const segments = list.flatMap((s) =>
			[...s.closed, s.segment]
				.filter((points) => points.length > 0)
				.map((points) => ({ s, points })),
		);
		const starts = segments.map(({ points }) => (points[0] as Point).t);
		let expired = false;
		const attempt = async () => {
			// 有段落在已整天过期的日期（分区已经或将被保留期扫描删除，#32）：不重建分区，运行的数据已不完整，
			// 与删除分区时一样把运行标记为已过保留期。
			const stale = starts.some((t) => this.deps.retention.dayExpired(t));
			if (!stale) for (const t of starts) await this.deps.retention.ensurePartition(t);
			await this.deps.db.transaction(async (tx) => {
				// 运行已过保留期（#32）就不再写回。锁住运行这一行，与保留期扫描（先标记再删摘要）互斥。
				const [run] = await tx
					.select({ purgedAt: runs.metricsPurgedAt })
					.from(runs)
					.where(eq(runs.id, state.runId))
					.for(stale ? "update" : "share");
				expired = !run || run.purgedAt !== null;
				if (!expired && stale) {
					await purgeRunMetrics(tx, [state.runId], this.deps.clock.now());
					expired = true;
				}
				if (expired) return;
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
							(run_id, task_id, metric, labels, start_at, end_at, offsets, agent_offsets, "values", mins, maxs, points, min, max, avg, last)
						values (
							${state.runId}, ${state.taskId}, ${s.name}, ${JSON.stringify(s.labels)}::jsonb,
							${startAt.toISOString()}, ${new Date(end.t * 1000).toISOString()},
							${sql.param(segment.map((p) => p.t - start.t))}::int4[],
							${sql.param(agentOffsets(segment))}::int8[], ${sql.param(values)}::float8[],
							${sql.param(mins)}::float8[], ${sql.param(maxs)}::float8[],
							${segment.length}, ${Math.min(...mins)}, ${Math.max(...maxs)},
							${values.reduce((a, b) => a + b, 0) / values.length}, ${end.value}
						)
						on conflict (task_id, metric, labels, start_at) do update set
							end_at = excluded.end_at, offsets = excluded.offsets, agent_offsets = excluded.agent_offsets,
							"values" = excluded."values",
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
						firstAgentAt: new Date(s.firstAgentAt * 1000),
						lastAgentAt: new Date(s.lastAgentAt * 1000),
					};
					await tx
						.insert(metricSeries)
						.values({
							taskId: state.taskId,
							runId: state.runId,
							metric: s.name,
							labels: s.labels,
							...summary,
						})
						.onConflictDoUpdate({
							target: [metricSeries.taskId, metricSeries.metric, metricSeries.labels],
							set: summary,
						});
				}
				await tx
					.update(tasks)
					.set({
						metricPoints: [...state.series.values()].reduce(
							(n, s) => n + (list.includes(s) ? s.points : s.written),
							0,
						),
						metricTruncated: state.truncated,
						metricSeriesCapped: state.seriesCapped,
						metricDropped: state.dropped,
					})
					.where(eq(tasks.id, state.taskId));
			});
		};
		try {
			await attempt();
		} catch (error) {
			if (!isMissingPartition(error)) throw error;
			// 分区在别处被删除（内存里「分区已存在」的记录过期了）：忘掉它们再写一次——还在保留期内的重新创建，
			// 刚被保留期扫描删除的不再重建（同上）。
			this.deps.retention.forgetPartitions(starts);
			await attempt();
		}
		if (expired) {
			// 丢弃内存中的点，之后收到的点也直接丢弃。
			state.expired = true;
			state.series = new Map();
		}
		state.countersDirty = false;
		for (const s of list) {
			s.dirtySince = undefined;
			s.closed = [];
			s.written = s.points;
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
			.select({
				task: tasks,
				document: orchestrationVersions.document,
				purgedAt: runs.metricsPurgedAt,
			})
			.from(tasks)
			.innerJoin(runs, eq(runs.id, tasks.runId))
			.innerJoin(orchestrationVersions, eq(orchestrationVersions.id, runs.orchestrationVersionId))
			.where(eq(tasks.id, taskId));
		if (!row) return undefined;
		const { task } = row;
		const metrics = await this.#declared(row.document, task.nodeId, task.agentName);
		const rows = await this.deps.db
			.select()
			.from(metricSeries)
			.where(eq(metricSeries.taskId, taskId));
		const series = new Map<string, Series>();
		for (const r of rows) {
			const labels = sortedLabels(r.labels);
			series.set(seriesKey(r.metric, labels), {
				name: r.metric,
				labels,
				points: r.points,
				written: r.points,
				min: r.min,
				max: r.max,
				sum: r.sum,
				last: r.last,
				firstAt: r.firstAt.getTime() / 1000,
				// 升级之前写入的摘要没有 Agent 时间：它的首尾时间就是 Agent 时间，没有可以和新点比较的控制面时间。
				lastAt: r.lastAgentAt === null ? Number.NEGATIVE_INFINITY : r.lastAt.getTime() / 1000,
				firstAgentAt: (r.firstAgentAt ?? r.firstAt).getTime() / 1000,
				lastAgentAt: (r.lastAgentAt ?? r.lastAt).getTime() / 1000,
				lastMono: undefined,
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
			declared: new Map(metrics.map((m) => [m.name, [...(m.labels ?? [])].sort()])),
			points: task.metricPoints,
			truncated: task.metricTruncated,
			seriesCapped: task.metricSeriesCapped,
			maxLabeledSeries: MAX_SERIES - metrics.filter((m) => !isLabeled(m)).length,
			labeledSeries: [...series.values()].filter((s) => Object.keys(s.labels).length > 0).length,
			dropped: task.metricDropped,
			countersDirty: false,
			series,
			lastSeen: this.deps.clock.now().getTime(),
			expired: row.purgedAt !== null,
		};
	}

	/** 任务的节点类型声明的指标：锁定的节点包版本；开发版本取任务所在 Agent 上报的元信息。 */
	async #declared(
		document: OrchestrationDocument,
		nodeId: string,
		agentName: string | null,
	): Promise<MetricDeclaration[]> {
		const ref = await nodeTypeOf(this.deps.db, document, nodeId, agentName);
		return ref?.type?.metrics ?? [];
	}
}

/** 任务行上记录的指标数据缺失：截断、序列超限与丢弃的点数。 */
export const dataLossOf = (
	task: Pick<typeof tasks.$inferSelect, "metricTruncated" | "metricSeriesCapped" | "metricDropped">,
): MetricDataLoss => ({
	truncated: task.metricTruncated,
	series_capped: task.metricSeriesCapped,
	dropped_points: task.metricDropped,
});

/** 写入的行没有对应的分区（PostgreSQL 23514 check_violation：no partition of relation … found for row）。 */
function isMissingPartition(error: unknown): boolean {
	for (let e: unknown = error; e instanceof Error; e = e.cause) {
		if ((e as { code?: unknown }).code === "23514") return true;
	}
	return false;
}

/** 运行的已写库的序列摘要：任务 ID → 摘要，按指标名、标签排序。 */
export async function seriesSummaries(
	db: Db,
	runId: string,
): Promise<Map<string, MetricSummary[]>> {
	const rows = await db.select().from(metricSeries).where(eq(metricSeries.runId, runId));
	const byTask = new Map<string, MetricSummary[]>();
	for (const row of rows) {
		const list = byTask.get(row.taskId) ?? [];
		list.push({
			name: row.metric,
			labels: sortedLabels(row.labels),
			points: row.points,
			min: row.min,
			max: row.max,
			avg: row.sum / row.points,
			last: row.last,
			...summaryTimes(row),
		});
		byTask.set(row.taskId, list);
	}
	for (const list of byTask.values()) list.sort(compareSeries);
	return byTask;
}

function emptySeries(name: string, labels: Labels): Series {
	return {
		name,
		labels,
		points: 0,
		written: 0,
		min: Number.POSITIVE_INFINITY,
		max: Number.NEGATIVE_INFINITY,
		sum: 0,
		last: 0,
		firstAt: 0,
		lastAt: 0,
		firstAgentAt: 0,
		lastAgentAt: 0,
		lastMono: undefined,
		segment: [],
		closed: [],
		dirtySince: undefined,
	};
}

function addPoint(series: Series, p: Point): void {
	if (series.points === 0) {
		series.firstAt = p.t;
		series.firstAgentAt = p.agentT;
	} else if (p.t < series.firstAt) {
		// 只有已有的点是升级之前写入的（firstAt 是 Agent 时间）才会这样：首尾时间要包住新点，查询的默认范围才取得到它。
		series.firstAt = p.t;
	}
	series.points++;
	series.min = Math.min(series.min, p.min);
	series.max = Math.max(series.max, p.max);
	series.sum += p.value;
	series.last = p.value;
	series.lastAt = p.t;
	series.lastAgentAt = p.agentT;
	series.segment.push(p);
}

/**
 * 这个点是不是序列里已经收到过的（见文件头「两种时间」）：`t` 是它的控制面时间（Unix 秒），`mono` 是单调时钟读数。
 * 没有读数的点（旧版本 Agent）没法判断，一律不算重复；Agent 时间不参与判断。
 */
function isDuplicate(series: Series, t: number, mono: number | undefined): boolean {
	if (mono === undefined) return false;
	if (series.lastMono === undefined) return t <= series.lastAt;
	return mono <= series.lastMono;
}

/**
 * 段里每个点的「Agent 时间 − 控制面时间」（秒）；全段相同时（通常如此）只存一个元素。
 * 读出时见 metric-queries.ts。
 */
function agentOffsets(segment: Point[]): number[] {
	const offsets = segment.map((p) => p.agentT - p.t);
	return offsets.every((d) => d === offsets[0]) ? offsets.slice(0, 1) : offsets;
}

/**
 * 摘要行的首尾时间。升级之前写入的行（没有 Agent 时间列）只有 Agent 时间：它的时间列就是 Agent 时间，
 * 控制面时间没有记录（null）。
 */
export function summaryTimes(
	row: Pick<
		typeof metricSeries.$inferSelect,
		"firstAt" | "lastAt" | "firstAgentAt" | "lastAgentAt"
	>,
): Pick<MetricSummary, "first_time" | "last_time" | "first_agent_time" | "last_agent_time"> {
	if (row.firstAgentAt === null || row.lastAgentAt === null) {
		return {
			first_time: null,
			last_time: null,
			first_agent_time: row.firstAt.toISOString(),
			last_agent_time: row.lastAt.toISOString(),
		};
	}
	return {
		first_time: row.firstAt.toISOString(),
		last_time: row.lastAt.toISOString(),
		first_agent_time: row.firstAgentAt.toISOString(),
		last_agent_time: row.lastAgentAt.toISOString(),
	};
}

/**
 * 一批里不带读数的点（旧版本 Agent，或连接没有对应关系）的控制面时间（Unix 秒）：按收到这一批的时刻排，
 * 规则见文件头「两种时间」。用到时才算，带读数的批次没有这份开销。
 */
class ArrivalTimes {
	/** `batch.points` 的下标 → 控制面时间。 */
	#times: Map<number, number> | undefined;

	constructor(
		private readonly clock: ConnectionClock,
		private readonly batch: MetricBatch,
		private readonly receivedAtMs: number,
		private readonly range: { accepts(t: number): boolean },
	) {}

	/** `batch.points[index]`（不带读数的点）的控制面时间。 */
	of(index: number): number {
		this.#times ??= this.#arrange();
		return this.#times.get(index) as number;
	}

	#arrange(): Map<number, number> {
		const receivedS = Math.floor(this.receivedAtMs / 1000);
		/** 序列 → 它在这一批里不带读数的点（到达顺序）：下标和 Agent 时间。 */
		const bySeries = new Map<string, { index: number; agentT: number }[]>();
		let oldest = Number.POSITIVE_INFINITY;
		let newest = Number.NEGATIVE_INFINITY;
		for (const [index, p] of this.batch.points.entries()) {
			if (this.clock.occurredAt(p.monotonicMs)) continue;
			const agentT = agentSeconds(p.timeUnixS);
			oldest = Math.min(oldest, agentT);
			newest = Math.max(newest, agentT);
			const key = seriesKey(p.name, p.labels);
			const list = bySeries.get(key) ?? [];
			list.push({ index, agentT });
			bySeries.set(key, list);
		}
		const groups = [...bySeries.values()];
		// Agent 时间的间隔可信：每个序列里都严格递增，并且照它往前排的最早的点还在可接收范围内。
		const trusted =
			this.range.accepts(receivedS - (newest - oldest)) &&
			groups.every((points) =>
				points.every((p, i) => i === 0 || p.agentT > (points[i - 1]?.agentT ?? p.agentT)),
			);
		const times = new Map<number, number>();
		for (const points of groups) {
			for (const [i, p] of points.entries()) {
				const before = trusted ? newest - p.agentT : points.length - 1 - i;
				times.set(p.index, receivedS - before);
			}
		}
		return times;
	}
}
