// 保密环境变量的值按值打码（src/redact.ts 写着规则和做不到的）。
import { SECRET_MASK } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { forLog, LOG_TEXT_LIMIT, Redactor } from "../src/redact.js";

const redactor = (...values: string[]) => {
	const r = new Redactor();
	r.add(values);
	return r;
};

describe("按值打码", () => {
	it("原文、JSON 转义的写法、\\u 写法都认", () => {
		const r = redactor('ab"c\\d', "密钥值");
		expect(r.redact('x ab"c\\d y')).toBe(`x ${SECRET_MASK} y`);
		expect(r.redact(JSON.stringify({ v: 'ab"c\\d' }))).toBe(`{"v":"${SECRET_MASK}"}`);
		expect(r.redact("\\u5bc6\\u94a5\\u503c")).toBe(SECRET_MASK);
	});

	it("值有几行时每一行单独也认（被换行拆开打出来）", () => {
		const r = redactor("line-one\nline-two");
		expect(r.redact("line-one")).toBe(SECRET_MASK);
		expect(r.redact("a\nline-two\nb")).toBe(`a\n${SECRET_MASK}\nb`);
	});

	it("值再短也打码，空串不算；长的写法先换", () => {
		expect(redactor("x").redact("axb")).toBe(`a${SECRET_MASK}b`);
		expect(redactor("").redact("abc")).toBe("abc");
		expect(redactor("abc", "abcdef").redact("abcdef")).toBe(SECRET_MASK);
	});

	it("对象里的字符串都打码", () => {
		expect(redactor("tok").redactValue({ a: ["x tok"], b: { c: "tok" }, n: 1 })).toEqual({
			a: [`x ${SECRET_MASK}`],
			b: { c: SECRET_MASK },
			n: 1,
		});
	});
});

describe("跨两条增量", () => {
	it("值被拆在两段里：留下末尾不发，和下一段拼起来再认；结束时发出剩下的", () => {
		const stream = redactor("secret-token").stream();
		const out = [stream.push("abc secret-"), stream.push("token def"), stream.flush()].join("");
		expect(out).toBe(`abc ${SECRET_MASK} def`);
		expect(out).not.toContain("secret-");
	});

	it("一个字一个字地来也认得出", () => {
		const stream = redactor("hunter2").stream();
		const out = [...[..."pw=hunter2!"].map((c) => stream.push(c)), stream.flush()].join("");
		expect(out).toBe(`pw=${SECRET_MASK}!`);
	});

	it("没有要打码的值时原样立刻发出", () => {
		const stream = new Redactor().stream();
		expect(stream.push("abc")).toBe("abc");
		expect(stream.flush()).toBe("");
	});
});

describe("写进助手服务日志的原文（#640）", () => {
	it.each([
		["Authorization 头", "Authorization: Bearer abc.def-123", "Authorization: ******"],
		[
			"JSON 里的 authorization",
			'{"authorization":"Basic dXNlcjpwdw=="}',
			'{"authorization":"******"}',
		],
		["只有 Bearer", "token was Bearer abc.def-123 then", "token was Bearer ****** then"],
		["x-api-key 头", "x-api-key: sk-123456", "x-api-key: ******"],
		[
			"地址里的用户名和密码",
			"via https://user:pw@proxy.example/v1",
			"via https://******@proxy.example/v1",
		],
		["没有凭据", "502: upstream boom", "502: upstream boom"],
	])("按形状打码：%s", (_name, raw, logged) => {
		expect(forLog(raw, [])).toBe(logged.replaceAll("******", SECRET_MASK));
	});

	it("先按值打码（每个打码器），再截到上限：截断不会切出值的半截", () => {
		const value = "v".repeat(20);
		const raw = `${"a".repeat(LOG_TEXT_LIMIT - 10)}${value}${"b".repeat(100)}`;
		const logged = forLog(raw, [redactor("other"), redactor(value)]);
		expect(logged).not.toContain("vvvvv");
		expect(logged.startsWith(`${"a".repeat(LOG_TEXT_LIMIT - 10)}${SECRET_MASK}`)).toBe(true);
		expect(logged).toMatch(/…（后面截掉了 \d+ 个字符）$/);
		expect(forLog("short", [])).toBe("short");
	});
});
