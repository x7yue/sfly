// 上游模型的错误换成助手服务自己的说法（#640）：只留类别和状态码，原文不出来。
import { describe, expect, it } from "vitest";
import { withoutAddress } from "../src/sessions.js";
import { describeUpstreamError } from "../src/upstream-error.js";

const SECRET_BODY =
	'{"message":"转发到 provider-acme 失败","account":"acct-42","request_id":"req-9"}';

describe("上游的错误 → 自己的说法", () => {
	it.each([
		[`aeval API error (502): ${SECRET_BODY}`, "upstream", "上游出错（上游返回 502）"],
		[`401 ${SECRET_BODY}`, "auth", "上游拒绝了密钥（上游返回 401）"],
		["403 forbidden", "auth", "上游拒绝了密钥（上游返回 403）"],
		["402 Payment required: insufficient balance", "quota", "上游的额度不足（上游返回 402）"],
		["429 Rate limit reached for requests", "rate_limit", "上游限流（上游返回 429）"],
		["Request failed with status code 503", "upstream", "上游出错（上游返回 503）"],
		["Connection error.: connect ECONNREFUSED 10.0.0.5:8177", "unreachable", "连不上上游模型"],
		["getaddrinfo ENOTFOUND model.internal", "unreachable", "连不上上游模型"],
		["Request timed out.", "timeout", "上游模型超时"],
		[
			"400 This model's maximum context length is 128000 tokens",
			"context_overflow",
			"上下文超出了模型的上限（上游返回 400）",
		],
		["400 bad request", "other", "模型调用出错（上游返回 400）"],
		["something odd", "other", "模型调用出错"],
		["", "other", "模型调用出错"],
	])("%s", (raw, errorClass, text) => {
		const described = describeUpstreamError(raw);
		expect(described).toMatchObject({ errorClass, text });
		// 原文里的任何一段都不在给人看的那句话里。
		for (const part of [
			"provider-acme",
			"acct-42",
			"req-9",
			"10.0.0.5",
			"model.internal",
			"maximum context",
		]) {
			expect(described.text).not.toContain(part);
		}
	});

	it("正文里的数字不当成状态码", () => {
		expect(describeUpstreamError("model said 404 things went wrong").status).toBeUndefined();
	});
});

describe("给人看的文字里不带工作台的地址", () => {
	it.each([
		[
			"connect ECONNREFUSED 172.22.0.7:50052",
			"172.22.0.7:50052",
			"connect ECONNREFUSED dev-root-dev",
		],
		["连不上 172.22.0.7（端口 50052）", "172.22.0.7:50052", "连不上 dev-root-dev（端口 50052）"],
		["connect to [fd00::7]:50052 failed", "[fd00::7]:50052", "connect to dev-root-dev failed"],
		["没有地址", "dev:50052", "没有地址"],
		["写 /dev/null 失败（dev:50052）", "dev:50052", "写 /dev/null 失败（dev-root-dev）"],
	])("%s", (text, address, expected) => {
		expect(withoutAddress(text, address, "dev-root-dev")).toBe(expected);
	});
});
