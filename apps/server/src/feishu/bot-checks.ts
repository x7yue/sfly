import { feishuBotNotRegistered } from "@sfly/orchestration";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { feishuBots } from "../db/schema.js";
import type { Tx } from "../engine/step.js";

/** 节点选择的一个飞书机器人（触发时按实际值检查）。 */
export interface BotToCheck {
	nodeId: string;
	/** 「飞书机器人」类型的输入名（#233）；飞书通知节点自己的机器人字段不写。 */
	input?: string;
	bot: string;
	/** 值从哪来（例如「取自入口参数」），写在问题的说明后面的括号里。 */
	source?: string;
}

/** 这些名称里已登记的飞书机器人。触发时的检查、节点执行、`ctx.notify` 和运行通知都用它查，不各写一份。 */
export async function registeredBots(db: Db | Tx, names: readonly string[]): Promise<Set<string>> {
	if (names.length === 0) return new Set();
	const rows = await db
		.select({ name: feishuBots.name })
		.from(feishuBots)
		.where(inArray(feishuBots.name, [...names]));
	return new Set(rows.map((r) => r.name));
}

/** 消息要发给的机器人不存在（还没有登记，或者已被删除）时，消息不发送的原因（中文）；写进任务日志。 */
export const feishuBotGone = (bot: string): string => `飞书机器人「${bot}」还没有登记或已被删除`;

export interface FeishuBotProblem {
	code: "feishu_bot_not_registered";
	message: string;
	node_id: string;
}

/**
 * 被引用的飞书机器人必须已登记（ADR 0020）：触发时按实际值检查（引用入口参数的机器人），
 * 所有引用一次查库。飞书通知节点和「飞书机器人」类型的输入（#233）共用。
 * 常量在保存和触发前由静态检查（@sfly/orchestration 的 feishuBotWarnings）检查。
 */
export async function checkFeishuBots(
	db: Db | Tx,
	references: readonly BotToCheck[],
): Promise<FeishuBotProblem[]> {
	const registered = await registeredBots(db, [...new Set(references.map((r) => r.bot))]);
	return references
		.filter((r) => !registered.has(r.bot))
		.map(({ nodeId, input, bot, source }) => ({
			code: "feishu_bot_not_registered",
			message: `${feishuBotNotRegistered(nodeId, bot, input)}${source === undefined ? "" : `（${source}）`}`,
			node_id: nodeId,
		}));
}
