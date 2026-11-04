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

/** 可以标记为 always 的节点种类（docs/SEMANTICS.md §3.2）；异步任务节点不行。 */
export const ALWAYS_KINDS = [
	"package",
	"timer",
	"sleep",
] as const satisfies readonly OrchestrationNode["kind"][];

export const canBeAlways = (
	kind: OrchestrationNode["kind"],
): kind is (typeof ALWAYS_KINDS)[number] => (ALWAYS_KINDS as readonly string[]).includes(kind);
