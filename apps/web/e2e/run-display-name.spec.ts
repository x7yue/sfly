import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { openMonitor } from "./monitor-scenario";
import {
	driveToRetry,
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
	const active = summary.getByRole("list", { name: "正在执行的节点" });
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
	const failures = dashboardPanel(page, "最近失败").getByRole("link");
	await expect(failures).toHaveCount(1);
	await expect(failures.first()).toContainText("子流程失败 · 压测监控");
	await expect(failures.first()).toContainText("失败节点 探测延迟（probe） · 主链仍在运行");

	await page.goto("/runs");
	const card = page.getByRole("article", { name: `运行 ${runId.slice(0, 8)}` });
	await expect(card.getByRole("listitem")).toHaveText([/^核对结果（verify）执行中/]);

	await agent.fail(verify, "AssertionError: 仍然差 3 笔");
	const history = page.getByRole("table", { name: "历史运行" });
	await expect(
		history
			.getByRole("row", { name: new RegExp(runId.slice(0, 8)) })
			.getByRole("cell")
			.nth(2),
	).toHaveText("失败 · 核对结果（verify）");
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

	await page.goto("/runs");
	await expect(
		page.getByRole("article", { name: `运行 ${newRun.slice(0, 8)}` }).getByRole("listitem"),
	).toHaveText([/^拉取全部订单（fetch）执行中/]);
	await expect(
		page
			.getByRole("table", { name: "历史运行" })
			.getByRole("row", { name: new RegExp(oldRun.slice(0, 8)) })
			.getByRole("cell")
			.nth(2),
	).toHaveText("失败 · 核对结果（verify）");

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
