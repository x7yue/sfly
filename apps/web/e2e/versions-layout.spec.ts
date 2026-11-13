import type { Page } from "@playwright/test";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { createEditorScenario } from "./editor-support";
import { expect, test } from "./fixtures";
import { box } from "./support";
import { saveSecondVersion, secondVersion } from "./versions-support";

// 版本历史页的版式：画布占满剩下的高度，上方内容晚到、画布变矮后重新适配视图；差异里的文字不在字母中间断开。

const pane = (page: Page, n: number) => page.getByRole("region", { name: `版本 ${n}（只读）` });

test("版本画布占满页面剩下的高度：只有一个版本时下面不留空", async ({ page, controlPlane }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	const id = await createEditorScenario(controlPlane);
	await page.goto(`/orchestrations/${id}/versions`);
	await expect(pane(page, 1)).toBeVisible();

	const canvas = await box(pane(page, 1));
	expect(canvas.height).toBeGreaterThanOrEqual(360);
	// 画布下沿落在页面底边距（60px）之上，下面没有一块空白。
	expect(canvas.y + canvas.height).toBeGreaterThan(800 - 70);
	expect(canvas.y + canvas.height).toBeLessThanOrEqual(800 - 50);
});

test("版本差异里的文字在空格处折行，不在单词中间断开", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	const longUrl = Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ");
	const longVersion = {
		...secondVersion,
		nodes: secondVersion.nodes.map((n) =>
			n.id === "fetch" ? { ...n, inputs: { url: longUrl } } : n,
		),
	};
	const saved = await controlPlane.fetch(`/orchestrations/${id}/versions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "bob" },
		body: JSON.stringify({ base_version: 1, document: longVersion }),
	});
	expect(saved.status).toBe(201);
	await page.goto(`/orchestrations/${id}/versions`);
	await expect(
		page.getByRole("region", { name: "差异" }).locator("ins", { hasText: "word0 word1" }),
	).toBeVisible();

	const wrapped = await page.evaluate(() => {
		const ins = [...document.querySelectorAll("ins")].find((el) =>
			el.textContent?.includes("word0 word1"),
		);
		const node = ins?.firstChild;
		if (!(node instanceof Text)) throw new Error("没有差异文字");
		const range = document.createRange();
		const tops = [...node.data].map((_, i) => {
			range.setStart(node, i);
			range.setEnd(node, i + 1);
			return Math.round(range.getClientRects()[0]?.top ?? -1);
		});
		let position = 0;
		let split = 0;
		for (const word of node.data.split(" ")) {
			if (new Set(tops.slice(position, position + word.length)).size > 1) split++;
			position += word.length + 1;
		}
		return { lines: new Set(tops).size, split };
	});
	expect(wrapped.lines).toBeGreaterThan(1);
	expect(wrapped.split).toBe(0);
});

/** 画布里所有节点合起来的竖直中心（屏幕坐标）。 */
async function contentMiddle(page: Page, n: number) {
	const boxes = await pane(page, n)
		.locator(".react-flow__node")
		.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
	const top = Math.min(...boxes.map((b) => b.top));
	const bottom = Math.max(...boxes.map((b) => b.bottom));
	return (top + bottom) / 2;
}

/**
 * 两个版本的场景，版本 2 的数据压住不发，调用返回的函数后才到达：版本 1 的画布先按还没有差异摘要时的高度
 * 打开，差异出现后画布变矮。
 */
async function openWithLateVersion2(page: Page, controlPlane: TestControlPlane) {
	const id = await createEditorScenario(controlPlane);
	await saveSecondVersion(controlPlane, id, "bob");
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(`**/api/orchestrations/${id}/versions/2`, async (route) => {
		await held;
		await route.continue();
	});
	await page.goto(`/orchestrations/${id}/versions`);
	await expect(pane(page, 1).locator('[data-node-id="fetch"]')).toBeVisible();
	return async () => {
		release();
		await expect(pane(page, 2).locator('[data-node-id="report"]')).toBeVisible();
		await expect(page.getByRole("region", { name: "差异" }).locator("ins").first()).toBeVisible();
	};
}

test("一个版本的数据晚到时，先打开的画布在上方差异出现、画布变矮后重新适配视图", async ({
	page,
	controlPlane,
}) => {
	const arrive = await openWithLateVersion2(page, controlPlane);
	const before = await box(pane(page, 1));
	await arrive();
	expect((await box(pane(page, 1))).y).toBeGreaterThan(before.y + 50);

	// 两个画布一样大，都按最终高度适配过的话，内容的竖直中心在同一高度。
	await expect
		.poll(async () => Math.abs((await contentMiddle(page, 1)) - (await contentMiddle(page, 2))))
		.toBeLessThan(4);
});

test("用户在画布上滚轮缩放过之后，画布变矮时视图不再自动变化", async ({ page, controlPlane }) => {
	const arrive = await openWithLateVersion2(page, controlPlane);
	const zoom = pane(page, 1).getByText(/^\d+%$/);
	const zoomBefore = await zoom.textContent();
	const canvas = await box(pane(page, 1));
	await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
	await page.mouse.wheel(0, -300);
	await expect(zoom).not.toHaveText(zoomBefore ?? "");
	const zoomed = await zoom.textContent();
	const before = { top: canvas.y, middle: await contentMiddle(page, 1) };

	await arrive();
	const top = (await box(pane(page, 1))).y;
	expect(top).toBeGreaterThan(before.top + 50);
	// 视口没动：内容跟着画布一起往下移，缩放比例不变。
	expect(
		Math.abs((await contentMiddle(page, 1)) - before.middle - (top - before.top)),
	).toBeLessThan(2);
	await expect(zoom).toHaveText(zoomed ?? "");
});
