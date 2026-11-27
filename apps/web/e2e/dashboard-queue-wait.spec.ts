import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { queuedOffline, queuedSlotsFull } from "./monitor-queue-scenario";

// 控制台运行块里排队中的节点写明在等什么（#601）：和运行监控概览的「进行中」同一句话（#457）。

const block = (page: Page, scenario: string) =>
	page
		.getByRole("region", { name: "正在运行" })
		.getByRole("region", { name: scenario, exact: true });

async function openDashboard(page: Page, clock: { now(): Date }) {
	await page.clock.setFixedTime(clock.now());
	await page.goto("/dashboard");
	await expect(page.getByRole("region", { name: "正在运行" })).toBeVisible();
}

test("Agent 不在线：进行中的那一行写明等谁、离线多久、排了多久、多久后超时，能跳到那台 Agent", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await queuedOffline(controlPlane, connectAgent, clock);
	await openDashboard(page, clock);
	const run = block(page, "准备环境场景");
	const note = run.getByTestId("queue-wait");
	await expect(note).toHaveCount(1);
	await expect(note).toHaveAttribute("data-state", "offline");
	await expect(note).toHaveText("等 agent-a（不在线，已离线 2m 05s）· 排队 5s · 4m 55s 后超时");
	// 这个节点单独占一行：节点名、「第 1 次尝试 · 排队中」，然后是这句话。
	const item = run.getByRole("list", { name: "进行中的节点" }).getByRole("listitem");
	await expect(item).toHaveCount(1);
	await expect(item).toContainText("准备环境");
	await expect(item).toContainText("第 1 次尝试 · 排队中 · 等 agent-a");
	// 一句话放得下，不被截断也不溢出运行块。
	const box = await run.boundingBox();
	const noteBox = await note.boundingBox();
	expect(noteBox && box && noteBox.x + noteBox.width <= box.x + box.width + 1).toBe(true);

	await note.getByRole("link", { name: "agent-a" }).click();
	await expect(page).toHaveURL(/\/agents#agent-agent-a$/);
});

test("Agent 在线、槽位占满：写明占着槽位的任务，运行编号链到那次运行", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { holderRunId } = await queuedSlotsFull(controlPlane, connectAgent, clock);
	await openDashboard(page, clock);
	// 两个运行块同一个场景名：排队的那个是带 queue-wait 的。
	const note = page.getByTestId("queue-wait");
	await expect(note).toHaveCount(1);
	await expect(note).toHaveAttribute("data-state", "slots_full");
	await expect(note).toContainText("等 agent-a（槽位占满，1 / 1）· 排队 10s · 4m 50s 后超时");
	const short = holderRunId.slice(0, 8);
	await expect(note.getByTestId("queue-wait-holders")).toHaveText(
		`；占着槽位的任务：准备环境场景（运行 ${short}）的 准备环境（a）`,
	);
	await note.getByRole("link", { name: `运行 ${short}` }).click();
	await expect(page).toHaveURL(new RegExp(`/runs/${holderRunId}`));
});

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
]) {
	test(`槽位占满那一句在运行块里换行：不溢出运行块，「排队 10s」不断在中间，页面没有横向滚动（${viewport.width}×${viewport.height}）`, async ({
		page,
		controlPlane,
		connectAgent,
		clock,
	}) => {
		await page.setViewportSize(viewport);
		await queuedSlotsFull(controlPlane, connectAgent, clock);
		await openDashboard(page, clock);
		const note = page.getByTestId("queue-wait");
		await expect(note).toHaveCount(1);
		const run = page
			.getByRole("region", { name: "正在运行" })
			.getByRole("region")
			.filter({ has: note });
		const lines = await note.evaluate((el) => {
			const range = document.createRange();
			range.selectNodeContents(el);
			const rects = Array.from(range.getClientRects());
			const tops = new Set(rects.map((r) => Math.round(r.top)));
			const timing = el.querySelector("span.whitespace-nowrap");
			return {
				lines: tops.size,
				right: Math.max(...rects.map((r) => r.right)),
				timingRects: timing ? timing.getClientRects().length : 0,
				timingText: timing?.textContent ?? "",
			};
		});
		const box = await run.boundingBox();
		expect(box).not.toBeNull();
		// 每一行都在运行块里。
		expect(lines.right).toBeLessThanOrEqual((box?.x ?? 0) + (box?.width ?? 0) + 1);
		// 「排队 10s」是一个整体：不在它中间换行。
		expect(lines.timingText).toContain("排队 10s");
		expect(lines.timingRects).toBe(1);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
	});
}
