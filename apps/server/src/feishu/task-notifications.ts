import type { AgentMessage, Notification } from "@sfly/proto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AgentConnection } from "../agents/agent-hub.js";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { tasks } from "../db/schema.js";
import type { TaskLogs } from "../logs/task-logs.js";
import { isUuid } from "../util/uuid.js";
import { feishuBotGone, registeredBots } from "./bot-checks.js";
import type { FeishuDelivery } from "./feishu-delivery.js";
import { enqueueFeishuMessage } from "./feishu-queue.js";
import { rawMessage, textMessage } from "./messages.js";

/**
 * SDK 写进事件管道的通知事件（`Context.notify`，sdk/python/src/sfly/context.py），Agent 原样转发：
 * 发文本的有 `text`（和 `at_all`），发原始消息的有 `message`（完整的飞书请求体，内容由 `rawMessage` 校验）；
 * 两者恰好有一个，同时有或都没有的内容不完整。
 */
const NotifyEvent = z.union([
	z.object({
		bot: z.string(),
		text: z.string(),
		at_all: z.boolean().default(false),
		message: z.never().optional(),
	}),
	z.object({
		bot: z.string(),
		text: z.never().optional(),
		message: z.unknown().refine((message) => message !== undefined),
	}),
]);

/**
 * 节点用 `ctx.notify` 发的飞书通知（ADR 0020）：Agent 从事件管道读到后以 Notification 消息转发过来。
 *
 * - 只接受任务所在 Agent 发来的（与日志相同）；
 * - 机器人必须在任务派发时下发的名单里（`tasks.referenced_feishu_bots`，「飞书机器人」类型的输入引用的机器人），
 *   并且已登记，才写进发送队列；否则在这个任务的日志里写一条 warning，不发送。
 *
 * 请求体由控制面组装，与飞书通知节点用同一套规则（messages.ts）：文本按文本格式组装，原始消息校验后原样发出，
 * 不合格的（不是对象、msg_type 不对、超过 20 KB）在这个任务的日志里写 warning、不发送。投递结果由投递写进这个任务的日志；
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
		const message =
			event.text === undefined
				? rawMessage(event.message)
				: { body: textMessage(event.text, event.at_all) };
		if ("problem" in message) return message.problem;
		return this.deps.db.transaction(async (tx) => {
			if (!(await registeredBots(tx, [event.bot])).has(event.bot)) return feishuBotGone(event.bot);
			await enqueueFeishuMessage(tx, {
				botName: event.bot,
				source: "notify",
				runId,
				taskId: notification.taskId,
				body: message.body,
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
