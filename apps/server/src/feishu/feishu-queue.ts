import { type FeishuMessageSource, feishuMessages } from "../db/schema.js";
import type { Tx } from "../engine/step.js";
import { truncateTextBody } from "./body-limit.js";

/** 要写进发送队列的一条消息。 */
export interface NewFeishuMessage {
	/** 发给哪个飞书机器人（名称）。 */
	botName: string;
	source: FeishuMessageSource;
	/** 发起这条消息的运行和任务；投递结果写进这个任务的日志。 */
	runId?: string;
	taskId?: string;
	/** 完整的飞书请求体；文本消息超过 20 KB 时入队时截断正文（{@link truncateTextBody}）。 */
	body: Record<string, unknown>;
	/** 入队时间（控制面时间）。 */
	now: Date;
}

/**
 * 把一条消息写进发送队列（ADR 0020）。必须在调用方的事务里调用，入队和调用方的状态变更同成同败
 * （飞书通知节点：消息入队和节点成功在同一个事务里）。事务提交之后调用 `FeishuDelivery.wake()`
 * 让投递循环马上看到它；不调用也会在下一次周期扫描时投递。
 */
export async function enqueueFeishuMessage(tx: Tx, message: NewFeishuMessage): Promise<void> {
	await tx.insert(feishuMessages).values({
		botName: message.botName,
		source: message.source,
		runId: message.runId ?? null,
		taskId: message.taskId ?? null,
		body: truncateTextBody(message.body),
		enqueuedAt: message.now,
	});
}
