import { describe, expect, it } from "vitest";
import { viaLabel } from "./copy";

describe("viaLabel", () => {
	it("已知的 AI 编程助手显示名称，其他名称原样显示", () => {
		expect(viaLabel("claude-code")).toBe("经 Claude Code");
		expect(viaLabel("codex")).toBe("经 Codex");
		expect(viaLabel("my-assistant")).toBe("经 my-assistant");
	});

	it("名称恰好是对象自带的属性名时也原样显示", () => {
		expect(viaLabel("constructor")).toBe("经 constructor");
		expect(viaLabel("toString")).toBe("经 toString");
	});

	// 库里升级之前存下的旧值（#670 之前什么都能存）：显示时按同一个规则判断，不合格的写「未知」，不原样显示。
	// 字符都用码位造出来。
	it("旧值里有控制字符、双向控制字符、零宽空格、超长或符号的：不原样显示", () => {
		const c = (...points: number[]) => String.fromCodePoint(...points);
		for (const bad of [
			`codex${c(0x9b)}2J`,
			`codex${c(0x202e)}`,
			`co${c(0x200b)}dex`,
			`codex${c(0xe0067)}`,
			"a".repeat(65),
			"<b>codex</b>",
			"",
		]) {
			expect(viaLabel(bad), JSON.stringify(bad)).toBe("经 未知");
		}
		expect(viaLabel("a".repeat(64))).toBe(`经 ${"a".repeat(64)}`);
	});
});
