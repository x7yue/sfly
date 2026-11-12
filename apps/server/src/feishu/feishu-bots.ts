import type { FeishuBotView, FeishuTestResult } from "@sfly/schema";
import { asc, eq } from "drizzle-orm";
import type { Clock } from "../clock.js";
import type { Db } from "../db/database.js";
import { feishuBots } from "../db/schema.js";
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
}

export type CreateFeishuBotResult = { kind: "created"; bot: FeishuBot } | { kind: "name_taken" };

/** 接口返回的形式：Webhook 地址打码。 */
export const toFeishuBotView = (bot: FeishuBot): FeishuBotView => ({
	name: bot.name,
	webhook_url: maskWebhookUrl(bot.webhookUrl),
	created_at: bot.createdAt.toISOString(),
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
});

/** 飞书机器人的存取。名称是主键：全局唯一，不能修改。 */
export class FeishuBots {
	constructor(private readonly deps: { db: Db; clock: Clock }) {}

	async list(): Promise<FeishuBot[]> {
		const rows = await this.deps.db.select().from(feishuBots).orderBy(asc(feishuBots.name));
		return rows.map(toBot);
	}

	async get(name: string): Promise<FeishuBot | undefined> {
		const [row] = await this.deps.db.select().from(feishuBots).where(eq(feishuBots.name, name));
		return row && toBot(row);
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

	/** 删除；机器人不存在时返回 false。 */
	async remove(name: string): Promise<boolean> {
		const rows = await this.deps.db
			.delete(feishuBots)
			.where(eq(feishuBots.name, name))
			.returning({ name: feishuBots.name });
		return rows.length > 0;
	}
}
