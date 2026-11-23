import {
	isNodeTimeout,
	isQueueTimeout,
	nodeTimeoutMessage,
	type OrchestrationNode,
	queueTimeoutMessage,
} from "@sfly/schema";

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
 * 三种来源的值都检查过：返回的永远是装得进 `AssignTask.timeout_seconds`（uint32）的正整数，派发路径上没有哪一种来源的值
 * 没被检查就进了序列化。节点类型的元信息可以来自开发版本（Agent 上报的，没经过发布校验），声明的超时不合格时当作没声明；
 * 场景里这个节点写的超时不合格时（升级前保存的版本里可能有）这里也不采用它，派发时由 {@link nodeTimeoutProblem}
 * 先报成配置错误，不会走到这里。控制面派发（assign-content.ts）、超时失败的错误信息和画布的检查器都用它。
 */
export function effectiveTimeout(
	node: { timeout?: number | undefined },
	type: { timeout?: unknown } | undefined,
): { seconds: number; source: TimeoutSource } {
	if (isNodeTimeout(node.timeout)) return { seconds: node.timeout, source: "node" };
	if (isNodeTimeout(type?.timeout)) return { seconds: type.timeout, source: "type" };
	return { seconds: NODE_DEFAULTS.timeout, source: "platform" };
}

/**
 * 场景里这个节点写的超时不合格（不是 1 到 4294967295 之间的整数）时的说明，没写（`undefined`）或合格时为 undefined；
 * 写了 `null` 和别的不合格的值一样报出来（保存时 `null` 同样被拒绝，保存、预检、派发是同一个口径，#576）。
 * 派发时以配置错误失败（不重试）、触发前的预检阻断、画布的警告用同一句；保存时更早被拒绝，
 * 这里管的是升级前保存的、已经在库里的值。`label` 是节点（`显示名称（节点 ID）`）。
 */
export function nodeTimeoutProblem(label: string, written: unknown): string | undefined {
	if (written === undefined || isNodeTimeout(written)) return undefined;
	return nodeTimeoutMessage(label, written);
}

/**
 * 包节点生效的排队超时（秒，docs/SEMANTICS.md §3.3）：场景里这个节点写的，没写就是平台默认的 10 分钟。
 * 返回的永远是 1 到上限之间的正整数，排队截止时间（进入排队的时刻 + 它）一定是有效的时间；场景里写的值不合格时
 * （升级前保存的版本里可能有）这里不采用它，由 {@link queueTimeoutProblem} 先报成配置错误，不会走到这里。
 * 节点类型不能声明排队超时（只有超时可以，`NodeTypeMetadata.timeout`）。
 */
export function effectiveQueueTimeout(node: { queue_timeout?: number | undefined }): number {
	return isQueueTimeout(node.queue_timeout) ? node.queue_timeout : NODE_DEFAULTS.queue_timeout;
}

/**
 * 场景里这个节点写的排队超时不合格（不是 1 到 4294967295 之间的整数）时的说明，没写（`undefined`）或合格时为 undefined；
 * 写了 `null` 和别的不合格的值一样报出来（口径同 {@link nodeTimeoutProblem}）。
 * 排队时以配置错误失败（不重试）、触发前的预检阻断、画布的警告用同一句；保存时更早被拒绝，
 * 这里管的是升级前保存的、已经在库里的值。`label` 是节点（`显示名称（节点 ID）`）。
 */
export function queueTimeoutProblem(label: string, written: unknown): string | undefined {
	if (written === undefined || isQueueTimeout(written)) return undefined;
	return queueTimeoutMessage(label, written);
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
