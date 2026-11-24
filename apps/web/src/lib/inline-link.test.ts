import { describe, expect, it } from "vitest";
import { INLINE_LINK, INLINE_LINK_CHILDREN } from "./inline-link";

describe("行内链接的样式", () => {
	it("给容器直接子元素 <a> 的那一份和 INLINE_LINK 是同一套类", () => {
		const prefixed = INLINE_LINK.split(" ")
			.map((name) => `*:[a]:${name}`)
			.join(" ");
		expect(INLINE_LINK_CHILDREN).toBe(prefixed);
	});

	it("文字比周围的 fg-2、fg-3 亮（fg-1），下划线单独设色（不跟随文字色）", () => {
		expect(INLINE_LINK.split(" ")).toEqual(
			expect.arrayContaining(["text-fg-1", "underline", "decoration-fg-3"]),
		);
	});
});
