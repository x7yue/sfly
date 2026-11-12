import { InvalidReferenceError, type ResolveScope, resolveInputs } from "@sfly/orchestration";
import type { OrchestrationNode } from "@sfly/schema";
import { textMessage } from "./messages.js";

type FeishuNotifyNode = Extract<OrchestrationNode, { kind: "feishu_notify" }>;

/** 飞书通知节点轮到执行时，解析输入、组装请求体的结果。 */
export type PreparedNotification =
	| {
			ok: true;
			bot: string;
			/** 记在任务上的输入：解析后的配置。 */
			inputs: Record<string, unknown>;
			body: Record<string, unknown>;
	  }
	| {
			ok: false;
			/** 为什么不能发送（中文）；节点照常成功，这句话写进节点日志。 */
			problem: string;
			inputs: Record<string, unknown>;
	  };

const show = (value: unknown) => JSON.stringify(value) ?? String(value);

/**
 * 解析飞书通知节点的输入并组装请求体（docs/SEMANTICS.md §1.3）。引用一律按 always 节点的规则解析
 * （调用方传 `missingAsNull` 的作用域）：缺失的输出取 null，内嵌在文字里显示为 `null`。
 * 解析或组装出错（引用无效、机器人的值不是字符串、文本解析出对象……）不抛出，返回 `ok: false` 和原因：
 * 通知永远不会成为节点失败的原因。
 */
export function prepareNotification(
	node: FeishuNotifyNode,
	scope: ResolveScope,
): PreparedNotification {
	const raw = { bot: node.bot ?? null, text: node.text, at_all: node.at_all };
	if (node.bot === undefined) return { ok: false, problem: "没有选择飞书机器人", inputs: raw };
	let resolved: { bot?: unknown; text?: unknown };
	try {
		resolved = resolveInputs({ bot: node.bot, text: node.text }, scope);
	} catch (error) {
		if (!(error instanceof InvalidReferenceError)) throw error;
		return { ok: false, problem: `引用无效：${error.message}`, inputs: raw };
	}
	const { bot, text } = resolved;
	if (typeof bot !== "string" || bot === "") {
		return {
			ok: false,
			problem: `机器人的值不是飞书机器人的名称（${show(bot)}）`,
			inputs: { ...raw, bot: bot ?? null },
		};
	}
	if (text !== null && typeof text === "object") {
		return {
			ok: false,
			problem: "文本里的引用解析出了对象或数组，文本只能由字符串和标量拼成",
			inputs: { ...raw, bot },
		};
	}
	const finalText = String(text);
	return {
		ok: true,
		bot,
		inputs: { bot, text: finalText, at_all: node.at_all },
		body: textMessage(finalText, node.at_all),
	};
}
