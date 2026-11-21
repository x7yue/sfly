/**
 * 节点的超时（秒）的取值范围（#476）。上限 4294967295 是派发给 Agent 的 `AssignTask.timeout_seconds`（`uint32`）装得下的最大值，
 * 更大的值序列化会失败。节点类型声明的超时（`@node(timeout=…)`，节点包元信息里的 `timeout`）和场景里节点写的超时
 * 用同一个范围，保存、触发前的预检、派发、`sfly build` 和命令行 push 的本地检查都按它，说同一句话。
 */
export const NODE_TIMEOUT_MAX_SECONDS = 4_294_967_295;

/** 是不是合格的超时：1 到 {@link NODE_TIMEOUT_MAX_SECONDS} 之间的整数。 */
export const isNodeTimeout = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isInteger(value) &&
	value > 0 &&
	value <= NODE_TIMEOUT_MAX_SECONDS;

/** 超时不合格的说明；`label` 是节点（`显示名称（节点 ID）`、节点 ID），`actual` 是写的值。 */
export const nodeTimeoutMessage = (label: string, actual: unknown): string =>
	`节点 ${label}：timeout 必须是 1 到 ${NODE_TIMEOUT_MAX_SECONDS} 之间的正整数（秒），实际是 ${String(actual)}`;
