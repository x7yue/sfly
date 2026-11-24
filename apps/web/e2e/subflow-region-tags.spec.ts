import type { Locator } from "@playwright/test";
import { dock, nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";
import { stoppingRun } from "./stop-subflow-scenario";

// 子流程区域标题行右边的运行状态（「• 成功」）和卡片上边线外面的标签（always）不叠在一起（#595）：
// 区域上方留出标题行，标题行和卡片之间再留出标签的位置（REGION_PADDING.top）。标签缩得太小时不显示（语义缩放），
// 所以从刚显示标签的缩放（最紧的一档）开始，逐档放大，每一档都量。读元素的实际位置，不比像素。

const rect = (locator: Locator) =>
	locator.evaluate((el) => {
		const r = el.getBoundingClientRect();
		return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
	});

/** 标签之间 `gap-1` 的距离：标签和状态至少隔开这么多。 */
const MIN_GAP = 4;

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
]) {
	test(`画布运行状态：区域标题行右边的状态和卡片上的 always 标签之间留着空隙，缩放到哪一档都一样（${viewport.width}×${viewport.height}）`, async ({
		page,
		controlPlane,
		connectAgent,
		clock,
	}) => {
		await page.setViewportSize(viewport);
		const { runId, scenarioId, finish } = await stoppingRun(controlPlane, connectAgent, clock);
		await finish();
		await page.clock.setFixedTime(clock.now());
		await page.goto(`/orchestrations/${scenarioId}?run=${runId}`);
		await expect(nodeCard(page, "watch")).toHaveAttribute("data-run", "stopped");
		const tag = nodeCard(page, "flush").getByText("always", { exact: true });
		const status = page
			.locator("section[aria-label^='子流程 '] span.ml-auto")
			.filter({ hasText: "成功" });
		await expect(status).toHaveCount(1);

		// 缩放到刚显示标签的那一档（缩得更小时标签和细节都隐藏）。
		const zoomIn = dock(page).getByRole("button", { name: "放大" });
		for (let step = 0; step < 10 && !(await tag.isVisible()); step++) await zoomIn.click();
		await expect(tag).toBeVisible();

		for (let round = 0; round < 4; round++) {
			// 缩放有过渡：等位置稳定下来再量（横向有重叠的话，标签在状态下面隔开 MIN_GAP）。
			await expect
				.poll(async () => {
					const t = await rect(tag);
					const s = await rect(status);
					const overlapX = Math.min(t.right, s.right) - Math.max(t.left, s.left);
					return overlapX > 0 ? t.top - s.bottom : Number.POSITIVE_INFINITY;
				})
				.toBeGreaterThanOrEqual(MIN_GAP);
			await zoomIn.click();
		}
	});
}
