/**
 * 飞书消息的请求体组装（ADR 0020）。`ctx.notify` 和运行通知共用这里的规则。
 * 文本消息的截断和原始消息的校验与 SDK（`sfly.feishu`）一致，共用 `testdata/feishu-*-cases.json` 里的用例。
 */
import {
	FEISHU_BODY_LIMIT_BYTES,
	FEISHU_BODY_LIMIT_LABEL,
	FEISHU_MSG_TYPES,
} from "@sfly/orchestration";

/** 「@所有人」：飞书文本消息里的写法。 */
export const AT_ALL = '<at user_id="all">所有人</at>';

/** 正文被截断时接在末尾的标记。 */
export const TRUNCATED_MARK = "…（已截断）";

/** 请求体序列化之后（实际发出去的样子）的字节数。 */
export const bodyBytes = (body: unknown): number => Buffer.byteLength(JSON.stringify(body), "utf8");

/**
 * 请求体里有一段可以截断的文本（`text`：文本消息的正文、运行通知的附加说明）：`build` 用给定的文本
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

/**
 * 卡片 Markdown 里要转义的字符：飞书开放平台文档「富文本（Markdown）」组件的「特殊字符转义说明」列出的那些
 * （`> < ~ - ! * / \ [ ] ( ) # : + " ' ` $ _`），加上 `&`（不转义的话，文字里恰好写着 `&#42;` 会被当成 `*`）。
 * 转义写成 HTML 数字实体 `&#编号;`（文档里 `~` 写 `&sim;`，那显示的是「∼」不是 `~`，所以统一用数字实体）。
 * **只转义文档里写明可用的这些**：别的符号在 CommonMark 里没有行内的意思，不转义，卡片的字节数也不白涨。
 */
const CARD_MARKDOWN_SPECIAL = /[&<>~\-!*/\\[\]()#:+"'`$_]/g;

/**
 * 把一段**别人写的文字**（触发人、场景名、节点显示名称、子流程名称、失败原因、出错位置）放进卡片的 Markdown 正文之前转义：
 * 文字里的 Markdown 和卡片的标记（`**强调**`、`[链接](地址)`、`<at user_id="all">`、`<font color=red>`、`` `代码` ``……）
 * 在卡片上按原样显示，不被当成格式。
 *
 * - 换行、制表符等连续的空白换成一个空格：这些文字是一行的内容，值都接在行首的标签（`**触发人**：`）后面，成不了行首的标记
 *   （标题、列表、引用、表格）；一个值里的换行也不能让后面的字出现在下一行的行首。
 * - **先截断、再转义**（截断在调用方：`clipReason` 按原文的字符数截）：转义之后一个字符变成好几个，先转义再截会把一个实体
 *   `&#42;` 切成两半（显示成 `&#4`）。截断留下的「…」不是特殊字符，不需要转义。
 * - 可以放进卡片的 Markdown 的只有这类文字：场景设置里的「附加说明」是给用户写 Markdown 用的（飞书卡片的标记写在里面是有意的，
 *   例如 `<at id=ou_1></at>`），不转义；标题（`plain_text`）、按钮的文字本来就不解释标记。
 */
export function escapeCardMarkdown(text: string): string {
	return text
		.replace(/[\s\u2028\u2029]+/g, " ")
		.replace(CARD_MARKDOWN_SPECIAL, (char) => `&#${char.charCodeAt(0)};`);
}

/** 卡片标题的颜色（飞书卡片 header 的颜色模板）。 */
export type CardColor = "blue" | "green" | "orange" | "red" | "grey";

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

/** 卡片的组装规则：header 加一组 body 元素（运行通知用）。 */
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
 * 卡片里有一段可以截断的文本（`text`，运行通知的附加说明）：`build` 用给定的文本组装整张卡片，
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
