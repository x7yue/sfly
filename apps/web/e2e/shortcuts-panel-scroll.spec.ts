import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";

// 快捷键面板内容比窗口高时（#595）：里面的内容下面还有时底边渐隐（切在行中间的那一行不再像被面板的下边缘切掉一半），
// 滚到底时最后一行完整露出（不再渐隐）。读元素的实际位置，不比像素。

const rect = (locator: Locator) =>
	locator.evaluate((el) => {
		const r = el.getBoundingClientRect();
		return { top: r.top, bottom: r.bottom };
	});

/** 滚到底时内容底边和滚动区域底边差的亚像素（scrollHeight 取整）。 */
const SUBPIXEL = 1;

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
]) {
	test(`快捷键面板：下面还有内容时底边渐隐，滚到底最后一行完整露出（${viewport.width}×${viewport.height}）`, async ({
		page,
	}) => {
		await page.setViewportSize(viewport);
		await page.goto("/");
		await expect(page.getByRole("heading", { name: "控制台", exact: true })).toBeVisible();
		await page.locator("body").press("?");
		const dialog = page.getByRole("dialog", { name: "快捷键" });
		await expect(dialog).toBeVisible();
		const rows = dialog.locator("dl > div");
		const scroller = dialog.locator("section").first().locator("xpath=..");

		// 内容比面板高，真的要滚；没滚过时下面还有内容：底边渐隐。
		const sizes = await scroller.evaluate((el) => ({
			scroll: el.scrollHeight,
			client: el.clientHeight,
		}));
		expect(sizes.scroll).toBeGreaterThan(sizes.client);
		await expect(scroller).toHaveAttribute("data-more-below", "");
		await expect(scroller).toHaveCSS("mask-image", /linear-gradient/);

		// 滚到底：不再渐隐；最后一行在滚动区域里（没被切），滚动区域在面板里，面板在窗口里。
		await scroller.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		await expect(scroller).not.toHaveAttribute("data-more-below", "");
		await expect(scroller).toHaveCSS("mask-image", "none");
		const area = await rect(scroller);
		const panel = await rect(dialog);
		const last = await rect(rows.last());
		expect(last.top).toBeGreaterThanOrEqual(area.top);
		expect(last.bottom).toBeLessThanOrEqual(area.bottom + SUBPIXEL);
		expect(area.bottom).toBeLessThanOrEqual(panel.bottom + SUBPIXEL);
		expect(panel.top).toBeGreaterThanOrEqual(0);
		expect(panel.bottom).toBeLessThanOrEqual(viewport.height);
		// 最后一行下面留着面板自己的内边距。
		expect(panel.bottom - last.bottom).toBeGreaterThanOrEqual(8);
	});
}
