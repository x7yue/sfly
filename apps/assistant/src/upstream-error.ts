import type { ErrorClass } from "@sfly/schema";

/**
 * 上游模型的错误（pi 给的 `errorMessage`、`finalError`）换成助手服务自己的说法（#640）。
 *
 * 上游的错误原文不进会话事件、不到页面：原文里是上游返回的错误体，可能有供应商的名字、账户、请求 ID、内部主机名，
 * 生产里上游回什么这里就显示什么。只留错误的类别（`error_class`，规则照评测集 `evals/assistant/aeval/classify.py`
 * 的 `_INFRA`）和状态码；原文由调用方写进助手服务的日志。和控制面「错误原文不对外，只给稳定的错误码和一句说明，
 * 原文进日志」是同一条。
 */
export interface UpstreamError {
	errorClass: ErrorClass;
	/** 上游返回的 HTTP 状态码（认得出时）。 */
	status?: number;
	/** 给人看的一句话，不带原文，例如「上游返回 502」「连不上上游模型」。 */
	text: string;
}

// 状态码出现在 pi 各家提供方的几种写法里：`<名字> API error (502): …`、SDK 的 `502 …`、`status code 502`、`status: 502`。
const STATUS = [
	/API error \((\d{3})\)/i,
	/^(\d{3})\b/,
	/status(?: code)?[:= ]+(\d{3})\b/i,
	/\bHTTP (\d{3})\b/,
];
const CONTEXT = /context (length|window)|too many tokens|maximum context|prompt is too long/i;
const UNREACHABLE =
	/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|Connection error|socket hang up|fetch failed|other side closed|^terminated/i;
const TIMEOUT = /ETIMEDOUT|timed out|timeout/i;
const AUTH = /unauthori[sz]ed|forbidden|invalid api key|authentication/i;
const QUOTA = /insufficient|quota|billing/i;
const RATE = /rate.?limit|too many requests|overloaded/i;

function statusOf(raw: string): number | undefined {
	for (const pattern of STATUS) {
		const found = pattern.exec(raw);
		const status = found ? Number(found[1]) : Number.NaN;
		if (status >= 400 && status <= 599) return status;
	}
	return undefined;
}

function classOf(raw: string, status: number | undefined): ErrorClass {
	if (CONTEXT.test(raw)) return "context_overflow";
	if (status === 401 || status === 403) return "auth";
	if (status === 402) return "quota";
	if (status === 429) return "rate_limit";
	if (status === 408) return "timeout";
	if (status !== undefined && status >= 500) return "upstream";
	if (UNREACHABLE.test(raw)) return "unreachable";
	if (TIMEOUT.test(raw)) return "timeout";
	if (AUTH.test(raw)) return "auth";
	if (QUOTA.test(raw)) return "quota";
	if (RATE.test(raw)) return "rate_limit";
	return "other";
}

const TEXT: Record<ErrorClass, string> = {
	unreachable: "连不上上游模型",
	timeout: "上游模型超时",
	auth: "上游拒绝了密钥",
	quota: "上游的额度不足",
	rate_limit: "上游限流",
	upstream: "上游出错",
	context_overflow: "上下文超出了模型的上限",
	other: "模型调用出错",
};

export function describeUpstreamError(raw: string): UpstreamError {
	const status = statusOf(raw);
	const errorClass = classOf(raw, status);
	const text =
		status === undefined ? TEXT[errorClass] : `${TEXT[errorClass]}（上游返回 ${status}）`;
	return { errorClass, ...(status !== undefined && { status }), text };
}
