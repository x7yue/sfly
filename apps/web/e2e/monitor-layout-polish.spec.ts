import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { failedRun } from "./monitor-failure-scenario";
import { rectOf } from "./monitor-layout-support";
import { openMonitor, runningScenario } from "./monitor-scenario";
import { openOverview } from "./overview-support";

// 运行监控版面的几处（#595 第 6 到 10 条，从 #586 的审查里挪来的）：1024×768 里图表区的预留、选中节点时图表的定位、
// 时间线自动滚动对齐到行、顶栏在宽屏里失败摘要和各链状态一起显示、短链的线路铺满整行。读元素排版后的实际位置，不比像素。

const workspace = (page: Page) => page.getByRole("region", { name: "图表工作区" });
const header = (page: Page) => page.getByRole("banner");

/**
 * 一个元素在图表工作区里露出来的高度：工作区的滚动区域减去吸顶的工具栏（工具栏盖住的那一截看不到）。
 */
const visibleInWorkspace = (el: Locator) =>
	el.evaluate((node) => {
		const box = node.closest('[aria-label="图表工作区"]') as HTMLElement;
		const bar = box.querySelector('[role="toolbar"]') as HTMLElement;
		const r = node.getBoundingClientRect();
		const top = Math.max(box.getBoundingClientRect().top, bar.getBoundingClientRect().bottom);
		return Math.max(
			0,
			Math.min(r.bottom, box.getBoundingClientRect().bottom) - Math.max(r.top, top),
		);
	});

/** 能看清曲线的图表高度：一张图表的绘图区（136px 高）至少露出这么多（和 monitor-narrow 里是同一个数）。 */
const VISIBLE_FIGURE = 120;

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
	{ width: 1024, height: 768 },
]) {
	const size = `${viewport.width}×${viewport.height}`;

	test(`详情：第一张图表露出能看清曲线的高度，工具栏折成几行时预留的高度跟着加（${size}）`, async ({
		page,
		controlPlane,
		connectAgent,
		clock,
	}) => {
		await page.setViewportSize(viewport);
		const { runId } = await failedRun(controlPlane, connectAgent, clock, {
			cleanupDone: true,
			metrics: true,
		});
		await openMonitor(page, clock, runId);
		const figure = workspace(page).getByRole("figure").first();
		await expect(figure).toBeVisible();
		const visible = await visibleInWorkspace(figure);
		const toolbar = await rectOf(workspace(page).getByRole("toolbar", { name: "图表工具栏" }));
		expect(
			visible,
			`${size}：第一张图表露出 ${visible}px，工具栏 ${toolbar.height}px，图表工作区 ${(await rectOf(workspace(page))).height}px`,
		).toBeGreaterThanOrEqual(VISIBLE_FIGURE);
	});
}

test("选中节点时，它那一组的第一张图表露出大半：选中靠后的节点（组在工作区下面看不到的地方）也滚到看得见", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	// probe 是子流程里的节点，它那一组排在工作区的最后一个节点组，打开时在底下。
	await openMonitor(page, clock, runId, "probe");
	const ws = workspace(page);
	await expect(ws.locator("[data-group]").first()).toBeVisible();
	await expect(ws.getByText("加载中")).toHaveCount(0);
	const group = ws.locator('[data-group$=":probe"]');
	const chart = group.locator("[data-chart]").first();
	await expect(chart).toBeVisible();
	const height = (await rectOf(chart)).height;
	await expect
		.poll(() => visibleInWorkspace(chart), { message: "选中的节点那一组的第一张图表露出的高度" })
		.toBeGreaterThanOrEqual(height * 0.75);
});

test("时间线选中最后一行的节点后，自动滚动停在行的上沿：没有哪一行被吸顶的刻度行压住一半", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId, "probe");
	const line = page.getByRole("region", { name: "链路时间线" });
	await expect(line.locator("[data-node-item]").last()).toBeVisible();
	await expect
		.poll(
			() =>
				line.evaluate((section) => {
					const axis = section.querySelector("[data-axis-track]")?.parentElement;
					if (!axis) throw new Error("没有刻度行");
					const edge = axis.getBoundingClientRect().bottom;
					return [...section.querySelectorAll("[data-chain-row], [data-node-item]")]
						.map((row) => row.getBoundingClientRect())
						.filter((r) => r.top < edge - 0.5 && r.bottom > edge + 0.5).length;
				}),
			{ message: "被刻度行压住一半的行数" },
		)
		.toBe(0);
});

test("顶栏：宽屏（1920×1080）里失败摘要和各链状态一起显示，没有哪个被挤没了、顶栏不被撑出屏幕", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await page.setViewportSize({ width: 1920, height: 1080 });
	// 运行还在进行、已有节点失败：详情里没有失败横幅，失败摘要在顶栏。
	const { runId } = await failedRun(controlPlane, connectAgent, clock, { cleanupDone: false });
	await openMonitor(page, clock, runId);
	const bar = header(page);
	const summary = bar.getByTestId("run-failure");
	await expect(summary).toBeVisible();
	const chains = bar.getByRole("list", { name: "各链状态" });
	await expect(chains).toBeVisible();
	const badges = chains.getByRole("listitem");
	expect(await badges.count()).toBeGreaterThan(0);
	// 每个状态徽标都完整露出（没有被 overflow 裁掉）。
	const listBox = await rectOf(chains);
	for (const badge of await badges.all()) {
		const box = await rectOf(badge);
		expect(box.x + box.width).toBeLessThanOrEqual(listBox.x + listBox.width + 0.5);
		expect(box.width).toBeGreaterThan(0);
	}
	expect((await rectOf(summary)).width).toBeGreaterThanOrEqual(320);
	expect(await bar.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
});

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 1024, height: 768 },
]) {
	const size = `${viewport.width}×${viewport.height}`;

	test(`概览：站放得下时每条链的各站平分整行（短链不挤在左边一两百像素），放不下时不溢出（${size}）`, async ({
		page,
		controlPlane,
		connectAgent,
		clock,
	}) => {
		await page.setViewportSize(viewport);
		const { runId } = await runningScenario(controlPlane, connectAgent, clock);
		await openOverview(page, clock, runId);
		const rows = page.getByRole("list", { name: "各链进度" }).locator(":scope > li");
		await expect(rows).toHaveCount(2);
		for (const row of await rows.all()) {
			const measured = await row.evaluate((li) => {
				const stations = [...li.querySelectorAll("ol > li")].map((s) => s.getBoundingClientRect());
				const count =
					li.querySelector("[data-skipped-count]")?.parentElement ?? li.lastElementChild;
				if (!count || stations.length === 0) throw new Error("没有站或计数");
				const last = stations[stations.length - 1] as DOMRect;
				return {
					gap: count.getBoundingClientRect().left - last.right,
					overflow: li.scrollWidth - li.clientWidth,
					widths: stations.map((s) => Math.round(s.width)),
				};
			});
			// 最后一站的格子一直铺到计数那一列（站名那几列分掉了整行剩下的宽度，没有一整块空白）。
			expect(measured.gap, `${size}：${JSON.stringify(measured)}`).toBeLessThanOrEqual(8);
			expect(measured.overflow, `${size}：${JSON.stringify(measured)}`).toBeLessThanOrEqual(0);
		}
	});
}
