import { z } from "zod";
import { MetricName } from "./package-metadata.js";

/** HTTP 契约（ADR 0007）：运行的指标摘要 `GET /runs/:id/metrics/summary`（#29）。 */

/** 一个任务（一次尝试）一个指标的摘要。 */
export const MetricSummary = z.strictObject({
	name: MetricName,
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
	first_time: z.iso.datetime(),
	last_time: z.iso.datetime(),
});

/** 一个任务（一次尝试）的指标摘要。 */
export const TaskMetricSummary = z.strictObject({
	task_id: z.uuid(),
	chain_instance_id: z.uuid(),
	node_id: z.string(),
	attempt: z.number().int().positive(),
	/** 指标数据超过单任务上限，之后的点已被丢弃。 */
	truncated: z.boolean(),
	/** Agent 断线期间排队超过上限而丢弃的点数。 */
	dropped_points: z.number().int().nonnegative(),
	/** 按指标名排序。 */
	metrics: z.array(MetricSummary),
});

/**
 * 运行的指标摘要：只列出有指标数据（或被截断、有丢弃）的任务，按任务创建顺序。
 * 运行结束超过指标保留期（#32）后 `expired` 为 true，`tasks` 为空。
 */
export const RunMetricSummary = z.strictObject({
	run_id: z.uuid(),
	/** 已过保留期：这个运行的指标数据已被清理。 */
	expired: z.boolean(),
	tasks: z.array(TaskMetricSummary),
});

export type MetricSummary = z.infer<typeof MetricSummary>;
export type TaskMetricSummary = z.infer<typeof TaskMetricSummary>;
export type RunMetricSummary = z.infer<typeof RunMetricSummary>;
