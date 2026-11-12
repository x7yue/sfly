/**
 * 飞书消息的请求体组装（ADR 0020）。三种来源（飞书通知节点、`ctx.notify`、运行通知）共用这里的规则；
 * Markdown 卡片和原始消息的规则后面加在这里。
 */

/** 「@所有人」：飞书文本消息里的写法。 */
export const AT_ALL = '<at user_id="all">所有人</at>';

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
