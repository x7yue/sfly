import { EnvHttpProxyAgent, request } from "undici";
import { type FeishuFailure, failureFromError, failureFromResponse } from "./feishu-failure.js";

/**
 * 向飞书群机器人的 Webhook 地址发一次请求（ADR 0020）。这是控制面第一次主动对外发 HTTP 请求：
 *
 * - 直接访问 Webhook 地址里的主机，不写死飞书域名（私有部署的飞书也能用）；
 * - 遵循 `HTTPS_PROXY`（http 地址用 `HTTP_PROXY`）和 `NO_PROXY` 环境变量（控制面启动时读取代理设置）；
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
	readonly #dispatcher = new EnvHttpProxyAgent();

	/** `body` 是完整的飞书请求体（`msg_type` 和 `content`），原样序列化成 JSON 发出。 */
	async send(
		webhookUrl: string,
		body: object,
		{ timeoutMs = FEISHU_REQUEST_TIMEOUT_MS }: { timeoutMs?: number } = {},
	): Promise<FeishuSendResult> {
		const signal = AbortSignal.timeout(timeoutMs);
		try {
			const res = await request(webhookUrl, {
				method: "POST",
				headers: { "content-type": "application/json; charset=utf-8" },
				body: JSON.stringify(body),
				dispatcher: this.#dispatcher,
				signal,
			});
			const failure = failureFromResponse(res.statusCode, await readText(res.body));
			return failure ? { ok: false, failure } : { ok: true, httpStatus: res.statusCode };
		} catch (error) {
			return {
				ok: false,
				failure: failureFromError(error, {
					host: hostOf(webhookUrl),
					timedOut: signal.aborted,
					timeoutMs,
				}),
			};
		}
	}

	/** 关闭连接池；正在进行的请求立即以网络错误结束。 */
	async close(): Promise<void> {
		await this.#dispatcher.destroy();
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

async function readText(body: AsyncIterable<Buffer> & { destroy(): unknown }): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of body) {
		chunks.push(chunk);
		size += chunk.length;
		if (size > MAX_RESPONSE_BYTES) {
			body.destroy();
			break;
		}
	}
	return Buffer.concat(chunks).toString("utf8");
}
