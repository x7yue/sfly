import { STATUS_CODES } from "node:http";
import type { ErrorClass } from "@sfly/schema";

/**
 * 上游模型的错误（pi 给的 `errorMessage`）换成助手服务自己的说法（#640）。
 *
 * 上游的错误原文不进会话事件、不到页面：原文里是上游返回的错误体，可能有供应商的名字、账户、请求 ID、内部主机名，
 * 生产里上游回什么这里就显示什么。只留错误的类别（`error_class`）和状态码；原文由调用方写进助手服务的日志。
 * 和控制面「错误原文不对外，只给稳定的错误码和一句说明，原文进日志」是同一条。
 *
 * `error_class` 落库之后改不了，所以宁可分到 `other`，不能分错：状态码只从结构上取，类别先看状态码（规则的表在协议里
 * `ErrorClass` 的说明，packages/schema/src/sessions.ts）。
 */
export interface UpstreamError {
	errorClass: ErrorClass;
	/** 上游返回的 HTTP 状态码（认得出时）。 */
	status?: number;
	/** 给人看的一句话，不带原文，例如「上游出错（上游返回 502）」「连不上上游模型」。 */
	text: string;
}

/**
 * pi 只给一个字符串（`errorMessage`），没有结构化的状态码字段。它的写法是固定的几种（pi-ai 的
 * `formatProviderError`，和它原样留下的 SDK 的消息），状态码只在消息的开头：
 * - `502: <错误体>`；
 * - `<提供方> API error (502): <错误体>`（前缀一行之内、不带括号和冒号）；
 * - SDK 自己的消息 `502 status code (no body)`、`403 Forbidden`、`529 {"type":"error",…}`：开头的三位数后面跟空格，
 *   只在它是登记过的 HTTP 状态码、或者后面紧跟错误体（`{`）时才算（`443 bytes received` 不算）。
 * 不在全文里找：错误体里提到的别的状态码（上游转述的、请求 ID 里的数字）不算。
 */
const COLON = /^(\d{3}): /;
const PREFIXED = /^[^\n():]{1,80} \((\d{3})\): /;
const SDK = /^(\d{3}) (.)/;

export function statusOf(raw: string): number | undefined {
	const found = COLON.exec(raw) ?? PREFIXED.exec(raw);
	let status = found ? Number(found[1]) : undefined;
	if (status === undefined) {
		const [, digits = "", next] = SDK.exec(raw) ?? [];
		if (STATUS_CODES[digits] !== undefined || next === "{") status = Number(digits);
	}
	return status !== undefined && status >= 400 && status <= 599 ? status : undefined;
}

/**
 * 没有状态码时只认连接层的失败，而且只认结构上的 Node 错误码，或者整条消息就是 SDK 固定的那一句；不看正文里的词。
 * pi 把最里层的原因接在 SDK 的消息后面（`Connection error.: <原因>`），原因里没有错误码时再在末尾加上 `(<错误码>)`：
 * - Node 的系统错误自己的写法 `<调用> <错误码> …`：`Connection error.: connect ECONNREFUSED 10.0.0.5:8177`；
 * - 末尾括号里的错误码：`Connection error.: unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)`。
 */
const SYSCALL_CODE =
	/^(?:(?:Connection error\.|fetch failed): )?[a-z][A-Za-z]* ([A-Z][A-Z0-9_]+)\b/;
const TRAILING_CODE = /\(([A-Z][A-Z0-9_]+)\)$/;
const UNREACHABLE_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EPIPE",
	"UND_ERR_SOCKET",
	"UND_ERR_CLOSED",
	// TLS：证书验不过、主机名不符（连不上对的那一台）。
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"CERT_HAS_EXPIRED",
	"ERR_TLS_CERT_ALTNAME_INVALID",
]);
const TIMEOUT_CODES = new Set([
	"ETIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
]);
/** SDK 固定的几句（整条消息）。`terminated` 是 undici 在流读到一半连接断了时给的。 */
const UNREACHABLE_MESSAGES = [/^Connection error\.?$/, /^terminated$/];
const TIMEOUT_MESSAGES = [/^Request timed out\.?$/, /^The operation was aborted due to timeout$/];

function connectionClass(raw: string): ErrorClass {
	const code = SYSCALL_CODE.exec(raw)?.[1] ?? TRAILING_CODE.exec(raw)?.[1];
	if (code !== undefined && UNREACHABLE_CODES.has(code)) return "unreachable";
	if (code !== undefined && TIMEOUT_CODES.has(code)) return "timeout";
	if (UNREACHABLE_MESSAGES.some((pattern) => pattern.test(raw))) return "unreachable";
	if (TIMEOUT_MESSAGES.some((pattern) => pattern.test(raw))) return "timeout";
	return "other";
}

/** 有状态码时，正文只能在状态码定下的范围里细分。 */
const QUOTA_WORDS = /insufficient_quota|insufficient (balance|credit|funds)|quota|billing|credit/i;
const CONTEXT_WORDS = /context (length|window)|too many tokens|maximum context|prompt is too long/i;

function statusClass(status: number, raw: string): ErrorClass {
	if (status === 401 || status === 403) return QUOTA_WORDS.test(raw) ? "quota" : "auth";
	if (status === 402) return "quota";
	if (status === 429) return QUOTA_WORDS.test(raw) ? "quota" : "rate_limit";
	if (status === 408 || status === 504) return "timeout";
	if (status >= 500) return "upstream";
	return CONTEXT_WORDS.test(raw) ? "context_overflow" : "other";
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
	if (status === undefined) {
		const errorClass = connectionClass(raw);
		return { errorClass, text: TEXT[errorClass] };
	}
	const errorClass = statusClass(status, raw);
	// 其余的 4xx：上游看了请求、不收（参数不对、模型不存在这一类）。
	const said = errorClass === "other" ? "上游拒绝了这次请求" : TEXT[errorClass];
	return { errorClass, status, text: `${said}（上游返回 ${status}）` };
}
