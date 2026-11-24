import { SCOPES } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { SCOPE_SEPARATOR, scopeLabels, scopesText, viaLabel } from "./copy";

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
