// 会话令牌的名称、有效期和第二道打码（src/sessions/session-tokens.ts，规格 #547）：不连数据库的部分。
import {
	ASSISTANT_STOP_WAIT_MS,
	ASSISTANT_TURN_MAX_MS,
	SECRET_MASK,
	TOKEN_PREFIXES,
} from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	maskSessionTokens,
	SESSION_TOKEN_MARGIN_MS,
	SESSION_TOKEN_TTL_MS,
	sessionTokenName,
} from "../src/sessions/session-tokens.js";

const TOKEN = `${TOKEN_PREFIXES.session}${"0123456789abcdef".repeat(3)}`;

describe("令牌的名称", () => {
	it("「会话：<会话标题>」", () => {
		expect(
			sessionTokenName({ id: "a1b2c3d4-0000-4000-8000-000000000000", title: "改巡检节点" }),
		).toBe("会话：改巡检节点");
	});

	it("标题带着名称不允许的字符（让文字倒着显示、换行的）：换成会话 ID 的前 8 位，不把它带到别人的命令行和页面上", () => {
		const id = "a1b2c3d4-0000-4000-8000-000000000000";
		for (const title of ["改‮巡检", "改\n巡检", "改\u0000巡检"]) {
			expect(sessionTokenName({ id, title }), JSON.stringify(title)).toBe("会话：a1b2c3d4");
		}
	});
});

describe("有效期", () => {
	it("这一轮的硬上限、加停止一轮最晚的时间、再加余量：助手服务和控制面引用同一个数，改了硬上限有效期跟着走", () => {
		expect(SESSION_TOKEN_TTL_MS).toBe(
			ASSISTANT_TURN_MAX_MS + ASSISTANT_STOP_WAIT_MS + SESSION_TOKEN_MARGIN_MS,
		);
		// 一轮 20 分钟加收尾 23 秒，余量让令牌在正常的一轮里不会先过期，又不比一轮长很多。
		expect(SESSION_TOKEN_TTL_MS).toBeGreaterThan(ASSISTANT_TURN_MAX_MS + ASSISTANT_STOP_WAIT_MS);
		expect(SESSION_TOKEN_TTL_MS).toBeLessThan(2 * ASSISTANT_TURN_MAX_MS);
	});
});

describe("第二道打码：按令牌的格式（sfly_ses_ 加后面整段令牌字符），不按值", () => {
	it("文字里完整的令牌换成掩码，前后的文字原样；几个都换", () => {
		expect(maskSessionTokens(`令牌是 ${TOKEN}，对吧；还有 ${TOKEN}。`)).toBe(
			`令牌是 ${SECRET_MASK}，对吧；还有 ${SECRET_MASK}。`,
		);
		expect(maskSessionTokens(`SFLY_API_TOKEN=${TOKEN}\nX=1\n`)).toBe(
			`SFLY_API_TOKEN=${SECRET_MASK}\nX=1\n`,
		);
	});

	it("前缀后面连着的令牌字符（字母、数字、下划线、连字符）不论多长都是令牌的一部分，到别的字符为止", () => {
		expect(maskSessionTokens("a sfly_ses_abc-DEF_123 b")).toBe(`a ${SECRET_MASK} b`);
		expect(maskSessionTokens(`${TOKEN}extra_more-and-more.`)).toBe(`${SECRET_MASK}.`);
		// 前缀前面连着的字符不是令牌的一部分：前缀在哪里都认。
		expect(maskSessionTokens(`x${TOKEN}`)).toBe(`x${SECRET_MASK}`);
	});

	it("只看格式：单独的前缀（文档里的写法）、别的前缀（个人令牌）、没有前缀的十六进制串都不动", () => {
		for (const text of [
			"令牌以 sfly_ses_ 开头",
			"sfly_ses_",
			`个人令牌 ${TOKEN_PREFIXES.personal}${"ab".repeat(24)}`,
			"0123456789abcdef".repeat(3),
			"sfly_ses",
		]) {
			expect(maskSessionTokens(text), text).toBe(text);
		}
	});

	it("事件是 JSON：每一个字符串都处理（嵌套的对象、数组里的），键、数字、布尔、null 不动；没有令牌时原样返回同一个值", () => {
		const event = {
			type: "tool_result",
			is_error: false,
			exit_code: 0,
			text: `x ${TOKEN}`,
			nested: { list: [`${TOKEN}`, 3, null, { deep: `y${TOKEN}` }] },
			[TOKEN]: "键不处理",
		};
		expect(maskSessionTokens(event)).toEqual({
			type: "tool_result",
			is_error: false,
			exit_code: 0,
			text: `x ${SECRET_MASK}`,
			nested: { list: [SECRET_MASK, 3, null, { deep: `y${SECRET_MASK}` }] },
			[TOKEN]: "键不处理",
		});
		const clean = { type: "assistant_message", text: "没有令牌", usage: { input: 1 } };
		expect(maskSessionTokens(clean)).toBe(clean);
	});

	it("打不打码只取决于文字里有没有完整的格式，和哪个令牌是真的无关（编造的、别的轮次的一样打）", () => {
		const invented = `${TOKEN_PREFIXES.session}${"z".repeat(5)}`;
		expect(maskSessionTokens(invented)).toBe(SECRET_MASK);
		expect(maskSessionTokens(`${TOKEN_PREFIXES.session}${"9".repeat(200)}`)).toBe(SECRET_MASK);
	});
});

describe("已知边界：这几种写法两道打码都不认（按格式认，不猜各种写法；靠令牌的范围和一轮结束就吊销兜底，docs/ARCHITECTURE.md）", () => {
	it("被换行拆开的（`fold -w 10`）：令牌字符到换行为止，前半截换成掩码，后半截原样留着；每一段都在前缀后面的不认", () => {
		const half = TOKEN.slice(0, 20);
		const rest = TOKEN.slice(20);
		// 前半截连着前缀：打码，后半截（没有前缀）原样。
		expect(maskSessionTokens(`${half}\n${rest}`)).toBe(`${SECRET_MASK}\n${rest}`);
		// `fold -w 5` 这类每段都很短：前缀本身被拆开，一段也认不出，原样。
		const folded = TOKEN.match(/.{1,5}/g)?.join("\n") ?? "";
		expect(maskSessionTokens(folded)).toBe(folded);
		// 空白拆开的同理。
		expect(maskSessionTokens(`${half} ${rest}`)).toBe(`${SECRET_MASK} ${rest}`);
	});

	it("被 ANSI 转义序列夹住的：前缀后面紧跟序列的、序列插在前缀中间的都认不出，原样", () => {
		for (const text of [
			`${TOKEN_PREFIXES.session}\u001b[0m${"0123456789abcdef".repeat(3)}`,
			`\u001b[01;31msfly_ses\u001b[m_${"0123456789abcdef".repeat(3)}`,
		]) {
			expect(maskSessionTokens(text), JSON.stringify(text)).toBe(text);
		}
	});

	it("编码过的、大小写改过的、字符之间插了空格的：原样", () => {
		const hex = "0123456789abcdef".repeat(3);
		for (const text of [
			Buffer.from(TOKEN).toString("base64"),
			TOKEN.toUpperCase(),
			[...TOKEN].join(" "),
			`'sfly_ses_''${hex}'`,
		]) {
			expect(maskSessionTokens(text), text).toBe(text);
		}
	});
});
