import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	agentNameProblem,
	installCommand,
	NAME_EDGE_WHITESPACE,
	shellQuote,
} from "./credential-command";

describe("装到测试机上的命令", () => {
	it("一行，放在子 shell 里：read -rs 读入凭据（输入不显示）、export、再运行安装脚本；凭据不在命令里", () => {
		const command = installCommand("http://sfly.internal:8080/install.sh", "agent-a");
		expect(command).toBe(
			"(read -rs SFLY_TOKEN && export SFLY_TOKEN && " +
				"curl -fsSL http://sfly.internal:8080/install.sh | sh -s -- --name agent-a)",
		);
		// 一行：没有换行，两行一起粘贴时 `read` 读走第二行的事不会发生（没有括号粘贴的终端里凭据会被当成命令执行）。
		expect(command).not.toContain("\n");
		// 不把凭据放进命令行参数：命令里没有 --token，也没有 sfly_agt_ 开头的原值。
		expect(command).not.toContain("--token");
		expect(command).not.toContain("sfly_agt_");
		expect(command.startsWith("(read -rs SFLY_TOKEN && export SFLY_TOKEN && ")).toBe(true);
		expect(command.endsWith(")")).toBe(true);
	});

	it("还不知道名字时写占位", () => {
		expect(installCommand("http://sfly.example:8080/install.sh", null)).toBe(
			"(read -rs SFLY_TOKEN && export SFLY_TOKEN && " +
				"curl -fsSL http://sfly.example:8080/install.sh | sh -s -- --name <名称>)",
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
			"--name 'x; echo pwned')",
		);
	});

	it("控制面的地址也只当一个参数", () => {
		expect(installCommand("http://h/install.sh?x=1&y=2", "a")).toContain(
			"curl -fsSL 'http://h/install.sh?x=1&y=2' |",
		);
	});
});

/**
 * 真的用 bash 运行页面上的命令（`curl` 换成桩，把装进来的环境和参数写到文件里）：
 * 命令是一行、凭据读进来交给安装脚本、`read` 读不到凭据时不装、装完之后交互 shell 里没有 SFLY_TOKEN。
 */
describe("装到测试机上的命令：真的运行", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sfly-cmd-"));
		// 桩 curl：输出一段脚本，脚本把 SFLY_TOKEN、收到的参数个数和 --name 的值写到 $OUT。
		writeFileSync(
			join(dir, "curl"),
			`#!/bin/sh\necho 'printf "%s|%s|%s" "$SFLY_TOKEN" "$#" "$2" > "$OUT"'\n`,
			{ mode: 0o755 },
		);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	/** 在 bash 里运行命令；`input` 是它的标准输入（读者粘贴的凭据）；`after` 是命令之后同一个 shell 里再运行的一句。 */
	const run = (command: string, input: string, after = "") => {
		const out = join(dir, "out");
		const result = spawnSync("bash", ["--noprofile", "--norc", "-c", `${command}\n${after}`], {
			input,
			env: { PATH: `${dir}:/usr/bin:/bin`, OUT: out },
			encoding: "utf8",
		});
		return { ...result, installed: existsSync(out) ? readFileSync(out, "utf8") : null };
	};

	it("粘贴的凭据交给安装脚本（环境变量），名字作为一个参数；命令之后的交互 shell 里没有 SFLY_TOKEN", () => {
		const command = installCommand("http://sfly.internal:8080/install.sh", "worker 1");
		// `$SFLY_TOKEN` 没设置时 `${…-unset}` 写 unset：命令之后同一个 shell 里查一下。
		const result = run(
			command,
			"sfly_agt_secret\n",
			"echo after=[$(printenv SFLY_TOKEN || echo unset)]",
		);
		expect(result.status).toBe(0);
		// 凭据在环境变量里；参数只有 `--name` 和名字两个，名字是一个参数（带空格也是）。
		expect(result.installed).toBe("sfly_agt_secret|2|worker 1");
		expect(result.stdout).toContain("after=[unset]");
		// 凭据没有出现在输出里（read -s 不回显）。
		expect(result.stdout).not.toContain("sfly_agt_secret");
	});

	it("read 读不到凭据（标准输入已经结束）：不装", () => {
		const result = run(installCommand("http://sfly.internal:8080/install.sh", "a"), "");
		expect(result.installed).toBeNull();
		expect(result.status).not.toBe(0);
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
		// 名称中间的空白是名称的一部分，不做 trim（命令里整个加引号）。
		expect(agentNameProblem("a b")).toBeUndefined();
	});

	it("首尾有空白的不行（Agent 读 agent.env 时会去掉两侧的空白，Hello 报的名字和凭据对不上，永远连不上）", () => {
		for (const name of [" a", "a ", " a ", "a\u00a0", "\u3000a\u3000"]) {
			expect(agentNameProblem(name), JSON.stringify(name)).toBe(NAME_EDGE_WHITESPACE);
		}
		expect(NAME_EDGE_WHITESPACE).toContain("首尾不能有空白");
		expect(NAME_EDGE_WHITESPACE).toContain("agent.env");
	});

	it("和控制面签发接口的路径参数是同一个判断：页面说行的，接口也认；页面说不行的，接口也拒（首尾空白一类单列，见下）", () => {
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

	it("页面比控制面严的一类：首尾有空白的名称接口认、页面不让签发（控制面签发接口的规则不在这里动，命令行同样的问题另记）", () => {
		const params = agentsApi.issueCredential.params;
		for (const name of [" a", "a ", " a "]) {
			expect(params.safeParse({ name }).success, JSON.stringify(name)).toBe(true);
			expect(agentNameProblem(name), JSON.stringify(name)).toBe(NAME_EDGE_WHITESPACE);
		}
	});
});
