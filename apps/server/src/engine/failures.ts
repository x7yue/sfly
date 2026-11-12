import { isRetryable, NODE_DEFAULTS } from "@sfly/orchestration";
import type { OrchestrationNode } from "@sfly/schema";
import type { ErrorKind, TaskStatus } from "../db/schema.js";

/**
 * 失败处理规则（docs/SEMANTICS.md §3.2、§3.3）：是否重试（可重试的错误类型在 @sfly/orchestration）、
 * always 节点、链是否已失败。
 */

/** 节点配置的重试次数（只有包节点能配置）。 */
export const retriesOf = (node: OrchestrationNode): number =>
	node.kind === "package" ? (node.retries ?? NODE_DEFAULTS.retries) : 0;

/** 第 attempt 次尝试以 kind 失败后，是否再派发一次（attempt + 1）。 */
export const shouldRetry = (node: OrchestrationNode, kind: ErrorKind, attempt: number): boolean =>
	isRetryable(kind) && attempt <= retriesOf(node);

/** 前面的节点失败后仍然执行的节点（包节点、定时节点、Sleep 节点、停止子流程节点可以设置）。 */
export const isAlways = (node: OrchestrationNode): boolean => "always" in node && node.always;

/**
 * 最终失败的节点：每个节点最近一次尝试的状态是 failed 的那一行（按链实例和节点分组，行里没有链实例时算同一条链）。
 */
export function finalFailures<
	T extends { chainInstanceId?: string; nodeId: string; attempt: number; status: TaskStatus },
>(rows: readonly T[]): T[] {
	const latest = new Map<string, T>();
	for (const row of rows) {
		const key = `${row.chainInstanceId ?? ""}\0${row.nodeId}`;
		const seen = latest.get(key);
		if (!seen || row.attempt > seen.attempt) latest.set(key, row);
	}
	return [...latest.values()].filter((row) => row.status === "failed");
}

/** 链上是否已有节点最终失败：某个节点最近一次尝试的状态是 failed。 */
export const hasFinalFailure = (
	rows: ReadonlyArray<{ nodeId: string; attempt: number; status: TaskStatus }>,
): boolean => finalFailures(rows).length > 0;
