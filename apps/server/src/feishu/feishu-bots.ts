import type { FeishuBotView, FeishuTestResult } from "@sfly/schema";
import { and, asc, count, eq } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { feishuBots, feishuMessages } from "../db/schema.js";
import type { TaskLogs } from "../logs/task-logs.js";
import { discardNote, logDiscards } from "./discards.js";
import type { FeishuSendResult } from "./feishu-client.js";
import { maskWebhookUrl } from "./webhook-url.js";

/**
 * 一个飞书机器人（ADR 0020）。`webhookUrl` 是完整地址（相当于凭据），只在控制面内部用来发请求；
 * 对外一律用 {@link toFeishuBotView} 打码。
 */
export interface FeishuBot {
	name: string;
	webhookUrl: string;
	createdAt: Date;
	/** 最近一次投递（每发一次请求记一次）；还没有投递过时为 null。 */
	lastDelivery: { at: Date; ok: boolean; message: string | null } | null;
}

export type CreateFeishuBotResult = { kind: "created"; bot: FeishuBot } | { kind: "name_taken" };

/** 接口返回的形式：Webhook 地址打码；`backlog` 是这个机器人还在排队的消息条数。 */
export const toFeishuBotView = (bot: FeishuBot, backlog: number): FeishuBotView => ({
	name: bot.name,
	webhook_url: maskWebhookUrl(bot.webhookUrl),
	created_at: bot.createdAt.toISOString(),
	last_delivery: bot.lastDelivery && {
		at: bot.lastDelivery.at.toISOString(),
		ok: bot.lastDelivery.ok,
		message: bot.lastDelivery.message,
	},
	backlog,
});

/** 固定的测试消息：文本里带「sfly」，机器人用关键词校验时可以把它设为关键词。 */
export const testMessage = (name: string) => ({
	msg_type: "text",
	content: { text: `sfly 测试消息：飞书机器人「${name}」已连通，这条消息由控制面发出。` },
});

/** 测试消息的发送结果，翻译成接口返回的形式。 */
export const toTestResult = (result: FeishuSendResult): FeishuTestResult =>
	result.ok
		? {
				ok: true,
				message: "测试消息已送达",
				next_step: null,
				feishu_code: null,
				http_status: result.httpStatus,
			}
		: {
				ok: false,
				message: result.failure.reason,
				next_step: result.failure.nextStep,
				feishu_code: result.failure.code,
				http_status: result.failure.httpStatus,
			};

type FeishuBotRow = typeof feishuBots.$inferSelect;
const toBot = (row: FeishuBotRow): FeishuBot => ({
	name: row.name,
	webhookUrl: row.webhookUrl,
	createdAt: row.createdAt,
	lastDelivery:
		row.lastDeliveryAt === null || row.lastDeliveryOk === null
			? null
			: { at: row.lastDeliveryAt, ok: row.lastDeliveryOk, message: row.lastDeliveryError },
});

/** 飞书机器人的存取。名称是主键：全局唯一，不能修改。 */
export class FeishuBots {
	constructor(
		private readonly deps: {
			db: Db;
			clock: Clock;
			/** 删除机器人时，丢弃的消息的结果写进发起它们的任务的日志。 */
			logs: Pick<TaskLogs, "appendSystem">;
			/** 写日志失败时调用：删除已经完成，不能因此让请求失败。 */
			onError: (error: unknown) => void;
		},
	) {}

	async list(): Promise<FeishuBot[]> {
		const rows = await this.deps.db.select().from(feishuBots).orderBy(asc(feishuBots.name));
		return rows.map(toBot);
	}

	async get(name: string): Promise<FeishuBot | undefined> {
		const [row] = await this.deps.db.select().from(feishuBots).where(eq(feishuBots.name, name));
		return row && toBot(row);
	}

	/** 每个机器人还在排队的消息条数（没有排队消息的机器人不在里面）。 */
	async backlogs(): Promise<Map<string, number>> {
		const rows = await this.deps.db
			.select({ bot: feishuMessages.botName, queued: count() })
			.from(feishuMessages)
			.where(eq(feishuMessages.status, "queued"))
			.groupBy(feishuMessages.botName);
		return new Map(rows.map((row) => [row.bot, row.queued]));
	}

	/** 这个机器人还在排队的消息条数。 */
	async backlog(name: string): Promise<number> {
		return (await this.backlogs()).get(name) ?? 0;
	}

	async create(name: string, webhookUrl: string): Promise<CreateFeishuBotResult> {
		const [row] = await this.deps.db
			.insert(feishuBots)
			.values({ name, webhookUrl, createdAt: this.deps.clock.now() })
			.onConflictDoNothing()
			.returning();
		return row ? { kind: "created", bot: toBot(row) } : { kind: "name_taken" };
	}

	/** 整个替换 Webhook 地址；机器人不存在时返回 undefined。 */
	async replaceWebhookUrl(name: string, webhookUrl: string): Promise<FeishuBot | undefined> {
		const [row] = await this.deps.db
			.update(feishuBots)
			.set({ webhookUrl })
			.where(eq(feishuBots.name, name))
			.returning();
		return row && toBot(row);
	}

	/**
	 * 删除；机器人不存在时返回 false。它还没有投递的消息在同一个事务里记为「已丢弃：机器人已删除」，
	 * 提交之后把结果写进发起它们的任务的日志。
	 */
	async remove(name: string): Promise<boolean> {
		const discarded = await this.deps.db.transaction(async (tx) => {
			const removed = await tx
				.delete(feishuBots)
				.where(eq(feishuBots.name, name))
				.returning({ name: feishuBots.name });
			if (removed.length === 0) return undefined;
			return tx
				.update(feishuMessages)
				.set({
					status: "discarded",
					lastError: discardNote("bot_removed", name),
					nextAttemptAt: null,
					finishedAt: this.deps.clock.now(),
				})
				.where(and(eq(feishuMessages.botName, name), eq(feishuMessages.status, "queued")))
				.returning({ taskId: feishuMessages.taskId });
		});
		if (discarded === undefined) return false;
		await logDiscards(this.deps.logs, discarded, "bot_removed", name).catch(this.deps.onError);
		return true;
	}
}
