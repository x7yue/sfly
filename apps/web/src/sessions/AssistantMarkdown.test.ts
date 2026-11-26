import { describe, expect, it } from "vitest";
import { linkHost } from "./AssistantMarkdown";

describe("助手的话里的链接：只认 http(s) 的绝对地址", () => {
	it("http、https 返回主机名（带端口）", () => {
		expect(linkHost("https://example.com/docs")).toBe("example.com");
		expect(linkHost("http://10.0.0.5:8080/a?b=1")).toBe("10.0.0.5:8080");
	});

	it("别的协议（javascript:、data:、mailto:、file:）和相对地址、空的都不是：只显示文字，不可点", () => {
		for (const href of [
			"javascript:alert(1)",
			"JaVaScRiPt:alert(1)",
			"data:text/html,<script>1</script>",
			"mailto:a@b.c",
			"file:///etc/passwd",
			"/runs/abc",
			"./x.md",
			"//evil.example/x",
			"",
		]) {
			expect(linkHost(href), href).toBeNull();
		}
		expect(linkHost(undefined)).toBeNull();
	});
});
