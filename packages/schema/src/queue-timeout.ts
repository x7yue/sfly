/**
 * 节点的排队超时（秒，`queue_timeout`）的取值范围（#559）。排队截止时间是「进入排队的时刻 + 排队超时」，要装进一个有效的
 * `Date`（和数据库的 timestamptz）：`Date` 能表示的时间到公元 275760 年，换算下来排队超时在 8.6e12 秒以内都是有效的，
 * 再大的值算出的截止时间无效，触发会返回 500，或者运行中途把已经成功的节点记成失败（「Invalid time value」）。
 *
 * 上限取 4294967295 秒（约 136 年），和节点的超时（{@link NODE_TIMEOUT_MAX_SECONDS}，#476）同一个数：场景里这两个以秒计
 * 的字段说同一句话；它离 `Date` 的极限还差三个数量级，不会拦住任何合理的用法（排队几天、几个月都在范围内）。
 * 保存、触发前的预检、排队时都按它，说同一句话。
 */
export const QUEUE_TIMEOUT_MAX_SECONDS = 4_294_967_295;

/** 是不是合格的排队超时：1 到 {@link QUEUE_TIMEOUT_MAX_SECONDS} 之间的整数。 */
export const isQueueTimeout = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isInteger(value) &&
	value > 0 &&
	value <= QUEUE_TIMEOUT_MAX_SECONDS;

/** 排队超时不合格的说明；`label` 是节点（`显示名称（节点 ID）`、节点 ID），`actual` 是写的值。 */
export const queueTimeoutMessage = (label: string, actual: unknown): string =>
	`节点 ${label}：queue_timeout 必须是 1 到 ${QUEUE_TIMEOUT_MAX_SECONDS} 之间的正整数（秒），实际是 ${String(actual)}`;
