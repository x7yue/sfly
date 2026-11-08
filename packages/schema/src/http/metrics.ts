import { z } from "zod";
import { ChartView, MetricDeclaration, MetricName } from "../package-metadata.js";
import { endpoint, Timestamp } from "./contract.js";

/**
 * 运行的指标接口的契约（约定见 ./contract.ts）：指标摘要（#29）；指标目录、序列查询（降采样）、
 * 实时增量和平台自带图表（#31）。运行结束超过指标保留期（#32）后，摘要、目录与序列返回
 * `expired: true` 且不含数据；平台自带图表不受影响。
 */

/** 路径里的运行 ID：不是 UUID 时控制面返回 404（与找不到相同），所以这里只要求是字符串。 */
const IdParams = z.object({ id: z.string() });

/**
 * 序列的标签（#78）：键 → 值。一个任务里，一个指标在一组确定的标签值下的全部点构成一个序列；
 * 不带标签的序列为 `{}`。
 */
export const MetricLabels = z.record(z.string(), z.string());

/** 按键排序的标签副本：内容相同的标签得到相同的 JSON（与 jsonb 的规范形式一样，比较时相等）。 */
export function sortedLabels(labels: Readonly<Record<string, string>>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
}

/**
 * 序列的身份（指标名 + 标签）：不带标签时就是指标名，带标签时是指标名、NUL 和键排序后的标签 JSON。
 * 指标名是标识符、不含 NUL，两种形式不会冲突；按它排序即先按指标名、再按标签排序。
 */
export function seriesKey(name: string, labels: Readonly<Record<string, string>>): string {
	for (const _ in labels) return `${name}\u0000${JSON.stringify(sortedLabels(labels))}`;
	return name;
}

/** 一个任务（一次尝试）一个序列的摘要。 */
export const MetricSummary = z.object({
	name: MetricName,
	labels: MetricLabels,
	/** 已写入的点数（每秒最多一个点）。 */
	points: z.number().int().nonnegative(),
	/** 所有点的每秒最小值中的最小值。 */
	min: z.number(),
	/** 所有点的每秒最大值中的最大值。 */
	max: z.number(),
	/** 所有点的值的平均。 */
	avg: z.number(),
	/** 最新值。 */
	last: z.number(),
	first_time: Timestamp,
	last_time: Timestamp,
});

/** 一个任务（一次尝试）的指标摘要。 */
export const TaskMetricSummary = z.object({
	task_id: z.uuid(),
	chain_instance_id: z.uuid(),
	node_id: z.string(),
	attempt: z.number().int().positive(),
	/** 指标数据超过单任务上限，之后的点已被丢弃。 */
	truncated: z.boolean(),
	/** Agent 断线期间排队超过上限而丢弃的点数。 */
	dropped_points: z.number().int().nonnegative(),
	/** 按指标名排序，同一指标的序列按标签排序。 */
	metrics: z.array(MetricSummary),
});

/**
 * 运行的指标摘要：只列出有指标数据（或被截断、有丢弃）的任务，按任务创建顺序。
 * 已过保留期时 `expired` 为 true，`tasks` 为空。
 */
export const RunMetricSummary = z.object({
	run_id: z.uuid(),
	/** 已过保留期：这个运行的指标数据已被清理。 */
	expired: z.boolean(),
	tasks: z.array(TaskMetricSummary),
});

/** 一个节点的一次尝试在目录里的条目。 */
export const CatalogAttempt = z.object({
	task_id: z.uuid(),
	attempt: z.number().int().positive(),
	/** 指标数据超过单任务上限，之后的点已被丢弃。 */
	truncated: z.boolean(),
	/** Agent 断线期间排队超过上限而丢弃的点数。 */
	dropped_points: z.number().int().nonnegative(),
	/** 已写库的点的摘要（每个序列一项），按指标名、标签排序；运行中的当前段约每 10 秒写一次。 */
	metrics: z.array(MetricSummary),
});

/** 目录里的一个包节点（链实例 × 节点）。 */
export const CatalogNode = z.object({
	chain_instance_id: z.uuid(),
	node_id: z.string(),
	package: z.string(),
	/** 节点类型名（包内）。 */
	node: z.string(),
	/** 锁定的节点包版本；`dev` 时声明取任务所在 Agent 当前加载的源码。 */
	version: z.string(),
	/** 节点类型声明的指标；找不到节点类型（例如 dev 包已卸载）时为空。 */
	metrics: z.array(MetricDeclaration),
	/** 声明的图表在前，之后是为没被任何图表引用的指标生成的默认图表。 */
	charts: z.array(ChartView),
	primary_metric: MetricName.nullable(),
	/** 各次尝试，按 attempt 升序；最后一个是最新一次。 */
	attempts: z.array(CatalogAttempt).min(1),
});

/**
 * 运行的指标目录：开始过执行的包节点，按任务创建顺序。
 * 已过保留期时 `expired` 为 true，`nodes` 为空（与摘要一致）。
 */
export const RunMetricCatalog = z.object({
	run_id: z.uuid(),
	/** 已过保留期：这个运行的指标数据已被清理。 */
	expired: z.boolean(),
	nodes: z.array(CatalogNode),
});

/** 目标点数的默认值与上限。 */
export const DEFAULT_SERIES_POINTS = 300;
export const MAX_SERIES_POINTS = 5000;

/**
 * 序列查询的查询参数：节点（链实例 × 节点）、可选的尝试（默认最新一次）、
 * 指标名（逗号分隔，默认节点类型声明的全部指标）、时间范围（ISO，闭区间，按秒取整；默认数据的首尾时间）、
 * 目标点数（桶数上限）。
 */
export const MetricSeriesQuery = z
	.strictObject({
		chain_instance_id: z.uuid(),
		node_id: z.string().min(1),
		attempt: z.coerce.number().int().positive().optional(),
		metrics: z
			.string()
			.transform((s) => s.split(",").filter((m) => m !== ""))
			.pipe(z.array(MetricName).max(50))
			.optional(),
		from: Timestamp.optional(),
		to: Timestamp.optional(),
		points: z.coerce.number().int().min(1).max(MAX_SERIES_POINTS).default(DEFAULT_SERIES_POINTS),
	})
	.refine(
		(q) => q.from === undefined || q.to === undefined || Date.parse(q.from) <= Date.parse(q.to),
		{
			message: "from 不能晚于 to",
			path: ["from"],
		},
	);

/** 一个桶：起始时间 + 落在桶里的点的最小（每秒最小值中的最小）、最大、平均、最新值。 */
export const MetricBucket = z.object({
	time: Timestamp,
	/** 桶里的点数（每秒最多一个）。 */
	points: z.number().int().positive(),
	min: z.number(),
	max: z.number(),
	avg: z.number(),
	last: z.number(),
});

/**
 * 序列查询的结果：查询的每个指标的全部序列（按指标的查询顺序，同一指标按标签排序），每个序列的非空桶按时间升序。
 * 没有任何数据的指标：没声明标签键时给出一个 `labels` 为 `{}`、没有桶的序列，声明了标签键时没有序列。
 * 已过保留期时 `expired` 为 true，每个序列都没有桶；没有指定时间范围时 from、to 为 null。
 */
export const MetricSeries = z.object({
	run_id: z.uuid(),
	/** 已过保留期：这个运行的指标数据已被清理。 */
	expired: z.boolean(),
	chain_instance_id: z.uuid(),
	node_id: z.string(),
	task_id: z.uuid(),
	attempt: z.number().int().positive(),
	/** 实际的时间范围（按秒取整）；没有指定且没有任何数据时为 null。 */
	from: Timestamp.nullable(),
	to: Timestamp.nullable(),
	/** 每个桶的跨度（秒，至少 1）：桶 k 覆盖 [from + k × bucket_seconds, from + (k + 1) × bucket_seconds)。 */
	bucket_seconds: z.number().int().positive(),
	truncated: z.boolean(),
	series: z.array(
		z.object({ name: MetricName, labels: MetricLabels, buckets: z.array(MetricBucket) }),
	),
});

/** 一个合并后的点（每个序列每秒一个）。 */
export const MetricPointView = z.object({
	name: MetricName,
	labels: MetricLabels,
	time: Timestamp,
	value: z.number(),
	/** 这一秒内的最小、最大值（counter 与 value 相同）。 */
	min: z.number(),
	max: z.number(),
});

/**
 * 运行事件流 `GET /runs/:id/events` 上的 `metrics` 事件：一个执行中任务新收到的点（Agent 每秒最多一批）。
 * 断线期间错过的点用序列查询补齐。
 */
export const MetricIncrement = z.object({
	task_id: z.uuid(),
	chain_instance_id: z.uuid(),
	node_id: z.string(),
	attempt: z.number().int().positive(),
	points: z.array(MetricPointView).min(1),
});

/** 平台自带图表的一个时间桶：桶内的最大值与按时间加权的平均值。 */
export const PlatformBucket = z.object({
	time: Timestamp,
	max: z.number().int().nonnegative(),
	avg: z.number().nonnegative(),
});

/**
 * 平台自带图表（不新增存储，全部由任务记录推导）。
 * 时间序列覆盖运行的开始到结束（运行中到现在），按目标点数分桶。
 */
export const PlatformMetrics = z.object({
	run_id: z.uuid(),
	from: Timestamp,
	to: Timestamp,
	bucket_seconds: z.number().int().positive(),
	/** 所有节点的重试次数之和。 */
	retries: z.number().int().nonnegative(),
	/** 开始过的节点（链实例 × 节点），按任务创建顺序。时长单位毫秒，运行中的尝试算到现在。 */
	nodes: z.array(
		z.object({
			chain_instance_id: z.uuid(),
			node_id: z.string(),
			kind: z.string(),
			attempts: z.number().int().positive(),
			/** 尝试次数减 1。 */
			retries: z.number().int().nonnegative(),
			/** 各次尝试从进入排队到结束的时长之和（含排队与等待）。 */
			duration_ms: z.number().int().nonnegative(),
			/** 包节点：各次尝试从进入排队到开始执行（含派发、安装）的时长之和。 */
			queue_ms: z.number().int().nonnegative(),
			/** 定时 / Sleep 节点：等待的时长之和。 */
			wait_ms: z.number().int().nonnegative(),
		}),
	),
	/** 本运行同时执行中的任务数（包节点从开始执行到结束）。 */
	concurrency: z.array(PlatformBucket),
	/** 本运行用到的每个 Agent 的槽位占用：这个 Agent 上同时执行中的任务数（含其他运行的任务）。 */
	agents: z.array(
		z.object({
			name: z.string(),
			/** Agent 的槽位数；没有注册过时为 null。 */
			slots: z.number().int().nonnegative().nullable(),
			occupancy: z.array(PlatformBucket),
		}),
	),
});

/** 平台自带图表的查询参数。 */
export const PlatformMetricsQuery = z.strictObject({
	points: z.coerce.number().int().min(1).max(MAX_SERIES_POINTS).default(120),
});

export const metricsApi = {
	/**
	 * 运行的指标摘要：每个有指标数据的任务（每次尝试）每个指标的点数、最小、最大、平均、最新值、首尾时间，
	 * 以及截断标记。只包含已经写库的点（当前段约每 10 秒写一次，任务结束时立即写入）。
	 */
	summary: endpoint({
		method: "GET",
		path: "/runs/:id/metrics/summary",
		key: ["metrics", "summary"],
		params: IdParams,
		response: RunMetricSummary,
	}),
	/** 运行的指标目录：每个包节点的指标声明、图表定义（含默认图表）、主指标，以及每次尝试的摘要和截断标记。 */
	catalog: endpoint({
		method: "GET",
		path: "/runs/:id/metrics",
		key: ["metrics", "catalog"],
		params: IdParams,
		response: RunMetricCatalog,
	}),
	/**
	 * 一个节点（默认最新一次尝试）的指标按目标点数降采样，含尚未写库的点。节点不存在时 404。
	 * 实时增量在运行事件流上（`metrics` 事件，{@link MetricIncrement}）。
	 */
	series: endpoint({
		method: "GET",
		path: "/runs/:id/metrics/series",
		key: ["metrics", "series"],
		params: IdParams,
		query: MetricSeriesQuery,
		response: MetricSeries,
	}),
	/** 平台自带图表，由任务记录推导。 */
	platform: endpoint({
		method: "GET",
		path: "/runs/:id/metrics/platform",
		key: ["metrics", "platform"],
		params: IdParams,
		query: PlatformMetricsQuery,
		response: PlatformMetrics,
	}),
};

export type MetricLabels = z.infer<typeof MetricLabels>;
export type MetricSummary = z.infer<typeof MetricSummary>;
export type CatalogAttempt = z.infer<typeof CatalogAttempt>;
export type CatalogNode = z.infer<typeof CatalogNode>;
export type RunMetricCatalog = z.infer<typeof RunMetricCatalog>;
export type MetricSeriesQuery = z.infer<typeof MetricSeriesQuery>;
export type MetricBucket = z.infer<typeof MetricBucket>;
export type MetricSeries = z.infer<typeof MetricSeries>;
export type MetricPointView = z.infer<typeof MetricPointView>;
export type MetricIncrement = z.infer<typeof MetricIncrement>;
export type PlatformBucket = z.infer<typeof PlatformBucket>;
export type PlatformMetrics = z.infer<typeof PlatformMetrics>;
export type TaskMetricSummary = z.infer<typeof TaskMetricSummary>;
export type RunMetricSummary = z.infer<typeof RunMetricSummary>;
