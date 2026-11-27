import { actAs } from "../../server/test/support/credentials.js";
import type { AssignedTask } from "../../server/test/support/fake-agent.js";
import { ErrorKind, LogLevel } from "../../server/test/support/fake-agent.js";
import { inspector } from "./editor-support";
import { expect, test } from "./fixtures";
import { focusList, saveVersion, setFocusItems } from "./focus-support";
import {
	connPoint,
	labeledRun,
	logLine,
	MONITOR_SCENARIO,
	metricPackage,
	openMonitor,
	pingPoints,
	runningScenario,
	unixAt,
} from "./monitor-scenario";
import {
	attention,
	focusChart,
	OVERVIEW_ITEMS,
	openOverview,
	overviewRun,
	readouts,
	viewTab,
} from "./overview-support";
import { createScenario, publishPackage, scenarioUsing, triggerRun } from "./support";

// 运行监控「概览」（#344）：概览 / 详情标签页、地址与记住的视图、关注项读数与图表、没设关注项时的主指标。

const timeline = (page: import("@playwright/test").Page) =>
	page.getByRole("region", { name: "链路时间线" });

test("默认打开概览，地址跟着视图变，刷新后停在上次的视图；链接里写明的视图优先于记住的视图", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await page.clock.setFixedTime(clock.now());

	// 第一次打开：概览，当前视图写进地址。
	await page.goto(`/runs/${runId}`);
	await expect(viewTab(page, "概览")).toHaveAttribute("aria-selected", "true");
	await expect(page).toHaveURL(new RegExp(`/runs/${runId}\\?view=overview$`));
	await expect(page.getByRole("heading", { name: "链路", level: 2, exact: true })).toBeVisible();
	await expect(timeline(page)).toHaveCount(0);

	// 切到详情：就是原来的页面。
	await viewTab(page, "详情").click();
	await expect(viewTab(page, "详情")).toHaveAttribute("aria-selected", "true");
	await expect(page).toHaveURL(new RegExp(`/runs/${runId}\\?view=detail$`));
	await expect(timeline(page)).toBeVisible();
	await expect(page.getByRole("heading", { name: "链路", level: 2, exact: true })).toHaveCount(0);

	// 刷新停在详情；不带视图打开同一个运行，浏览器记住的上次视图是详情。
	await page.reload();
	await expect(viewTab(page, "详情")).toHaveAttribute("aria-selected", "true");
	await page.goto(`/runs/${runId}`);
	await expect(viewTab(page, "详情")).toHaveAttribute("aria-selected", "true");
	await expect(page).toHaveURL(new RegExp(`/runs/${runId}\\?view=detail$`));

	// 链接里写明的视图优先：发给同事的链接停在同一处，不看对方记住了什么。
	await page.goto(`/runs/${runId}?view=overview`);
	await expect(viewTab(page, "概览")).toHaveAttribute("aria-selected", "true");
	await expect(page.getByRole("heading", { name: "链路", level: 2, exact: true })).toBeVisible();

	// 切回概览之后，不带视图再打开，回到概览。
	await viewTab(page, "详情").click();
	await viewTab(page, "概览").click();
	await page.goto(`/runs/${runId}`);
	await expect(viewTab(page, "概览")).toHaveAttribute("aria-selected", "true");
});

test("地址里带 node 时概览标出这个节点的关注项（数值和图表），第一项滚进视野；换一个节点跟着换", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await overviewRun(controlPlane, connectAgent, clock);
	await page.clock.setFixedTime(clock.now());
	// 窗口矮到放不下整页：第二行的图表「清理 level」在视野外。
	await page.setViewportSize({ width: 1280, height: 520 });
	await page.goto(`/runs/${runId}?view=overview`);
	await expect(focusChart(page, "清理 level")).toBeAttached();
	await expect(focusChart(page, "清理 level")).not.toBeInViewport();
	const located = page.locator('[aria-current="location"]');
	await expect(located).toHaveCount(0);

	await page.goto(`/runs/${runId}?view=overview&node=cleanup`);
	await expect(viewTab(page, "概览")).toHaveAttribute("aria-selected", "true");
	await expect(located).toHaveCount(1);
	await expect(focusChart(page, "清理 level")).toHaveAttribute("aria-current", "location");
	await expect(focusChart(page, "清理 level")).toBeInViewport({ ratio: 1 });
	// 强制颜色模式（Windows 高对比度）换掉了描边色：被定位的卡片改用系统高亮色的内描边，别的卡片没有。
	await page.emulateMedia({ forcedColors: "active" });
	await expect(focusChart(page, "清理 level")).toHaveCSS("outline-style", "solid");
	await expect(focusChart(page, "下单延迟")).toHaveCSS("outline-style", "none");
	await page.emulateMedia({ forcedColors: "none" });

	// probe 有两项关注项：数值「total」和图表「探活 level」；别的节点的不标。
	await page.goto(`/runs/${runId}?view=overview&node=probe`);
	await expect(located).toHaveCount(2);
	await expect(located.filter({ hasText: "total" })).toHaveCount(1);
	await expect(focusChart(page, "探活 level")).toHaveAttribute("aria-current", "location");
	await expect(focusChart(page, "下单延迟")).not.toHaveAttribute("aria-current", "location");
});

test("地址里带 node 时，可视区域变小或版面变高后重新对准被定位的项；自己滚动过以后不再替他对准", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await overviewRun(controlPlane, connectAgent, clock);
	await page.clock.setFixedTime(clock.now());
	await page.setViewportSize({ width: 1280, height: 640 });
	await page.goto(`/runs/${runId}?view=overview&node=cleanup`);
	const located = focusChart(page, "清理 level");
	await expect(located).toBeInViewport({ ratio: 1 });

	// 版面变高：probe 打了一条 WARN，「需要注意」出现在关注项上面，把卡片往下推；页面跟着重新对准。
	agent.logs(tasks.probe as AssignedTask, [logLine(clock, 1, "探活超时", LogLevel.WARN)]);
	await agent.sync();
	await expect(attention(page)).toBeVisible();
	await expect(located).toBeInViewport({ ratio: 1 });

	// 窗口变矮：概览的可视区域变小，被定位的卡片重新对准，整张都在视野里。
	await page.setViewportSize({ width: 1280, height: 480 });
	await expect(located).toBeInViewport({ ratio: 1 });

	// 用户自己往上滚了：之后窗口再变，不把页面拉回去。
	await page.mouse.move(640, 300);
	await page.mouse.wheel(0, -5000);
	await expect(located).not.toBeInViewport();
	await page.setViewportSize({ width: 1280, height: 460 });
	await page.evaluate(
		() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
	);
	await expect(located).not.toBeInViewport();
});

test("标签页是 tablist：方向键、Home、End 切换并移动焦点，只有选中的标签在 Tab 顺序里", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openOverview(page, clock, runId);
	const overview = viewTab(page, "概览");
	const detail = viewTab(page, "详情");
	await expect(page.getByRole("tablist", { name: "运行监控视图" })).toBeVisible();
	await expect(overview).toHaveAttribute("tabindex", "0");
	await expect(detail).toHaveAttribute("tabindex", "-1");

	await overview.focus();
	await page.keyboard.press("ArrowRight");
	await expect(detail).toHaveAttribute("aria-selected", "true");
	await expect(detail).toBeFocused();
	await expect(timeline(page)).toBeVisible();
	await expect(page).toHaveURL(/view=detail/);

	await page.keyboard.press("ArrowRight");
	await expect(overview).toHaveAttribute("aria-selected", "true");
	await expect(overview).toBeFocused();
	await page.keyboard.press("End");
	await expect(detail).toBeFocused();
	await expect(detail).toHaveAttribute("aria-selected", "true");
	await page.keyboard.press("Home");
	await expect(overview).toBeFocused();
	await expect(overview).toHaveAttribute("aria-selected", "true");
	await page.keyboard.press("ArrowLeft");
	await expect(detail).toBeFocused();
	await expect(page.getByRole("tabpanel", { name: "详情", exact: true })).toBeVisible();
});

test("失败和取消的运行总是先打开详情：失败的运行定位到失败的节点，记住概览也一样", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	await agent.succeed(tasks.probe as AssignedTask);
	await agent.fail(tasks.verify as AssignedTask, "AssertionError: 仍然漏拦", ErrorKind.NODE_ERROR);
	const cleanup = await agent.nextAssign();
	clock.advance(1000);
	await agent.succeed(cleanup);
	await page.clock.setFixedTime(clock.now());
	// 浏览器记住的是概览。
	await page.addInitScript(() => window.localStorage.setItem("sfly.monitor.view", "overview"));

	await page.goto(`/runs/${runId}`);
	await expect(viewTab(page, "详情")).toHaveAttribute("aria-selected", "true");
	await expect(page).toHaveURL(new RegExp(`/runs/${runId}\\?view=detail$`));
	await expect(timeline(page).locator('[data-node-row="verify"] button')).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	// 用户自己切到概览，地址里写明的视图被尊重。
	await viewTab(page, "概览").click();
	await expect(page.getByRole("heading", { name: "链路", level: 2, exact: true })).toBeVisible();
	await page.reload();
	await expect(viewTab(page, "概览")).toHaveAttribute("aria-selected", "true");
});

test("取消的运行也先打开详情", async ({ page, controlPlane, connectAgent, clock }) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const res = await controlPlane.fetch(`/runs/${runId}/cancel`, {
		method: "POST",
		headers: { "content-type": "application/json", ...actAs("tester") },
		body: "{}",
	});
	expect(res.status).toBe(200);
	for (const task of [tasks.probe, tasks.verify] as AssignedTask[]) {
		await agent.nextCancel();
		await agent.cancelled(task);
	}
	// 清理节点（always）照常执行，之后运行才是已取消。
	await agent.succeed(await agent.nextAssign());
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/runs/${runId}`);
	await expect(page.getByRole("banner").getByTestId("run-status")).toHaveText("已取消");
	await expect(viewTab(page, "详情")).toHaveAttribute("aria-selected", "true");
});

test("读数：数值类的关注项排成一条，写状态形状、名称、最新值、来源节点和多久前；累计值就是当前累计，成功的节点是最终值", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await overviewRun(controlPlane, connectAgent, clock);
	await openOverview(page, clock, runId);

	const heading = page.getByRole("heading", { name: "关注项", level: 2 });
	await expect(heading).toBeVisible();
	await expect(page.getByTestId("focus-count")).toHaveText("6");
	await expect(readouts(page).getByRole("listitem")).toHaveCount(2);

	// 执行中的 probe：累计值 total 是 16（当前累计，不是速率），最后一个点在 1 秒前。
	const total = readouts(page).getByRole("button", {
		name: "total 16，来自 probe（执行中），1s 前",
	});
	await expect(total).toBeVisible();
	await expect(total).toContainText("total");
	await expect(total).toContainText("16");
	await expect(total).toContainText("probe · 1s 前");
	await expect(total.locator('[data-status-dot="running"]')).toHaveCount(1);

	// 已成功的 fetch：最终值，状态形状是成功。
	const errors = readouts(page).getByRole("button", {
		name: "errors 1 次，来自 fetch（成功），最终值",
	});
	await expect(errors).toContainText("1次");
	await expect(errors).toContainText("fetch · 最终值");
	await expect(errors.locator('[data-status-dot="ok"]')).toHaveCount(1);

	// 读数按作者的顺序：probe 的 total 在前（第 4 个），fetch 的 errors 在后（第 5 个）。
	await expect(readouts(page).getByRole("button")).toHaveText([/total/, /errors/]);
});

test("图表：按作者的顺序两列排开，纵轴从 0 开始，多条线有图例，还没开始的节点写明原因", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await overviewRun(controlPlane, connectAgent, clock);
	await openOverview(page, clock, runId);

	const titles = page.locator("[data-focus-chart] h3");
	await expect(titles).toHaveText(["下单延迟", "探活 level", "请求数", "清理 level"]);

	// 两列：第一行两张图表并排，第二行在下面。
	const boxes = await page.locator("[data-focus-chart]").evaluateAll((els) =>
		els.map((el) => {
			const r = el.getBoundingClientRect();
			return { x: Math.round(r.x), y: Math.round(r.y) };
		}),
	);
	expect(boxes[0]?.y).toBe(boxes[1]?.y);
	expect(boxes[0]?.x).toBeLessThan(boxes[1]?.x ?? 0);
	expect(boxes[2]?.y).toBeGreaterThan(boxes[0]?.y ?? 0);

	// 下单延迟：来源 fetch 已成功，读数是最近更新的那条线（latency_ms），有两条线的图例；纵轴从 0 开始。
	const latency = focusChart(page, "下单延迟");
	await expect(latency).toContainText("latency_ms");
	await expect(latency).toContainText("50");
	await expect(latency).toContainText("fetch · 最终值");
	const legend = latency.getByRole("list", { name: "图例" });
	await expect(legend.getByRole("listitem")).toHaveText(["latency_ms", "p99_ms"]);
	const plot = latency.getByRole("img", { name: /^下单延迟/ });
	await expect(plot.locator("text").first()).toHaveText("0");
	await expect(plot.locator("polyline")).toHaveCount(2);
	await expect(plot).toHaveAccessibleName("下单延迟 latency_ms 50 ms，来自 fetch（成功），最终值");

	// 柱状图画柱，不画线。
	const bars = focusChart(page, "请求数").getByRole("img", { name: /^请求数/ });
	await expect(bars.locator("rect")).not.toHaveCount(0);
	await expect(bars.locator("polyline")).toHaveCount(0);

	// 还没开始执行的 cleanup：没有数据，写明原因。
	await expect(focusChart(page, "清理 level")).toContainText("还没有开始执行");
	await expect(focusChart(page, "清理 level")).toContainText("cleanup · 还没有开始执行");
});

test("点任何一项都进入详情，并定位到它所在的节点", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await overviewRun(controlPlane, connectAgent, clock);
	await openOverview(page, clock, runId);

	await readouts(page)
		.getByRole("button", { name: /^total 16/ })
		.click();
	await expect(viewTab(page, "详情")).toHaveAttribute("aria-selected", "true");
	await expect(page).toHaveURL(new RegExp(`/runs/${runId}\\?view=detail&node=probe$`));
	await expect(timeline(page).locator('[data-node-row="probe"] button')).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	// 图表工作区里它所在的节点分组被选中。
	await expect(page.getByRole("region", { name: "probe 的图表" })).toHaveAttribute(
		"data-selected",
		"true",
	);

	await viewTab(page, "概览").click();
	await focusChart(page, "下单延迟").getByRole("button", { name: "在详情里查看 fetch" }).click();
	await expect(page).toHaveURL(new RegExp(`/runs/${runId}\\?view=detail&node=fetch$`));
	await expect(timeline(page).locator('[data-node-row="fetch"] button')).toHaveAttribute(
		"aria-pressed",
		"true",
	);
});

test("链路：各链的线路（子流程从触发它的节点分出），下面一行写进行中的节点、Agent、尝试号和已执行的时长", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openOverview(page, clock, runId);

	const rows = page.getByRole("list", { name: "各链进度" }).locator(":scope > li");
	await expect(rows).toHaveCount(2);
	await expect(rows.first()).toContainText("主链");
	await expect(rows.first()).toContainText("3/5");
	await expect(rows.first().getByRole("listitem")).toHaveText([
		"entry（成功）",
		"fetch（成功）",
		"spawn（成功）",
		"verify（执行中）",
		"cleanup（待执行）",
	]);
	await expect(rows.nth(1)).toContainText("子流程 sub");
	const [spawn, sub] = await Promise.all([
		rows.first().getByRole("listitem").filter({ hasText: "spawn" }).boundingBox(),
		rows.nth(1).getByRole("listitem").first().boundingBox(),
	]);
	expect(Math.abs((spawn?.x ?? 0) - (sub?.x ?? Number.NaN))).toBeLessThan(1);

	const running = page.getByRole("list", { name: "进行中的节点" });
	await expect(running.getByRole("listitem")).toHaveCount(2);
	await expect(running.getByRole("listitem").filter({ hasText: "verify" })).toContainText(
		"agent-a · 第 2 次尝试 · 5s",
	);
	await expect(running.getByRole("listitem").filter({ hasText: "probe" })).toContainText(
		"agent-a · 第 1 次尝试 · 8s",
	);
});

test("场景没设关注项：显示执行中节点的主指标，并给出「设置关注项」的入口", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, scenarioId } = await runningScenario(controlPlane, connectAgent, clock);
	await openOverview(page, clock, runId);

	await expect(page.getByRole("heading", { name: "执行中节点的主指标", level: 2 })).toBeVisible();
	await expect(page.getByText("场景没有设置关注项")).toBeVisible();
	const setting = page.getByRole("link", { name: "设置关注项" });
	await expect(setting).toHaveAttribute("href", `/orchestrations/${scenarioId}?settings=focus`);

	// 执行中的 verify（第 2 次尝试）和 probe 各一项；主指标 level 是瞬时值，写最近一个点。verify 的第 2 次尝试是第 9 秒
	// （上海时间 08:00:09）开始的重试，10 分钟以内算异常（#351），读数写原因、排在前面。
	const clock0 = Date.parse("2026-01-01T00:00:00.000Z");
	const last = (base: number, from: number) => {
		const level = pingPoints(clock0, from, 13, base).filter(([name]) => name === "level");
		return level.at(-1)?.[2];
	};
	const items = readouts(page).getByRole("button");
	await expect(items).toHaveCount(2);
	await expect(items.nth(0)).toHaveAccessibleName(
		`level ${last(5, 9)}，来自 verify（执行中），需要注意：重试（第 2 次尝试）· 08:00:09`,
	);
	await expect(items.nth(1)).toHaveAccessibleName(
		`level ${last(3, 6)}，来自 probe（执行中），1s 前`,
	);
	await expect(page.getByTestId("focus-count")).toHaveCount(0);

	// 入口直接打开场景设置的「关注项」页，不是停在「概况」。
	await setting.click();
	await expect(page).toHaveURL(new RegExp(`/orchestrations/${scenarioId}\\?settings=focus$`));
	const tab = inspector(page).getByRole("tab", { name: "关注项" });
	await expect(tab).toHaveAttribute("aria-selected", "true");
	await expect(inspector(page).getByRole("tab", { name: "概况" })).toHaveAttribute(
		"aria-selected",
		"false",
	);
	await expect(inspector(page).getByText("本场景的关注项已用 0 / 8")).toBeVisible();
});

test("场景没设关注项，执行中的节点都没声明主指标：写明这个原因；节点都结束、运行结束后不画写着没有执行中的节点的空框", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const scenarioId = await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));
	const runId = await triggerRun(controlPlane, scenarioId);
	const task = await agent.nextAssign();
	await openOverview(page, clock, runId);

	await expect(page.getByRole("list", { name: "进行中的节点" })).toContainText("ping");
	await expect(readouts(page)).toHaveCount(0);
	await expect(page.getByText("执行中的节点都没有声明主指标。")).toBeVisible();
	await expect(page.getByText("没有执行中的节点。")).toHaveCount(0);

	// 运行结束了：主指标是执行中节点的，不会再有读数。不画写着「没有执行中的节点」的空框，标题也不再写「执行中节点的主指标」：
	// 标题是「关注项」，下面一句说明为什么没有读数、怎么才会有，「设置关注项」还在。
	await agent.succeed(task);
	await expect(page.getByTestId("run-status")).toHaveText("成功");
	await expect(page.getByText("没有执行中的节点。")).toHaveCount(0);
	await expect(page.getByText("执行中的节点都没有声明主指标。")).toHaveCount(0);
	await expect(page.getByRole("region", { name: "执行中节点的主指标" })).toHaveCount(0);
	const section = page.getByRole("region", { name: "关注项", exact: true });
	await expect(section.getByRole("link", { name: "设置关注项" })).toBeVisible();
	await expect(section).toContainText(
		"运行结束后不再显示执行中节点的主指标。设置关注项后，这里会显示它们的最终值。",
	);
});

test("场景没设关注项，节点还在准备中（安装节点包）：显示它的主指标读数，写明还没有开始执行，不说没声明主指标", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane, metricPackage());
	const scenarioId = await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));
	const runId = await triggerRun(controlPlane, scenarioId);
	const task = await agent.nextAssign({ start: false });
	await openOverview(page, clock, runId);

	await expect(page.getByRole("heading", { name: "执行中节点的主指标", level: 2 })).toBeVisible();
	// 还没开始执行：时长处写「准备中」，不从排队算起（和控制台运行块、Agent 槽位格一样）。
	await expect(page.getByRole("list", { name: "进行中的节点" }).getByRole("listitem")).toHaveText([
		"ping agent-a · 第 1 次尝试 · 准备中",
	]);
	const item = readouts(page).getByRole("button");
	await expect(item).toHaveCount(1);
	await expect(item).toHaveAccessibleName("level —，来自 ping（准备中），还没有开始执行");
	await expect(page.getByText("执行中的节点都没有声明主指标。")).toHaveCount(0);
	await expect(page.getByText("没有执行中的节点。")).toHaveCount(0);

	await agent.started(task);
	await expect(item).toHaveAccessibleName("level —，来自 ping（执行中），还没有数据");
});

test("图表的序列多于 10 条：刷新后平均值的排名变了，画的还是第一次挑出的那几条", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { agent, task, runId, scenarioId, clock0 } = await labeledRun(
		{ controlPlane, connectAgent, clock },
		[
			{ name: "tps", unit: "req/s", kind: "gauge" },
			{ name: "conn_tps", unit: "req/s", kind: "gauge", labels: ["host"] },
		],
		[{ title: "各连接", type: "line", metrics: ["conn_tps"] }],
	);
	await setFocusItems(controlPlane, scenarioId, [
		{ node_id: "ping", chart: "各连接" },
		{ node_id: "ping", chart: "tps" },
	]);
	const host = (i: number) => `h${String(i).padStart(2, "0")}`;
	// 12 台主机各一个点，h00 最低、h11 最高：第一次只画最高的 10 条，h00、h01 不画。
	agent.metrics(task, [
		...Array.from({ length: 12 }, (_, i) => connPoint(clock0, { host: host(i) }, 1, 10 + 5 * i)),
		["tps", unixAt(clock0, 1), 77] as [string, number, number],
	]);
	await agent.sync();
	clock.advance(10_000);
	await openOverview(page, clock, runId);

	const legend = focusChart(page, "各连接").getByRole("list", { name: "图例" });
	await expect(legend).toContainText("还有 2 条序列");
	await expect(legend).not.toContainText("h00");
	await expect(legend).not.toContainText("h01");
	const before = await legend.getByRole("listitem").allTextContents();
	expect(before).toHaveLength(11);

	// h00、h01 之后的点把它们的平均值抬到最高：按这时的排名会换成它们。
	agent.metrics(task, [
		...[2, 3, 4, 5, 6].flatMap((s) => [
			connPoint(clock0, { host: host(0) }, s, 1000),
			connPoint(clock0, { host: host(1) }, s, 900),
		]),
		["tps", unixAt(clock0, 7), 88] as [string, number, number],
	]);
	await agent.sync();
	clock.advance(1000);
	// 同一次刷新里 tps 那张图表的读数变了：确认读数已经刷新过，再看图例。
	await expect(
		focusChart(page, "tps").getByRole("img", { name: /^tps 88 req\/s，来自 ping/ }),
	).toBeVisible();
	await expect(legend.getByRole("listitem")).toHaveText(before);
});

test("场景设了关注项：「调整关注项」也直接打开「关注项」页，列表里是这些项；地址里的值不合法时停在「概况」", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, scenarioId } = await overviewRun(controlPlane, connectAgent, clock);
	await openOverview(page, clock, runId);

	await page.getByRole("link", { name: "调整关注项" }).click();
	await expect(page).toHaveURL(new RegExp(`/orchestrations/${scenarioId}\\?settings=focus$`));
	const panel = inspector(page);
	await expect(panel.getByRole("tab", { name: "关注项" })).toHaveAttribute("aria-selected", "true");
	await expect(focusList(panel).getByRole("listitem")).toHaveCount(OVERVIEW_ITEMS.length);

	await page.goto(`/orchestrations/${scenarioId}?settings=bogus`);
	await expect(panel.getByRole("tab", { name: "概况" })).toHaveAttribute("aria-selected", "true");
});

test("运行中每 2 秒刷新：新上报的点出现在读数里，不用刷新页面；运行结束后读数变成最终值", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await overviewRun(controlPlane, connectAgent, clock);
	await openOverview(page, clock, runId);
	await expect(
		readouts(page).getByRole("button", { name: "total 16，来自 probe（执行中），1s 前" }),
	).toBeVisible();

	const clock0 = Date.parse("2026-01-01T00:00:00.000Z");
	agent.metrics(tasks.probe as AssignedTask, [["total", unixAt(clock0, 14), 18]]);
	await agent.sync();
	clock.advance(1000);
	await expect(
		readouts(page).getByRole("button", { name: "total 18，来自 probe（执行中），1s 前" }),
	).toBeVisible();

	// probe 成功后：最终值，不再「多久前」。
	await agent.succeed(tasks.probe as AssignedTask);
	await expect(
		readouts(page).getByRole("button", { name: "total 18，来自 probe（成功），最终值" }),
	).toBeVisible();
});

test("详情不受影响：用 view=detail 打开就是原来的页面", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	await expect(page.getByRole("region", { name: "图表工作区" })).toBeVisible();
	await expect(page.getByRole("region", { name: "底部面板" })).toBeVisible();
});

test("点一项进入详情后，焦点在「详情」标签上，键盘用户不会落在页面最前面", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await overviewRun(controlPlane, connectAgent, clock);
	await openOverview(page, clock, runId);
	const button = readouts(page).getByRole("button", { name: /^total 16/ });
	await button.focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/view=detail&node=probe$/);
	await expect(viewTab(page, "详情")).toBeFocused();
});

test("子流程还没触发的节点也在概览里：写明还没有开始执行，点开进入详情", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({
		name: "agent-a",
		slots: 4,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await publishPackage(controlPlane, metricPackage());
	const scenarioId = await createScenario(controlPlane, "日终数据处理", MONITOR_SCENARIO);
	await setFocusItems(controlPlane, scenarioId, [
		{ node_id: "probe", chart: "level", title: "探活 level" },
	]);
	const runId = await triggerRun(controlPlane, scenarioId);
	await agent.nextAssign();
	await openOverview(page, clock, runId);

	// 子流程要等 fetch 成功、spawn 执行之后才触发：probe 还没有链实例。
	const card = focusChart(page, "探活 level");
	await expect(card).toContainText("probe · 还没有开始执行");
	await card.getByRole("button", { name: "在详情里查看 probe" }).click();
	await expect(page).toHaveURL(new RegExp(`/runs/${runId}\\?view=detail&node=probe$`));
	await expect(timeline(page)).toBeVisible();
});

test("运行已经结束、子流程没有触发：节点写「这次运行没有执行」，不再说还会执行", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({
		name: "agent-a",
		slots: 4,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await publishPackage(controlPlane, metricPackage());
	const scenarioId = await createScenario(controlPlane, "日终数据处理", MONITOR_SCENARIO);
	await setFocusItems(controlPlane, scenarioId, [
		{ node_id: "probe", chart: "level", title: "探活 level" },
	]);
	const runId = await triggerRun(controlPlane, scenarioId);
	// fetch 两次尝试都失败（重试 1 次），运行结束：子流程没有触发，probe 一直待执行。
	await agent.fail(await agent.nextAssign(), "下单接口返回 503");
	await agent.fail(await agent.nextAssign(), "下单接口返回 503");
	await openOverview(page, clock, runId);

	const card = focusChart(page, "探活 level");
	await expect(card).toContainText("probe · 这次运行没有执行");
	await expect(card).not.toContainText("还没有开始执行");
});

test("排队中的节点（已有任务、还没开始）在概览和详情里写同一句话：还没有开始执行", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	// agent-b 注册过但不在线：派给它的任务一直排队。
	const offline = await connectAgent({
		name: "agent-b",
		slots: 1,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await offline.disconnect();
	await publishPackage(controlPlane, metricPackage());
	const scenarioId = await createScenario(controlPlane, "排队的节点", {
		default_agent: "agent-b",
		nodes: [
			{ id: "entry", kind: "entry", params: [] },
			{
				id: "probe",
				kind: "package",
				package: "demo-checks",
				node: "ping",
				inputs: { host: "p" },
			},
		],
		edges: [{ from: "entry", to: "probe", kind: "chain" }],
		packages: { "demo-checks": "1.2.0" },
	});
	await setFocusItems(controlPlane, scenarioId, [
		{ node_id: "probe", chart: "level", title: "探活 level" },
	]);
	const runId = await triggerRun(controlPlane, scenarioId);
	await openOverview(page, clock, runId);

	const card = focusChart(page, "探活 level");
	await expect(card).toContainText("probe · 还没有开始执行");
	await expect(card.locator("p + div")).toContainText("还没有开始执行");

	await viewTab(page, "详情").click();
	// 组默认展开还是收起取决于节点状态：等到图表或展开按钮出现，收起时点开。
	const group = page.getByRole("region", { name: "probe 的图表" });
	const figure = group.getByRole("figure", { name: "level", exact: true });
	const toggle = group.getByRole("button", { expanded: false });
	await expect(figure.or(toggle)).toBeVisible();
	if (!(await figure.isVisible())) await toggle.click();
	await expect(figure).toContainText("还没有开始执行");
});

test("这次运行的节点包版本里没有这张图表：读数写明原因，不显示数值", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, scenarioId } = await runningScenario(controlPlane, connectAgent, clock);
	// 之后的版本升到 1.3.0，http_check 的图表「吞吐」改名为「吞吐量」，作者按新名字设了关注项；这次运行锁定的是 1.2.0。
	const renamed = metricPackage().nodes.map((node) => ({
		...node,
		...("charts" in node
			? { charts: node.charts.map((c) => (c.title === "吞吐" ? { ...c, title: "吞吐量" } : c)) }
			: {}),
	}));
	await publishPackage(controlPlane, { version: "1.3.0", nodes: renamed });
	await saveVersion(controlPlane, scenarioId, 1, {
		...MONITOR_SCENARIO,
		packages: { "demo-checks": "1.3.0" },
	});
	await setFocusItems(controlPlane, scenarioId, [
		{ node_id: "fetch", chart: "吞吐量" },
		{ node_id: "fetch", chart: "errors" },
	]);
	await openOverview(page, clock, runId);

	const missing = readouts(page).getByRole("button", { name: /没有图表 吞吐量/ });
	await expect(missing).toContainText("这个版本的节点没有图表 吞吐量");
	// 没有值可说：脚注只写来源节点，不写「最终值」。
	await expect(missing).not.toContainText("最终值");
	await expect(missing).toContainText("fetch");
	// 其余项照常显示。
	await expect(readouts(page).getByRole("button", { name: /^errors 1 次/ })).toBeVisible();
});

test("概览里点失败区域的按钮：切到详情并打开失败节点的「尝试」页签，不改记住的视图；顶栏不重复失败摘要", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	await agent.succeed(tasks.probe as AssignedTask);
	await agent.fail(tasks.verify as AssignedTask, "AssertionError: 仍然漏拦", ErrorKind.NODE_ERROR);
	const cleanup = await agent.nextAssign();
	clock.advance(1000);
	await agent.succeed(cleanup);
	await openOverview(page, clock, runId);

	// 概览没有失败横幅（横幅是详情里时间线上方的），失败区域在最上面；失败区域已经写着失败，顶栏不再写一遍。
	await expect(page.locator('[data-slot="banner"]')).toHaveCount(0);
	const area = page.getByTestId("failure-area");
	await expect(area).toBeVisible();
	await expect(page.getByRole("banner").getByTestId("run-failure")).toHaveCount(0);
	await area.getByRole("button", { name: "在详情里查看 verify 的尝试" }).click();
	await expect(viewTab(page, "详情")).toHaveAttribute("aria-selected", "true");
	await expect(
		page.getByRole("region", { name: "底部面板" }).getByRole("tab", { name: "尝试" }),
	).toHaveAttribute("aria-selected", "true");
	expect(await page.evaluate(() => window.localStorage.getItem("sfly.monitor.view"))).toBeNull();
});
