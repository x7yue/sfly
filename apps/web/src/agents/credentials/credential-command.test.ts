import { agentsApi } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	agentNameProblem,
	installCommand,
	READ_TOKEN_LINE,
	shellQuote,
} from "./credential-command";

describe("装到测试机上的命令", () => {
	it("两行：先 read -rs 读入凭据（输入不显示），再运行安装脚本；凭据不在命令里", () => {
		expect(installCommand("http://sfly.internal:8080/install.sh", "agent-a")).toBe(
			"read -rs SFLY_TOKEN && export SFLY_TOKEN\n" +
				"curl -fsSL http://sfly.internal:8080/install.sh | sh -s -- --name agent-a",
		);
		const command = installCommand("http://sfly.internal:8080/install.sh", "agent-a");
		// 不把凭据放进命令行参数：命令里没有 --token，也没有 sfly_agt_ 开头的原值。
		expect(command).not.toContain("--token");
		expect(command).not.toContain("sfly_agt_");
		expect(command.split("\n")[0]).toBe(READ_TOKEN_LINE);
	});

	it("还不知道名字时写占位", () => {
		expect(installCommand("http://sfly.example:8080/install.sh", null)).toBe(
			"read -rs SFLY_TOKEN && export SFLY_TOKEN\n" +
				"curl -fsSL http://sfly.example:8080/install.sh | sh -s -- --name <名称>",
		);
	});

	it("名称是别人起的：含空格、引号、$()、反引号、分号、非 ASCII 的名称整个放进单引号，只是一个参数", () => {
		expect(shellQuote("worker-1")).toBe("worker-1");
		expect(shellQuote("a b")).toBe("'a b'");
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
		expect(shellQuote("$(rm -rf ~)")).toBe("'$(rm -rf ~)'");
		expect(shellQuote("`id`")).toBe("'`id`'");
		expect(shellQuote("a;b")).toBe("'a;b'");
		expect(shellQuote("探测主机")).toBe("'探测主机'");
		expect(installCommand("http://h/install.sh", "x; echo pwned")).toContain(
			"--name 'x; echo pwned'",
		);
	});

	it("控制面的地址也只当一个参数", () => {
		expect(installCommand("http://h/install.sh?x=1&y=2", "a")).toContain(
			"curl -fsSL 'http://h/install.sh?x=1&y=2' |",
		);
	});
});

describe("给还没连过的名字签发：名称的规则和控制面一样", () => {
	it("空的、有零宽字符的、有控制字符的、超过 64 个字符的不行，带第几个字符", () => {
		expect(agentNameProblem("")).toBe("填写 Agent 的名称");
		expect(agentNameProblem("a\u200bb")).toContain("第 2 个字符是 U+200B");
		expect(agentNameProblem("a\u202eb")).toContain("U+202E");
		expect(agentNameProblem("a\nb")).toContain("U+000A");
		expect(agentNameProblem("x".repeat(65))).toBe("Agent 的名称不能超过 64 个字符");
	});

	it("64 个字符放得下（按字符数，不按字节）；中文、emoji 的名称照常；名称不做 trim", () => {
		expect(agentNameProblem("x".repeat(64))).toBeUndefined();
		expect(agentNameProblem("测".repeat(64))).toBeUndefined();
		expect(agentNameProblem("😀".repeat(64))).toBeUndefined();
		expect(agentNameProblem("探测主机-1")).toBeUndefined();
		expect(agentNameProblem(" a ")).toBeUndefined();
	});

	it("和控制面签发接口的路径参数是同一个判断：页面说行的，接口也认；页面说不行的，接口也拒", () => {
		const params = agentsApi.issueCredential.params;
		for (const name of [
			"",
			"a",
			"a b",
			"x".repeat(64),
			"x".repeat(65),
			"a\u200bb",
			"a\nb",
			"😀".repeat(64),
		]) {
			expect(agentNameProblem(name) === undefined).toBe(params.safeParse({ name }).success);
		}
	});
});
