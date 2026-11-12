import type { OrchestrationDocument } from "@sfly/schema";
import { referencesIn } from "./references.js";

/**
 * 飞书机器人（ADR 0020）的静态检查：节点选的机器人必须已登记。
 *
 * - 常量名称不是已登记的机器人：保存时警告，触发时阻断（{@link feishuBotWarnings}）；
 * - 含引用的值（整值引用入口参数）在触发时按实际值检查，节点执行时再看一次（控制面）；
 * - 登记情况来自控制面的机器人列表，不知道时（例如画布还在加载）只检查有没有选择。
 *
 * 其他引用机器人的地方（「飞书机器人」类型的输入，#233）复用 {@link feishuBotNotRegistered} 的说明。
 */

export interface FeishuBotWarning {
	code: "feishu_bot_not_registered" | "feishu_bot_unset";
	message: string;
	node_id: string;
	/** 警告所指的字段，检查器显示在字段下面。 */
	input: string;
}

/**
 * 选择的机器人没有登记过时的说明（静态检查、触发时按实际值检查共用）。
 * `input` 是节点的输入名（「飞书机器人」类型的输入）；飞书通知节点自己的机器人字段不写。
 */
export function feishuBotNotRegistered(nodeId: string, bot: string, input?: string): string {
	const where = input === undefined ? `节点 ${nodeId}` : `节点 ${nodeId} 的输入 ${input}`;
	return `${where} 选择的飞书机器人「${bot}」还没有登记`;
}

/** 飞书通知节点还没有选择机器人时的说明。 */
export const feishuBotUnset = (nodeId: string): string => `节点 ${nodeId} 没有选择飞书机器人`;

/**
 * 飞书通知节点的机器人检查：没有选择；常量不是已登记的机器人（`bots`：已登记的机器人名称）。
 * 含引用的值在触发、执行时才知道。`bots` 为 undefined 时不检查登记情况。
 */
export function feishuBotWarnings(
	doc: OrchestrationDocument,
	bots?: ReadonlySet<string>,
): FeishuBotWarning[] {
	const warnings: FeishuBotWarning[] = [];
	for (const node of doc.nodes) {
		if (node.kind !== "feishu_notify") continue;
		if (node.bot === undefined) {
			warnings.push({
				code: "feishu_bot_unset",
				message: feishuBotUnset(node.id),
				node_id: node.id,
				input: "bot",
			});
		} else if (bots && referencesIn(node.bot).length === 0 && !bots.has(node.bot)) {
			warnings.push({
				code: "feishu_bot_not_registered",
				message: feishuBotNotRegistered(node.id, node.bot),
				node_id: node.id,
				input: "bot",
			});
		}
	}
	return warnings;
}
