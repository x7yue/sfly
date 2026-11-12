import type { AgentMessage, Notification } from "@sfly/proto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AgentConnection } from "../agents/agent-hub.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { feishuBots, tasks } from "../db/schema.js";
import type { TaskLogs } from "../logs/task-logs.js";
import { isUuid } from "../util/uuid.js";
import type { FeishuDelivery } from "./feishu-delivery.js";
import { enqueueFeishuMessage } from "./feishu-queue.js";
import { textMessage } from "./messages.js";

/** SDK 写进事件管道的通知事件（`Context.notify`，sdk/python/src/sfly/context.py），Agent 原样转发。 */
const NotifyEvent = z.object({
	bot: z.string(),
	text: z.string(),
	at_all: z.boolean().default(false),
});

/**
 * 节点用 `ctx.notify` 发的飞书通知（ADR 0020）：Agent 从事件管道读到后以 Notification 消息转发过来。
 *
 * - 只接受任务所在 Agent 发来的（与日志相同）；
 * - 机器人必须在任务派发时下发的名单里（`tasks.referenced_feishu_bots`，「飞书机器人」类型的输入引用的机器人），
 *   并且已登记，才写进发送队列；否则在这个任务的日志里写一条 warning，不发送。
 *
 * 请求体由控制面组装，与飞书通知节点用同一套规则（messages.ts）。投递结果由投递写进这个任务的日志；
 * 不经过引擎、不改变任何状态，通知不会让任务失败。
 */
export class TaskNotifications {
	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			logs: Pick<TaskLogs, "appendSystem">;
			delivery: Pick<FeishuDelivery, "wake">;
		},
	) {}

	handles(message: AgentMessage): boolean {
		return message.body.case === "notification";
	}

	async onMessage(conn: AgentConnection, message: AgentMessage): Promise<void> {
		if (message.body.case !== "notification") return;
		const notification = message.body.value;
		if (!isUuid(notification.taskId)) return;
		const [task] = await this.deps.db
			.select({
				runId: tasks.runId,
				agentName: tasks.agentName,
				bots: tasks.referencedFeishuBots,
			})
			.from(tasks)
			.where(eq(tasks.id, notification.taskId));
		if (task?.agentName !== conn.name) return;
		const problem = await this.#enqueue(notification, task.runId, task.bots);
		if (problem === undefined) this.deps.delivery.wake();
		else
			await this.deps.logs.appendSystem(
				notification.taskId,
				"warn",
				`ctx.notify 的消息没有发送：${problem}`,
			);
	}

	/** 校验并写进发送队列；不能发送时返回原因。 */
	async #enqueue(
		notification: Notification,
		runId: string,
		referenced: readonly string[],
	): Promise<string | undefined> {
		const event = parseEvent(notification.eventJson);
		if (!event) return "通知的内容不完整或格式不对";
		if (!referenced.includes(event.bot)) {
			return `飞书机器人「${event.bot}」不是通过「飞书机器人」类型的参数传给这个节点的，把它声明成 sfly.FeishuBot 类型的参数`;
		}
		return this.deps.db.transaction(async (tx) => {
			const [bot] = await tx
				.select({ name: feishuBots.name })
				.from(feishuBots)
				.where(eq(feishuBots.name, event.bot));
			if (!bot) return `飞书机器人「${event.bot}」还没有登记或已被删除`;
			await enqueueFeishuMessage(tx, {
				botName: event.bot,
				source: "notify",
				runId,
				taskId: notification.taskId,
				body: textMessage(event.text, event.at_all),
				now: this.deps.clock.now(),
			});
			return undefined;
		});
	}
}

function parseEvent(json: string): z.infer<typeof NotifyEvent> | undefined {
	try {
		const parsed = NotifyEvent.safeParse(JSON.parse(json));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}
