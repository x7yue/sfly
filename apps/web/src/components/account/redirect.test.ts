import { describe, expect, it } from "vitest";
import { safeRedirect } from "./redirect";

describe("登录之后回到哪里", () => {
	it("本站的路径照常（含查询参数和哈希）", () => {
		expect(safeRedirect("/orchestrations/abc")).toBe("/orchestrations/abc");
		expect(safeRedirect("/runs/1?node=a#logs")).toBe("/runs/1?node=a#logs");
	});

	it("别的站点的地址、协议相对地址、反斜杠、javascript: 都回首页", () => {
		for (const bad of [
			"https://evil.example/",
			"//evil.example/x",
			"/\\evil.example",
			"javascript:alert(1)",
			"evil.example",
			"",
			undefined,
			42,
		]) {
			expect(safeRedirect(bad), String(bad)).toBe("/");
		}
	});

	it("登录页和初始化页自己不当作回去的地方（登录后又回到登录页）", () => {
		expect(safeRedirect("/login")).toBe("/");
		expect(safeRedirect("/login?redirect=%2F")).toBe("/");
		expect(safeRedirect("/setup")).toBe("/");
	});
});
