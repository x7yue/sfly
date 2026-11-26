import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusFirst } from "./focus-recovery";

// focusFirst：按顺序试，第一个真的拿到了焦点的为止。声明的接班元素选到了却聚焦不上（被禁用、被隐藏）时要往下试，
// 不能停在它上面（e2e 里接班元素要么没有、要么能聚焦，走不到这一支，所以在这里用假的 document 测）。

interface Fake {
	element: HTMLElement;
	/** `focus()` 被调了几次。 */
	attempts: () => number;
}

let doc: { activeElement: unknown };

beforeEach(() => {
	doc = { activeElement: null };
	vi.stubGlobal("document", doc);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** 能聚焦的元素：`focus()` 之后成为 `document.activeElement`；聚焦不上的（被禁用、被隐藏）`focus()` 什么也不做，和浏览器一样。 */
function fake(focusable: boolean): Fake {
	let attempts = 0;
	const element = {
		focus() {
			attempts++;
			if (focusable) doc.activeElement = element;
		},
	} as unknown as HTMLElement;
	return { element, attempts: () => attempts };
}

describe("focusFirst：按顺序试，第一个真的拿到了焦点的为止", () => {
	it("第一个能聚焦就停在它，后面的不再试", () => {
		const [a, b] = [fake(true), fake(true)];
		expect(focusFirst([a.element, b.element])).toBe(a.element);
		expect(doc.activeElement).toBe(a.element);
		expect(b.attempts()).toBe(0);
	});

	it("选到了却聚焦不上（被禁用、被隐藏）：往下试，交给第一个真拿到焦点的", () => {
		const [disabled, hidden, ok, later] = [fake(false), fake(false), fake(true), fake(true)];
		expect(focusFirst([disabled.element, hidden.element, ok.element, later.element])).toBe(
			ok.element,
		);
		expect(doc.activeElement).toBe(ok.element);
		expect([disabled.attempts(), hidden.attempts(), ok.attempts(), later.attempts()]).toEqual([
			1, 1, 1, 0,
		]);
	});

	it("都聚焦不上：每个试一次，返回 null，焦点不动", () => {
		const [a, b] = [fake(false), fake(false)];
		expect(focusFirst([a.element, b.element])).toBeNull();
		expect(doc.activeElement).toBeNull();
		expect([a.attempts(), b.attempts()]).toEqual([1, 1]);
	});

	it("一个都没有：返回 null", () => {
		expect(focusFirst([])).toBeNull();
	});

	it("接班元素的来源是惰性的：前面的聚焦上了，后面的候选（要去查 DOM 的相邻项、页面标题）不再求值", () => {
		let evaluated = 0;
		function* targets(): Generator<HTMLElement> {
			evaluated++;
			yield fake(true).element;
			evaluated++;
			yield fake(true).element;
		}
		focusFirst(targets());
		expect(evaluated).toBe(1);
	});
});
