import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";

// 快捷键面板里名称相同的登记合成一行（#595）：「删除节点 / 断开连线」写一次，按键是 Delete 或 Backspace。
// 这一行比别的行宽出一截（名称加两个键）：占一列的话五列（四列）都要跟着加宽，面板撑到铺满窗口（1440×900 里 1400px、
// 1280×800 里 1240px，窗口宽减 40px 的上限）；占两列，别的行的宽度不变，面板仍跟着内容走；占两列的行里按键紧跟在名称后面
// （不顶到右端）。读元素的实际位置，不比像素。

/** `width` 是排版宽度（offsetWidth），不受出场动画的缩放影响；`right` 是屏幕上的位置，只用来比较同一时刻的两个元素。 */
const rect = (locator: Locator) =>
	locator.evaluate((el) => ({
		right: el.getBoundingClientRect().right,
		width: (el as HTMLElement).offsetWidth,
	}));

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
]) {
	test(`快捷键面板：同名的登记合成一行、占两列，面板的宽度不被这一行撑开（${viewport.width}×${viewport.height}）`, async ({
		page,
	}) => {
		await page.setViewportSize(viewport);
		await page.goto("/");
		await expect(page.getByRole("heading", { name: "控制台", exact: true })).toBeVisible();
		await page.locator("body").press("?");
		const dialog = page.getByRole("dialog", { name: "快捷键" });
		await expect(dialog).toBeVisible();

		const group = dialog.getByRole("region", { name: "编排画布" });
		const merged = group.locator("dl > div").filter({ hasText: "删除节点 / 断开连线" });
		await expect(merged).toHaveCount(1);
		await expect(merged).toContainText("Delete");
		await expect(merged).toContainText("或");
		await expect(merged).toContainText("Backspace");

		// 占两列：比同一组里别的行宽得多；整行在这一组的表格里，没有伸出去。
		const other = group.locator("dl > div").filter({ hasText: "复制节点" }).first();
		const mergedBox = await rect(merged);
		const otherBox = await rect(other);
		expect(mergedBox.width).toBeGreaterThan(otherBox.width * 1.8);
		const list = await rect(group.locator("dl"));
		expect(mergedBox.right).toBeLessThanOrEqual(list.right + 0.5);

		// 按键跟在名称后面（别的行名称在左、按键顶到右端；这一行宽出一倍，顶到右端会在中间空出一大截）。
		const gap = await merged.evaluate((row) => {
			const name = row.querySelector("dt")?.getBoundingClientRect();
			const keys = row.querySelector("dd")?.getBoundingClientRect();
			if (!name || !keys) throw new Error("没有 dt、dd");
			return keys.left - name.right;
		});
		expect(gap).toBeGreaterThan(0);
		expect(gap).toBeLessThanOrEqual(16);

		// 面板跟着内容走：比窗口宽减 40px 的上限窄得多（不是被这一行撑到上限）。
		const panel = await rect(dialog);
		expect(panel.width).toBeLessThan(viewport.width - 100);
	});
}
