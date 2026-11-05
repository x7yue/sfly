import type { Page } from "@playwright/test";
import type { AssignedTask } from "../../server/test/support/fake-agent.js";
import { expect, test } from "./fixtures";
import { openMonitor, runningScenario, unixAt } from "./monitor-scenario";

// 运行监控页的图表工作区（原型 #/monitor/:runId 的中间区域）：按节点分组的指标图表、筛选、只看、
// 悬停联动、拖选缩放、实时追加、选中节点。

const workspace = (page: Page) => page.getByRole("region", { name: "图表工作区" });
const timeline = (page: Page) => page.getByRole("region", { name: "链路时间线" });
const panel = (page: Page) => page.getByRole("region", { name: "底部面板" });
const group = (page: Page, node: string) =>
	workspace(page).getByRole("region", { name: `${node} 的图表` });
const groupToggle = (page: Page, node: string) =>
	group(page, node)
		.getByRole("button", { expanded: true })
		.or(group(page, node).getByRole("button", { expanded: false }));
const chart = (page: Page, node: string, title: string) =>
	group(page, node).getByRole("figure", { name: title, exact: true });
const groupOrder = (page: Page) =>
	workspace(page)
		.locator("[data-group]")
		.evaluateAll((els) => els.map((el) => (el as HTMLElement).getAttribute("aria-label")));

/** 拖选时间线轨道上 a–b（比例）这一段。 */
async function brush(page: Page, a: number, b: number) {
	const track = await timeline(page).locator('[data-node-row="fetch"] > div').boundingBox();
	if (!track) throw new Error("没有轨道");
	const y = track.y + track.height / 2;
	await page.mouse.move(track.x + track.width * a, y);
	await page.mouse.down();
	await page.mouse.move(track.x + track.width * ((a + b) / 2), y, { steps: 5 });
	await page.mouse.move(track.x + track.width * b, y, { steps: 5 });
	await page.mouse.up();
}

test("按节点分组，顺序与链上执行顺序一致；默认只展开执行中和失败的组；平台自带图表是最后一组", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	const ws = workspace(page);

	await expect(ws.getByTestId("chart-count")).toHaveText(
		"3 个节点 · 12 张图表 · 共 3 个节点声明了图表",
	);
	expect(await groupOrder(page)).toEqual([
		"fetch 的图表",
		"verify 的图表",
		"probe 的图表",
		"平台自带图表",
	]);

	// 组标题：状态、名称、主指标最新值、图表数、Agent。
	const fetch = group(page, "fetch");
	await expect(fetch).toContainText("成功");
	await expect(fetch).toContainText("demo-checks/http_check");
	await expect(fetch.locator('[data-primary-metric="latency_ms"]')).toContainText("latency_ms50ms");
	await expect(fetch).toContainText("4 张图表");
	await expect(fetch).toContainText("agent-a");
	await expect(group(page, "probe")).toContainText("子流程 sub");

	// 成功的 fetch 折叠，执行中的 verify、probe 展开；平台自带图表默认折叠。
	await expect(groupToggle(page, "fetch")).toHaveAttribute("aria-expanded", "false");
	await expect(fetch.getByRole("figure")).toHaveCount(0);
	await expect(groupToggle(page, "verify")).toHaveAttribute("aria-expanded", "true");
	await expect(group(page, "verify").getByRole("figure")).toHaveCount(2);
	await expect(
		ws.getByRole("region", { name: "平台自带图表" }).getByRole("button", { expanded: false }),
	).toBeVisible();

	// 全部展开 / 全部折叠。
	await ws.getByRole("button", { name: "全部展开" }).click();
	await expect(fetch.getByRole("figure")).toHaveCount(4);
	const platform = ws.getByRole("region", { name: "平台自带图表" });
	await expect(platform.getByRole("figure")).toHaveCount(4);
	await expect(platform.getByRole("figure", { name: "重试次数" })).toContainText("1次");
	await expect(platform.getByRole("figure", { name: "节点耗时 Top 10" })).toContainText("fetch");
	await ws.getByRole("button", { name: "全部折叠" }).click();
	await expect(ws.getByRole("figure")).toHaveCount(0);
});

test("四种图表类型与多序列图例；横轴是节点实际运行的时段并标出起止时间；运行中实时追加", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const clock0 = Date.parse("2026-01-01T00:00:00Z");
	await openMonitor(page, clock, runId, "fetch");

	const latency = chart(page, "fetch", "延迟");
	await expect(latency.locator("[data-series]")).toHaveCount(2);
	await expect(latency).toContainText("latency_ms");
	await expect(latency).toContainText("p99_ms");
	// fetch 在 08:00:02 开始、08:00:06 结束。
	await expect(latency.locator("[data-window]")).toHaveText("08:00:02 – 08:00:06");
	await expect(chart(page, "fetch", "吞吐").locator("[data-series] path")).toHaveCount(2);
	await expect(chart(page, "fetch", "请求数").locator("rect")).toHaveCount(4);
	// errors 没被图表引用：默认图表是数值卡（counter）。
	await expect(chart(page, "fetch", "errors").locator("[data-latest]")).toHaveText("1次");

	// 执行中的 probe：右端随现在推进，新上报的点实时追加。
	const level = chart(page, "probe", "level");
	await expect(level.locator("[data-window]")).toHaveText("08:00:06 – 08:00:14");
	await expect(level.locator("[data-latest]")).toHaveText("3");
	agent.metrics(tasks.probe as AssignedTask, [["level", unixAt(clock0, 14), 42]]);
	await expect(level.locator("[data-latest]")).toHaveText("42");
	await expect(group(page, "probe").locator('[data-primary-metric="level"]')).toContainText("42");
});

test("节点多选筛选：按链整组勾选、搜索、快速选择、平台自带图表；清除筛选；底部面板范围跟随筛选", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	const ws = workspace(page);
	await expect(ws.getByTestId("chart-count")).toContainText("3 个节点");

	await ws.getByRole("button", { name: /节点：全部节点/ }).click();
	const menu = page.getByRole("dialog", { name: "按节点筛选图表" });
	// 取消整条子流程链。
	await menu.getByRole("checkbox", { name: /^子流程 sub/ }).uncheck();
	await expect(group(page, "probe")).toHaveCount(0);
	await expect(ws.getByRole("button", { name: /节点：已选 2 个节点/ })).toBeVisible();
	await expect(ws.getByTestId("chart-count")).toHaveText("2 个节点 · 10 张图表");

	// 搜索节点，单独勾选。
	await menu.getByRole("textbox", { name: "搜索节点 ID 或名称" }).fill("pro");
	await expect(menu.getByRole("checkbox", { name: "fetch" })).toHaveCount(0);
	await menu.getByRole("checkbox", { name: "probe" }).check();
	await expect(group(page, "probe")).toBeVisible();
	await menu.getByRole("textbox", { name: "搜索节点 ID 或名称" }).fill("");

	// 快速选择：执行中（不含平台自带图表），再单独勾上平台自带图表。
	await menu.getByRole("button", { name: "执行中", exact: true }).click();
	expect(await groupOrder(page)).toEqual(["verify 的图表", "probe 的图表"]);
	await menu.getByRole("checkbox", { name: "平台自带图表" }).check();
	expect(await groupOrder(page)).toEqual(["verify 的图表", "probe 的图表", "平台自带图表"]);
	await menu.getByRole("button", { name: "清空" }).click();
	await expect(ws.locator("[data-group]")).toHaveCount(0);
	await expect(ws).toContainText("没有匹配的图表");
	await menu.getByRole("button", { name: "有数据" }).click();
	await expect(ws.locator("[data-group]")).toHaveCount(3);
	await menu.getByRole("button", { name: "失败", exact: true }).click();
	await expect(ws.locator("[data-group]")).toHaveCount(0);
	await menu.getByRole("button", { name: "执行中", exact: true }).click();
	await menu.getByRole("button", { name: "完成" }).click();
	await expect(menu).toBeHidden();

	// 没有选中节点时，底部面板的范围跟随筛选；有选中节点时跟随选中。
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：verify（第 2 次）");
	await timeline(page).locator('[data-node-row="verify"] button').click();
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：跟随筛选（2 个节点）");

	await ws.getByRole("button", { name: "清除筛选" }).click();
	await expect(ws.getByRole("button", { name: /节点：全部节点/ })).toBeVisible();
	await expect(ws.locator("[data-group]")).toHaveCount(4);
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：未选中节点");
});

test("只看一个节点；按名称搜索图表；紧凑密度", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	const ws = workspace(page);

	await ws.getByRole("button", { name: "只看 fetch" }).click();
	expect(await groupOrder(page)).toEqual(["fetch 的图表"]);
	await expect(groupToggle(page, "fetch")).toHaveAttribute("aria-expanded", "true");
	await expect(ws.getByRole("button", { name: /节点：fetch/ })).toBeVisible();
	await expect(ws.getByRole("button", { name: "只看 fetch" })).toHaveCount(0);
	await ws.getByRole("button", { name: "清除筛选" }).click();
	await expect(ws.locator("[data-group]")).toHaveCount(4);

	await ws.getByRole("textbox", { name: "搜索图表或节点" }).fill("吞吐");
	expect(await groupOrder(page)).toEqual(["fetch 的图表"]);
	await expect(group(page, "fetch").getByRole("figure")).toHaveCount(1);
	await expect(ws.getByTestId("chart-count")).toHaveText(
		"1 个节点 · 1 张图表 · 共 3 个节点声明了图表",
	);
	await ws.getByRole("textbox", { name: "搜索图表或节点" }).fill("");

	const plot = chart(page, "verify", "level").locator("svg[data-plot]");
	await expect(plot).toHaveCSS("height", "96px");
	await ws.getByRole("button", { name: "紧凑" }).click();
	await expect(plot).toHaveCSS("height", "56px");
});

test("悬停联动：图表上的竖线与读数跨图表和时间线按时间对齐", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);

	// 在 probe 的图表上悬停（probe 08:00:06 – 08:00:14，取 08:00:10.5）。
	const probePlot = chart(page, "probe", "level").locator("svg[data-plot]");
	await probePlot.scrollIntoViewIfNeeded();
	const plot = await probePlot.boundingBox();
	if (!plot) throw new Error("没有绘图区");
	await page.mouse.move(plot.x + plot.width * (4.5 / 8), plot.y + plot.height / 2);
	await expect(timeline(page).locator("[data-hover-line]")).toBeVisible();
	// 同一时刻在 verify 的图表（08:00:09 – 08:00:14）上也有竖线与读数。
	const verifyLevel = chart(page, "verify", "level");
	await expect(verifyLevel.locator("[data-chart-hover]")).toHaveCount(1);
	await expect(verifyLevel.locator("[data-hover-reading]")).toHaveText("08:00:10  10");
	await expect(chart(page, "probe", "level").locator("[data-hover-reading]")).toHaveText(
		"08:00:10  9",
	);
	// 时间线上的竖线在 10.5 / 14 处。
	const track = await timeline(page).locator('[data-node-row="fetch"] > div').boundingBox();
	const line = await timeline(page).locator("[data-hover-line]").boundingBox();
	if (!track || !line) throw new Error("没有竖线");
	expect((line.x - track.x) / track.width).toBeCloseTo(10.5 / 14, 1);

	await page.mouse.move(plot.x + plot.width / 2, plot.y - 200);
	await expect(page.locator("[data-chart-hover]")).toHaveCount(0);

	// 在时间线上悬停，图表上出现竖线。
	await page.mouse.move(track.x + track.width * (12.5 / 14), track.y + track.height / 2);
	await expect(verifyLevel.locator("[data-hover-reading]")).toHaveText("08:00:12  6");
	await expect(chart(page, "probe", "level").locator("[data-chart-hover]")).toHaveCount(1);
});

test("时间线拖选的范围作用于图表；日志标记显示在图表上；选中节点时展开它的组并显示节点摘要", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	const probeLevel = chart(page, "probe", "level");
	await expect(probeLevel.locator("[data-window]")).toHaveText("08:00:06 – 08:00:14");

	// 选中执行中的 verify（默认）：组内顶部显示节点摘要。
	await expect(group(page, "verify").getByTestId("node-summary")).toContainText(
		"demo-checks/ping@1.2.0",
	);
	await expect(group(page, "verify").getByTestId("node-summary")).toContainText("2");

	// 拖选 50%–100%（08:00:07 – 08:00:14）：probe 的横轴截到这一段，fetch（2–6 秒）在这段里没有数据。
	await brush(page, 0.5, 1);
	await expect(timeline(page).getByTestId("zoom-range")).toHaveText("08:00:07 – 08:00:14");
	await expect(probeLevel.locator("[data-window]")).toHaveText("08:00:07 – 08:00:14");

	// 选中折叠的 fetch：组展开、显示摘要。
	await timeline(page).locator('[data-node-row="fetch"] button').click();
	await expect(groupToggle(page, "fetch")).toHaveAttribute("aria-expanded", "true");
	await expect(group(page, "fetch").getByTestId("node-summary")).toContainText(
		"demo-checks/http_check@1.2.0",
	);
	await expect(group(page, "verify").getByTestId("node-summary")).toHaveCount(0);
	await expect(chart(page, "fetch", "延迟")).toContainText("所选时间段内无数据");
	await expect(group(page, "fetch")).toBeInViewport();

	await timeline(page).getByRole("button", { name: "回到实时" }).click();
	await expect(chart(page, "fetch", "延迟").locator("[data-window]")).toHaveText(
		"08:00:02 – 08:00:06",
	);

	// 点 fetch 的一行日志：图表上出现标记线。
	const line = panel(page)
		.getByRole("log", { name: "日志" })
		.getByRole("button", { name: /retrying request/ });
	await line.click();
	await expect(chart(page, "fetch", "延迟").locator("[data-chart-marker]")).toHaveCount(1);
	await line.click();
	await expect(chart(page, "fetch", "延迟").locator("[data-chart-marker]")).toHaveCount(0);
});
