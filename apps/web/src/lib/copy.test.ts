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
});
