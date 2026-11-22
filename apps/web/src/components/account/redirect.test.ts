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

	it("路径里任何位置的反斜杠和控制字符（制表符、换行、NUL、DEL）都回首页：自己拒绝，不靠路由库兜底", () => {
		for (const bad of [
			"/\t/evil.example",
			"/\u000b/evil.example",
			"/\n/evil.example",
			"/\r/evil.example",
			"/\u0000/evil.example",
			"/\u007f/evil.example",
			"/a\\b",
			"/ok/path\\..\\evil",
			"/runs/1\n",
		]) {
			expect(safeRedirect(bad), JSON.stringify(bad)).toBe("/");
		}
		// 正常路径里的百分号编码、中文、空格编码不受影响。
		expect(safeRedirect("/orchestrations/%E5%9C%BA%E6%99%AF?name=a%20b")).toBe(
			"/orchestrations/%E5%9C%BA%E6%99%AF?name=a%20b",
		);
		expect(safeRedirect("/场景")).toBe("/场景");
	});

	it("登录页和初始化页自己不当作回去的地方（登录后又回到登录页）", () => {
		expect(safeRedirect("/login")).toBe("/");
		expect(safeRedirect("/login?redirect=%2F")).toBe("/");
		expect(safeRedirect("/setup")).toBe("/");
	});
});
