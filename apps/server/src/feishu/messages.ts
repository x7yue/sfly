/**
 * 飞书消息的请求体组装（ADR 0020）。三种来源（飞书通知节点、`ctx.notify`、运行通知）共用这里的规则。
 * 文本消息的截断、Markdown 卡片和原始消息的校验与 SDK（`sfly.feishu`）一致，共用 `testdata/feishu-*-cases.json` 里的用例。
 */
import {
	FEISHU_BODY_LIMIT_BYTES,
	FEISHU_BODY_LIMIT_LABEL,
	FEISHU_MSG_TYPES,
} from "@sfly/orchestration";
import type { OrchestrationNode } from "@sfly/schema";

/** 「@所有人」：飞书文本消息里的写法。 */
export const AT_ALL = '<at user_id="all">所有人</at>';

/** 正文被截断时接在末尾的标记。 */
export const TRUNCATED_MARK = "…（已截断）";

/** 请求体序列化之后（实际发出去的样子）的字节数。 */
export const bodyBytes = (body: unknown): number => Buffer.byteLength(JSON.stringify(body), "utf8");

/**
 * 请求体里有一段可以截断的文本（`text`：文本消息的正文、Markdown 卡片的正文、运行通知的附加说明）：`build` 用给定的文本
 * 组装整个请求体。整个请求体超过 {@link FEISHU_BODY_LIMIT_BYTES} 时截断这段文本：留下最长的、放得下的前缀
 * （按 Unicode 字符，不把一个字符切成两半），末尾接上 {@link TRUNCATED_MARK}。
 * 其余部分太大，连空前缀加标记都放不下时返回 undefined。文本消息、卡片和 SDK 本地调试（`sfly.feishu`）用同一条规则。
 */
export function fitToLimit<T>(text: string, build: (text: string) => T): T | undefined {
	const whole = build(text);
	if (bodyBytes(whole) <= FEISHU_BODY_LIMIT_BYTES) return whole;
	// 每个字符至少占一个字节，放得下的前缀不会超过上限的字符数：文本再长也只看开头这一段。
	const chars: string[] = [];
	for (const char of text) {
		chars.push(char);
		if (chars.length >= FEISHU_BODY_LIMIT_BYTES) break;
	}
	const cut = (n: number) => build(chars.slice(0, n).join("") + TRUNCATED_MARK);
	const fits = (n: number) => bodyBytes(cut(n)) <= FEISHU_BODY_LIMIT_BYTES;
	if (!fits(0)) return undefined;
	// 前缀越长请求体越大，二分找出放得下的最长前缀。
	let [low, high] = [0, chars.length];
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (fits(mid)) low = mid;
		else high = mid - 1;
	}
	return cut(low);
}

/**
 * 文本消息（`msg_type: text`）。`atAll` 打开时在正文末尾追加 {@link AT_ALL}；用户自己写在正文里的 at 标签原样保留。
 * 请求体超过 {@link FEISHU_BODY_LIMIT_BYTES} 时截断正文（{@link fitToLimit}）；「@所有人」仍留在最后，截断不能让重要的提醒丢掉。
 * 发文本格式的消息一律经过这里，原始消息（`rawMessage`）不截断。
 * 规则的细节和用例见 `testdata/feishu-text-cases.json`。
 */
export function textMessage(
	text: string,
	atAll: boolean,
): { msg_type: "text"; content: { text: string } } {
	const tail = atAll ? AT_ALL : "";
	const fitted = fitToLimit(text, (kept) => ({
		msg_type: "text" as const,
		content: { text: `${kept}${tail}` },
	}));
	// 空正文加截断标记和「@所有人」总是放得下（后面接的只有定长的 AT_ALL）。
	if (fitted === undefined) throw new Error("文本消息连空正文加截断标记都放不下");
	return fitted;
}

export type CardColor = Extract<OrchestrationNode, { kind: "feishu_notify" }>["color"];

/** 卡片 JSON 2.0 里平台用到的元素：markdown 和打开链接的按钮。 */
export type CardElement =
	| { tag: "markdown"; content: string }
	| {
			tag: "button";
			text: { tag: "plain_text"; content: string };
			type: "primary" | "default";
			behaviors: [{ type: "open_url"; default_url: string }];
	  };

/** 卡片的 header：标题、可选的副标题和颜色模板。 */
export interface CardHeader {
	title: string;
	subtitle?: string;
	color: CardColor;
}

/** 卡片消息（`msg_type: interactive`，卡片 JSON 2.0）。 */
export type CardMessage = {
	msg_type: "interactive";
	card: {
		schema: "2.0";
		header: {
			title: { tag: "plain_text"; content: string };
			subtitle?: { tag: "plain_text"; content: string };
			template: CardColor;
		};
		body: { elements: CardElement[] };
	};
};

/** 卡片的组装规则：header 加一组 body 元素。Markdown 卡片和运行通知共用，不各写一份。 */
export const interactiveCard = (
	{ title, subtitle, color }: CardHeader,
	elements: CardElement[],
): CardMessage => ({
	msg_type: "interactive",
	card: {
		schema: "2.0",
		header: {
			title: { tag: "plain_text", content: title },
			...(subtitle === undefined ? {} : { subtitle: { tag: "plain_text", content: subtitle } }),
			template: color,
		},
		body: { elements },
	},
});

/**
 * 卡片里有一段可以截断的文本（`text`，Markdown 卡片的正文、运行通知的附加说明）：`build` 用给定的文本组装整张卡片，
 * 请求体超过 {@link FEISHU_BODY_LIMIT_BYTES} 时截断这段文本（{@link fitToLimit}）；其余部分太大，
 * 连空前缀加标记都放不下时无法组装（`too_large`）。
 */
export function fitCard(
	text: string,
	build: (text: string) => CardMessage,
): { body: CardMessage } | { error: "too_large" } {
	const body = fitToLimit(text, build);
	return body === undefined ? { error: "too_large" } : { body };
}

/**
 * Markdown 卡片。标题和正文照原样放进去，空字符串也照常组装；请求体太大时截断正文（{@link fitCard}）。
 * 规则的细节和用例见 `testdata/feishu-card-cases.json`。
 */
export const markdownCard = (
	title: string,
	markdown: string,
	color: CardColor,
): { body: CardMessage } | { error: "too_large" } =>
	fitCard(markdown, (content) => interactiveCard({ title, color }, [{ tag: "markdown", content }]));

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
	if (
		typeof body.msg_type !== "string" ||
		!(FEISHU_MSG_TYPES as readonly string[]).includes(body.msg_type)
	) {
		return {
			problem: `原始消息的 msg_type 必须是 ${FEISHU_MSG_TYPES.join("、")} 之一（现在是 ${JSON.stringify(body.msg_type) ?? "没有"}）`,
		};
	}
	const size = bodyBytes(body);
	if (size > FEISHU_BODY_LIMIT_BYTES) {
		return {
			problem: `原始消息有 ${(size / 1024).toFixed(1)} KB，超过飞书请求体 ${FEISHU_BODY_LIMIT_LABEL} 的上限；原始消息不截断`,
		};
	}
	return { body };
}
