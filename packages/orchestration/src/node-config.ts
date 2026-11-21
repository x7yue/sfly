import { NODE_TIMEOUT_MAX_SECONDS, type OrchestrationNode } from "@sfly/schema";

/**
 * 包节点执行配置的默认值（docs/SEMANTICS.md §3.3），单位：秒 / 次。
 * 文档里不写这些字段时使用默认值；控制面引擎和画布都从这里取。
 */
export const NODE_DEFAULTS = {
	timeout: 60 * 60,
	retries: 0,
	queue_timeout: 10 * 60,
} as const;

/** 生效的超时从哪来：场景里这个节点写的、节点类型声明的，还是平台默认的（#476）。 */
export type TimeoutSource = "node" | "type" | "platform";

/**
 * 包节点生效的超时（秒）和它从哪来（docs/SEMANTICS.md §3.3）：场景里这个节点写的 → 节点类型声明的 → 平台默认的 1 小时。
 * `type` 是节点类型的元信息；开发版本的元信息是 Agent 上报的、没经过发布校验，所以声明的超时不是 1 到 32 位无符号整数上限之间的
 * 整数时当作没声明。控制面派发（assign-content.ts）、超时失败的错误信息和画布的检查器都用它。
 */
export function effectiveTimeout(
	node: { timeout?: number },
	type: { timeout?: unknown } | undefined,
): { seconds: number; source: TimeoutSource } {
	if (node.timeout !== undefined) return { seconds: node.timeout, source: "node" };
	const declared = type?.timeout;
	if (
		typeof declared === "number" &&
		Number.isInteger(declared) &&
		declared > 0 &&
		declared <= NODE_TIMEOUT_MAX_SECONDS
	) {
		return { seconds: declared, source: "type" };
	}
	return { seconds: NODE_DEFAULTS.timeout, source: "platform" };
}

/** 任务失败的错误类型（docs/SEMANTICS.md §3.3）。 */
export type ErrorKind = "node_error" | "timeout" | "agent_lost" | "env_error" | "config_error";

/** 按 `retries` 重试的错误类型；env_error、config_error 不重试。控制面引擎和运行视图共用。 */
export const RETRYABLE_ERROR_KINDS: readonly ErrorKind[] = ["node_error", "timeout", "agent_lost"];

export const isRetryable = (kind: string): boolean =>
	(RETRYABLE_ERROR_KINDS as readonly string[]).includes(kind);

/** 可以标记为 always 的节点种类（docs/SEMANTICS.md §3.2、§4.1）；异步任务节点不行。 */
export const ALWAYS_KINDS = [
	"package",
	"stop_subflow",
] as const satisfies readonly OrchestrationNode["kind"][];

export const canBeAlways = (
	kind: OrchestrationNode["kind"],
): kind is (typeof ALWAYS_KINDS)[number] => (ALWAYS_KINDS as readonly string[]).includes(kind);
