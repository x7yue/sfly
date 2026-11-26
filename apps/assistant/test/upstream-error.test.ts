// 上游模型的错误换成助手服务自己的说法（#640）：只留类别和状态码，原文不出来。
// 状态码只从消息开头的固定写法取，类别先看状态码；没有状态码时只认连接层的失败（规则的表在协议里 `ErrorClass` 的说明）。
import { describe, expect, it } from "vitest";
import { describeUpstreamError } from "../src/upstream-error.js";

const SECRET_BODY =
	'{"message":"转发到 provider-acme 失败","account":"acct-42","request_id":"req-9"}';

type Case = [name: string, raw: string, errorClass: string, status: number | undefined];

/** pi 实际产生的几种写法（pi-ai 的 formatProviderError 和它原样留下的 SDK 消息）。 */
const FORMATS: Case[] = [
	["`NNN: 错误体`", `401: ${SECRET_BODY}`, "auth", 401],
	["`<提供方> API error (NNN): 错误体`", `aeval API error (502): ${SECRET_BODY}`, "upstream", 502],
	["`<提供方> error (NNN): 消息`", "Foo error (429): slow down", "rate_limit", 429],
	["SDK：`NNN status code (no body)`", "403 status code (no body)", "auth", 403],
	["SDK：`NNN <状态的说法>`", "408 Request Timeout", "timeout", 408],
	[
		"SDK：`NNN {错误体}`，没登记的状态码",
		'529 {"type":"error","error":{"type":"x"}}',
		"upstream",
		529,
	],
	["SDK：`NNN <消息>`，消息小写开头", "400 invalid model ID", "other", 400],
	// 连接层：pi 把最里层的原因接在 SDK 的消息后面，原因里已经有错误码时不再加括号（test/fixtures/pi-retry.jsonl 是真的 pi 录的）。
	[
		"连接被拒（pi 实际的写法）",
		"Connection error.: connect ECONNREFUSED 127.0.0.1:8177",
		"unreachable",
		undefined,
	],
	[
		"域名解析不了（pi 实际的写法）",
		"Connection error.: getaddrinfo ENOTFOUND llm.corp.example",
		"unreachable",
		undefined,
	],
	["连接被重置（pi 实际的写法）", "Connection error.: read ECONNRESET", "unreachable", undefined],
	[
		"连接超时（pi 实际的写法）",
		"Connection error.: connect ETIMEDOUT 10.0.0.5:443",
		"timeout",
		undefined,
	],
	["没有 SDK 的前缀", "connect EHOSTUNREACH 10.0.0.5:443", "unreachable", undefined],
];

/** 审查的反例（reviews/rv641 的 logs/classify.jsonl）：上一版在这些上分错了类别或状态码。 */
const REVIEW: Case[] = [
	[
		"真 400，正文里有 API error (503)",
		'400: {"error":{"message":"relay saw Foo API error (503) earlier"}}',
		"other",
		400,
	],
	[
		"真 400，正文里 status code 502",
		'400: {"error":{"message":"origin status code 502"}}',
		"other",
		400,
	],
	[
		"流中途的错误（没有 HTTP 状态码），正文 status: 429",
		'{"type":"error","error":{"message":"origin answered status: 429"}}',
		"other",
		undefined,
	],
	[
		"没有状态码，正文里 HTTP 404",
		'{"error":{"message":"see HTTP 404 in logs"}}',
		"other",
		undefined,
	],
	["开头的数字不是状态码", "443 bytes received then the stream was reset", "other", undefined],
	[
		"真 400，正文提到 timeout 参数",
		'400: {"error":{"message":"Invalid value for \'timeout\': must be an integer"}}',
		"other",
		400,
	],
	[
		"真 404，正文提到 authentication",
		'404: {"error":{"message":"authentication scheme not supported for this model"}}',
		"other",
		404,
	],
	[
		"真 400，正文提到 insufficient",
		'400: {"error":{"message":"insufficient permissions for tool use"}}',
		"other",
		400,
	],
	[
		"真 404，正文提到 rate limit",
		'404: {"error":{"message":"see rate limit docs: model not found"}}',
		"other",
		404,
	],
	[
		"真 400，正文提到 fetch failed",
		'400: {"error":{"message":"image url fetch failed"}}',
		"other",
		400,
	],
	[
		"TLS 失败",
		"Connection error.: unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)",
		"unreachable",
		undefined,
	],
	[
		"TLS 主机名不符",
		"Connection error.: Hostname/IP does not match certificate's altnames (ERR_TLS_CERT_ALTNAME_INVALID)",
		"unreachable",
		undefined,
	],
	[
		"域名解析不了",
		"Connection error.: getaddrinfo ENOTFOUND llm.corp.example (ENOTFOUND)",
		"unreachable",
		undefined,
	],
	[
		"连接被拒",
		"Connection error.: connect ECONNREFUSED 10.0.0.5:8443 (ECONNREFUSED)",
		"unreachable",
		undefined,
	],
	[
		"主机不可达",
		"Connection error.: connect EHOSTUNREACH 10.0.0.5:8443 (EHOSTUNREACH)",
		"unreachable",
		undefined,
	],
	[
		"连接超时",
		"Connection error.: connect ETIMEDOUT 10.0.0.5:443 (ETIMEDOUT)",
		"timeout",
		undefined,
	],
	["请求超时", "Request timed out.", "timeout", undefined],
	["中止于超时", "The operation was aborted due to timeout", "timeout", undefined],
	[
		"回应体不是 JSON（网关的 HTML）",
		"502 <html><head><title>502 Bad Gateway</title></head><body>gw</body></html>",
		"upstream",
		502,
	],
	["回应体是空的", "502 status code (no body)", "upstream", 502],
	["401", '401: {"error":{"message":"bad key"}}', "auth", 401],
	["403", "403 Forbidden", "auth", 403],
	["402", '402: {"error":{"message":"pay"}}', "quota", 402],
	["408", "408 Request Timeout", "timeout", 408],
	["429", '429: {"error":{"message":"slow down"}}', "rate_limit", 429],
	["500", '500: {"error":{"message":"boom"}}', "upstream", 500],
	["带前缀的 529", "Foo API error (529): overloaded", "upstream", 529],
	["terminated", "terminated", "unreachable", undefined],
	[
		"上下文超长 400",
		'400: {"error":{"message":"prompt is too long: 210000 tokens > 200000 maximum"}}',
		"context_overflow",
		400,
	],
	["流里 network_error", "Provider finish_reason: network_error", "other", undefined],
	["413", "413 Request Entity Too Large", "other", 413],
	[
		"状态码后跟换行的元数据",
		'502: {"error":{"message":"x"}}\n{"request_id":"req-9"}',
		"upstream",
		502,
	],
	["正文里 HTTP 503，真 400", '400: {"error":{"message":"upstream HTTP 503 seen"}}', "other", 400],
	[
		"真 401，正文里 API error (500)",
		'401: {"error":{"message":"gateway saw Foo API error (500) from auth svc"}}',
		"auth",
		401,
	],
];

/** 有状态码时正文只在状态码的范围里细分；没有状态码时不看正文。 */
const TABLE: Case[] = [
	["403，正文说额度", '403: {"error":{"code":"insufficient_quota"}}', "quota", 403],
	[
		"429，正文说额度",
		"429 You exceeded your current quota, please check your plan and billing details",
		"quota",
		429,
	],
	["504 是超时", "504 Gateway Timeout", "timeout", 504],
	["其余 5xx 是上游出错", "503 Service Unavailable", "upstream", 503],
	[
		"5xx 正文说超时也还是上游出错",
		'500: {"error":{"message":"request timed out upstream"}}',
		"upstream",
		500,
	],
	[
		"429 正文说上下文也还是限流",
		'429: {"error":{"message":"maximum context reached"}}',
		"rate_limit",
		429,
	],
	["没有状态码，正文说超时", "upstream said the request timed out", "other", undefined],
	["没有状态码，正文说上下文超长", "prompt is too long: 210000 tokens", "other", undefined],
	["没有状态码，正文说限流", "rate limit exceeded", "other", undefined],
	[
		"连接层的原因在末尾括号里",
		"fetch failed: connect ECONNRESET 10.0.0.5:443 (ECONNRESET)",
		"unreachable",
		undefined,
	],
	["SDK 只说连不上", "Connection error.", "unreachable", undefined],
	// 审查用真的 pi 录到的两种（reviews/rv641b）：上游接了连接就重置、流读到一半断开。
	["上游接了连接就重置（真的 pi）", "Connection error.: write EPIPE", "unreachable", undefined],
	[
		"流读到一半断开（真的 pi）",
		"terminated: other side closed (UND_ERR_SOCKET)",
		"unreachable",
		undefined,
	],
	["带前缀的写法不在开头不算", "upstream said: Foo API error (503): x", "other", undefined],
	["正文里的数字不当成状态码", "model said 404 things went wrong", "other", undefined],
	[
		"正文里的 `NNN: ` 不算（不在开头）",
		'{"error":{"message":"origin said 503: try later"}}',
		"other",
		undefined,
	],
	[
		"开头的 `(NNN): ` 前面不是 error 不算",
		"upstream stalled (502): retry later",
		"other",
		undefined,
	],
	[
		"正文里的错误码不算（不在开头的 Node 写法里、不在末尾括号里）",
		"upstream relay hit ECONNREFUSED earlier",
		"other",
		undefined,
	],
	["开头像 Node 的写法、错误码不是连接层的", "open ENOENT /tmp/x", "other", undefined],
	["空的", "", "other", undefined],
];

const LABEL: Record<string, string> = {
	unreachable: "连不上模型端点",
	timeout: "模型端点超时",
	auth: "密钥被拒绝",
	quota: "额度不足",
	rate_limit: "被限流",
	upstream: "模型端点出错",
	context_overflow: "对话太长，模型装不下",
	other: "其他错误",
};

describe("上游的错误 → 类别、状态码和自己的说法", () => {
	it.each([...FORMATS, ...REVIEW, ...TABLE])("%s", (_name, raw, errorClass, status) => {
		const described = describeUpstreamError(raw);
		expect({ errorClass: described.errorClass, status: described.status }).toEqual({
			errorClass,
			status,
		});
		const label = LABEL[errorClass];
		expect(described.label).toBe(label);
		expect(described.text).toBe(status === undefined ? label : `${label}（${status}）`);
	});

	it("给人看的那句话里没有原文的任何一段", () => {
		for (const [, raw] of [...FORMATS, ...REVIEW, ...TABLE]) {
			const { text } = describeUpstreamError(raw);
			for (const part of [
				"provider-acme",
				"acct-42",
				"req-9",
				"10.0.0.5",
				"llm.corp",
				"Foo",
				"maximum",
			]) {
				expect(text).not.toContain(part);
			}
		}
	});
});
