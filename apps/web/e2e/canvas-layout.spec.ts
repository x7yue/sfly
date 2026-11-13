import type { Page } from "@playwright/test";
import type { AssignedTask } from "../../server/test/support/fake-agent.js";
import {
	addMenu,
	createEditorScenario,
	dock,
	editorDocument,
	inspector,
	nodeCard,
	openEditor,
	paneMenu,
	switchMode,
} from "./editor-support";
import { expect, test } from "./fixtures";
import { runningScenario } from "./monitor-scenario";
import { box, createScenario, expectFocusVisible, overlap, publishPackage } from "./support";

// 编排画布的布局与动效：检查器最宽时的画布、新节点的落点、子流程区域标题、连线选中、视口动画、工具条的方向键。

test("1280 宽检查器拖到最宽：画布留得下小地图和工具条，两者不重叠，工具条不贴着窗口边缘", async ({
	page,
	controlPlane,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.addInitScript(() => localStorage.setItem("sfly.panel.width", "2000"));
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "fetch").click();

	const panel = await box(inspector(page));
	// 上限 = 视口宽度减去给画布留的 742px（小地图 + 工具条 + 间距），不是视口的 60%（768px）。
	expect(Math.round(panel.width)).toBe(538);
	const toolbar = await box(dock(page));
	const minimap = await box(page.locator(".react-flow__minimap"));
	expect(toolbar.width).toBeLessThanOrEqual(506);
	expect(overlap(toolbar, minimap)).toBe(false);
	expect(toolbar.x).toBeGreaterThanOrEqual(minimap.x + minimap.width + 8);
	expect(toolbar.x + toolbar.width).toBeLessThanOrEqual(panel.x - 8);
});

test("没有来源的新节点不盖住子流程区域：落在区域标题栏上也会挪到区域外", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const region = page.getByRole("region", { name: "子流程 sub_entry" });
	const area = await box(region);

	// 在子流程区域标题栏上的空白处右键添加节点：卡片中心就落在区域里。
	await page.mouse.click(area.x + area.width * 0.5, area.y + 8, { button: "right" });
	await paneMenu(page)
		.getByRole("menuitem", { name: /添加节点/ })
		.click();
	await addMenu(page).getByRole("option", { name: /定时/ }).click();
	await expect(nodeCard(page, "timer_1")).toBeVisible();

	const added = await box(nodeCard(page, "timer_1"));
	expect(overlap(added, await box(region))).toBe(false);
	for (const other of ["entry", "fetch", "dispatch", "ping", "sub_entry", "sub_ping"]) {
		expect(overlap(added, await box(nodeCard(page, other))), other).toBe(false);
	}
});

test("子流程区域标题栏：窄的区域先去掉「由谁触发」，名字完整留着；宽的区域两段都在", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane);
	const narrow = await createScenario(controlPlane, "窄区域", {
		...editorDocument,
		nodes: editorDocument.nodes
			.filter((n) => n.id !== "sub_ping")
			.map((n) => (n.id === "sub_entry" ? { ...n, name: "回显" } : n)),
		edges: editorDocument.edges.filter((e) => e.to !== "sub_ping"),
	});
	await openEditor(page, narrow, "sub_entry");

	const region = page.getByRole("region", { name: "子流程 回显" });
	await expect(region.getByText("回显", { exact: true })).toBeVisible();
	expect(
		await region
			.getByText("回显", { exact: true })
			.evaluate((el) => el.scrollWidth <= el.clientWidth),
	).toBe(true);
	await expect(region.getByText(/由 dispatch 触发/)).toBeHidden();

	const wide = await createScenario(controlPlane, "宽区域", editorDocument);
	await openEditor(page, wide);
	await expect(
		page.getByRole("region", { name: "子流程 sub_entry" }).getByText(/由 dispatch 触发 · 2 个节点/),
	).toBeVisible();
});

test("运行状态里选中执行中的节点：进入它的连线仍是青色实线，不被选中的虚线流动顶替", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { scenarioId } = await runningScenario(controlPlane, connectAgent, clock);
	await page.goto(`/orchestrations/${scenarioId}`);
	await switchMode(page, "run");
	const live = page.locator('[data-edge="chain:spawn->verify"]');
	await expect(live).toHaveAttribute("data-run", "live");
	const read = () =>
		live.evaluate((el) => {
			const s = getComputedStyle(el);
			return {
				stroke: s.stroke,
				dash: s.strokeDasharray,
				animation: s.animationName,
				width: Number.parseFloat(s.strokeWidth),
			};
		});
	const before = await read();
	expect(before.dash).toBe("none");

	await nodeCard(page, "verify").click();
	await expect(live).toHaveAttribute("data-highlighted", "true");
	const after = await read();
	expect(after.stroke).toBe(before.stroke);
	expect(after.dash).toBe("none");
	expect(after.animation).toBe("none");
	expect(after.width).toBeGreaterThan(before.width);
});

test("编辑时选中节点：相关连线的虚线流动两个周期后停住；开启「减少动效」时不流动", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const link = page.locator('[data-edge="chain:fetch->dispatch"]');
	const motion = () =>
		link.evaluate((el) => {
			const s = getComputedStyle(el);
			return { name: s.animationName, count: s.animationIterationCount };
		});
	expect((await motion()).name).toBe("none");
	await nodeCard(page, "fetch").click();
	expect(await motion()).toEqual({ name: "edge-flow", count: "2" });

	await page.emulateMedia({ reducedMotion: "reduce" });
	expect((await motion()).name).toBe("none");
});

/** 点一下工具条上的按钮，看这之后 0.5 秒里视口的变换一共出现过几个不同的值（包含点之前的那个）。 */
const viewportSteps = (page: Page, button: string) =>
	page.evaluate(async (label) => {
		const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
		const target = document.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
		if (!viewport || !target) throw new Error("没有画布");
		const seen = new Set<string>();
		seen.add(viewport.style.transform);
		target.click();
		const end = performance.now() + 500;
		while (performance.now() < end) {
			seen.add(viewport.style.transform);
			await new Promise((resolve) => requestAnimationFrame(resolve));
		}
		return seen.size;
	}, button);

test("视口动画受「减少动效」控制：缩放按钮、适配视图一步到位", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	expect(await viewportSteps(page, "放大")).toBeGreaterThan(3);
	expect(await viewportSteps(page, "适配视图")).toBeGreaterThan(3);

	await page.emulateMedia({ reducedMotion: "reduce" });
	expect(await viewportSteps(page, "放大")).toBe(2);
	expect(await viewportSteps(page, "适配视图")).toBe(2);
});

test("画布工具条是一个 Tab 停靠点：← → 在按钮之间移动并首尾相接，Tab 直接离开", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const buttons = dock(page).getByRole("button");
	const first = buttons.first();
	const last = buttons.last();
	await expect(first).toHaveAccessibleName("添加节点");
	await expect(last).toHaveAccessibleName("检查器");

	// 只有一个按钮在 Tab 顺序里。
	const stops = await dock(page)
		.locator("button")
		.evaluateAll((els) => els.filter((el) => (el as HTMLElement).tabIndex >= 0).length);
	expect(stops).toBe(1);

	await first.focus();
	await page.keyboard.press("ArrowRight");
	await expect(dock(page).getByRole("button", { name: "指针" })).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(dock(page).getByRole("button", { name: "抓手" })).toBeFocused();
	await last.focus();
	await page.keyboard.press("ArrowRight");
	await expect(first).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect(last).toBeFocused();
	// 撤销、重做还不能用，方向键跳过它们。
	await dock(page).getByRole("button", { name: "适配视图" }).focus();
	await page.keyboard.press("ArrowRight");
	await expect(dock(page).getByRole("button", { name: "整理布局" })).toBeFocused();

	// 回到工具条时落在刚才的按钮上；Tab 离开工具条，不会逐个经过其余按钮。
	await page.keyboard.press("Tab");
	expect(
		await page.evaluate(() => document.activeElement?.closest('[role="toolbar"]') === null),
	).toBe(true);
});

test("画布节点的键盘焦点环离卡片外沿 3px", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await page.getByRole("region", { name: /^编排画布/ }).focus();
	await page.keyboard.press("ArrowRight");
	await expectFocusVisible(nodeCard(page, "entry"));
	const ring = await nodeCard(page, "entry").evaluate((el) => {
		const s = getComputedStyle(el);
		return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset };
	});
	expect(ring).toEqual({ style: "solid", width: "2px", offset: "3px" });
});

test("选中执行失败的节点：进入它的连线保持红色", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { scenarioId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	await page.goto(`/orchestrations/${scenarioId}`);
	await switchMode(page, "run");
	await agent.fail(tasks.verify as AssignedTask, "AssertionError: 漏拦");
	const failed = page.locator('[data-edge="chain:spawn->verify"]');
	await expect(failed).toHaveAttribute("data-run", "failed");
	const stroke = await failed.evaluate((el) => getComputedStyle(el).stroke);
	await nodeCard(page, "verify").click();
	await expect(failed).toHaveAttribute("data-highlighted", "true");
	expect(await failed.evaluate((el) => getComputedStyle(el).stroke)).toBe(stroke);
});
