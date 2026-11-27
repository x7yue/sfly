import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { openMonitor, runningScenario } from "./monitor-scenario";

// 打开带 `?node=` 的地址时选中节点那一组的图表（#383）：版面变了（底部面板变高、图表工作区变矮）仍然对准，
// 直到用户自己滚动图表工作区。

const workspace = (page: Page) => page.getByRole("region", { name: "图表工作区" });

/** 第一张图表在工作区里露出的比例：减去吸顶的工具栏盖住的那一截。 */
const shownRatio = (chart: Locator) =>
	chart.evaluate((node) => {
		const box = node.closest('[aria-label="图表工作区"]') as HTMLElement;
		const bar = box.querySelector('[role="toolbar"]') as HTMLElement;
		const r = node.getBoundingClientRect();
		const top = Math.max(box.getBoundingClientRect().top, bar.getBoundingClientRect().bottom);
		const shown = Math.min(r.bottom, box.getBoundingClientRect().bottom) - Math.max(r.top, top);
		return Math.max(0, shown) / r.height;
	});

/** 把底部面板的上沿往上拖 `dy` 像素：面板变高，上面的图表工作区和时间线变矮。 */
async function dragPanel(page: Page, dy: number) {
	const handle = page.getByRole("separator", { name: "调整底部面板高度" });
	const box = await handle.boundingBox();
	if (!box) throw new Error("没有拖动条");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2, box.y - dy, { steps: 4 });
	await page.mouse.up();
}

test("带 ?node= 打开后底部面板变高、图表工作区变矮，选中的组仍然看得见；用户滚动过以后不再替他对准", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	// probe 那一组排在工作区的最后一个节点组，打开时在底下。
	await openMonitor(page, clock, runId, "probe");
	const ws = workspace(page);
	await expect(ws.getByText("加载中")).toHaveCount(0);
	const chart = ws.locator('[data-group$=":probe"] [data-chart]').first();
	await expect(chart).toBeVisible();
	await expect.poll(() => shownRatio(chart)).toBeGreaterThanOrEqual(0.75);

	const before = (await ws.boundingBox())?.height ?? 0;
	await dragPanel(page, 200);
	await expect.poll(async () => (await ws.boundingBox())?.height ?? 0).toBeLessThan(before - 50);
	await expect
		.poll(() => shownRatio(chart), { message: "工作区变矮以后，选中的组的第一张图表露出的比例" })
		.toBeGreaterThanOrEqual(0.75);

	// 用户自己滚回顶部以后，版面再变也不跳回去。
	await ws.hover();
	await page.mouse.wheel(0, -5000);
	await expect.poll(() => ws.evaluate((el) => el.scrollTop)).toBe(0);
	await dragPanel(page, -100);
	// biome-ignore lint/plugin/e2e-fixed-wait: 确认工作区没有被滚回去，只能等一段时间再看
	await page.waitForTimeout(300);
	expect(await ws.evaluate((el) => el.scrollTop)).toBe(0);
});
