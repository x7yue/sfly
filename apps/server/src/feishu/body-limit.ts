import { AT_ALL } from "./messages.js";

/** 飞书对请求体的限制：不超过 20 KB（按 UTF-8 编码后的 JSON 字节数算）。 */
export const FEISHU_BODY_MAX_BYTES = 20 * 1024;

/** 正文被截断时，加在被保留的正文后面的说明。 */
export const TRUNCATED_NOTE = "…（已截断）";

const jsonBytes = (body: unknown) => Buffer.byteLength(JSON.stringify(body), "utf8");
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;

/**
 * 文本消息（`msg_type: text`）的请求体超过 {@link FEISHU_BODY_MAX_BYTES} 时截断正文：保留尽量长的开头，
 * 末尾加 {@link TRUNCATED_NOTE}；不会切开一个字符（代理对）。正文末尾的「@所有人」（{@link AT_ALL}）留在最后，
 * 截断不能让重要的提醒丢掉。没超过上限、不是文本消息的请求体原样返回。
 */
export function truncateTextBody(body: Record<string, unknown>): Record<string, unknown> {
	if (jsonBytes(body) <= FEISHU_BODY_MAX_BYTES) return body;
	const content = body.content;
	if (body.msg_type !== "text" || !isRecord(content) || typeof content.text !== "string") {
		return body;
	}
	const text = content.text;
	const tail = text.endsWith(AT_ALL) ? AT_ALL : "";
	const head = text.slice(0, text.length - tail.length);
	const prefix = (length: number) =>
		head.slice(0, length > 0 && isHighSurrogate(head.charCodeAt(length - 1)) ? length - 1 : length);
	const withKept = (kept: string) => ({
		...body,
		content: { ...content, text: `${kept}${TRUNCATED_NOTE}${tail}` },
	});
	// fits(low) 成立、fits(high) 不成立：整段正文加上说明已经放不下，一个字符都不留一定放得下。
	let low = 0;
	let high = head.length;
	while (high - low > 1) {
		const middle = (low + high) >> 1;
		if (jsonBytes(withKept(prefix(middle))) <= FEISHU_BODY_MAX_BYTES) low = middle;
		else high = middle;
	}
	return withKept(prefix(low));
}
