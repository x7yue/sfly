import { feishuBotNotRegistered } from "@sfly/orchestration";
import { inArray } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { feishuBots } from "../db/schema.js";
import type { Tx } from "../engine/step.js";

/** 节点选择的一个飞书机器人（触发时按实际值检查）。 */
export interface FeishuBotReference {
	nodeId: string;
	/** 「飞书机器人」类型的输入名（#233）；飞书通知节点自己的机器人字段不写。 */
	input?: string;
	bot: string;
	/** 值从哪来（例如「取自入口参数」），写在问题的说明后面的括号里。 */
	source?: string;
}

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
	references: readonly FeishuBotReference[],
): Promise<FeishuBotProblem[]> {
	const names = [...new Set(references.map((r) => r.bot))];
	if (names.length === 0) return [];
	const registered = new Set(
		(
			await db
				.select({ name: feishuBots.name })
				.from(feishuBots)
				.where(inArray(feishuBots.name, names))
		).map((r) => r.name),
	);
	return references
		.filter((r) => !registered.has(r.bot))
		.map(({ nodeId, input, bot, source }) => ({
			code: "feishu_bot_not_registered",
			message: `${feishuBotNotRegistered(nodeId, bot, input)}${source === undefined ? "" : `（${source}）`}`,
			node_id: nodeId,
		}));
}
