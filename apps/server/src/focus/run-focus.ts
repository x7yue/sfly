import {
	type ChartView,
	chartMetrics,
	DEFAULT_FOCUS_POINTS,
	focusName,
	focusSeriesOf,
	isOnAgentStatus,
	latestSeries,
	type MetricDeclaration,
	type NodeStatus,
	type RunFocus,
	type RunFocusItem,
	type RunFocusQuery,
} from "@sfly/schema";
import type { Clock } from "../clock.js";
import type { Db, Tx } from "../db/database.js";
import type { MetricQueries, TaskSeriesRead } from "../metrics/metric-queries.js";
import { declaredNodeType } from "../metrics/node-types.js";
import type { NodeTypeView } from "../packages/default-charts.js";
import {
	nodeNameIn,
	type RunAttemptDetail,
	type RunChain,
	type RunNode,
	type RunReadFull,
} from "../runs/run-read.js";
import {
	type AnomalySubject,
	focusAnomaly,
	isFinalStatus,
	SAMPLE_POINTS,
	sampleIntervalMs,
	staleSince,
} from "./focus-anomaly.js";
import type { FocusItem } from "./focus-list.js";

/**
 * 解析一次运行的关注项要用到的依赖：控制面里读读数的地方（HTTP 接口、控制台）传这三样。
 * `db` 可以是事务：在事务里读时，要看到这个事务里刚写下的节点状态，运行的读取（`readRuns`）
 * 也要走同一个事务。所有查询（包括 `queries` 读的序列）都走 `db`，一个接一个地执行，不从连接池另取连接。
 */
export interface RunFocusDeps {
	db: Db | Tx;
	clock: Clock;
	queries: Pick<MetricQueries, "taskSeries">;
}

export interface RunFocusOptions {
	/** 每个序列降采样成多少个点（0 只要最新值）；默认 {@link DEFAULT_FOCUS_POINTS}。 */
	points?: RunFocusQuery["points"];
}

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null);

/**
 * 一个来源节点：它在这次运行里所在的链实例（子流程还没触发时没有）、状态和最新一次尝试（三者出自运行读取里的同一个链实例，
 * 见 {@link sourcesOf}），以及这次运行锁定的版本里它的节点类型。
 */
interface Source {
	chainInstanceId: string | null;
	/** 节点的显示名称（取自这次运行绑定的版本）；没有时为 undefined。 */
	displayName: string | undefined;
	status: NodeStatus;
	/** 最新一次尝试；节点还没有尝试时为 undefined。 */
	attempt: RunAttemptDetail | undefined;
	/** 上一次尝试的错误信息（最新一次是重试时，重试的原因）；没有时为 null。 */
	previousError: string | null;
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
 * 没设就是准备中、执行中节点的主指标；有异常的项（focus-anomaly.ts）排在前面，两部分各自保持原来的顺序。
 * `read` 是这次运行的 `full` 读取（src/runs/run-read.ts，用 `deps.db` 读）。
 *
 * - 只返回节点在这次运行绑定的版本里的项（`position` 仍是它在作者列表里的位置）；设了关注项时，
 *   节点还没开始也照样返回，所在的子流程还没触发的节点状态是 pending，没有链实例（`source.chain_instance_id` 为 null）。
 * - 来源的链实例、状态和最新一次尝试的任务出自运行读取里同一个链实例（{@link placedNodes}）；图表的定义取这次运行绑定的版本锁定的节点包版本，那个版本里没有这张图表时
 *   `unavailable` 是 `chart_missing`。开发版本取 Agent 当前加载的源码，不一定是运行当时的定义。
 * - 数值卡只有第一个序列，其余图表是声明的全部序列；`latest` 是最近更新的那个序列的最后一个点，采样间隔也按这个序列
 *   最近的点估算。
 */
export async function resolveRunFocus(
	deps: RunFocusDeps,
	read: RunReadFull,
	options: RunFocusOptions = {},
): Promise<RunFocus> {
	const { document } = read.version;
	const points = options.points ?? DEFAULT_FOCUS_POINTS;
	const generatedAt = deps.clock.now();
	const authored = read.scenario.focusItems;
	const mode = authored.length > 0 ? "focus" : "primary";
	const expired = read.run.metricsPurgedAt !== null;

	// 节点在这次运行里的位置：已经开始的链（主链和已触发的子流程）上的节点；子流程还没触发的节点没有位置，是 pending。
	const placed = placedNodes(read.chains);
	const inDocument = (nodeId: string) => document.nodes.some((n) => n.id === nodeId);
	const isPackage = (nodeId: string) =>
		document.nodes.find((n) => n.id === nodeId)?.kind === "package";
	const wanted =
		mode === "focus"
			? new Set(authored.map((i) => i.node_id).filter(inDocument))
			: new Set(
					[...placed]
						.filter(([id, at]) => isOnAgentStatus(at.node.status) && isPackage(id))
						.map(([id]) => id),
				);
	const sources = await sourcesOf(deps.db, read, wanted, placed);

	const readings = mode === "focus" ? focusReadings(authored, sources) : primaryReadings(sources);
	const reads = await readSeries(deps, expired, sources, readings, points);
	const items = readings.map((reading) =>
		itemOf(
			reading,
			sources.get(reading.nodeId) as Source,
			reads.get(reading.nodeId),
			points,
			generatedAt,
		),
	);
	return {
		generated_at: generatedAt.toISOString(),
		mode,
		expired,
		items: [...items.filter((i) => i.anomaly), ...items.filter((i) => !i.anomaly)],
	};
}

/** 节点在这次运行里所在的链实例和它在运行读取里的那一项。 */
type Placed = ReadonlyMap<string, { chainInstanceId: string; node: RunNode<RunAttemptDetail> }>;

/**
 * 每个节点在这次运行里所在的链实例：取第一个有这个节点的链实例（层级、开始时间、ID 的顺序）。一个子流程在一次运行里
 * 最多一个实例（docs/SEMANTICS.md §1），所以一个节点至多在一个链实例上，这条规则只是让结果确定。
 */
function placedNodes(chains: readonly RunChain<RunAttemptDetail>[]): Placed {
	const placed = new Map<string, { chainInstanceId: string; node: RunNode<RunAttemptDetail> }>();
	for (const chain of chains) {
		for (const node of chain.nodes) {
			if (!placed.has(node.node_id)) placed.set(node.node_id, { chainInstanceId: chain.id, node });
		}
	}
	return placed;
}

/**
 * 每个要读的节点的来源（docs/ARCHITECTURE.md §6.1「运行里的关注项读数」）：链实例、状态、最新一次尝试和它前面的一次都出自
 * 运行读取里同一个链实例的同一项（{@link placedNodes}），尝试不含占位。判断异常要的错误信息和运行视图一样在读取时打码，
 * 所以异常原因（失败、重试的 `message`）在各页面里都已打码。
 */
async function sourcesOf(
	db: Db | Tx,
	read: RunReadFull,
	wanted: ReadonlySet<string>,
	placed: Placed,
): Promise<Map<string, Source>> {
	const { document } = read.version;
	const sources = new Map<string, Source>();
	for (const nodeId of wanted) {
		const at = placed.get(nodeId);
		const tried = at?.node.attempts ?? [];
		const attempt = tried.at(-1);
		sources.set(nodeId, {
			chainInstanceId: at?.chainInstanceId ?? null,
			status: at?.node.status ?? "pending",
			displayName: nodeNameIn(document, nodeId),
			attempt,
			previousError: tried.at(-2)?.errorMessage ?? null,
			type: await declaredNodeType(db, read.run.projectId, document, nodeId, attempt?.agent),
		});
	}
	return sources;
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
				metrics: chart ? chartMetrics(chart) : [],
				unit: unitOf(source.type?.metrics, chart?.metrics[0]),
				chartMissing: chart === undefined,
			},
		];
	});
}

/** 没设关注项时：准备中、执行中的节点（节点类型有主指标的）的主指标，按节点在运行里的顺序。 */
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

/**
 * 每个有数据可读的节点读一次序列：同一个节点的几个项合并成一次查询。一个接一个地读：`db` 是事务时只有这一个连接
 * （再从连接池另取连接，会和等这个事务的锁的写入互相等死）。
 */
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
	for (const [nodeId, names] of metricsOf) {
		const { attempt, type } = sources.get(nodeId) as Source;
		if (!attempt?.startedAt || !type || names.size === 0) continue;
		reads.set(
			nodeId,
			await deps.queries.taskSeries(
				attempt.taskId,
				{
					declared: type.metrics ?? [],
					names: [...names],
					expired,
					points: Math.max(1, points),
					recent: SAMPLE_POINTS,
				},
				deps.db,
			),
		);
	}
	return reads;
}

type SeriesRead = TaskSeriesRead["series"][number];

/** 这一项引用的序列：按图表里指标的顺序（数值卡的指标只有第一个，不带标签，所以只有一个序列）。 */
const seriesOf = (reading: Reading, read: TaskSeriesRead): SeriesRead[] =>
	reading.metrics.flatMap((metric) => read.series.filter((s) => s.name === metric));

/** 一项的读数：来源节点的状态、图表引用的指标和序列、最新值、采样间隔和异常（按 `now` 判断）。 */
function itemOf(
	reading: Reading,
	source: Source,
	read: TaskSeriesRead | undefined,
	points: number,
	now: Date,
): RunFocusItem {
	const { attempt } = source;
	const series = read ? seriesOf(reading, read) : [];
	const newest = latestSeries(series, (s) => s.end?.at);
	const latest = newest?.end && { end: newest.end, series: newest };
	const interval = latest ? sampleIntervalMs(latest.series.recent) : null;
	const subject: AnomalySubject = {
		status: source.status,
		attempt,
		previousError: source.previousError,
		chartMissing: reading.chartMissing,
		lastAt: latest ? latest.end.at * 1000 : null,
		sampleIntervalMs: interval,
	};
	const anomaly = focusAnomaly(subject, now);
	return {
		position: reading.position,
		node_id: reading.nodeId,
		...(source.displayName === undefined ? {} : { display_name: source.displayName }),
		chart: reading.chart,
		title: reading.title,
		chart_type: reading.chartType,
		unit: reading.unit,
		...(reading.chartMissing ? { unavailable: "chart_missing" as const } : {}),
		metrics: reading.metrics.map((name) => ({
			name,
			label_keys: source.type?.metrics?.find((m) => m.name === name)?.labels ?? [],
		})),
		source: {
			status: source.status,
			attempt: attempt?.attempt ?? 0,
			task_id: attempt?.taskId ?? null,
			chain_instance_id: source.chainInstanceId,
			started_at: isoOrNull(attempt?.startedAt ?? null),
			ended_at: isoOrNull(attempt?.endedAt ?? null),
		},
		latest: latest
			? {
					value: latest.end.value,
					metric: latest.series.name,
					labels: latest.series.labels,
					at: iso(latest.end.at),
				}
			: null,
		series: points === 0 ? [] : series.map(focusSeriesOf),
		bucket_seconds: read?.bucketSeconds ?? 1,
		last_at: latest ? iso(latest.end.at) : null,
		sample_interval_ms: interval,
		stale_since: isoOrNull(staleSince(subject, now)),
		final: isFinalStatus(source.status),
		anomaly,
	};
}
