import type { TaskLogs } from "../logs/task-logs.js";
import { BACKLOG_LIMIT } from "./delivery-policy.js";

/** 消息还没投递就被丢弃的原因。 */
export type DiscardReason = "bot_removed" | "backlog";

/**
 * 记在队列里的丢弃原因（中文）：「已丢弃：机器人已删除」「已丢弃：积压过多」，后面跟一句说明。
 * 写进任务日志的也是它。
 */
export function discardNote(reason: DiscardReason, bot: string): string {
	return reason === "bot_removed"
		? `已丢弃：机器人已删除。飞书机器人「${bot}」已被删除，它还没有投递的消息不会再发送`
		: `已丢弃：积压过多。飞书机器人「${bot}」排队的消息超过 ${BACKLOG_LIMIT} 条，丢弃最旧的消息`;
}

/**
 * 丢弃的结果写进发起这些消息的任务的日志（warning）。同一个任务有多条消息被丢弃时只写一行，注明条数：
 * 失控的循环一次丢掉上万条消息，不能再用上万行日志把任务的日志淹掉。
 */
export async function logDiscards(
	logs: Pick<TaskLogs, "appendSystem">,
	discarded: ReadonlyArray<{ taskId: string | null }>,
	reason: DiscardReason,
	bot: string,
): Promise<void> {
	const perTask = new Map<string, number>();
	for (const { taskId } of discarded) {
		if (taskId !== null) perTask.set(taskId, (perTask.get(taskId) ?? 0) + 1);
	}
	const note = discardNote(reason, bot);
	for (const [taskId, count] of perTask) {
		await logs.appendSystem(
			taskId,
			"warn",
			count === 1 ? note : `${note}（这个任务有 ${count} 条消息被丢弃）`,
		);
	}
}
