import type { OrchestrationNode } from "@sfly/schema";

/**
 * 包节点执行配置的默认值（docs/SEMANTICS.md §3.3），单位：秒 / 次。
 * 文档里不写这些字段时使用默认值；控制面引擎和画布都从这里取。
 */
export const NODE_DEFAULTS = {
	timeout: 60 * 60,
	retries: 0,
	queue_timeout: 10 * 60,
} as const;

/** 任务失败的错误类型（docs/SEMANTICS.md §3.3）。 */
export type ErrorKind = "node_error" | "timeout" | "agent_lost" | "env_error" | "config_error";

/** 按 `retries` 重试的错误类型；env_error、config_error 不重试。控制面引擎和运行视图共用。 */
export const RETRYABLE_ERROR_KINDS: readonly ErrorKind[] = ["node_error", "timeout", "agent_lost"];

export const isRetryable = (kind: string): boolean =>
	(RETRYABLE_ERROR_KINDS as readonly string[]).includes(kind);

/** 可以标记为 always 的节点种类（docs/SEMANTICS.md §3.2、§4.1）；异步任务节点不行。 */
export const ALWAYS_KINDS = [
	"package",
	"timer",
	"sleep",
	"stop_subflow",
	"feishu_notify",
] as const satisfies readonly OrchestrationNode["kind"][];

export const canBeAlways = (
	kind: OrchestrationNode["kind"],
): kind is (typeof ALWAYS_KINDS)[number] => (ALWAYS_KINDS as readonly string[]).includes(kind);
