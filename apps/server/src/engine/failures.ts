import { NODE_DEFAULTS } from "@sfly/orchestration";
import type { OrchestrationNode } from "@sfly/schema";
import type { ErrorKind, TaskStatus } from "../db/schema.js";

/**
 * 失败处理规则（docs/SEMANTICS.md §3.2、§3.3）：哪些错误按 `retries` 重试、always 节点、链是否已失败。
 */

/** 按 `retries` 重试的错误类型；env_error、config_error 不重试。 */
export const RETRYABLE_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
	"node_error",
	"timeout",
	"agent_lost",
]);

/** 节点配置的重试次数（只有包节点能配置）。 */
export const retriesOf = (node: OrchestrationNode): number =>
	node.kind === "package" ? (node.retries ?? NODE_DEFAULTS.retries) : 0;

/** 第 attempt 次尝试以 kind 失败后，是否再派发一次（attempt + 1）。 */
export const shouldRetry = (node: OrchestrationNode, kind: ErrorKind, attempt: number): boolean =>
	RETRYABLE_KINDS.has(kind) && attempt <= retriesOf(node);

/** 前面的节点失败后仍然执行的节点（包节点、定时节点、Sleep 节点可以设置）。 */
export const isAlways = (node: OrchestrationNode): boolean => "always" in node && node.always;

/** 链上是否已有节点最终失败：某个节点最近一次尝试的状态是 failed。 */
export function hasFinalFailure(
	rows: ReadonlyArray<{ nodeId: string; attempt: number; status: TaskStatus }>,
): boolean {
	const latest = new Map<string, { attempt: number; status: TaskStatus }>();
	for (const row of rows) {
		const seen = latest.get(row.nodeId);
		if (!seen || row.attempt > seen.attempt) latest.set(row.nodeId, row);
	}
	return [...latest.values()].some((row) => row.status === "failed");
}
