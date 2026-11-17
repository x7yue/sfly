import type { Page } from "@playwright/test";
import type { AssignedTask } from "../../server/test/support/fake-agent.js";
import { annotationFrame } from "./annotation-support";
import { dock, inspector, modes, nodeCard, switchMode, withoutFollow } from "./editor-support";
import { expect, test } from "./fixtures";
import { MONITOR_SCENARIO, openMonitor, runningScenario } from "./monitor-scenario";
import { createScenario, expectFocusVisible, publishPackage, triggerRun } from "./support";

// 编排画布的「运行状态」模式（原型 #/editor/:id?run=<id>）：节点叠加运行状态，检查器给出运行摘要与监控页入口。

const edge = (page: Page, from: string, to: string) =>
	page.locator(`[data-edge="chain:${from}->${to}"]`);

test("切换到运行状态：叠加最近一次运行的节点状态，进入执行中节点的连线为 live；检查器显示运行摘要，不显示日志与尝试详情；E / R 切换", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, scenarioId, agent, tasks } = await runningScenario(
		controlPlane,
		connectAgent,
		clock,
	);
	await withoutFollow(page);
	await page.goto(`/orchestrations/${scenarioId}`);
	await expect(nodeCard(page, "verify")).toBeVisible();
	await expect(nodeCard(page, "verify")).not.toHaveAttribute("data-run");

	await modes(page)
		.getByRole("button", { name: /运行状态/ })
		.click();
	await expect(modes(page).getByRole("button", { name: /运行状态/ })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.getByTestId("canvas-run")).toContainText(runId.slice(0, 8));
	await expect(nodeCard(page, "fetch")).toHaveAttribute("data-run", "done");
	await expect(nodeCard(page, "fetch")).toContainText("成功");
	// 读屏名称接上状态和卡片右侧的数字（这里是耗时）。
	await expect(nodeCard(page, "fetch")).toHaveAccessibleName(
		/^节点 fetch，HTTP 检查 成功 [\d.]+m?s$/,
	);
	await expect(nodeCard(page, "verify")).toHaveAttribute("data-run", "running");
	await expect(nodeCard(page, "verify")).toContainText("执行中");
	// 第 2 次尝试的重试是异常：场景没设关注项时，主指标的异常也写进名称（接在状态和卡片右侧的数字后面）。
	await expect(nodeCard(page, "verify")).toHaveAccessibleName(
		/^节点 verify，.+ 执行中 [\d/dhms. ]+ 1 项需要注意：主指标 level 重试（第 2 次尝试）· \d\d:\d\d:\d\d$/,
	);
	await expect(nodeCard(page, "cleanup")).toHaveAttribute("data-run", "pending");
	await expect(edge(page, "spawn", "verify")).toHaveAttribute("data-run", "live");
	// 线路图：两端都已完成的路段是「走过的」，执行中节点后面的还没走到。
	await expect(edge(page, "fetch", "spawn")).toHaveAttribute("data-run", "travelled");
	await expect(edge(page, "verify", "cleanup")).toHaveAttribute("data-run", "ahead");
	// 子流程区域标题显示实例状态。
	await expect(page.getByRole("region", { name: "子流程 sub" })).toContainText("运行中");
	// 运行状态下只读：没有保存按钮。
	await expect(page.getByRole("button", { name: /保存/ })).toHaveCount(0);
	await expect(page.getByRole("link", { name: "打开运行监控" })).toHaveAttribute(
		"href",
		`/runs/${runId}`,
	);

	await nodeCard(page, "fetch").click();
	const panel = inspector(page);
	await expect(panel.getByRole("heading", { level: 2 })).toBeVisible();
	await expect(panel.getByTestId("run-summary")).toContainText(`${runId.slice(0, 8)} · v1`);
	await expect(panel.getByTestId("run-summary")).toContainText("agent-a");
	await expect(panel.getByTestId("run-summary")).toContainText("4.0s");
	await expect(panel.getByTestId("run-attempts")).toHaveText("1");
	await expect(panel).toContainText("日志和每次尝试在运行监控详情里");
	await expect(panel.getByRole("tab")).toHaveCount(0);

	// 实时更新：verify 第 2 次失败后，卡片与检查器显示失败与错误摘要（不显示堆栈）。
	await nodeCard(page, "verify").click();
	await expect(panel.getByTestId("run-attempts")).toHaveText("2");
	await agent.fail(tasks.verify as AssignedTask, "AssertionError: 还是漏拦\n\nTraceback: stack");
	await expect(nodeCard(page, "verify")).toHaveAttribute("data-run", "failed");
	await expect(panel.getByRole("alert")).toContainText("AssertionError: 还是漏拦");
	await expect(panel).not.toContainText("Traceback");
	await expect(edge(page, "spawn", "verify")).toHaveAttribute("data-run", "failed");

	// E 回到编辑模式，R 再切回来。
	await switchMode(page, "edit");
	await expect(nodeCard(page, "verify")).not.toHaveAttribute("data-run");
	await expect(page.getByRole("button", { name: /保存/ })).toBeVisible();
	await switchMode(page, "run");
	await expect(nodeCard(page, "verify")).toHaveAttribute("data-run", "failed");
});

test("选中节点：卡片外隔开一圈中性描边，执行中节点的青色描边不变；强制颜色下是隔开的系统高亮色轮廓，不画在卡片里面", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { scenarioId, runId } = await runningScenario(controlPlane, connectAgent, clock);
	await page.goto(`/orchestrations/${scenarioId}?run=${runId}`);
	const verify = nodeCard(page, "verify");
	await expect(verify).toHaveAttribute("data-run", "running");
	const look = () =>
		verify.evaluate((el) => {
			const style = getComputedStyle(el);
			return {
				border: style.borderTopColor,
				shadow: style.boxShadow,
				outline: [style.outlineStyle, style.outlineWidth, style.outlineOffset],
			};
		});
	const canvas = await page
		.locator("[data-canvas-region]")
		.evaluate((el) => getComputedStyle(el).backgroundColor);
	const unselected = await look();
	expect(unselected.shadow).toBe("none");

	// 先垫 3px 画布底色，外面再画 2px 中性描边（--selected 是 #d4d4d4）；卡片自己的青色描边没有被选中盖掉。
	await verify.click();
	await expect(verify).toHaveAttribute("aria-pressed", "true");
	await page.mouse.move(0, 0);
	const rings = `${canvas} 0px 0px 0px 3px, rgb(212, 212, 212) 0px 0px 0px 5px`;
	await expect.poll(async () => (await look()).shadow.endsWith(rings)).toBe(true);
	const selected = await look();
	expect(selected.border).toBe(unselected.border);
	expect(selected.border).not.toBe("rgb(212, 212, 212)");
	expect(selected.outline).toEqual(unselected.outline);

	// 强制颜色模式没有 box-shadow：选中的卡片换成隔开一圈的 Highlight 轮廓，画在卡片外面；没选中的没有。
	await page.emulateMedia({ forcedColors: "active" });
	await expect(verify).toHaveCSS("outline-style", "solid");
	await expect(verify).toHaveCSS("outline-width", "3px");
	await expect(verify).toHaveCSS("outline-offset", "3px");
	const fetch = nodeCard(page, "fetch");
	await expect(fetch).toHaveAttribute("aria-pressed", "false");
	await expect(fetch).toHaveCSS("outline-style", "none");
});

test("节点被滚进视野时画布不会被滚开：先把节点滚到顶端（浏览器聚焦、测试工具点击前都会这样做），点节点的中心仍然选中它", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { scenarioId, runId } = await runningScenario(controlPlane, connectAgent, clock);
	// 关掉跟随执行：镜头不动，量出来的中心点就是点击时节点的位置。
	await page.addInitScript(() => localStorage.setItem("sfly.canvas.follow", "0"));
	await page.goto(`/orchestrations/${scenarioId}?run=${runId}`);
	await expect(nodeCard(page, "verify")).toHaveAttribute("data-run", "running");
	// 画布外层能被滚开的话，这一步会把它滚开，xyflow 随后滚回去，按滚开时算的中心点就点到了空白画布上。
	const center = await nodeCard(page, "verify").evaluate((el) => {
		el.scrollIntoView({ block: "start", inline: "start" });
		const rect = el.getBoundingClientRect();
		return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
	});
	await page.mouse.click(center.x, center.y);
	await expect(nodeCard(page, "verify")).toHaveAttribute("aria-pressed", "true");
	await expect(inspector(page).getByTestId("run-summary")).toContainText("agent-a");
});

test("运行状态下 Enter 把焦点移到检查器、Esc 回到画布上的节点，焦点环都可见", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { scenarioId } = await runningScenario(controlPlane, connectAgent, clock);
	await withoutFollow(page);
	await page.goto(`/orchestrations/${scenarioId}`);
	await modes(page)
		.getByRole("button", { name: /运行状态/ })
		.click();
	await expect(nodeCard(page, "fetch")).toHaveAttribute("data-run", "done");
	await nodeCard(page, "fetch").click();

	await page.keyboard.press("Enter");
	await expectFocusVisible(inspector(page));
	await page.keyboard.press("Escape");
	await expectFocusVisible(nodeCard(page, "fetch"));
});

test("从监控页「在画布中打开」带入该运行（不是最近一次），「在运行监控详情里打开」跳转后定位到该节点", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, scenarioId } = await runningScenario(controlPlane, connectAgent, clock);
	// 再触发一次：最近一次运行变成新的这一次（fetch 还在排队）。
	const latest = await triggerRun(controlPlane, scenarioId);
	await withoutFollow(page);
	await openMonitor(page, clock, runId);

	await page.getByRole("banner").getByRole("link", { name: "在画布中打开" }).click();
	await expect(page).toHaveURL(`/orchestrations/${scenarioId}?run=${runId}`);
	await expect(modes(page).getByRole("button", { name: /运行状态/ })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.getByTestId("canvas-run")).toContainText(runId.slice(0, 8));
	await expect(page.getByTestId("canvas-run")).not.toContainText(latest.slice(0, 8));
	await expect(nodeCard(page, "fetch")).toHaveAttribute("data-run", "done");

	await nodeCard(page, "fetch").click();
	await inspector(page).getByRole("link", { name: "在运行监控详情里打开 fetch" }).click();
	await expect(page).toHaveURL(`/runs/${runId}?view=detail&node=fetch`);
	await expect(page.locator('[data-node-row="fetch"] button')).toHaveAttribute(
		"aria-pressed",
		"true",
	);
});

test("画布的运行状态与运行监控之间的入口有定向的页面过渡，运行状态标签在两页之间移动；减少动效时直接切换", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, scenarioId } = await runningScenario(controlPlane, connectAgent, clock);
	type Recorded = { vt: (string[] | null)[] };
	const transitions = () => page.evaluate(() => (window as unknown as Recorded).vt.splice(0));
	const pill = (testId: string) => page.getByTestId(testId).locator("[data-status]").first();

	await page.goto(`/orchestrations/${scenarioId}?run=${runId}`);
	await expect(pill("canvas-run")).toHaveCSS("view-transition-name", "run-state");
	await page.evaluate(() => {
		const w = window as unknown as Recorded;
		w.vt = [];
		const start = document.startViewTransition.bind(document);
		document.startViewTransition = ((options?: { types?: string[] }) => {
			w.vt.push(options?.types ?? null);
			return start(options as never);
		}) as typeof document.startViewTransition;
	});

	await page.getByRole("link", { name: "打开运行监控" }).click();
	await expect(page).toHaveURL(`/runs/${runId}?view=overview`);
	await expect(pill("run-status")).toHaveCSS("view-transition-name", "run-state");
	expect(await transitions()).toEqual([["to-monitor"]]);

	await page.getByRole("banner").getByRole("link", { name: "在画布中打开" }).click();
	await expect(page).toHaveURL(`/orchestrations/${scenarioId}?run=${runId}`);
	await expect(page.getByTestId("canvas-run")).toContainText(runId.slice(0, 8));
	expect(await transitions()).toEqual([["to-canvas"]]);

	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.getByRole("link", { name: "打开运行监控" }).click();
	await expect(page).toHaveURL(`/runs/${runId}?view=overview`);
	expect(await transitions()).toEqual([]);
});

test("场景还没有运行过：运行状态模式给出提示，节点不叠加状态", async ({ page, controlPlane }) => {
	await publishPackage(controlPlane);
	const scenarioId = await createScenario(controlPlane, "空场景", MONITOR_SCENARIO);
	await page.goto(`/orchestrations/${scenarioId}`);
	await expect(nodeCard(page, "fetch")).toBeVisible();
	await switchMode(page, "run");
	await expect(page.getByTestId("canvas-run")).toHaveText("还没有运行");
	await expect(nodeCard(page, "fetch")).not.toHaveAttribute("data-run");
	await expect(inspector(page)).toContainText("这个场景还没有运行过");
});

/** 计算样式里的颜色（rgb() 或 color(srgb …)）转成 0–1 的 sRGB 分量。 */
const srgb = (css: string) => {
	const parts = css.match(/[\d.]+/g)?.map(Number) ?? [];
	return css.startsWith("color(") ? parts.slice(0, 3) : parts.slice(0, 3).map((v) => v / 255);
};
const luminance = (css: string) => {
	const [r = 0, g = 0, b = 0] = srgb(css).map((c) =>
		c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
	);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (fg: string, bg: string) => {
	const [a, b] = [luminance(fg), luminance(bg)];
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

test("注释框里已完成的站只留轮廓、辅助文字不低于 4.5:1；看全图时失败的站点灯是实心红，站外一行写标题和原因", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	// 绿色注释框：下沉后的卡片底比平常亮，是六种颜色里辅助文字对比度最低的。
	const { runId, scenarioId, agent, tasks } = await runningScenario(
		controlPlane,
		connectAgent,
		clock,
		{
			...MONITOR_SCENARIO,
			annotations: [
				{ id: "annotation_1", title: "取数", color: "green", nodes: ["fetch"], subflows: [] },
			],
		},
	);
	await page.goto(`/orchestrations/${scenarioId}?run=${runId}`);
	const fetch = nodeCard(page, "fetch");
	await expect(fetch).toHaveAttribute("data-run", "done");
	await expect(fetch).toHaveAttribute("data-ground", "green");
	const [figure, card, outline] = await fetch.evaluate((el) => [
		getComputedStyle(el.querySelector("[data-node-figure]") as Element).color,
		getComputedStyle(el).backgroundColor,
		getComputedStyle(el).borderTopColor,
	]);
	expect(contrast(figure, card)).toBeGreaterThanOrEqual(4.5);
	// 走完的站只留轮廓：底色就是注释框的底板，靠一圈灰描边和底板分开。
	const panel = await annotationFrame(page, "annotation_1").evaluate(
		(el) => getComputedStyle(el).backgroundColor,
	);
	expect(card).toBe(panel);
	expect(contrast(outline, panel)).toBeGreaterThanOrEqual(1.6);

	await agent.fail(tasks.verify as AssignedTask, "AssertionError: 还是漏拦");
	const verify = nodeCard(page, "verify");
	await expect(verify).toHaveAttribute("data-run", "failed");
	// 失败原因去掉开头的异常类名，全文在悬停提示里。
	await expect(verify).toContainText("还是漏拦");
	await expect(verify).not.toContainText("AssertionError");
	await expect(verify.getByTitle("AssertionError: 还是漏拦").first()).toBeAttached();
	const overview = verify.locator("[data-node-overview]");
	for (let i = 0; i < 12; i++) await dock(page).getByRole("button", { name: "缩小" }).click();
	await expect(page.getByRole("status", { name: "缩放比例" })).toHaveText("30%");
	// 看全图：站外一行写上标题和失败原因。
	await expect(overview).toBeVisible();
	const name = await verify.locator("[data-slot=base-node-title]").textContent();
	await expect(overview).toHaveText(`${name} 还是漏拦`);
	const lamp = verify.locator("[data-lamp]");
	await expect
		.poll(() =>
			lamp.evaluate((el) => {
				const probe = document.createElement("span");
				probe.style.backgroundColor = "var(--danger)";
				document.body.append(probe);
				const danger = getComputedStyle(probe).backgroundColor;
				probe.remove();
				return getComputedStyle(el).backgroundColor === danger;
			}),
		)
		.toBe(true);
	// 放大到 65% 以上：卡片第二行写得下原因，站外一行收起。
	const zoom = page.getByRole("status", { name: "缩放比例" });
	const percent = async () => Number.parseInt((await zoom.textContent()) ?? "0", 10);
	for (let i = 0; i < 20 && (await percent()) < 70; i++)
		await dock(page).getByRole("button", { name: "放大" }).click();
	await expect(overview).toBeHidden();
});
