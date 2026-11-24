// 环境变量写错时，报错里回显什么只有一处决定（src/config/echo.ts，#619）：**只有数值类回显，最多 12 个字符**，别的一律不回显
// （「认得的才回显」认得的形状里仍然装得下任意内容：地址的主机位置没有长度上限，代理项的字符集和令牌重合，所以收到只剩数值类）。
// 这里是那个函数自己的单元测试；每个变量 × 各种带凭据的形状、走真的 main.ts 的总表在 main-env-settings.test.ts。
import { describe, expect, it } from "vitest";
import { echoNumber, MAX_ECHO_CHARS, NOT_ECHOED } from "../src/config/echo.js";

/** 凭据的标记：回显里不能出现它（哪怕是一部分）。 */
const MARK = "SECRET_MARK_x7q9";
const USER = "USERMARK-k3m8";

describe("echoNumber：数值类", () => {
	it("上限是 12 个字符", () => {
		expect(MAX_ECHO_CHARS).toBe(12);
	});

	it.each([
		"30",
		"0.5",
		"-1",
		"+8080",
		"1e300",
		"1,5",
		"--1",
		".",
		"80 80",
		"10MB",
		"30 天",
		"5d",
		"0x10",
		"NaN",
		"Infinity",
		"-Infinity",
		// 正好 12 个字符。
		"123456789012",
		"1048576000MB".slice(0, 12),
	])("像一个数、或者认得的词，不超过 12 个字符（%s）：原样回显（带引号）", (value) => {
		expect(value.length).toBeLessThanOrEqual(12);
		expect(echoNumber(value)).toBe(JSON.stringify(value));
	});

	it("前后的空白不算，回显的是去掉空白的", () => {
		expect(echoNumber("  30  ")).toBe('"30"');
		expect(echoNumber(" ".repeat(40) + "30")).toBe('"30"');
	});

	it.each([
		["13 个数字", "1234567890123"],
		["28 位数字", "9".repeat(28)],
		["银行卡号的写法", "4111-1111-1111-1111"],
		["很长的十六进制", `0x${"a".repeat(30)}`],
		["太长的 e", "e".repeat(40)],
		["数字加令牌", `30${MARK}`],
		["地址", `postgres://${USER}:${MARK}@db:5432/sfly`],
	])("超过 12 个字符（%s）：不回显，只说有多少个字符", (_, value) => {
		const shown = echoNumber(value);

		expect(shown).toBe(NOT_ECHOED.tooLong(value.length));
		expect(shown).toContain(`有 ${value.length} 个字符`);
		expect(shown).not.toContain(MARK);
		expect(shown).not.toContain(USER);
	});

	it.each([
		["一个词", "abc"],
		["短的令牌", "Zq7k"],
		["用户名密码@主机（短）", "u:p@h"],
		["全角 ＠", "u:p＠h"],
		["十六进制字母", "deadbeef"],
	])("不像数、不超过 12 个字符（%s）：不回显", (_, value) => {
		expect(echoNumber(value)).toBe(NOT_ECHOED.unknown);
	});
});
