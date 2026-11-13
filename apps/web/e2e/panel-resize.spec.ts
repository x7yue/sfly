import type { Locator, Page } from "@playwright/test";
import { createEditorScenario, dock, inspector, nodeCard, openEditor } from "./editor-support";
import { expect, test } from "./fixtures";
import { runningScenario } from "./monitor-scenario";
import { box, createScenario, publishPackage, scenarioUsing } from "./support";

// 检查器和运行抽屉拖动左边缘调宽（#188）：宽度记在浏览器里，所有场景共用。

const inspectorHandle = (page: Page) => page.getByRole("separator", { name: "调整检查器宽度" });

const widthOf = async (locator: Locator) => Math.round((await box(locator)).width);

/** 按住拖动条横向拖动 dx（负数往左，面板变宽）。 */
async function drag(page: Page, handle: Locator, dx: number) {
	const b = await box(handle);
	const x = b.x + b.width / 2;
	const y = b.y + b.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + dx / 2, y, { steps: 4 });
	await page.mouse.move(x + dx, y, { steps: 4 });
	await page.mouse.up();
}

/** 打开画布，等检查器出现（要量它的宽度）。 */
async function openWithInspector(page: Page, id: string, node = "sub_ping") {
	await openEditor(page, id, node);
	await expect(inspector(page)).toBeVisible();
}

test("检查器：拖动左边缘调宽，限制在 372px 到视口宽度的 60%；刷新、换场景后保持；窗口缩小时收回；双击恢复默认", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	const other = await createScenario(controlPlane, "另一个场景", scenarioUsing("agent-a"));
	await openWithInspector(page, id);
	expect(await widthOf(inspector(page))).toBe(372);

	await drag(page, inspectorHandle(page), -200);
	await expect.poll(() => widthOf(inspector(page))).toBe(572);
	// 右边缘不动：往左变宽。
	const b = await box(inspector(page));
	expect(Math.round(b.x + b.width)).toBe(1440 - 12);

	// 上限：视口宽度（1440）的 60%；下限 372。
	await drag(page, inspectorHandle(page), -900);
	await expect.poll(() => widthOf(inspector(page))).toBe(864);
	await drag(page, inspectorHandle(page), 900);
	await expect.poll(() => widthOf(inspector(page))).toBe(372);

	await drag(page, inspectorHandle(page), -300);
	await expect.poll(() => widthOf(inspector(page))).toBe(672);
	await page.reload();
	await expect(inspector(page)).toBeVisible();
	expect(await widthOf(inspector(page))).toBe(672);
	await openWithInspector(page, other, "ping");
	expect(await widthOf(inspector(page))).toBe(672);

	// 窗口缩小：按上限（1000 的 60%）收回；放大后回到保存的宽度。
	await page.setViewportSize({ width: 1000, height: 800 });
	await expect.poll(() => widthOf(inspector(page))).toBe(600);
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect.poll(() => widthOf(inspector(page))).toBe(672);

	await inspectorHandle(page).dblclick();
	await expect.poll(() => widthOf(inspector(page))).toBe(372);
	await page.reload();
	await expect(inspector(page)).toBeVisible();
	expect(await widthOf(inspector(page))).toBe(372);
});

test("检查器调宽手柄可以用键盘：聚焦后左右方向键调整，Enter 恢复默认", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openWithInspector(page, id);
	const handle = inspectorHandle(page);
	await handle.focus();
	await expect(handle).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("ArrowLeft");
	await expect.poll(() => widthOf(inspector(page))).toBe(404);
	await expect(handle).toHaveAttribute("aria-valuenow", "404");
	await page.keyboard.press("ArrowRight");
	await expect.poll(() => widthOf(inspector(page))).toBe(388);
	// 不小于下限。
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("ArrowRight");
	await expect.poll(() => widthOf(inspector(page))).toBe(372);
	await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("Enter");
	await expect.poll(() => widthOf(inspector(page))).toBe(372);
	await expect(handle).toBeFocused();
	// 方向键调宽时不切换画布上的选中节点。
	await expect(nodeCard(page, "entry")).toHaveAttribute("aria-pressed", "false");
});

test("适配视图和定位节点按检查器的实际宽度避让", async ({ page, controlPlane, connectAgent }) => {
	await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const doc = scenarioUsing("agent-a");
	const id = await createScenario(controlPlane, "巡检", {
		...doc,
		nodes: doc.nodes.map((n) => (n.id === "ping" ? { ...n, agent: "ghost" } : n)),
	});
	await openWithInspector(page, id, "ping");
	await drag(page, inspectorHandle(page), -900);
	await expect.poll(() => widthOf(inspector(page))).toBe(864);

	const expectClear = async (nodeId: string) => {
		await expect
			.poll(async () => {
				const node = await box(nodeCard(page, nodeId));
				return node.x > 0 && node.x + node.width < (await box(inspector(page))).x;
			})
			.toBe(true);
	};
	// 工具条让到检查器左边，不被挡住。
	const toolbar = await box(dock(page));
	expect(toolbar.x + toolbar.width).toBeLessThan((await box(inspector(page))).x);
	expect(toolbar.x).toBeGreaterThanOrEqual(0);
	await dock(page).getByRole("button", { name: "适配视图" }).click();
	for (const node of doc.nodes) await expectClear(node.id);

	// 定位节点：运行抽屉里预检问题的「前往」。
	await page.getByRole("button", { name: "运行", exact: true }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await drawer.getByRole("button", { name: "前往 ping" }).click();
	await expect(nodeCard(page, "ping")).toHaveAttribute("aria-pressed", "true");
	await expectClear("ping");
	// 定位后节点在空出来的区域中间，而不是贴着检查器。视口要用 200ms 平移过去：上面的「不被挡住」在平移
	// 开始前就成立了，所以位置也放进等待条件，不在半路量一次就下结论（#281）。
	await expect
		.poll(async () => {
			const node = await box(nodeCard(page, "ping"));
			const free = (await box(inspector(page))).x;
			return Math.abs(node.x + node.width / 2 - free / 2);
		})
		.toBeLessThan(40);
});

test("运行状态模式的检查器使用同一个宽度，也可以调宽", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { scenarioId } = await runningScenario(controlPlane, connectAgent, clock);
	await openWithInspector(page, scenarioId, "verify");
	await drag(page, inspectorHandle(page), -128);
	await expect.poll(() => widthOf(inspector(page))).toBe(500);

	await page
		.getByRole("group", { name: "模式" })
		.getByRole("button", { name: /运行状态/ })
		.click();
	await expect(page.getByRole("button", { name: /保存/ })).toHaveCount(0);
	await expect(inspector(page)).toBeVisible();
	expect(await widthOf(inspector(page))).toBe(500);
	await drag(page, inspectorHandle(page), -100);
	await expect.poll(() => widthOf(inspector(page))).toBe(600);

	await page.getByRole("group", { name: "模式" }).getByRole("button", { name: /编辑/ }).click();
	await expect(page.getByRole("button", { name: /保存/ })).toBeVisible();
	expect(await widthOf(inspector(page))).toBe(600);
});

test("运行抽屉：拖动左边缘调宽并记住；键盘可调；双击恢复默认", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));
	await page.goto("/orchestrations");
	const runButton = page
		.getByRole("article", { name: "巡检" })
		.getByRole("button", { name: "运行" });
	await runButton.click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	const handle = drawer.getByRole("separator", { name: "调整运行抽屉宽度" });
	await expect(drawer.getByRole("button", { name: "触发运行" })).toBeVisible();
	expect(await widthOf(drawer)).toBe(460);

	await drag(page, handle, -240);
	await expect.poll(() => widthOf(drawer)).toBe(700);
	await drag(page, handle, -900);
	await expect.poll(() => widthOf(drawer)).toBe(864);
	await handle.focus();
	await page.keyboard.press("ArrowRight");
	await expect.poll(() => widthOf(drawer)).toBe(848);

	// 关闭后再打开、刷新后都保持。
	await page.keyboard.press("Escape");
	await expect(drawer).toHaveCount(0);
	await page.reload();
	await runButton.click();
	await expect(drawer.getByRole("button", { name: "触发运行" })).toBeVisible();
	expect(await widthOf(drawer)).toBe(848);

	await handle.dblclick();
	await expect.poll(() => widthOf(drawer)).toBe(460);
});
