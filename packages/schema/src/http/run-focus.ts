import { z } from "zod";
import { ChartDeclaration, MetricName } from "../package-metadata.js";
import { endpoint, Timestamp } from "./contract.js";
import { MetricLabels } from "./metrics.js";
import { NodeStatus } from "./runs.js";

/**
 * 一次运行的关注项读数的契约（约定见 ./contract.ts）：`GET /runs/:id/focus` 一次返回运行的全部关注项，
 * 概览、画布、控制台、Agent 管理页和飞书运行通知都用这一份结果。
 * 解析规则在控制面（apps/server/src/focus/run-focus.ts 的 `resolveRunFocus`），页面不再自己拼指标查询。
 */

/** 每个序列降采样点数的默认值与上限。 */
export const DEFAULT_FOCUS_POINTS = 60;
export const MAX_FOCUS_POINTS = 300;

export const RunFocusQuery = z.strictObject({
	/** 每个序列降采样成多少个点；0 只要最新值，不返回序列。 */
	points: z.coerce.number().int().min(0).max(MAX_FOCUS_POINTS).default(DEFAULT_FOCUS_POINTS),
});

/** 序列里的一个桶：起始时间（控制面时间）、桶内的最小、最大值和最新值。 */
export const FocusPoint = z.object({
	/** 桶的起始时间；升级之前存下的数据没有控制面时间，用它的 Agent 时间。 */
	time: Timestamp,
	min: z.number(),
	max: z.number(),
	/** 桶里最后一个点的值。 */
	last: z.number(),
});

export const FocusSeries = z.object({
	metric: MetricName,
	labels: MetricLabels,
	/** 按时间升序，每 `bucket_seconds` 秒一个桶，没有点的桶不给。 */
	points: z.array(FocusPoint),
});

/** 读数的最新值：最近更新的那个序列的最后一个点。 */
export const FocusLatest = z.object({
	value: z.number(),
	/** 这个点所在序列的指标名和标签；不带标签的序列标签为 `{}`。 */
	metric: MetricName,
	labels: MetricLabels,
	/** 这个点的控制面时间（按秒取整）。 */
	at: Timestamp,
});

/** 来源节点和它最新一次尝试的任务。 */
export const FocusSource = z.object({
	/** 来源节点的状态，取法与运行视图里的节点状态一致。 */
	status: NodeStatus,
	/** 最新一次尝试的序号；节点还没有尝试时为 0。 */
	attempt: z.number().int().nonnegative(),
	/** 最新一次尝试的任务；节点还没有尝试时为 null。 */
	task_id: z.string().nullable(),
	/** 节点所在的链实例。 */
	chain_instance_id: z.string(),
	/** 这次尝试开始、结束的时间，图表的横轴从开始画到结束（还没结束就画到 `generated_at`）；没有就是 null。 */
	started_at: Timestamp.nullable(),
	ended_at: Timestamp.nullable(),
});

/** 异常的四种原因，规则见 GLOSSARY「关注项」与方案文档第 4.1 节。 */
export const FocusAnomalyKind = z.enum(["log", "stale", "failed", "retry"]);

/** 一项的异常；没有异常为 null。 */
export const FocusAnomaly = z.object({
	kind: FocusAnomalyKind,
	/** `log` 时是最近一条日志的级别。 */
	level: z.enum(["warn", "error"]).optional(),
	/** 异常发生的时间（控制面时间）：最近一条日志、最后一个点、失败或重试开始的时间。 */
	at: Timestamp,
	/** 原因的原文，页面直接显示。 */
	message: z.string(),
	/** `log` 时是这次尝试里 WARN / ERROR 的总条数。 */
	count: z.number().int().positive().optional(),
});

/**
 * 一个关注项（或没设关注项时一个执行中节点的主指标）的读数。
 *
 * `mode` 为 `primary` 时没有图表：`chart` 与 `title` 是主指标名，`chart_type` 是 `stat`，`position` 按节点的执行顺序编号。
 * `unavailable` 为 `chart_missing`（这次运行锁定的节点包版本里没有这张图表）时，`chart_type` 是 `line`、`unit` 是空串、
 * 没有数据，这几个值没有意义，页面按 `unavailable` 写明原因。
 */
export const RunFocusItem = z.object({
	/** 作者设定的位置，从 1 开始；列表里不在这次运行里的项也占位置，所以返回的位置可以不连续。 */
	position: z.number().int().positive(),
	node_id: z.string(),
	/** 图表标题。 */
	chart: z.string(),
	/** 显示名：作者起的名字，没起名时是图表标题。 */
	title: z.string(),
	chart_type: ChartDeclaration.shape.type,
	/** 图表第一个指标的单位。 */
	unit: z.string(),
	unavailable: z.literal("chart_missing").optional(),
	source: FocusSource,
	latest: FocusLatest.nullable(),
	/** 数值卡只有第一个序列，其余图表是声明的全部序列；`points` 为 0 时为空。 */
	series: z.array(FocusSeries),
	/** 每个桶的跨度（秒，至少 1）。 */
	bucket_seconds: z.number().int().positive(),
	/** 最后一个点的控制面时间；一个点都没有为 null。 */
	last_at: Timestamp.nullable(),
	/** 按最近 10 个点估算的采样间隔（毫秒）；点不够 2 个时为 null。 */
	sample_interval_ms: z.number().int().positive().nullable(),
	/** 来源节点成功或已停止：只显示最终值，不判断异常。 */
	final: z.boolean(),
	anomaly: FocusAnomaly.nullable(),
});

export const RunFocus = z.object({
	/** 控制面生成这份读数的时间，页头「数据更新于」用它。 */
	generated_at: Timestamp,
	/** 场景设了关注项是 `focus`；没设时是执行中节点的主指标 `primary`。 */
	mode: z.enum(["focus", "primary"]),
	/** 这次运行的指标已过保留期：每一项都没有数据。 */
	expired: z.boolean(),
	/** 已按「异常在前，其余按作者顺序」排好。 */
	items: z.array(RunFocusItem),
});

export const runFocusApi = {
	/**
	 * 一次运行的全部关注项：只返回节点在这次运行的版本里的那些项，取节点最新一次尝试的任务，图表的定义取这次运行
	 * 锁定的节点包版本（那个版本里没有这张图表时 `unavailable` 为 `chart_missing`）。场景没设关注项时 `mode` 是
	 * `primary`，返回执行中节点的主指标。运行不存在时 404。
	 */
	focus: endpoint({
		method: "GET",
		path: "/runs/:id/focus",
		client: true,
		key: ["runs", "focus"],
		params: z.object({ id: z.string() }),
		query: RunFocusQuery,
		response: RunFocus,
	}),
};

export type RunFocusQuery = z.infer<typeof RunFocusQuery>;
export type FocusPoint = z.infer<typeof FocusPoint>;
export type FocusSeries = z.infer<typeof FocusSeries>;
export type FocusLatest = z.infer<typeof FocusLatest>;
export type FocusSource = z.infer<typeof FocusSource>;
export type FocusAnomaly = z.infer<typeof FocusAnomaly>;
export type RunFocusItem = z.infer<typeof RunFocusItem>;
export type RunFocus = z.infer<typeof RunFocus>;
