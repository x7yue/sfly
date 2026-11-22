/**
 * 这台 Agent 现在能不能接新任务（派发的闸门）：派发（`engine.ts` 的 `#dispatch`）和「排队的任务在等什么」
 * （`queue-wait.ts`，页面和命令行写给人看）用同一段判断，改派发的条件只改这里，页面上说的原因不会和实际不一致。
 *
 * 条件和顺序（第一个不满足的就是原因）：
 * 1. 不在线：没有已推送 Welcome 的连接（`offline`）；
 * 2. 在线但还在准备环境：Welcome 之后、第一次心跳之前不派发（`preparing`，#219，准备环境的时间不计租约）；
 * 3. 版本与控制面不一致：不派新任务，等它更新后重新连上（`version_mismatch`，ADR 0014）；
 * 4. 槽位用满：准备中、执行中的任务数不少于槽位数（`slots_full`）。
 * 都满足时可以派发（`null`）；任务本身的条件（排队超时、派发内容能不能生成）不在这里，那是任务的事，不是 Agent 的。
 *
 * 纯函数，不读数据库、不看时钟；调用方传入连接的状态和任务计数。
 */

export type DispatchBlock = "offline" | "preparing" | "version_mismatch" | "slots_full";

/** 连接的状态：`AgentConnection` 的一部分。 */
export interface GateConnection {
	ready: boolean;
	info: { slots: number };
}

/** 前三条（只看连接，不用查任务）：派发先看它们，不满足就不必去数任务。 */
export function connectionBlock(
	connection: GateConnection | undefined,
	versionMismatch: boolean,
): Exclude<DispatchBlock, "slots_full"> | null {
	if (!connection) return "offline";
	if (!connection.ready) return "preparing";
	return versionMismatch ? "version_mismatch" : null;
}

/** 空闲的槽位数：槽位总数减去占着槽位的任务（准备中、执行中）数，不会是负数。 */
export const freeSlots = (slots: number, occupied: number): number => Math.max(slots - occupied, 0);

/** 现在能不能派发，不能时是什么原因；`occupied` 是占着槽位的任务数（只在连接满足条件时用得上）。 */
export function dispatchBlock(
	connection: GateConnection | undefined,
	versionMismatch: boolean,
	occupied: number,
): DispatchBlock | null {
	const block = connectionBlock(connection, versionMismatch);
	if (block) return block;
	return connection && freeSlots(connection.info.slots, occupied) === 0 ? "slots_full" : null;
}
