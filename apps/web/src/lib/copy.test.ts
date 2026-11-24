import { SCOPES, VIA_NAME_PATTERN, VIA_UNKNOWN } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { SCOPE_SEPARATOR, scopeLabels, scopesText, viaLabel } from "./copy";

describe("viaLabel", () => {
	it("已知的 AI 编程助手显示名称，其他名称原样显示", () => {
		expect(viaLabel("claude-code")).toBe("经 Claude Code");
		expect(viaLabel("codex")).toBe("经 Codex");
		expect(viaLabel("my-assistant")).toBe("经 my-assistant");
	});

	it("请求头里有 agent/ 但名称不合格时控制面存的固定值 ?（不可能是合格的名称），和库里旧的不合格值一样显示「未知」（新旧一致）；unknown 本身是合格的名称，原样显示", () => {
		expect(viaLabel(VIA_UNKNOWN)).toBe("经 未知");
		expect(viaLabel("?")).toBe("经 未知");
		expect(viaLabel("unknown")).toBe("经 unknown");
		expect(viaLabel("co\u202edex")).toBe("经 未知");
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

describe("VIA_UNKNOWN", () => {
	it("不可能是合格的名称：和请求头里合格的名称分得开（#691 复审）", () => {
		expect(VIA_NAME_PATTERN.test(VIA_UNKNOWN)).toBe(false);
	});
});

describe("范围的写法（令牌列表）", () => {
	it("scopeLabels 是每个范围的中文名，scopesText 是用顿号连起来的同一串（列表里按范围分段排，换行只在顿号处）", () => {
		const scopes = SCOPES;
		const labels = scopeLabels(scopes);
		expect(labels).toHaveLength(scopes.length);
		expect(scopesText(scopes)).toBe(labels.join(SCOPE_SEPARATOR));
		expect(SCOPE_SEPARATOR).toBe("、");
		expect(scopesText(scopes.slice(0, 1))).toBe(scopeLabels(scopes.slice(0, 1))[0]);
		expect(scopesText([])).toBe("");
	});
});
