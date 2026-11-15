import {
	type ChartView,
	DEFAULT_FOCUS_POINTS,
	type FocusSeries,
	type MetricDeclaration,
	type NodeStatus,
	type RunFocus,
	type RunFocusItem,
	type RunFocusQuery,
} from "@sfly/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { orchestrations, orchestrationVersions, runs, tasks } from "../db/schema.js";
import { loadRunBoards } from "../engine/run-board.js";
import type { MetricQueries, SeriesEnd, TaskSeriesRead } from "../metrics/metric-queries.js";
import type { NodeTypeView } from "../packages/default-charts.js";
import { isUuid } from "../util/uuid.js";
import { type FocusItem, focusName } from "./focus-list.js";
import { declaredNodeType } from "./focus-views.js";

/** 解析一次运行的关注项要用到的依赖：控制面里谁要读读数（HTTP 接口、飞书运行通知、控制台）都传这三样。 */
export interface RunFocusDeps {
	db: Db;
	clock: Clock;
	queries: Pick<MetricQueries, "taskSeries">;
}

export interface RunFocusOptions {
	/** 每个序列降采样成多少个点（0 只要最新值）；默认 {@link DEFAULT_FOCUS_POINTS}。 */
	points?: RunFocusQuery["points"];
	/** 用这份列表代替场景现在的关注项（调用方自己保存了某个时刻的列表时用）。 */
	items?: readonly FocusItem[];
}

type AttemptRow = Pick<
	typeof tasks.$inferSelect,
	"id" | "chainInstanceId" | "nodeId" | "attempt" | "agentName" | "status" | "startedAt" | "endedAt"
>;

/** 被跳过的节点、还没开始就被取消或停止的尝试只是占位，不算尝试（与运行视图一致）。 */
const isPlaceholder = (t: Pick<AttemptRow, "status" | "startedAt">) =>
	t.status === "skipped" ||
	((t.status === "cancelled" || t.status === "stopped") && t.startedAt === null);

/** 来源节点成功或已停止：只显示最终值。 */
const isFinal = (status: NodeStatus) => status === "success" || status === "stopped";

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null);

/** 一个来源节点：它在这次运行里所在的链实例和状态、最新一次尝试，以及这次运行锁定的版本里它的节点类型。 */
interface Source {
	chainInstanceId: string;
	status: NodeStatus;
	/** 最新一次尝试；节点还没有尝试时为 undefined。 */
	attempt: AttemptRow | undefined;
	type: NodeTypeView | undefined;
}

/** 要读的一项：来源节点、图表（没设关注项时是主指标）、它引用的指标。 */
interface Reading {
	position: number;
	nodeId: string;
	chart: string;
	title: string;
	chartType: ChartView["type"];
	/** 图表引用的指标（数值卡只画第一个）；这次运行的节点类型里没有这张图表时为空。 */
	metrics: readonly string[];
	unit: string;
	chartMissing: boolean;
}

/**
 * 一次运行的关注项读数（`GET /runs/:id/focus`，契约见 @sfly/schema 的 `RunFocus`）：场景设了关注项就按作者的顺序，
 * 没设就是执行中节点的主指标。运行不存在（或编号不是 UUID）时为 undefined。
 *
 * - 只返回节点在这次运行里的项：运行绑定的版本里没有这个节点，或节点所在的子流程还没有触发时不返回。
 * - 来源是节点最新一次尝试的任务；图表的定义取这次运行绑定的版本锁定的节点包版本，那个版本里没有这张图表时
 *   `unavailable` 是 `chart_missing`。开发版本取 Agent 当前加载的源码，不一定是运行当时的定义。
 * - 数值卡只有第一个序列，其余图表是声明的全部序列；`latest` 是最近更新的那个序列的最后一个点。
 * - 异常归 #351：`anomaly` 和 `sample_interval_ms` 在这里一律是 null。
 */
export async function resolveRunFocus(
	deps: RunFocusDeps,
	runId: string,
	options: RunFocusOptions = {},
): Promise<RunFocus | undefined> {
	const { db } = deps;
	if (!isUuid(runId)) return undefined;
	const [row] = await db
		.select({
			run: runs,
			versionId: orchestrationVersions.id,
			document: orchestrationVersions.document,
			focusItems: orchestrations.focusItems,
		})
		.from(runs)
		.innerJoin(orchestrationVersions, eq(orchestrationVersions.id, runs.orchestrationVersionId))
		.innerJoin(orchestrations, eq(orchestrations.id, runs.orchestrationId))
		.where(eq(runs.id, runId));
	if (!row) return undefined;
	const { document } = row;
	const points = options.points ?? DEFAULT_FOCUS_POINTS;
	const generatedAt = deps.clock.now();
	const authored = options.items ?? row.focusItems;
	const mode = authored.length > 0 ? "focus" : "primary";
	const expired = row.run.metricsPurgedAt !== null;

	// 节点在这次运行里的位置：只有已经开始的链（主链和已触发的子流程）上的节点。
	const placed = new Map<string, { chainInstanceId: string; status: NodeStatus }>();
	const board = await loadRunBoards(db, [{ id: runId, versionId: row.versionId, document }]);
	for (const chain of board.get(runId) ?? []) {
		for (const node of chain.nodes) {
			if (!placed.has(node.node_id)) {
				placed.set(node.node_id, { chainInstanceId: chain.id, status: node.status });
			}
		}
	}
	const isPackage = (nodeId: string) =>
		document.nodes.find((n) => n.id === nodeId)?.kind === "package";
	const wanted =
		mode === "focus"
			? new Set(authored.map((i) => i.node_id).filter((id) => placed.has(id)))
			: new Set(
					[...placed]
						.filter(([id, at]) => at.status === "running" && isPackage(id))
						.map(([id]) => id),
				);

	const attempts = await latestAttempts(db, runId, [...wanted]);
	const sources = new Map<string, Source>();
	for (const nodeId of wanted) {
		const at = placed.get(nodeId) as { chainInstanceId: string; status: NodeStatus };
		const attempt = attempts.get(nodeId);
		sources.set(nodeId, {
			...at,
			attempt,
			type: await declaredNodeType(db, document, nodeId, attempt?.agentName),
		});
	}

	const readings = mode === "focus" ? focusReadings(authored, sources) : primaryReadings(sources);
	const reads = await readSeries(deps, expired, sources, readings, points);
	return {
		generated_at: generatedAt.toISOString(),
		mode,
		expired,
		items: readings.map((reading) =>
			itemOf(reading, sources.get(reading.nodeId) as Source, reads.get(reading.nodeId), points),
		),
	};
}

/** 这些节点各自最新一次尝试（不含占位）。 */
async function latestAttempts(
	db: Db,
	runId: string,
	nodeIds: readonly string[],
): Promise<Map<string, AttemptRow>> {
	const latest = new Map<string, AttemptRow>();
	if (nodeIds.length === 0) return latest;
	const rows = await db
		.select({
			id: tasks.id,
			chainInstanceId: tasks.chainInstanceId,
			nodeId: tasks.nodeId,
			attempt: tasks.attempt,
			agentName: tasks.agentName,
			status: tasks.status,
			startedAt: tasks.startedAt,
			endedAt: tasks.endedAt,
		})
		.from(tasks)
		.where(and(eq(tasks.runId, runId), inArray(tasks.nodeId, [...nodeIds])))
		.orderBy(asc(tasks.attempt));
	for (const row of rows) if (!isPlaceholder(row)) latest.set(row.nodeId, row);
	return latest;
}

const unitOf = (metrics: readonly MetricDeclaration[] | undefined, name: string | undefined) =>
	metrics?.find((m) => m.name === name)?.unit ?? "";

/** 作者的关注项里节点在这次运行里的那些，各自对上这次运行锁定的节点包版本里的图表。 */
function focusReadings(
	authored: readonly FocusItem[],
	sources: ReadonlyMap<string, Source>,
): Reading[] {
	return authored.flatMap((item, index): Reading[] => {
		const source = sources.get(item.node_id);
		if (!source) return [];
		const chart = source.type?.charts?.find((c) => c.title === item.chart);
		return [
			{
				position: index + 1,
				nodeId: item.node_id,
				chart: item.chart,
				title: focusName(item),
				chartType: chart?.type ?? "line",
				metrics: chart ? (chart.type === "stat" ? chart.metrics.slice(0, 1) : chart.metrics) : [],
				unit: unitOf(source.type?.metrics, chart?.metrics[0]),
				chartMissing: chart === undefined,
			},
		];
	});
}

/** 没设关注项时：执行中的节点（节点类型有主指标的）的主指标，按节点在运行里的顺序。 */
function primaryReadings(sources: ReadonlyMap<string, Source>): Reading[] {
	const readings: Reading[] = [];
	for (const [nodeId, { type }] of sources) {
		const metric = type?.primary_metric;
		if (metric === undefined) continue;
		readings.push({
			position: readings.length + 1,
			nodeId,
			chart: metric,
			title: metric,
			chartType: "stat",
			metrics: [metric],
			unit: unitOf(type?.metrics, metric),
			chartMissing: false,
		});
	}
	return readings;
}

/** 每个有数据可读的节点读一次序列：同一个节点的几个项合并成一次查询。 */
async function readSeries(
	deps: RunFocusDeps,
	expired: boolean,
	sources: ReadonlyMap<string, Source>,
	readings: readonly Reading[],
	points: number,
): Promise<Map<string, TaskSeriesRead>> {
	const metricsOf = new Map<string, Set<string>>();
	for (const { nodeId, metrics } of readings) {
		const names = metricsOf.get(nodeId) ?? new Set<string>();
		for (const name of metrics) names.add(name);
		metricsOf.set(nodeId, names);
	}
	const reads = new Map<string, TaskSeriesRead>();
	await Promise.all(
		[...metricsOf].map(async ([nodeId, names]) => {
			const { attempt, type } = sources.get(nodeId) as Source;
			if (!attempt?.startedAt || !type || names.size === 0) return;
			reads.set(
				nodeId,
				await deps.queries.taskSeries(attempt.id, {
					declared: type.metrics ?? [],
					names: [...names],
					expired,
					points: Math.max(1, points),
				}),
			);
		}),
	);
	return reads;
}

type SeriesRead = TaskSeriesRead["series"][number];

/** 这一项引用的序列：按图表里指标的顺序（数值卡的指标只有第一个，不带标签，所以只有一个序列）。 */
const seriesOf = (reading: Reading, read: TaskSeriesRead): SeriesRead[] =>
	reading.metrics.flatMap((metric) => read.series.filter((s) => s.name === metric));

const focusSeries = (s: SeriesRead): FocusSeries => ({
	metric: s.name,
	labels: s.labels,
	points: s.buckets.map((b) => ({
		// 升级之前存下的数据没有控制面时间，横轴用它的 Agent 时间（与 bucketStartMs 一致）。
		time: b.time ?? b.agent_time,
		min: b.min,
		max: b.max,
		last: b.last,
	})),
});

/** 一项的读数：来源节点的状态、图表引用的序列和最新值。 */
function itemOf(
	reading: Reading,
	source: Source,
	read: TaskSeriesRead | undefined,
	points: number,
): RunFocusItem {
	const { attempt } = source;
	const series = read ? seriesOf(reading, read) : [];
	// 最近更新的序列；同一时刻更新的取靠前的。
	let latest: { end: SeriesEnd; series: SeriesRead } | undefined;
	for (const s of series) {
		if (s.end && (!latest || s.end.at > latest.end.at)) latest = { end: s.end, series: s };
	}
	return {
		position: reading.position,
		node_id: reading.nodeId,
		chart: reading.chart,
		title: reading.title,
		chart_type: reading.chartType,
		unit: reading.unit,
		...(reading.chartMissing ? { unavailable: "chart_missing" as const } : {}),
		source: {
			status: source.status,
			attempt: attempt?.attempt ?? 0,
			task_id: attempt?.id ?? null,
			chain_instance_id: source.chainInstanceId,
			started_at: isoOrNull(attempt?.startedAt ?? null),
			ended_at: isoOrNull(attempt?.endedAt ?? null),
		},
		latest: latest
			? { value: latest.end.value, labels: latest.series.labels, at: iso(latest.end.at) }
			: null,
		series: points === 0 ? [] : series.map(focusSeries),
		bucket_seconds: read?.bucketSeconds ?? 1,
		last_at: latest ? iso(latest.end.at) : null,
		sample_interval_ms: null,
		final: isFinal(source.status),
		anomaly: null,
	};
}
