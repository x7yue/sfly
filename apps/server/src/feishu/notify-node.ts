import {
	FEISHU_BODY_LIMIT_LABEL,
	type FeishuNotifyNode,
	feishuReferableInputs,
	InvalidReferenceError,
	type ResolveScope,
	resolveInputs,
} from "@sfly/orchestration";
import { markdownCard, rawMessage, textMessage } from "./messages.js";

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

/** 当前格式的配置里不含引用的部分（解析前后都一样）。 */
function plainConfig(node: FeishuNotifyNode): Record<string, unknown> {
	switch (node.format) {
		case "text":
			return { at_all: node.at_all };
		case "card":
			return { color: node.color };
		case "raw":
			return {};
	}
}

/** 文字字段解析后的值转成字符串；引用解析出对象或数组时返回原因：文字只能由字符串和标量拼成。 */
function textOf(value: unknown, field: string): { text: string } | { problem: string } {
	if (value !== null && typeof value === "object") {
		return { problem: `${field}里的引用解析出了对象或数组，${field}只能由字符串和标量拼成` };
	}
	return { text: String(value) };
}

/**
 * 解析飞书通知节点的输入并组装请求体（docs/SEMANTICS.md §1.3、§4.2）。只处理当前格式的字段；
 * 引用一律按 always 节点的规则解析（调用方传 `missingAsNull` 的作用域）：缺失的输出取 null，内嵌在文字里显示为 `null`。
 * 解析或组装出错（引用无效、机器人的值不是字符串、文字里解析出对象、原始消息不合格……）不抛出，
 * 返回 `ok: false` 和原因：通知永远不会成为节点失败的原因。
 */
export function prepareNotification(
	node: FeishuNotifyNode,
	scope: ResolveScope,
): PreparedNotification {
	const referable = feishuReferableInputs(node);
	const raw = {
		bot: node.bot ?? null,
		format: node.format,
		...referable,
		...plainConfig(node),
	};
	if (node.bot === undefined) return { ok: false, problem: "没有选择飞书机器人", inputs: raw };
	let resolved: Record<string, unknown>;
	try {
		resolved = resolveInputs({ bot: node.bot, ...referable }, scope);
	} catch (error) {
		if (!(error instanceof InvalidReferenceError)) throw error;
		return { ok: false, problem: `引用无效：${error.message}`, inputs: raw };
	}
	const { bot, ...fields } = resolved;
	if (typeof bot !== "string" || bot === "") {
		return {
			ok: false,
			problem: `机器人的值不是飞书机器人的名称（${show(bot)}）`,
			inputs: { ...raw, bot: bot ?? null },
		};
	}
	const failed = (problem: string): PreparedNotification => ({
		ok: false,
		problem,
		inputs: { ...raw, bot },
	});
	const sent = (inputs: Record<string, unknown>, body: Record<string, unknown>) =>
		({ ok: true, bot, inputs: { bot, format: node.format, ...inputs }, body }) as const;

	switch (node.format) {
		case "text": {
			const text = textOf(fields.text, "文本");
			if ("problem" in text) return failed(text.problem);
			return sent({ text: text.text, at_all: node.at_all }, textMessage(text.text, node.at_all));
		}
		case "card": {
			const title = textOf(fields.title, "标题");
			if ("problem" in title) return failed(title.problem);
			const markdown = textOf(fields.markdown, "正文");
			if ("problem" in markdown) return failed(markdown.problem);
			const card = markdownCard(title.text, markdown.text, node.color);
			if ("error" in card) {
				return failed(
					`标题太长，连截断后的正文都放不下，整张卡片超过飞书请求体 ${FEISHU_BODY_LIMIT_LABEL} 的上限`,
				);
			}
			return sent({ title: title.text, color: node.color, markdown: markdown.text }, card.body);
		}
		case "raw": {
			if (node.message === undefined) return failed("还没有填写原始消息");
			const message = rawMessage(fields.message);
			if ("problem" in message) return failed(message.problem);
			return sent({ message: message.body }, message.body);
		}
	}
}
