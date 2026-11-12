/**
 * 飞书消息的请求体组装（ADR 0020）。三种来源（飞书通知节点、`ctx.notify`、运行通知）共用这里的规则。
 * Markdown 卡片的规则与 SDK 的 `sfly.feishu.card` 一致，共用 `testdata/feishu-card-cases.json` 里的用例。
 */
import type { OrchestrationNode } from "@sfly/schema";

/** 「@所有人」：飞书文本消息里的写法。 */
export const AT_ALL = '<at user_id="all">所有人</at>';

/** 飞书请求体的大小上限：紧凑 JSON 按 UTF-8 编码的字节数（官方说明「不能超过 20 KB」）。 */
export const FEISHU_BODY_LIMIT_BYTES = 20 * 1024;

/** 正文被截断时接在末尾的标记。 */
export const TRUNCATED_MARK = "…（已截断）";

/** 请求体序列化之后（实际发出去的样子）的字节数。 */
export const bodyBytes = (body: unknown): number => Buffer.byteLength(JSON.stringify(body), "utf8");

/**
 * 文本消息（`msg_type: text`）。`atAll` 打开时在正文末尾追加 {@link AT_ALL}；
 * 用户自己写在正文里的 at 标签原样保留。
 */
export function textMessage(
	text: string,
	atAll: boolean,
): { msg_type: "text"; content: { text: string } } {
	return { msg_type: "text", content: { text: atAll ? `${text}${AT_ALL}` : text } };
}

export type CardColor = Extract<OrchestrationNode, { kind: "feishu_notify" }>["color"];

/** Markdown 卡片（`msg_type: interactive`，卡片 JSON 2.0）：header 是标题加颜色模板，body 是一个 markdown 元素。 */
export type CardMessage = {
	msg_type: "interactive";
	card: {
		schema: "2.0";
		header: { title: { tag: "plain_text"; content: string }; template: CardColor };
		body: { elements: [{ tag: "markdown"; content: string }] };
	};
};

const card = (title: string, markdown: string, color: CardColor): CardMessage => ({
	msg_type: "interactive",
	card: {
		schema: "2.0",
		header: { title: { tag: "plain_text", content: title }, template: color },
		body: { elements: [{ tag: "markdown", content: markdown }] },
	},
});

/**
 * Markdown 卡片。标题和正文照原样放进去，空字符串也照常组装。请求体超过 {@link FEISHU_BODY_LIMIT_BYTES} 时截断正文：
 * 留下最长的、放得下的前缀（按 Unicode 字符，不把一个字符切成两半），末尾接上 {@link TRUNCATED_MARK}；
 * 标题太长，连空前缀加标记都放不下时无法组装（`too_large`）。
 * 规则的细节和用例见 `testdata/feishu-card-cases.json`。
 */
export function markdownCard(
	title: string,
	markdown: string,
	color: CardColor,
): { body: CardMessage } | { error: "too_large" } {
	const whole = card(title, markdown, color);
	if (bodyBytes(whole) <= FEISHU_BODY_LIMIT_BYTES) return { body: whole };
	// 每个字符至少占一个字节，放得下的前缀不会超过上限的字符数：正文再长也只看开头这一段。
	const chars: string[] = [];
	for (const char of markdown) {
		chars.push(char);
		if (chars.length >= FEISHU_BODY_LIMIT_BYTES) break;
	}
	const cut = (n: number) => card(title, chars.slice(0, n).join("") + TRUNCATED_MARK, color);
	const fits = (n: number) => bodyBytes(cut(n)) <= FEISHU_BODY_LIMIT_BYTES;
	if (!fits(0)) return { error: "too_large" };
	// 前缀越长请求体越大，二分找出放得下的最长前缀。
	let [low, high] = [0, chars.length];
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(mid)) low = mid;
		else high = mid - 1;
	}
	return { body: cut(low) };
}

/** 飞书自定义机器人接受的 `msg_type`。 */
const MSG_TYPES = ["text", "post", "image", "share_chat", "interactive"];

/**
 * 原始消息：完整的飞书请求体，原样发出。只校验它是一个对象、`msg_type` 是飞书支持的类型、不超过
 * {@link FEISHU_BODY_LIMIT_BYTES}（不截断：截断会弄坏结构）；不合格时给出原因（中文），消息不发送。
 */
export function rawMessage(
	value: unknown,
): { body: Record<string, unknown> } | { problem: string } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return { problem: "原始消息不是一个对象，需要完整的飞书请求体（JSON 对象）" };
	}
	const body = value as Record<string, unknown>;
	if (typeof body.msg_type !== "string" || !MSG_TYPES.includes(body.msg_type)) {
		return {
			problem: `原始消息的 msg_type 必须是 ${MSG_TYPES.join("、")} 之一（现在是 ${JSON.stringify(body.msg_type) ?? "没有"}）`,
		};
	}
	const size = bodyBytes(body);
	if (size > FEISHU_BODY_LIMIT_BYTES) {
		return {
			problem: `原始消息有 ${(size / 1024).toFixed(1)} KB，超过飞书请求体 20 KB 的上限；原始消息不截断`,
		};
	}
	return { body };
}
