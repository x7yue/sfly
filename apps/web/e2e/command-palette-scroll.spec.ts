import type { Locator } from "@playwright/test";
import { expect, test } from "./fixtures";

// 命令面板的列表比窗口放得下的高时（#595）：下面还有内容就把底边渐隐，滚动位置正好切在某一行中间的那一行
// 不再像被提示栏盖住；滚到底时最后一项完整露出，不被提示栏压住；用方向键选中的项总在渐隐区上面。
// 读元素的实际位置，不比像素。

/** 列表底边渐隐区的高度（components/ui/command.tsx 的 mask-image，2rem）。 */
const FADE = 32;

const rect = (locator: Locator) =>
	locator.evaluate((el) => {
		const r = el.getBoundingClientRect();
		return { top: r.top, bottom: r.bottom };
	});

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
]) {
	test(`命令面板：列表下面还有内容时底边渐隐，滚到底最后一项完整露出（${viewport.width}×${viewport.height}）`, async ({
		page,
	}) => {
		await page.setViewportSize(viewport);
		await page.goto("/");
		await expect(page.getByRole("heading", { name: "控制台", exact: true })).toBeVisible();
		await page.keyboard.press("Control+k");
		const palette = page.getByRole("dialog", { name: "命令面板" });
		await expect(palette).toBeVisible();
		const list = palette.locator("[cmdk-list]");
		const footer = palette.locator("footer");
		const options = palette.getByRole("option");

		// 内容比列表高，真的要滚；没滚过时下面还有内容：底边渐隐。
		const sizes = await list.evaluate((el) => ({
			scroll: el.scrollHeight,
			client: el.clientHeight,
		}));
		expect(sizes.scroll).toBeGreaterThan(sizes.client);
		await expect(list).toHaveAttribute("data-more-below", "");
		await expect(list).toHaveCSS("mask-image", /linear-gradient/);

		// 列表和提示栏上下相接，不重叠。
		expect((await rect(list)).bottom).toBeLessThanOrEqual((await rect(footer)).top + 0.5);

		// 滚到底：不再渐隐，最后一项完整在列表里、在提示栏上面。
		await list.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		await expect(list).not.toHaveAttribute("data-more-below", "");
		await expect(list).toHaveCSS("mask-image", "none");
		const last = await rect(options.last());
		const box = await rect(list);
		expect(last.top).toBeGreaterThanOrEqual(box.top);
		expect(last.bottom).toBeLessThanOrEqual(box.bottom);
		expect(last.bottom).toBeLessThanOrEqual((await rect(footer)).top);

		// 方向键从头走到尾：选中的项总是完整在列表里，下面还有内容时也在渐隐区上面。
		await list.evaluate((el) => {
			el.scrollTop = 0;
		});
		await page.keyboard.press("Home");
		const count = await options.count();
		for (let i = 0; i < count; i++) {
			await expect
				.poll(async () => {
					const active = await rect(palette.locator('[cmdk-item][aria-selected="true"]'));
					const area = await rect(list);
					const fading = await list.evaluate((el) => el.hasAttribute("data-more-below"));
					return active.top >= area.top && active.bottom <= area.bottom - (fading ? FADE : 0);
				})
				.toBe(true);
			if (i < count - 1) await page.keyboard.press("ArrowDown");
		}

		// 筛选到放得下：不再渐隐。
		await page.keyboard.type("控制台");
		await expect(options).toHaveCount(1);
		await expect(list).not.toHaveAttribute("data-more-below", "");
		await expect(list).toHaveCSS("mask-image", "none");
	});
}
