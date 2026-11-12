import { type FeishuFailure, failureFromError, failureFromResponse } from "./feishu-failure.js";

/**
 * 向飞书机器人的 Webhook 地址发一次请求（ADR 0020）。这是控制面第一次主动对外发 HTTP 请求：
 *
 * - 直接访问 Webhook 地址里的主机，不写死飞书域名（私有部署的飞书也能用）；
 * - 不支持代理，控制面所在的机器要能直接访问这个主机；
 * - 单次请求超时 10 秒；
 * - 成功的条件是 HTTP 2xx 并且响应体里的 `code` 为 0，其余都是失败，失败带中文原因、下一步和能否重试
 *   （{@link FeishuFailure}）；
 * - 只发一次，不重试：「发送测试消息」直接用它，发送队列（#229）在它外面做退避重试。
 */
export const FEISHU_REQUEST_TIMEOUT_MS = 10_000;

/** 响应体最多读这么多字节（飞书的响应只有几十字节，防止对端回一个巨大的响应）。 */
const MAX_RESPONSE_BYTES = 64 * 1024;

export type FeishuSendResult =
	| { ok: true; httpStatus: number }
	| { ok: false; failure: FeishuFailure };

export class FeishuClient {
	readonly #closing = new AbortController();

	/** `body` 是完整的飞书请求体（`msg_type` 和 `content`），原样序列化成 JSON 发出。 */
	async send(
		webhookUrl: string,
		body: object,
		{ timeoutMs = FEISHU_REQUEST_TIMEOUT_MS }: { timeoutMs?: number } = {},
	): Promise<FeishuSendResult> {
		const timeout = AbortSignal.timeout(timeoutMs);
		try {
			const res = await fetch(webhookUrl, {
				method: "POST",
				headers: { "content-type": "application/json; charset=utf-8" },
				body: JSON.stringify(body),
				signal: AbortSignal.any([timeout, this.#closing.signal]),
			});
			const failure = failureFromResponse(res.status, await readText(res));
			return failure ? { ok: false, failure } : { ok: true, httpStatus: res.status };
		} catch (error) {
			return {
				ok: false,
				failure: failureFromError(error, {
					host: hostOf(webhookUrl),
					timedOut: timeout.aborted,
					timeoutMs,
				}),
			};
		}
	}

	/** 正在进行的请求立即以网络错误结束，之后发的请求也立即失败；控制面关闭时不用等还没响应的飞书。 */
	async close(): Promise<void> {
		this.#closing.abort(new Error("飞书客户端已关闭"));
	}
}

/** Webhook 地址里的主机（不含路径和令牌）；地址无效时给一个说明，不抛出。 */
function hostOf(webhookUrl: string): string {
	try {
		return new URL(webhookUrl).host;
	} catch {
		return "（Webhook 地址无效）";
	}
}

async function readText(res: Response): Promise<string> {
	if (!res.body) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size <= MAX_RESPONSE_BYTES) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		size += value.length;
	}
	await reader.cancel().catch(() => {});
	return Buffer.concat(chunks).toString("utf8");
}
