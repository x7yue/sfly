import {
	type CatalogNode,
	compareSeries,
	isLabeled,
	type Labels,
	type MetricBucket,
	type MetricDeclaration,
	type MetricSeries,
	type MetricSeriesQuery,
	NodeTypeMetadata,
	type OrchestrationDocument,
	type PlatformBucket,
	type PlatformMetrics,
	type RunMetricCatalog,
	seriesKey,
	sortedLabels,
} from "@sfly/schema";
import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import {
	agents as agentsTable,
	metricSeries,
	orchestrationVersions,
	runs,
	tasks,
} from "../db/schema.js";
import { withDefaultCharts } from "../packages/default-charts.js";
import { isUuid } from "../util/uuid.js";
import { nodeTypeOf } from "./node-types.js";
import { decodeFloat8Array, decodeInt4Array, decodeInt8Array } from "./pg-array.js";
import {
	dataLossOf,
	seriesSummaries,
	type TaskMetrics,
	type UnwrittenSeries,
} from "./task-metrics.js";

type TaskRow = typeof tasks.$inferSelect;

export type SeriesOutcome =
	| { ok: true; series: MetricSeries }
	| { ok: false; status: 400 | 404; code: string; message: string };

/** 序列最后一个点：控制面时间（Unix 秒）与值。 */
export interface SeriesEnd {
	at: number;
	value: number;
}

/** {@link MetricQueries.taskSeries} 的结果。 */
export interface TaskSeriesRead {
	/** 实际的时间范围（Unix 秒）；没有数据且没有指定时为 undefined。 */
	from: number | undefined;
	to: number | undefined;
	bucketSeconds: number;
	series: Array<{
		name: string;
		labels: Labels;
		buckets: MetricBucket[];
		/** 最后一个点；序列还没有点（或已过保留期）为 undefined。 */
		end: SeriesEnd | undefined;
		/**
		 * 最近 `recent` 个点的控制面时间（Unix 秒，升序，最后一个就是 `end.at`），不随降采样变粗；
		 * 查询没有要 `recent` 时为空。
		 */
		recent: number[];
	}>;
}

/** 一个桶的累计量。 */
interface Acc {
	points: number;
	min: number;
	max: number;
	sum: number;
	last: number;
	/** last 对应的点的 Agent 时间（Unix 秒）；没有记录控制面时间的点（升级之前写入的段）为 null。 */
	agentAt: number | null;
	/** last 对应的点在时间轴上的位置（Unix 秒）。 */
	lastAt: number;
}

/**
 * metric_segments 的一行；能直接用段摘要时数组为 null（不读取、不解压）。数组以二进制读出（array_send），
 * 用 {@link decodeFloat8Array} / {@link decodeInt4Array} 解码（#153）。
 */
interface SegmentRow extends Record<string, unknown> {
	metric: string;
	labels: Labels;
	start_s: number;
	end_s: number;
	points: number;
	min: number;
	max: number;
	avg: number;
	last: number;
	offsets: Buffer | null;
	/** 每点的「Agent 时间 − 控制面时间」（秒），全段相同时只有一个元素；升级之前写入的段为 null。 */
	agent_offsets: Buffer | null;
	/** 段里最后一个点的这个差值；升级之前写入的段为 null（它的时间列是 Agent 时间，控制面时间没有记录）。 */
	agent_last: number | null;
	values: Buffer | null;
	mins: Buffer | null;
	maxs: Buffer | null;
}

/** 一个序列最近的几段（{@link MetricQueries.taskSeries} 的 `recent`）：段的起始时间与时间偏移（array_send 的二进制）。 */
interface TailRow extends Record<string, unknown> {
	metric: string;
	labels: Labels;
	start_s: number;
	offsets: Buffer;
}

const isoOf = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

/** 被跳过的节点、还没开始就被取消的尝试只是占位，不算尝试（与运行视图一致）。 */
const isPlaceholder = (t: TaskRow) =>
	t.status === "skipped" || (t.status === "cancelled" && t.startedAt === null);

/**
 * 指标的只读查询（#31）：运行的指标目录、序列查询（降采样）、平台自带图表。
 * 原始数据见 src/metrics/task-metrics.ts（ADR 0009）。
 */
export class MetricQueries {
	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			/** 尚未写库的点在这里（序列查询要包括它们，断线重连后才能补齐）。 */
			metrics: TaskMetrics;
		},
	) {}

	/** 运行的指标目录；运行不存在时为 undefined。 */
	async catalog(runId: string): Promise<RunMetricCatalog | undefined> {
		const run = await this.#run(runId);
		if (!run) return undefined;
		if (run.run.metricsPurgedAt) return { run_id: runId, expired: true, nodes: [] };
		const packageNodes = new Set(
			run.document.nodes.filter((n) => n.kind === "package").map((n) => n.id),
		);
		const groups = this.#groups(await this.#tasks(runId), (id) => packageNodes.has(id));
		const summaries = await seriesSummaries(this.deps.db, runId);
		const nodes: CatalogNode[] = [];
		for (const attempts of groups) {
			const latest = attempts[attempts.length - 1] as TaskRow;
			const ref = await nodeTypeOf(this.deps.db, run.document, latest.nodeId, latest.agentName);
			if (!ref) continue;
			const parsed = NodeTypeMetadata.safeParse(ref.type);
			const type = parsed.success ? withDefaultCharts(parsed.data) : undefined;
			nodes.push({
				chain_instance_id: latest.chainInstanceId,
				node_id: latest.nodeId,
				package: ref.package,
				node: ref.node,
				version: ref.version,
				metrics: type?.metrics ?? [],
				charts: type?.charts ?? [],
				primary_metric: type?.primary_metric ?? null,
				attempts: attempts.map((t) => ({
					task_id: t.id,
					attempt: t.attempt,
					...dataLossOf(t),
					metrics: summaries.get(t.id) ?? [],
				})),
			});
		}
		return { run_id: runId, expired: false, nodes };
	}

	/**
	 * 一个节点（默认最新一次尝试）的指标序列，按目标点数降采样：时间范围 [from, to]（控制面时间，秒）分成跨度
	 * bucket_seconds 的桶，每个桶给出点数、最小（每秒最小值中的最小）、最大（每秒最大值中的最大，尖峰可见）、
	 * 平均、最新值。每个序列（指标名 + 标签，#78）分别降采样，按指标名查询时返回这个指标的全部序列。
	 * 整段落在一个桶里时直接用段摘要，不展开数组；内存里尚未写库的点覆盖库里同一范围的数据。
	 * 每个桶另带 Agent 时间（桶里最后一个点的）。升级之前写入的段没有记录控制面时间：按它的时间列（Agent 时间）
	 * 落桶，桶的 `time` 为 null（ADR 0018）。
	 */
	async series(runId: string, query: MetricSeriesQuery): Promise<SeriesOutcome> {
		const run = await this.#run(runId);
		if (!run) return { ok: false, status: 404, code: "not_found", message: "run not found" };
		const attempts = (
			await this.deps.db
				.select()
				.from(tasks)
				.where(
					and(
						eq(tasks.runId, runId),
						eq(tasks.chainInstanceId, query.chain_instance_id),
						eq(tasks.nodeId, query.node_id),
					),
				)
				.orderBy(asc(tasks.attempt))
		).filter((t) => !isPlaceholder(t));
		const task =
			query.attempt === undefined
				? attempts.at(-1)
				: attempts.find((t) => t.attempt === query.attempt);
		if (!task) return { ok: false, status: 404, code: "not_found", message: "attempt not found" };

		const ref = await nodeTypeOf(this.deps.db, run.document, task.nodeId, task.agentName);
		const declared = ref?.type?.metrics ?? [];
		const names = query.metrics ?? declared.map((m) => m.name);
		// 已过保留期（#32）：数据已清理，不再查询，每个序列都没有桶。
		const expired = run.run.metricsPurgedAt !== null;
		const read = await this.taskSeries(task.id, {
			declared,
			names,
			expired,
			from: query.from === undefined ? undefined : Math.floor(Date.parse(query.from) / 1000),
			to: query.to === undefined ? undefined : Math.floor(Date.parse(query.to) / 1000),
			points: query.points,
		});
		return {
			ok: true,
			series: {
				run_id: runId,
				chain_instance_id: task.chainInstanceId,
				node_id: task.nodeId,
				task_id: task.id,
				attempt: task.attempt,
				truncated: task.metricTruncated,
				series_capped: task.metricSeriesCapped,
				expired,
				from: read.from === undefined ? null : isoOf(read.from),
				to: read.to === undefined ? null : isoOf(read.to),
				bucket_seconds: read.bucketSeconds,
				series: read.series.map(({ name, labels, buckets }) => ({ name, labels, buckets })),
			},
		};
	}

	/**
	 * 一个任务（一次尝试）里这些指标的序列，按目标点数降采样（{@link MetricQueries.series} 与关注项读数共用）：
	 * 时间范围 [from, to]（控制面时间，Unix 秒）默认是这些指标已有数据的首尾，分成跨度 bucket_seconds 的桶，
	 * 含内存里尚未写库的点；每个序列另给最后一个点的精确时间与值（不随降采样变粗）。给了 `recent` 时，每个序列另给
	 * 最近这么多个点的时间（关注项估算采样间隔用，与时间范围无关）。
	 * 没有任何数据、也没有声明标签键的指标给出一个空序列；声明了标签键的没有序列。已过保留期（expired）时序列没有桶。
	 */
	async taskSeries(
		taskId: string,
		query: {
			/** 节点类型声明的指标（找出哪些带标签）。 */
			declared: readonly MetricDeclaration[];
			names: readonly string[];
			expired: boolean;
			from?: number | undefined;
			to?: number | undefined;
			points: number;
			/** 每个序列另给最近这么多个点的时间；不给时不读。 */
			recent?: number;
		},
	): Promise<TaskSeriesRead> {
		const { declared, names, expired } = query;
		const labeled = new Set(declared.filter(isLabeled).map((m) => m.name));
		const unwritten = new Map(
			expired
				? []
				: [...(await this.deps.metrics.unwritten(taskId))].filter(([, s]) =>
						names.includes(s.name),
					),
		);
		const known = expired
			? { series: [], first: undefined, last: undefined }
			: await this.#known(taskId, [...names], unwritten);
		// 每个指标的全部序列；没有任何数据、也没有声明标签键的指标给出一个空序列（图表照常画出空图）。
		const list = names.flatMap((name) => {
			const found = known.series.filter((s) => s.name === name);
			if (found.length > 0 || labeled.has(name)) return found;
			return [{ name, labels: {}, key: name }];
		});
		const from = query.from ?? known.first;
		const to = query.to ?? known.last;
		if (expired || from === undefined || to === undefined || names.length === 0) {
			return {
				from,
				to,
				bucketSeconds: 1,
				series: list.map(({ name, labels }) => ({
					name,
					labels,
					buckets: [],
					end: undefined,
					recent: [],
				})),
			};
		}
		const width = Math.max(1, Math.ceil((to - from + 1) / query.points));
		const [{ buckets, ends }, recent] = await Promise.all([
			this.#bucketize(taskId, [...names], unwritten, from, to, width),
			query.recent === undefined
				? new Map<string, number[]>()
				: this.#recent(taskId, list, unwritten, query.recent),
		]);
		return {
			from,
			to,
			bucketSeconds: width,
			series: list.map(({ name, labels, key }) => ({
				name,
				labels,
				buckets: buckets.get(key) ?? [],
				end: ends.get(key),
				recent: recent.get(key) ?? [],
			})),
		};
	}

	/**
	 * 每个序列（键是 {@link seriesKey}）最近 `n` 个点的控制面时间（Unix 秒，升序）。内存里的点（含当前段已经写过库的）
	 * 是最新的；不够 `n` 个时再从库里按起始时间倒着取最近的段（每段至少一个点，所以最多 `n` 段），取到够 `n` 个点为止。
	 * 同一个点可能内存和库里都有（当前段周期写库），按时间去重：同一序列里点的控制面时间严格递增。
	 */
	async #recent(
		taskId: string,
		list: ReadonlyArray<{ name: string; key: string }>,
		unwritten: Map<string, UnwrittenSeries>,
		n: number,
	): Promise<Map<string, number[]>> {
		const times = new Map<string, Set<number>>();
		for (const { key } of list) {
			times.set(
				key,
				new Set(
					unwritten
						.get(key)
						?.points.slice(-n)
						.map((p) => p.t),
				),
			);
		}
		const short = [
			...new Set(list.filter((s) => (times.get(s.key)?.size ?? 0) < n).map((s) => s.name)),
		];
		if (short.length > 0) {
			const result = await this.deps.db.execute<TailRow>(sql`
				select s.metric, s.labels, extract(epoch from g.start_at)::float8 as start_s,
					array_send(g.offsets) as offsets
				from metric_series s
				cross join lateral (
					select start_at, offsets, sum(points) over (order by start_at desc) - points as newer
					from (
						select start_at, offsets, points from metric_segments m
						where m.task_id = s.task_id and m.metric = s.metric and m.labels = s.labels
						order by start_at desc limit ${n}
					) latest
				) g
				where s.task_id = ${taskId} and s.metric in (${sql.join(
					short.map((name) => sql`${name}`),
					sql`, `,
				)}) and g.newer < ${n}`);
			for (const row of result.rows) {
				const set = times.get(seriesKey(row.metric, row.labels));
				if (!set) continue;
				for (const offset of decodeInt4Array(row.offsets)) set.add(row.start_s + offset);
			}
		}
		return new Map([...times].map(([key, set]) => [key, [...set].sort((a, b) => a - b).slice(-n)]));
	}

	/**
	 * 这些指标已有的序列（库里的摘要加上内存里还没写库的，按指标名、标签排序），以及数据的首尾时间（Unix 秒）；
	 * 没有数据时首尾时间为 undefined。
	 */
	async #known(
		taskId: string,
		names: string[],
		unwritten: Map<string, UnwrittenSeries>,
	): Promise<{
		series: Array<{ name: string; labels: Labels; key: string }>;
		first: number | undefined;
		last: number | undefined;
	}> {
		let first = Number.POSITIVE_INFINITY;
		let last = Number.NEGATIVE_INFINITY;
		const series = new Map<string, { name: string; labels: Labels; key: string }>();
		if (names.length > 0) {
			const rows = await this.deps.db
				.select({
					metric: metricSeries.metric,
					labels: metricSeries.labels,
					firstAt: metricSeries.firstAt,
					lastAt: metricSeries.lastAt,
				})
				.from(metricSeries)
				.where(and(eq(metricSeries.taskId, taskId), inArray(metricSeries.metric, names)));
			for (const r of rows) {
				first = Math.min(first, r.firstAt.getTime() / 1000);
				last = Math.max(last, r.lastAt.getTime() / 1000);
				const labels = sortedLabels(r.labels);
				const key = seriesKey(r.metric, labels);
				series.set(key, { name: r.metric, labels, key });
			}
		}
		for (const [key, s] of unwritten) {
			const head = s.points[0];
			const tail = s.points[s.points.length - 1];
			if (head) first = Math.min(first, head.t);
			if (tail) last = Math.max(last, tail.t);
			series.set(key, { name: s.name, labels: s.labels, key });
		}
		return {
			series: [...series.values()].sort(compareSeries),
			first: Number.isFinite(first) ? first : undefined,
			last: Number.isFinite(last) ? last : undefined,
		};
	}

	/** 这些指标每个序列（键是 {@link seriesKey}）的非空桶，以及最后一个点。 */
	async #bucketize(
		taskId: string,
		names: string[],
		unwritten: Map<string, UnwrittenSeries>,
		from: number,
		to: number,
		width: number,
	): Promise<{ buckets: Map<string, MetricBucket[]>; ends: Map<string, SeriesEnd> }> {
		// 段落在一个桶内、不和内存里的点重叠时只取段摘要（数组不读取、不解压）。
		const memFirst = Math.min(
			...[...unwritten.values()].map((s) => s.points[0]?.t ?? Number.POSITIVE_INFINITY),
		);
		const memBound = Number.isFinite(memFirst) ? isoOf(memFirst) : "infinity";
		const fromIso = isoOf(from);
		const toIso = isoOf(to);
		const summarized = sql`(start_at >= ${fromIso}::timestamptz and end_at <= ${toIso}::timestamptz
			and end_at < ${memBound}::timestamptz
			and floor((extract(epoch from start_at)::float8 - ${from}::float8) / ${width}::float8)
				= floor((extract(epoch from end_at)::float8 - ${from}::float8) / ${width}::float8))`;
		const result = await this.deps.db.execute<SegmentRow>(sql`
			select metric, labels, extract(epoch from start_at)::float8 as start_s, extract(epoch from end_at)::float8 as end_s,
				points, min, max, avg, last,
				case when ${summarized} then null else array_send(offsets) end as offsets,
				case when ${summarized} then null else array_send(agent_offsets) end as agent_offsets,
				agent_offsets[cardinality(agent_offsets)]::float8 as agent_last,
				case when ${summarized} then null else array_send("values") end as "values",
				case when ${summarized} then null else array_send(mins) end as mins,
				case when ${summarized} then null else array_send(maxs) end as maxs
			from metric_segments
			where task_id = ${taskId} and metric in (${sql.join(
				names.map((n) => sql`${n}`),
				sql`, `,
			)})
				and start_at <= ${toIso}::timestamptz and end_at >= ${fromIso}::timestamptz`);
		// 不排序：分桶按序列键累计，与行的顺序无关（同一序列的段在时间上互不重叠）。按 labels 排序要逐次比较
		// 存在行外（TOAST）的 jsonb，带标签时比查询本身还慢（#153）。

		const accs = new Map<string, Map<number, Acc>>();
		/** t 是点在时间轴上的位置（Unix 秒）。 */
		const add = (key: string, t: number, p: Omit<Acc, "lastAt">) => {
			const k = Math.floor((t - from) / width);
			let byBucket = accs.get(key);
			if (!byBucket) {
				byBucket = new Map();
				accs.set(key, byBucket);
			}
			const acc = byBucket.get(k);
			if (!acc) {
				byBucket.set(k, { ...p, lastAt: t });
				return;
			}
			acc.points += p.points;
			acc.min = Math.min(acc.min, p.min);
			acc.max = Math.max(acc.max, p.max);
			acc.sum += p.sum;
			if (t >= acc.lastAt) {
				acc.last = p.last;
				acc.agentAt = p.agentAt;
				acc.lastAt = t;
			}
		};
		const inMemory = (key: string, t: number) => {
			const points = unwritten.get(key)?.points;
			const head = points?.[0];
			const tail = points?.[points.length - 1];
			return head !== undefined && tail !== undefined && t >= head.t && t <= tail.t;
		};
		for (const row of result.rows) {
			const key = seriesKey(row.metric, row.labels);
			if (!row.offsets || !row.values || !row.mins || !row.maxs) {
				add(key, row.end_s, {
					points: row.points,
					min: row.min,
					max: row.max,
					sum: row.avg * row.points,
					last: row.last,
					agentAt: row.agent_last === null ? null : row.end_s + row.agent_last,
				});
				continue;
			}
			const offsets = decodeInt4Array(row.offsets);
			// 每点的「Agent 时间 − 控制面时间」（秒）：全段相同时数组只有一个元素（见 task-metrics.ts 的 agentOffsets）。
			const agentOffsets = row.agent_offsets && decodeInt8Array(row.agent_offsets);
			const sameOffset = agentOffsets?.length === 1 ? (agentOffsets[0] as number) : undefined;
			const values = decodeFloat8Array(row.values);
			const mins = decodeFloat8Array(row.mins);
			const maxs = decodeFloat8Array(row.maxs);
			for (const [i, offset] of offsets.entries()) {
				const t = row.start_s + offset;
				if (t < from || t > to || inMemory(key, t)) continue;
				const value = values[i] as number;
				add(key, t, {
					points: 1,
					min: mins[i] as number,
					max: maxs[i] as number,
					sum: value,
					last: value,
					agentAt: agentOffsets ? t + (sameOffset ?? (agentOffsets[i] as number)) : null,
				});
			}
		}
		for (const [key, s] of unwritten) {
			for (const p of s.points) {
				if (p.t < from || p.t > to) continue;
				add(key, p.t, {
					points: 1,
					min: p.min,
					max: p.max,
					sum: p.value,
					last: p.value,
					agentAt: p.agentT,
				});
			}
		}

		const buckets = new Map<string, MetricBucket[]>();
		const ends = new Map<string, SeriesEnd>();
		for (const [key, byBucket] of accs) {
			const lastBucket = Math.max(...byBucket.keys());
			const lastAcc = byBucket.get(lastBucket);
			if (lastAcc) ends.set(key, { at: lastAcc.lastAt, value: lastAcc.last });
			buckets.set(
				key,
				[...byBucket.entries()]
					.sort(([a], [b]) => a - b)
					.map(([k, acc]) => ({
						// 没有记录控制面时间的桶：桶是按 Agent 时间划分的，起始时间放在 agent_time。
						time: acc.agentAt === null ? null : isoOf(from + k * width),
						agent_time: isoOf(acc.agentAt ?? from + k * width),
						points: acc.points,
						min: acc.min,
						max: acc.max,
						avg: acc.sum / acc.points,
						last: acc.last,
					})),
			);
		}
		return { buckets, ends };
	}

	/**
	 * 平台自带图表（不新增存储）：节点耗时、重试次数、排队与等待时长由任务记录计算；并发任务数与 Agent 槽位占用
	 * 由任务的执行区间（started_at 到 ended_at，执行中的到现在）推导，按目标点数分桶。
	 */
	async platform(runId: string, points: number): Promise<PlatformMetrics | undefined> {
		const found = await this.#run(runId);
		if (!found) return undefined;
		const { run, document } = found;
		const now = this.deps.clock.now().getTime();
		const end = (t: TaskRow) => t.endedAt?.getTime() ?? now;
		const kinds = new Map(document.nodes.map((n) => [n.id, n.kind]));
		const rows = await this.#tasks(runId);

		const nodes = this.#groups(rows, () => true).map((attempts) => {
			const first = attempts[0] as TaskRow;
			const kind = kinds.get(first.nodeId) ?? "unknown";
			let duration = 0;
			let queue = 0;
			let wait = 0;
			for (const t of attempts) {
				const queued = t.queuedAt.getTime();
				duration += end(t) - queued;
				if (kind === "package") queue += (t.startedAt?.getTime() ?? end(t)) - queued;
				if (kind === "timer" || kind === "sleep") {
					wait += end(t) - (t.startedAt?.getTime() ?? queued);
				}
			}
			return {
				chain_instance_id: first.chainInstanceId,
				node_id: first.nodeId,
				kind,
				attempts: attempts.length,
				retries: attempts.length - 1,
				duration_ms: Math.max(0, Math.round(duration)),
				queue_ms: Math.max(0, Math.round(queue)),
				wait_ms: Math.max(0, Math.round(wait)),
			};
		});

		const from = Math.floor(run.startedAt.getTime() / 1000);
		const to = Math.max(from, Math.ceil((run.endedAt?.getTime() ?? now) / 1000));
		const width = Math.max(1, Math.ceil((to - from) / points));
		const timeline = new Timeline(from, to, width);
		const executing = (t: TaskRow) => t.agentName !== null && t.startedAt !== null;
		const intervals = (list: TaskRow[]) =>
			list.filter(executing).map((t) => [t.startedAt?.getTime() ?? 0, end(t)] as const);

		const agentNames = [
			...new Set(rows.filter(executing).map((t) => t.agentName as string)),
		].sort();
		const agentRows =
			agentNames.length === 0
				? []
				: await this.deps.db
						.select({ name: agentsTable.name, info: agentsTable.info })
						.from(agentsTable)
						.where(inArray(agentsTable.name, agentNames));
		const onAgents =
			agentNames.length === 0
				? []
				: await this.deps.db
						.select()
						.from(tasks)
						.where(
							and(
								inArray(tasks.agentName, agentNames),
								lt(tasks.startedAt, new Date(to * 1000)),
								or(isNull(tasks.endedAt), gt(tasks.endedAt, new Date(from * 1000))),
							),
						);
		return {
			run_id: runId,
			from: isoOf(from),
			to: isoOf(to),
			bucket_seconds: width,
			retries: nodes.reduce((n, node) => n + node.retries, 0),
			nodes,
			concurrency: timeline.occupancy(intervals(rows)),
			agents: agentNames.map((name) => ({
				name,
				slots: agentRows.find((a) => a.name === name)?.info.slots ?? null,
				occupancy: timeline.occupancy(intervals(onAgents.filter((t) => t.agentName === name))),
			})),
		};
	}

	async #run(
		runId: string,
	): Promise<{ document: OrchestrationDocument; run: typeof runs.$inferSelect } | undefined> {
		if (!isUuid(runId)) return undefined;
		const [row] = await this.deps.db
			.select({ run: runs, document: orchestrationVersions.document })
			.from(runs)
			.innerJoin(orchestrationVersions, eq(orchestrationVersions.id, runs.orchestrationVersionId))
			.where(eq(runs.id, runId));
		return row;
	}

	#tasks(runId: string): Promise<TaskRow[]> {
		return this.deps.db.select().from(tasks).where(eq(tasks.runId, runId)).orderBy(asc(tasks.seq));
	}

	/** include 的节点的尝试（不含占位），按「链实例 × 节点」分组，组按第一次尝试的创建顺序。 */
	#groups(rows: TaskRow[], include: (nodeId: string) => boolean): TaskRow[][] {
		const groups = new Map<string, TaskRow[]>();
		for (const t of rows) {
			if (isPlaceholder(t) || !include(t.nodeId)) continue;
			const key = `${t.chainInstanceId}/${t.nodeId}`;
			const list = groups.get(key) ?? [];
			list.push(t);
			groups.set(key, list);
		}
		return [...groups.values()].map((list) => list.sort((a, b) => a.attempt - b.attempt));
	}
}

/** 平台自带图表的时间轴：[from, to)（Unix 秒）按 width 秒分桶。 */
class Timeline {
	constructor(
		private readonly from: number,
		private readonly to: number,
		private readonly width: number,
	) {}

	/**
	 * 一组区间 [start, end)（毫秒）在每个桶内的同时数量：最大值，以及按时间加权的平均值
	 * （最后一个桶只算到 to 为止）。
	 */
	occupancy(intervals: ReadonlyArray<readonly [number, number]>): PlatformBucket[] {
		// 数量不变的时间段：按断点切开。
		const deltas = new Map<number, number>();
		for (const [start, end] of intervals) {
			if (end <= start) continue;
			deltas.set(start, (deltas.get(start) ?? 0) + 1);
			deltas.set(end, (deltas.get(end) ?? 0) - 1);
		}
		const times = [...deltas.keys()].sort((a, b) => a - b);
		const steps: Array<{ start: number; end: number; count: number }> = [];
		let count = 0;
		for (const [i, t] of times.entries()) {
			count += deltas.get(t) ?? 0;
			const next = times[i + 1];
			if (next !== undefined && count > 0) steps.push({ start: t, end: next, count });
		}

		const buckets: PlatformBucket[] = [];
		const n = Math.max(1, Math.ceil((this.to - this.from) / this.width));
		for (let k = 0; k < n; k++) {
			const b0 = (this.from + k * this.width) * 1000;
			const b1 =
				Math.min(this.from + (k + 1) * this.width, Math.max(this.to, this.from + 1)) * 1000;
			let max = 0;
			let area = 0;
			for (const step of steps) {
				const overlap = Math.min(step.end, b1) - Math.max(step.start, b0);
				if (overlap <= 0) continue;
				max = Math.max(max, step.count);
				area += step.count * overlap;
			}
			buckets.push({ time: new Date(b0).toISOString(), max, avg: area / (b1 - b0) });
		}
		return buckets;
	}
}
