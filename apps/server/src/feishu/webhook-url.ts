/**
 * Webhook 地址相当于一个凭据：拿到它的人就能往群里发消息（ADR 0020）。它明文保存在数据库里，
 * 接口、日志、投递记录和错误信息里一律只出现打码后的形式：只露出开头和结尾。
 */

const HEAD = 12;
const TAIL = 4;

/**
 * 打码：开头 12 个字符、省略号、结尾 4 个字符。地址很短时少露一些，保证露出的部分不超过四分之三。
 * 同一个地址总是打成同样的样子。
 */
export function maskWebhookUrl(url: string): string {
	const head = Math.min(HEAD, Math.floor(url.length / 4));
	const tail = Math.min(TAIL, Math.floor(url.length / 8));
	return `${url.slice(0, head)}…${tail === 0 ? "" : url.slice(-tail)}`;
}

/** 文字里夹带的 http(s) 地址（飞书返回的说明、底层库的错误信息）全部打码。 */
export function maskWebhookUrlsIn(text: string): string {
	return text.replace(/https?:\/\/[^\s"'<>]+/gi, maskWebhookUrl);
}
