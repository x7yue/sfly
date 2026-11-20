import { feishuBotNotRegistered } from "@sfly/orchestration";
import { inArray } from "drizzle-orm";
import type { Db, Tx } from "../db/database.js";
import { feishuBots } from "../db/schema.js";

/** 节点的输入选择的一个飞书机器人（触发时按实际值检查）。 */
export interface BotToCheck {
	nodeId: string;
	/** 问题的说明里节点的写法：「显示名称（节点 ID）」（`nodeNameWithId`）。 */
	node: string;
	/** 「飞书机器人」类型的输入名（#233）。 */
	input: string;
	bot: string;
	/**
	 * 问题的说明里这个机器人名称的写法，不给时写 `bot`。值取自 secret 参数时调用方传打了码的写法：
	 * 触发时的错误不回显 secret 参数的值（docs/SEMANTICS.md §2.1）。
	 */
	shown?: string;
	/** 值从哪来（例如「取自入口参数」），写在问题的说明后面的括号里。 */
	source?: string;
}

/** 这些名称里已登记的飞书机器人。触发时的检查、`ctx.notify` 和运行通知都用它查，不各写一份。 */
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
 * 所有引用一次查库。「飞书机器人」类型的输入（#233）用它。
 * 常量在保存和触发前由静态检查（@sfly/orchestration 的 feishuBotInputWarnings）检查。
 */
export async function checkFeishuBots(
	db: Db | Tx,
	references: readonly BotToCheck[],
): Promise<FeishuBotProblem[]> {
	const registered = await registeredBots(db, [...new Set(references.map((r) => r.bot))]);
	return references
		.filter((r) => !registered.has(r.bot))
		.map(({ nodeId, node, input, bot, shown = bot, source }) => ({
			code: "feishu_bot_not_registered",
			message: `${feishuBotNotRegistered(node, shown, input)}${source === undefined ? "" : `（${source}）`}`,
			node_id: nodeId,
		}));
}
