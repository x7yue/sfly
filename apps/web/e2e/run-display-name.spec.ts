import type { Locator, Page } from "@playwright/test";
import { inspector, nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";
import { openMonitor } from "./monitor-scenario";
import {
	driveToRetry,
	FIRST,
	NOTE,
	namedDocument,
	namedScenario,
	RENAMED,
} from "./run-display-name-scenario";
import { triggerRun } from "./support";

// 运行相关页面写节点的显示名称（#313）：「显示名称（节点 ID）」，名称取自运行绑定的场景版本；
// 节点有备注时，运行监控页的图表组标题上有备注图标。

const timeline = (page: Page) => page.getByRole("region", { name: "链路时间线" });
const workspace = (page: Page) => page.getByRole("region", { name: "图表工作区" });
const panel = (page: Page) => page.getByRole("region", { name: "底部面板" });
const dashboardPanel = (page: Page, name: string) =>
	page.getByRole("region", { name, exact: true });

test("运行抽屉、控制台统计和运行记录写成「显示名称（节点 ID）」；「子流程失败」写子流程名称", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { agent } = await namedScenario(controlPlane, connectAgent);
	await page.goto("/orchestrations");
	await page
		.getByRole("article", { name: "日终对账" })
		.getByRole("button", { name: "运行" })
		.click();
	const drawer = page.getByRole("dialog", { name: "运行 · 日终对账" });
	await drawer.getByRole("button", { name: "触发运行" }).click();
	const fetch = await agent.nextAssign();
	const summary = drawer.getByRole("region", { name: "运行摘要" });
	const active = summary.getByRole("list", { name: "进行中的节点" });
	await expect(active.getByRole("listitem")).toHaveText([/^执行中拉取订单（fetch）agent-a/]);
	agent.progress(fetch, 3, 10);
	await expect(active.getByRole("progressbar", { name: "拉取订单（fetch） 进度" })).toBeVisible();
	await expect(summary.getByRole("heading", { name: /最新日志/ })).toHaveText(
		"最新日志拉取订单（fetch）",
	);

	const verify = await driveToRetry(agent, clock, fetch);
	await expect(active.getByRole("listitem")).toHaveText([/^执行中核对结果（verify）agent-a/]);
	const runId = (await (await controlPlane.fetch("/runs?limit=1")).json()).runs[0].id as string;
	await page.keyboard.press("Escape");

	await page.clock.setFixedTime(clock.now());
	await page.goto("/");
	const running = dashboardPanel(page, "正在运行").getByRole("link", { name: /日终对账/ });
	await expect(running).toContainText("执行中：核对结果（verify）");
	await expect(running.getByRole("img", { name: /^子流程 压测监控 \d\/2$/ })).toBeVisible();
	const failures = dashboardPanel(page, "最近失败").getByRole("link");
	await expect(failures).toHaveCount(1);
	await expect(failures.first()).toContainText("子流程失败 · 压测监控");
	await expect(failures.first()).toContainText("失败节点 探测延迟（probe） · 主链仍在运行");

	await page.goto("/runs");
	const card = page.getByRole("article", { name: `运行 ${runId.slice(0, 8)}` });
	await expect(card.getByRole("listitem")).toHaveText([/^核对结果（verify）执行中/]);
	await expect(card).toContainText("子流程 压测监控 失败");
	await expect(card.getByRole("img", { name: /^子流程 压测监控 \d\/2$/ })).toBeVisible();
	await card.getByRole("button", { name: "取消运行" }).click();
	const cancel = page.getByRole("dialog", { name: `取消运行 ${runId.slice(0, 8)}？` });
	await expect(cancel.getByRole("list", { name: "取消的影响" })).toContainText(
		"执行中的 1 个任务先优雅终止核对结果（verify）",
	);
	await cancel.getByRole("button", { name: "继续运行" }).click();
	await expect(cancel).toBeHidden();

	await agent.fail(verify, "AssertionError: 仍然差 3 笔");
	const row = page
		.getByRole("table", { name: "历史运行" })
		.getByRole("row", { name: new RegExp(runId.slice(0, 8)) });
	await expect(row.getByRole("cell").nth(2)).toHaveText("失败 · 核对结果（verify）");
	await expect(row.getByRole("img", { name: /^子流程 压测监控 \d\/2$/ })).toBeVisible();
});

test("运行监控页：顶栏、失败横幅、时间线、尝试列表、范围标签、图表组标题与备注、节点筛选、合并日志的来源节点", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { agent, scenarioId } = await namedScenario(controlPlane, connectAgent);
	const runId = await triggerRun(controlPlane, scenarioId);
	const verify = await driveToRetry(agent, clock, await agent.nextAssign());
	await agent.fail(verify, "AssertionError: 仍然差 3 笔");
	await openMonitor(page, clock, runId);

	const summary = "失败于 核对结果（verify）（第 2 次）· AssertionError: 仍然差 3 笔";
	const banner = page.getByRole("region", { name: "运行失败" });
	await expect(banner.getByTestId("run-failure")).toHaveText(summary);
	await banner.getByRole("button", { name: "收起" }).click();
	await expect(page.getByRole("banner").getByTestId("run-failure")).toHaveText(summary);

	const row = (id: string) => timeline(page).locator(`[data-node-row="${id}"] button`);
	await expect(row("fetch")).toContainText("拉取订单（fetch）");
	await expect(row("fetch")).toHaveAccessibleName(
		/^拉取订单（fetch） demo-checks\/http_check 成功/,
	);
	await expect(row("spawn")).toContainText("派发监控（spawn）");
	await expect(row("sub")).toContainText("压测监控（sub）");
	await expect(row("probe")).toContainText("探测延迟（probe）");
	await expect(row("entry")).toHaveAccessibleName(/^entry 入口/);

	// 默认选中失败的 verify。
	await expect(panel(page).getByTestId("bp-scope")).toHaveText(
		"范围：核对结果（verify）（第 2 次）",
	);
	await expect(
		panel(page).getByRole("button", { name: "清除范围，不再只看 核对结果（verify）" }),
	).toBeVisible();
	await panel(page).getByRole("tab", { name: "尝试" }).click();
	const firstAttempt = panel(page).getByRole("article", { name: "核对结果（verify） 第 1 次尝试" });
	await expect(firstAttempt).toContainText("核对结果（verify）第 1 次");

	// 合并日志的来源节点。
	await panel(page)
		.getByRole("button", { name: /^清除范围/ })
		.click();
	await panel(page).getByRole("tab", { name: "日志" }).click();
	await expect(panel(page).locator("[data-log-origin]")).toHaveText([
		"拉取订单（fetch）",
		"压测监控 / 探测延迟（probe）",
	]);

	// 图表组标题；fetch 有备注，悬停或用 Tab 聚焦备注图标看全文。
	const fetchGroup = workspace(page).getByRole("region", { name: "拉取订单（fetch） 的图表" });
	await expect(fetchGroup).toContainText("拉取订单（fetch）");
	await expect(
		workspace(page).getByRole("region", { name: "核对结果（verify） 的图表" }),
	).toBeVisible();
	const probeGroup = workspace(page).getByRole("region", { name: "探测延迟（probe） 的图表" });
	await expect(probeGroup).toBeVisible();
	await expect(probeGroup.locator('[data-slot="note-icon"]')).toHaveCount(0);
	const note = fetchGroup.getByRole("button", { name: "备注" });
	await expect(note).toHaveAccessibleDescription(NOTE);
	await note.hover();
	await expect(page.getByRole("tooltip")).toContainText(NOTE);
	await page.mouse.move(0, 0);
	await expect(page.getByRole("tooltip")).toHaveCount(0);
	await fetchGroup.locator("button[aria-expanded]").focus();
	await page.keyboard.press("Tab");
	await expect(note).toBeFocused();
	await expect(page.getByRole("tooltip")).toContainText(NOTE);

	// 节点筛选按显示名称筛。
	await workspace(page)
		.getByRole("button", { name: /^节点：/ })
		.click();
	const filter = page.getByRole("dialog", { name: "按节点筛选图表" });
	const search = filter.getByRole("textbox", { name: "搜索节点 ID 或名称" });
	await search.fill("拉取");
	await expect(filter.getByRole("checkbox", { name: "拉取订单（fetch）" })).toBeVisible();
	await expect(filter.getByRole("checkbox", { name: /verify|probe/ })).toHaveCount(0);
	await search.fill("探测");
	await expect(filter.getByRole("checkbox", { name: "探测延迟（probe）" })).toBeVisible();
	await expect(filter.getByRole("checkbox", { name: /fetch|verify/ })).toHaveCount(0);
	await page.keyboard.press("Escape");

	// 平台自带图表里的节点。
	const platform = workspace(page).getByRole("region", { name: "平台自带图表" });
	await platform.getByRole("button", { expanded: false }).click();
	await expect(platform.getByRole("figure", { name: "节点耗时 Top 10" })).toContainText(
		"拉取订单（fetch）",
	);
	await expect(platform.getByRole("figure", { name: "重试次数" })).toContainText(
		"核对结果（verify） ×1",
	);
});

test("改了显示名称之后，旧运行仍显示它绑定版本里的名称", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { agent, scenarioId } = await namedScenario(controlPlane, connectAgent);
	const oldRun = await triggerRun(controlPlane, scenarioId);
	const verify = await driveToRetry(agent, clock, await agent.nextAssign());
	await agent.fail(verify, "AssertionError: 仍然差 3 笔");

	const saved = await controlPlane.fetch(`/orchestrations/${scenarioId}/versions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "tester" },
		body: JSON.stringify({ base_version: 1, document: namedDocument(RENAMED) }),
	});
	expect(saved.status).toBe(201);
	const newRun = await triggerRun(controlPlane, scenarioId);
	await agent.nextAssign();

	await openMonitor(page, clock, oldRun);
	await expect(timeline(page).locator('[data-node-row="fetch"]')).toContainText(
		"拉取订单（fetch）",
	);
	await expect(timeline(page).locator('[data-node-row="sub"]')).toContainText("压测监控（sub）");
	await expect(page.getByRole("region", { name: "运行失败" })).toContainText(
		"失败于 核对结果（verify）",
	);
	await openMonitor(page, clock, newRun);
	await expect(timeline(page).locator('[data-node-row="fetch"]')).toContainText(
		"拉取全部订单（fetch）",
	);

	// 画布的运行状态模式显示旧运行绑定的那一版。
	await page.goto(`/orchestrations/${scenarioId}?run=${oldRun}`);
	await nodeCard(page, "fetch").click();
	await expect(inspector(page).getByRole("heading", { name: "拉取订单" })).toBeVisible();
	await expect(
		inspector(page).getByRole("link", { name: "在运行监控详情里打开 拉取订单（fetch）" }),
	).toBeVisible();

	await page.goto("/runs");
	await expect(
		page.getByRole("article", { name: `运行 ${newRun.slice(0, 8)}` }).getByRole("listitem"),
	).toHaveText([/^拉取全部订单（fetch）执行中/]);
	const oldRow = page
		.getByRole("table", { name: "历史运行" })
		.getByRole("row", { name: new RegExp(oldRun.slice(0, 8)) });
	await expect(oldRow.getByRole("cell").nth(2)).toHaveText("失败 · 核对结果（verify）");
	await expect(oldRow.getByRole("img", { name: /^子流程 压测监控 / })).toBeVisible();

	await page.goto("/");
	await expect(
		dashboardPanel(page, "正在运行").getByRole("link", { name: /日终对账/ }),
	).toContainText("执行中：拉取全部订单（fetch）");
	const failures = dashboardPanel(page, "最近失败").getByRole("link");
	await expect(failures).toHaveText([
		/失败.*失败节点 核对结果（verify）/,
		/子流程失败 · 压测监控.*失败节点 探测延迟（probe）/,
	]);
});

const LONG = "一二三四五六七八九十".repeat(4);
const tooltips = (page: Page) => page.locator('[data-slot="tooltip-content"]');

test("运行监控页：名称被截断时，悬停或聚焦时间线行、图表组标题、顶栏失败摘要的按钮就显示全文；按钮是唯一的停靠点，不弹第二个提示", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { agent, scenarioId } = await namedScenario(controlPlane, connectAgent, {
		...FIRST,
		fetch: LONG,
		verify: LONG,
	});
	const runId = await triggerRun(controlPlane, scenarioId);
	const verify = await driveToRetry(agent, clock, await agent.nextAssign());
	await agent.fail(verify, "AssertionError: 仍然差 3 笔");
	await page.setViewportSize({ width: 1024, height: 900 });
	await openMonitor(page, clock, runId);
	await expect(page.getByTestId("run-failure")).toBeVisible();

	/** 悬停和键盘聚焦都显示 `text`，只有这一个提示；离开之后消失。 */
	const showsOnHoverAndFocus = async (button: Locator, text: string | RegExp) => {
		await expect(button).not.toHaveAttribute("title");
		// 按钮里没有别的可聚焦的元素：被截断的名字只是文字。
		await expect(button.locator("a, button, input, select, textarea, [tabindex]")).toHaveCount(0);
		await button.hover();
		await expect(tooltips(page)).toHaveCount(1);
		await expect(tooltips(page)).toContainText(text);
		await page.mouse.move(0, 0);
		await expect(tooltips(page)).toHaveCount(0);
		// 按过键之后聚焦才算键盘聚焦（focus-visible），鼠标点过别处之后程序聚焦不算。
		await page.keyboard.press("Shift");
		await button.focus();
		await expect(tooltips(page)).toHaveCount(1);
		await expect(tooltips(page)).toContainText(text);
		await button.blur();
		await expect(tooltips(page)).toHaveCount(0);
	};

	// 时间线行：名字被截断，读屏名称仍是完整的「名称（ID） 说明 状态」。
	const row = (id: string) => timeline(page).locator(`[data-node-row="${id}"] button`);
	await expect(row("fetch")).toHaveAccessibleName(
		new RegExp(`^${LONG}（fetch） demo-checks/http_check 成功`),
	);
	await showsOnHoverAndFocus(row("fetch"), `${LONG}（fetch） · demo-checks/http_check`);
	// 没被截断的行不弹提示。
	await row("entry").focus();
	await expect(tooltips(page)).toHaveCount(0);
	await row("entry").blur();

	// 顶栏的失败摘要：提示是完整的摘要加一句操作说明，按钮的无障碍描述是那句说明。
	await page
		.getByRole("region", { name: "运行失败" })
		.getByRole("button", { name: "收起" })
		.click();
	const failure = page.getByRole("banner").getByTestId("run-failure");
	await expect(failure).toHaveAccessibleDescription("点击查看这个节点的尝试");
	await failure.evaluate((el) => {
		el.style.maxWidth = "240px";
	});
	await showsOnHoverAndFocus(failure, `失败于 ${LONG}（verify）（第 2 次）`);
	await expect(failure).toHaveText(/^失败于 一二三/);
	await failure.evaluate((el) => {
		el.style.maxWidth = "";
	});

	// 图表组标题：展开按钮是触发器，名称放得下时不弹提示，被截断时（这里把按钮收窄）弹出全文。
	const toggle = workspace(page)
		.getByRole("region", { name: `${LONG}（fetch） 的图表` })
		.locator("button[aria-expanded]");
	await expect(toggle).toHaveAccessibleName(`成功 ${LONG} （fetch）`);
	await toggle.focus();
	await expect(tooltips(page)).toHaveCount(0);
	await toggle.blur();
	await toggle.evaluate((el) => {
		el.style.maxWidth = "200px";
	});
	await showsOnHoverAndFocus(toggle, `${LONG}（fetch）`);
});
