import type { Locator } from "@playwright/test";

// 运行监控和画布的版面类 e2e 共用的测量：读元素排版后的实际宽度和高度（不比屏幕像素），文字有没有被截断、
// 一行里的各项有没有互相压住。

/**
 * 元素里的文字（包括里面的元素）有几处被截断：文字排出来的宽度超过了元素内容区的宽度。读的是排版后的实际宽度：
 * 元素带内边距时 `scrollWidth` 看不出差几个像素的截断（省略号已经出现了）。
 */
export const clippedCount = (locator: Locator) =>
	locator.evaluate((root) => {
		const clipped = (el: Element) => {
			const style = getComputedStyle(el);
			const range = document.createRange();
			range.selectNodeContents(el);
			const content =
				el.getBoundingClientRect().width -
				Number.parseFloat(style.paddingLeft) -
				Number.parseFloat(style.paddingRight) -
				Number.parseFloat(style.borderLeftWidth) -
				Number.parseFloat(style.borderRightWidth);
			const clips = style.overflowX !== "visible" || style.textOverflow === "ellipsis";
			// 内容超出一个像素以上才算（亚像素的取整不算）。
			return clips && range.getBoundingClientRect().width > content + 1;
		};
		return [root, ...root.querySelectorAll("*")].filter(clipped).length;
	});

/** 元素里的文字没有被截断。 */
export const fits = async (locator: Locator) => (await clippedCount(locator)) === 0;

/** 元素和它里面的每个元素都没有被截断，也没有伸出所在的块。 */
export const nothingClipped = clippedCount;

/**
 * 一行（按钮）里从左到右的每一项互不重叠，也没有伸出这一行：返回压在前一项上的项的文字，没有就是空数组。
 * （只量名称有没有被自己的方框截断看不出名称是不是压在后面的标签和耗时上。）
 */
export const overlaps = (row: Locator) =>
	row.evaluate((button) => {
		const box = button.getBoundingClientRect();
		let previous = box.left;
		const pressed: string[] = [];
		for (const el of button.children) {
			const { left, right } = el.getBoundingClientRect();
			if (left < previous - 0.5) pressed.push(el.textContent ?? "");
			previous = Math.max(previous, right);
		}
		if (previous > box.right + 0.5) pressed.push("（伸出了这一行）");
		return pressed;
	});

/** 元素的位置和大小（取整到 0.1px）。 */
export const rectOf = (locator: Locator) =>
	locator.evaluate((el) => {
		const r = el.getBoundingClientRect();
		const round = (n: number) => Math.round(n * 10) / 10;
		return { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) };
	});

/** 两个矩形有没有重叠（边挨着不算）。 */
export const intersects = (
	a: { x: number; y: number; width: number; height: number },
	b: { x: number; y: number; width: number; height: number },
) =>
	a.x < b.x + b.width - 0.5 &&
	b.x < a.x + a.width - 0.5 &&
	a.y < b.y + b.height - 0.5 &&
	b.y < a.y + a.height - 0.5;
