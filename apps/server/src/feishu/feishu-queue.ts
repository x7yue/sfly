import { sql } from "drizzle-orm";
import { type FeishuMessageSource, feishuMessages } from "../db/schema.js";
import type { Tx } from "../engine/step.js";

/** 要写进发送队列的一条消息。 */
export interface NewFeishuMessage {
	/** 发给哪个飞书机器人（名称）。 */
	botName: string;
	source: FeishuMessageSource;
	/** 发起这条消息的运行和任务；投递结果写进这个任务的日志。 */
	runId?: string;
	taskId?: string;
	/** 完整的飞书请求体。 */
	body: Record<string, unknown>;
	/** 入队时间（控制面时间）。 */
	now: Date;
}

/**
 * 把一条消息写进发送队列（ADR 0020）。必须在调用方的事务里调用，入队和调用方的状态变更同成同败
 * （飞书通知节点：消息入队和节点成功在同一个事务里）。事务提交之后调用 `FeishuDelivery.wake()`
 * 让投递循环马上看到它；不调用也会在下一次周期扫描时投递。
 *
 * 同一个机器人的消息按提交的先后投递：`seq` 在 INSERT 时分配，投递取最小的可见 `seq`，所以后分配 `seq` 的消息
 * 不能比先分配的先提交。引擎在 step 的事务里入队（持有引擎的互斥锁），`ctx.notify` 在自己的事务里入队（不经过引擎），
 * 两者会并发。入队前先拿这个机器人的事务级咨询锁，到事务结束才释放：同一个机器人的入队事务一个接一个，
 * `seq` 的顺序就是提交的顺序；不同机器人的锁不同，互不等待。
 *
 * 一个事务可以给几个机器人入队（引擎的 step 一路推进几个飞书通知节点），锁按遇到的顺序拿，没法事先排序。
 * 不会死锁：同时拿多把锁的只有引擎的 step，它们被引擎的互斥锁串行化；其余入队（`ctx.notify`）的事务只拿一把锁，
 * 拿到之后不再等任何锁，所以不存在互相等待的环。
 */
export async function enqueueFeishuMessage(tx: Tx, message: NewFeishuMessage): Promise<void> {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${`sfly:feishu_messages:${message.botName}`}, 0))`,
	);
	await tx.insert(feishuMessages).values({
		botName: message.botName,
		source: message.source,
		runId: message.runId ?? null,
		taskId: message.taskId ?? null,
		body: message.body,
		enqueuedAt: message.now,
	});
}
