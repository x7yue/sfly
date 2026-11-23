// 环境变量写错时，报错里回显什么只有一处决定（src/config/echo.ts，#619 的审查）：认得的才回显，不是「看起来像凭据的不回显」。
// 这里是那几个函数自己的单元测试：每一种回显 × 各种带凭据的形状（半角和全角的 @、路径里的令牌、查询串里的令牌、用户名密码）。
// 走真的 main.ts、每个字符串类变量都过一遍的总表在 main-env-settings.test.ts。
import { describe, expect, it } from "vitest";
import { echoNumber, echoProxyItem, echoUrl, NOT_ECHOED } from "../src/config/echo.js";

/** 凭据的标记：回显里不能出现它（哪怕是一部分）。 */
const MARK = "SECRET_MARK_x7q9";
// 用户名里不放下划线：协议名里不能有它，没有协议的写法（`用户名:密码@主机`）才会被解析成「协议 用户名:」。
const USER = "USERMARK-k3m8";

describe("echoUrl：地址类", () => {
	it("能解析、协议认得：只回显协议、主机和端口（带引号），路径、查询串、片段、用户名密码都不回显", () => {
		expect(echoUrl("https://sfly.example.com:8443/path?x=1#top")).toBe(
			'"https://sfly.example.com:8443"',
		);
		expect(echoUrl("  http://[::1]:8080/  ")).toBe('"http://[::1]:8080"');
		expect(echoUrl("HTTPS://Sfly.Example.com")).toBe('"https://sfly.example.com"');
		expect(echoUrl("file://fileserver/share/pypi")).toBe('"file://fileserver"');
		expect(echoUrl("socks5://proxy:1080")).toBe(NOT_ECHOED.protocol);
	});

	it.each([
		["用户名和密码", `https://${USER}:${MARK}@host.example.com/p`],
		["只有密码", `https://${MARK}@host.example.com`],
		["令牌在路径里", `https://host.example.com/${MARK}`],
		["令牌在查询串里", `https://host.example.com/p?token=${MARK}`],
		["令牌在片段里", `https://host.example.com/p#${MARK}`],
		["别的协议、带用户名和密码", `postgres://${USER}:${MARK}@db.internal:5432/sfly?x=${MARK}`],
		["ftp、带用户名和密码", `ftp://${USER}:${MARK}@host.example.com:2121/${MARK}`],
		[
			"密码里有未转义的 @（最后一个 @ 前面都是用户信息）",
			`https://${USER}:p@${MARK}@host.example.com`,
		],
	])("能解析的地址带着凭据（%s）：回显里没有凭据", (_, value) => {
		const shown = echoUrl(value);

		expect(shown).not.toContain(MARK);
		expect(shown).not.toContain(USER);
		expect(shown).toMatch(/^"[a-z]+:\/\/[^"@/]+"$|^（/);
	});

	it.each([
		["半角 @，没有协议（被解析成协议 用户名:）", `${USER}:${MARK}@host.example.com`],
		["全角 ＠", `https://${USER}:${MARK}＠host.example.com/p`],
		["没有协议、令牌在路径里", `host.example.com/${MARK}`],
		["没有协议、令牌在查询串里", `host.example.com/p?token=${MARK}`],
		["主机里有空格", `https://host example.com/${MARK}`],
		["端口写错", `https://${USER}:${MARK}@host.example.com:abc/p`],
		["协议写错", `https//${USER}:${MARK}@host.example.com`],
	])("认不出的写法（%s）：什么都不回显，只说明没有回显", (_, value) => {
		const shown = echoUrl(value);

		expect(shown).not.toContain(MARK);
		expect(shown).not.toContain(USER);
		expect(shown.startsWith("（")).toBe(true);
		expect(shown.endsWith("没有回显）")).toBe(true);
	});

	it("没有协议（用户名:密码@主机、主机:端口）被解析成别的协议：说明是协议不认得，不把它当协议写出来", () => {
		expect(echoUrl(`${USER}:${MARK}@host.example.com`)).toBe(NOT_ECHOED.protocol);
		expect(echoUrl("sfly.internal:8080")).toBe(NOT_ECHOED.protocol);
	});

	it("解析不了：说明是解析不了；路径：说明是一个路径", () => {
		expect(echoUrl("dash.example.com")).toBe(NOT_ECHOED.unparseable);
		expect(echoUrl("")).toBe(NOT_ECHOED.unparseable);
		expect(echoUrl(`/mnt/${MARK}/mirror`)).toBe(NOT_ECHOED.path);
	});
});

describe("echoNumber：数字类", () => {
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
	])("像一个数、或者认得的词（%s）：原样回显（带引号）", (value) => {
		expect(echoNumber(value)).toBe(JSON.stringify(value));
	});

	it.each([
		["一个词", "abc"],
		["令牌", MARK],
		["用户名密码@主机", `${USER}:${MARK}@host`],
		["地址", `postgres://${USER}:${MARK}@db:5432/sfly`],
		["数字后面跟着令牌", `30${MARK}`],
		["数字加空格加令牌", `30 ${MARK}`],
		["全角 ＠", `${USER}:${MARK}＠host`],
		["像十六进制的令牌", "deadbeefcafe0123456789abcdef"],
		["太长", "1".repeat(40)],
	])("不像数（%s）：不回显", (_, value) => {
		expect(echoNumber(value)).toBe(NOT_ECHOED.unknown);
	});
});

describe("echoProxyItem：代理信任的一项", () => {
	it.each([
		"127.0.0.1",
		"10.0.0.0/8",
		"10.0.0.0/33",
		"10.0.0.256",
		"fd00::/8",
		"::1",
		"2001:db8::1/129",
		"loopback",
		"LinkLocal",
		"uniquelocal",
	])("IP、网段、关键字的样子（%s）：原样回显（带引号）", (value) => {
		expect(echoProxyItem(value)).toBe(JSON.stringify(value));
	});

	it.each([
		["一个词", "banana"],
		["令牌", MARK],
		["用户名密码@主机", `${USER}:${MARK}@proxy.internal`],
		["带协议的地址", `https://${USER}:${MARK}@proxy.internal`],
		["全角 ＠", `${USER}:${MARK}＠proxy.internal`],
		["令牌在路径里", `proxy.internal/${MARK}`],
		["令牌在查询串里", `10.0.0.1?token=${MARK}`],
		["只有十六进制字符的令牌", "deadbeefcafe0123456789abcdef"],
		["一个数字", "300"],
		["太长", `${"1.".repeat(40)}1`],
	])("不是 IP、网段、关键字的样子（%s）：不回显", (_, value) => {
		expect(echoProxyItem(value)).toBe(NOT_ECHOED.unknown);
	});
});
