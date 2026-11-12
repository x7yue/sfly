import { maskWebhookUrlsIn } from "./webhook-url.js";

/**
 * 一次向飞书发请求失败的原因（ADR 0020）：飞书的错误码、HTTP 状态码、网络错误和超时都翻译成中文的原因和下一步。
 * 「发送测试消息」直接显示它；发送队列（#229）用 `retryable` 决定要不要退避重试，并把 `reason` 写进投递结果。
 *
 * 原因和下一步里不出现 Webhook 地址（令牌在地址里），只写主机；飞书和底层库带来的文字经 {@link maskWebhookUrlsIn} 打码。
 */
export interface FeishuFailure {
	kind: "feishu_code" | "http_status" | "bad_response" | "network" | "timeout";
	/** 飞书返回的错误码；没有收到飞书的错误码时为 null。 */
	code: number | null;
	/** 收到响应时的 HTTP 状态码；网络错误和超时为 null。 */
	httpStatus: number | null;
	/** 中文原因。 */
	reason: string;
	/** 中文的下一步。 */
	nextStep: string;
	/** 值得退避重试：网络错误、超时、HTTP 429、5xx 和飞书的限流错误码 11232。其他都不重试。 */
	retryable: boolean;
}

const DOCS = "飞书官方文档「自定义机器人使用指南」";
const CHECK_NETWORK =
	"确认控制面所在的机器能访问这个主机（防火墙、DNS）；只能经代理出网时，给控制面配置 HTTPS_PROXY（http 地址用 HTTP_PROXY）和 NO_PROXY 环境变量，并让代理能访问飞书。";

interface KnownCode {
	reason: string;
	nextStep: string;
	retryable?: true;
}

/** 飞书自定义机器人的错误码（见 {@link DOCS}）。 */
const KNOWN_CODES: Record<number, KnownCode> = {
	19021: {
		reason: "飞书群里的机器人开启了签名校验，sfly 不支持签名校验",
		nextStep: "在飞书群的机器人设置里关闭「签名校验」，改用「自定义关键词」或「IP 白名单」。",
	},
	19022: {
		reason: "控制面的出口 IP 不在飞书群里这个机器人的 IP 白名单里",
		nextStep:
			"把控制面访问飞书时使用的出口 IP 加进机器人设置里的「IP 白名单」（经代理出网时填代理的出口 IP），或者改用「自定义关键词」。",
	},
	19024: {
		reason: "消息里没有飞书群里这个机器人设置的关键词",
		nextStep:
			"机器人开启了「自定义关键词」时，每条消息都要包含其中一个关键词：把关键词改成消息里会出现的词（测试消息里有「sfly」），或者改用「IP 白名单」。",
	},
	9499: {
		reason: "飞书认为请求格式不对（错误码 9499）",
		nextStep:
			"发原始消息时最常见：检查请求体是不是飞书要求的 JSON，msg_type 和 content 要对应。测试消息的内容是固定的，出现它时检查 Webhook 地址是不是飞书机器人的地址。",
	},
	11232: {
		reason: "触发了飞书的频率限制（错误码 11232）",
		nextStep: "稍后再试。飞书建议避开整点和半点发送，那时更容易触发频率限制。",
		retryable: true,
	},
};

/** 飞书返回了错误码（HTTP 状态码不一定是 200：9499 对应 400）。 */
function fromCode(code: number, msg: string, httpStatus: number): FeishuFailure {
	const known = KNOWN_CODES[code];
	if (known) {
		return {
			kind: "feishu_code",
			code,
			httpStatus,
			reason: known.reason,
			nextStep: known.nextStep,
			retryable: known.retryable === true,
		};
	}
	const detail = msg === "" ? "" : `：${maskWebhookUrlsIn(msg)}`;
	return {
		kind: "feishu_code",
		code,
		httpStatus,
		reason: `飞书返回了错误码 ${code}${detail}`,
		nextStep: `对照${DOCS}里的错误码说明排查。`,
		retryable: false,
	};
}

/** 飞书响应体：`{ "code": 0, "msg": "success", … }`；不是这个形状时返回 undefined。 */
function parseFeishuBody(text: string): { code: number; msg: string } | undefined {
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null) return undefined;
		const { code, msg } = value as { code?: unknown; msg?: unknown };
		if (typeof code !== "number" || !Number.isInteger(code)) return undefined;
		return { code, msg: typeof msg === "string" ? msg : "" };
	} catch {
		return undefined;
	}
}

/**
 * 解读飞书的响应：HTTP 2xx 并且响应体里的 `code` 为 0 才算送达，返回 undefined；其余都是失败。
 * 响应体里有错误码时以错误码为准；没有时按 HTTP 状态码解释。
 */
export function failureFromResponse(
	httpStatus: number,
	bodyText: string,
): FeishuFailure | undefined {
	const body = parseFeishuBody(bodyText);
	if (body && body.code !== 0) return fromCode(body.code, body.msg, httpStatus);
	const success = httpStatus >= 200 && httpStatus < 300;
	if (success && body) return undefined;
	if (success) {
		return {
			kind: "bad_response",
			code: null,
			httpStatus,
			reason: `响应不是飞书机器人的返回格式（HTTP ${httpStatus}）`,
			nextStep:
				"确认 Webhook 地址是飞书机器人的地址；控制面经代理出网时，检查代理（HTTPS_PROXY、NO_PROXY）有没有把请求截走或改写。",
			retryable: false,
		};
	}
	if (httpStatus === 429) {
		return {
			kind: "http_status",
			code: null,
			httpStatus,
			reason: "飞书返回了 HTTP 429：请求太频繁",
			nextStep: "稍后再试。飞书建议避开整点和半点发送，那时更容易触发频率限制。",
			retryable: true,
		};
	}
	if (httpStatus >= 500) {
		return {
			kind: "http_status",
			code: null,
			httpStatus,
			reason: `飞书服务暂时不可用（HTTP ${httpStatus}）`,
			nextStep: "稍后再试；一直失败时检查控制面和飞书之间的代理或网关。",
			retryable: true,
		};
	}
	return {
		kind: "http_status",
		code: null,
		httpStatus,
		reason: `飞书返回了 HTTP ${httpStatus}`,
		nextStep:
			"检查 Webhook 地址是否完整、有没有被改过；必要时在飞书群里重新复制机器人的 Webhook 地址。",
		retryable: false,
	};
}

/** 底层网络库的错误码 → 中文说法。 */
const NETWORK_CODES: Record<string, string> = {
	ECONNREFUSED: "连接被拒绝",
	ENOTFOUND: "域名无法解析",
	EAI_AGAIN: "域名无法解析",
	ECONNRESET: "连接被中断",
	UND_ERR_SOCKET: "连接被中断",
	EPIPE: "连接被中断",
	ETIMEDOUT: "连接超时",
	UND_ERR_CONNECT_TIMEOUT: "连接超时",
	EHOSTUNREACH: "主机不可达",
	ENETUNREACH: "网络不可达",
	UNABLE_TO_VERIFY_LEAF_SIGNATURE: "证书校验失败",
	SELF_SIGNED_CERT_IN_CHAIN: "证书校验失败",
	DEPTH_ZERO_SELF_SIGNED_CERT: "证书校验失败",
	CERT_HAS_EXPIRED: "证书已过期",
	ERR_TLS_CERT_ALTNAME_INVALID: "证书和主机名不匹配",
};

interface ErrorLike {
	code?: unknown;
	message?: unknown;
	cause?: unknown;
	errors?: unknown;
}

/** 沿着 cause 和 AggregateError 的 errors 找第一个认得的错误码。 */
function networkCode(error: unknown, depth = 0): string | undefined {
	if (typeof error !== "object" || error === null || depth > 4) return undefined;
	const { code, cause, errors } = error as ErrorLike;
	if (typeof code === "string" && code in NETWORK_CODES) return code;
	for (const inner of [cause, ...(Array.isArray(errors) ? errors : [])]) {
		const found = networkCode(inner, depth + 1);
		if (found) return found;
	}
	return undefined;
}

/** 网络错误里最里层的错误信息（打码后用于没有认得的错误码时）。 */
function errorMessage(error: unknown): string {
	if (typeof error !== "object" || error === null) return String(error);
	const { message, cause } = error as ErrorLike;
	const inner = cause === undefined ? "" : errorMessage(cause);
	return inner !== "" ? inner : typeof message === "string" ? message : String(error);
}

/**
 * 没有收到飞书的响应：网络错误、代理拒绝和超时。`host` 是 Webhook 地址里的主机（不含路径和令牌），
 * `timeoutMs` 是这次请求的超时时间。
 */
export function failureFromError(
	error: unknown,
	context: { host: string; timedOut: boolean; timeoutMs: number },
): FeishuFailure {
	const { host, timedOut, timeoutMs } = context;
	if (timedOut) {
		return {
			kind: "timeout",
			code: null,
			httpStatus: null,
			reason: `连接 ${host} 超时：${Math.round(timeoutMs / 1000)} 秒内没有收到飞书的响应`,
			nextStep: CHECK_NETWORK,
			retryable: true,
		};
	}
	const message = errorMessage(error);
	const proxy = /Proxy response \((\d+)\)/.exec(message);
	if (proxy) {
		return {
			kind: "network",
			code: null,
			httpStatus: null,
			reason: `无法经代理连接 ${host}：代理拒绝了连接（HTTP ${proxy[1]}）`,
			nextStep: `${CHECK_NETWORK}也检查 NO_PROXY 是否把这个主机排除在代理之外。`,
			retryable: true,
		};
	}
	const code = networkCode(error);
	const detail = code ? NETWORK_CODES[code] : `网络错误（${maskWebhookUrlsIn(message)}）`;
	return {
		kind: "network",
		code: null,
		httpStatus: null,
		reason: `无法连接 ${host}：${detail}`,
		nextStep: CHECK_NETWORK,
		retryable: true,
	};
}
