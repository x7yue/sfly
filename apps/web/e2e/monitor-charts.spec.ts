import type { Page } from "@playwright/test";
import type { AssignedTask } from "../../server/test/support/fake-agent.js";
import { expect, test } from "./fixtures";
import {
	connPoint,
	labeledRun,
	logLine,
	openMonitor,
	runningScenario,
	unixAt,
} from "./monitor-scenario";
import { createScenario, publishPackage, scenarioUsing, triggerRun } from "./support";

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

/** 拖选时间线轨道（node 那一行）上 a–b（比例）这一段。 */
async function brush(page: Page, a: number, b: number, node = "fetch") {
	const track = await timeline(page).locator(`[data-node-row="${node}"] > div`).boundingBox();
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

	await expect(ws.getByTestId("chart-count")).toHaveText("12 张图表，来自 3 个节点和平台自带");
	await expect
		.poll(() => groupOrder(page))
		.toEqual(["fetch 的图表", "verify 的图表", "probe 的图表", "平台自带图表"]);

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

test("每张图表只查它引用的指标；折叠的组只查组标题上的主指标（#153）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	// 每个节点请求过的 metrics 参数。
	const requested = new Map<string, Set<string | null>>();
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (!url.pathname.endsWith("/metrics/series")) return;
		const node = url.searchParams.get("node_id") ?? "";
		const set = requested.get(node) ?? new Set();
		set.add(url.searchParams.get("metrics"));
		requested.set(node, set);
	});
	const metricsOf = (node: string) => [...(requested.get(node) ?? [])].sort();
	await openMonitor(page, clock, runId);
	const fetch = group(page, "fetch");

	// fetch 成功后折叠：只查主指标；执行中的 verify 展开：两张默认图表各查一次（level 也是主指标）。
	await expect(fetch.locator('[data-primary-metric="latency_ms"]')).toContainText("50ms");
	await expect(chart(page, "verify", "total")).toBeVisible();
	await expect.poll(() => metricsOf("verify")).toEqual(["level", "total"]);
	expect(metricsOf("fetch")).toEqual(["latency_ms"]);

	// 展开 fetch：每张图表按它引用的指标查询，不再有查全部指标的请求。
	await groupToggle(page, "fetch").click();
	await expect(chart(page, "fetch", "延迟").locator("[data-series]")).toHaveCount(2);
	await expect
		.poll(() => metricsOf("fetch"))
		.toEqual(["errors", "latency_ms", "latency_ms,p99_ms", "requests", "rps"]);
	await expect(chart(page, "fetch", "吞吐").locator("[data-series] path")).toHaveCount(2);
});

test("四种图表类型与多序列图例；横轴是节点实际运行的时段并标出起止时间；运行中实时追加；纵轴上限与最新值相同时不重复显示", async ({
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
	// 两个不带标签的指标：标题栏不显示最新值（读数在悬停提示里）。
	await expect(latency.locator("[data-latest]")).toHaveCount(0);
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
	await expect(level.locator("[data-axis-max]")).toHaveText("9");
	agent.metrics(tasks.probe as AssignedTask, [["level", unixAt(clock0, 14), 42]]);
	await expect(level.locator("[data-latest]")).toHaveText("42");
	await expect(level.locator("[data-axis-max]")).toHaveCount(0);
	await expect(group(page, "probe").locator('[data-primary-metric="level"]')).toContainText("42");
});

test("带标签的指标每个序列一条线，图例用标签值命名；运行中出现的新序列实时加入图表", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { agent, task, runId, clock0 } = await labeledRun(
		{ controlPlane, connectAgent, clock },
		[
			{ name: "tps", unit: "req/s", kind: "gauge" },
			// 图例按声明的标签键顺序（port 在前）连接标签值。
			{ name: "conn_tps", unit: "req/s", kind: "gauge", labels: ["port", "host"] },
		],
		[
			{ title: "各连接", type: "line", metrics: ["conn_tps"] },
			{ title: "合计与各连接", type: "area", metrics: ["tps", "conn_tps"] },
		],
	);
	const conn = (host: string, s: number, value: number) =>
		connPoint(clock0, { host, port: "80" }, s, value);
	agent.metrics(task, [
		...[1, 2, 3].flatMap((s) => [conn("a", s, 10 + s), conn("b", s, 20 + s)]),
		...[1, 2, 3].map((s): [string, number, number] => ["tps", unixAt(clock0, s), 30 + s]),
	]);
	await agent.sync();
	clock.advance(5000);
	await openMonitor(page, clock, runId, "ping");

	const byConn = chart(page, "ping", "各连接");
	await expect(byConn.locator("[data-series] path")).toHaveCount(2);
	await expect(byConn.locator("[data-legend]")).toHaveText(["80 · a", "80 · b"]);
	const mixed = chart(page, "ping", "合计与各连接");
	await expect(mixed.locator("[data-series]")).toHaveCount(3);
	await expect(mixed.locator("[data-legend]")).toHaveText([
		"tps",
		"conn_tps · 80 · a",
		"conn_tps · 80 · b",
	]);
	// 标题栏的最新值：合计与各连接显示合计（不带标签的 tps）；只有各连接的多条线时不显示，读数在悬停提示里。
	await expect(mixed.locator("[data-latest]")).toHaveText("33req/s");
	await expect(byConn.locator("[data-latest]")).toHaveCount(0);
	// 主指标（不带标签）照常显示最新值。
	await expect(group(page, "ping").locator('[data-primary-metric="tps"]')).toContainText("33");

	// 运行中出现的新序列实时加入图表和图例。
	agent.metrics(task, [conn("c", 4, 5)]);
	await expect(byConn.locator("[data-legend]")).toHaveText(["80 · a", "80 · b", "80 · c"]);
	await expect(byConn.locator("[data-series] path")).toHaveCount(3);
	await expect(mixed.locator("[data-legend]")).toHaveText([
		"tps",
		"conn_tps · 80 · a",
		"conn_tps · 80 · b",
		"conn_tps · 80 · c",
	]);
});

test("序列超过 10 个时默认只显示时间范围内平均值最高的 10 个，其余在图例里置灰；点击图例切换；缩放后按新范围重新挑选", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { agent, task, runId, clock0 } = await labeledRun(
		{ controlPlane, connectAgent, clock },
		[
			{ name: "tps", unit: "req/s", kind: "gauge" },
			{ name: "conn_tps", unit: "req/s", kind: "gauge", labels: ["host"] },
		],
		[{ title: "各连接", type: "line", metrics: ["conn_tps"] }],
	);
	// h03…h12 在第 1–6 秒恒为 30…120；h01 恒为 10；h02 前 5 秒是 0、第 6 秒跳到 100
	// （最新值比多数序列高，但整段的平均值只有 16.7）。
	const hosts = Array.from({ length: 12 }, (_, i) => `h${String(i + 1).padStart(2, "0")}`);
	const value = (host: string, s: number) =>
		host === "h01" ? 10 : host === "h02" ? (s === 6 ? 100 : 0) : Number(host.slice(1)) * 10;
	agent.metrics(
		task,
		[1, 2, 3, 4, 5, 6].flatMap((s) =>
			hosts.map((h) => connPoint(clock0, { host: h }, s, value(h, s))),
		),
	);
	await agent.sync();
	clock.advance(10_000);
	await openMonitor(page, clock, runId, "ping");

	const byConn = chart(page, "ping", "各连接");
	const legend = byConn.locator("[data-legend]");
	await expect(legend).toHaveText(hosts);
	await expect(byConn.locator("[data-series]")).toHaveCount(10);
	await expect(byConn.locator("[data-legend][aria-pressed=false]")).toHaveText(["h01", "h02"]);
	await expect(byConn.locator('[data-series="h02"]')).toHaveCount(0);

	// 拖选到最后几秒：h02 在这段里的平均值超过 h03，h03 改为置灰。
	await brush(page, 0.55, 1, "ping");
	await expect(byConn.locator("[data-legend][aria-pressed=false]")).toHaveText(["h01", "h03"]);
	await expect(byConn.locator("[data-series]")).toHaveCount(10);
	await timeline(page).getByRole("button", { name: "回到实时" }).click();
	await expect(byConn.locator("[data-legend][aria-pressed=false]")).toHaveText(["h01", "h02"]);

	// 点置灰的图例项显示它，点显示中的图例项隐藏它。
	await legend.filter({ hasText: "h01" }).click();
	await expect(legend.filter({ hasText: "h01" })).toHaveAttribute("aria-pressed", "true");
	await expect(byConn.locator('[data-series="h01"]')).toHaveCount(1);
	await expect(byConn.locator("[data-series]")).toHaveCount(11);
	await legend.filter({ hasText: "h12" }).click();
	await expect(legend.filter({ hasText: "h12" })).toHaveAttribute("aria-pressed", "false");
	await expect(byConn.locator('[data-series="h12"]')).toHaveCount(0);
	await expect(byConn.locator("[data-series]")).toHaveCount(10);

	// 只看这个节点：图表与图例的选择照常。
	await workspace(page).getByRole("button", { name: "只看 ping" }).click();
	await expect.poll(() => groupOrder(page)).toEqual(["ping 的图表"]);
	await expect(byConn.locator("[data-legend][aria-pressed=false]")).toHaveText(["h02", "h12"]);
});

test("悬停多序列图表时，提示列出所有可见序列在那一刻的值；其他图表照常联动", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { agent, task, runId, clock0 } = await labeledRun(
		{ controlPlane, connectAgent, clock },
		[
			{ name: "tps", unit: "req/s", kind: "gauge" },
			{ name: "conn_tps", unit: "req/s", kind: "gauge", labels: ["host"] },
		],
		[
			{ title: "合计与各连接", type: "line", metrics: ["tps", "conn_tps"] },
			{ title: "合计", type: "line", metrics: ["tps"] },
		],
	);
	agent.metrics(task, [
		...[1, 2, 3, 4, 5, 6, 7].flatMap((s) => [
			connPoint(clock0, { host: "a" }, s, s),
			connPoint(clock0, { host: "b" }, s, 10 * s),
			["tps", unixAt(clock0, s), 11 * s] as [string, number, number],
		]),
	]);
	await agent.sync();
	clock.advance(8000);
	await openMonitor(page, clock, runId, "ping");

	const mixed = chart(page, "ping", "合计与各连接");
	// 运行 08:00:00 开始；悬停在第 4.5 秒（横轴是 0–8 秒）。
	const plotBox = await mixed.locator("svg[data-plot]").boundingBox();
	if (!plotBox) throw new Error("没有绘图区");
	await page.mouse.move(plotBox.x + plotBox.width * (4.5 / 8), plotBox.y + plotBox.height / 2);
	const values = mixed.locator("[data-hover-values] [data-hover-value]");
	// 按这一刻的值从大到小。
	await expect(values).toHaveText(["tps44", "conn_tps · b40", "conn_tps · a4"]);
	await expect(mixed.locator("[data-hover-reading]")).toHaveText("08:00:04");
	// 只有一条线的图表照常在标题栏显示读数，不弹出提示。
	const total = chart(page, "ping", "合计");
	await expect(total.locator("[data-hover-reading]")).toHaveText("08:00:04  44");
	await expect(total.locator("[data-hover-values]")).toHaveCount(0);

	// 隐藏的序列不在提示里。
	await page.mouse.move(0, 0);
	await mixed.locator("[data-legend]").filter({ hasText: "conn_tps · b" }).click();
	await page.mouse.move(plotBox.x + plotBox.width * (4.5 / 8), plotBox.y + plotBox.height / 2);
	await expect(values).toHaveText(["tps44", "conn_tps · a4"]);
	await page.mouse.move(0, 0);
	await expect(mixed.locator("[data-hover-values]")).toHaveCount(0);
});

test("任务的序列数超过上限时，组标题和引用带标签指标的图表上显示「序列超限」", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { agent, task, runId, clock0 } = await labeledRun(
		{ controlPlane, connectAgent, clock },
		[
			{ name: "tps", unit: "req/s", kind: "gauge" },
			{ name: "conn_tps", unit: "req/s", kind: "gauge", labels: ["host"] },
		],
		[
			{ title: "合计", type: "line", metrics: ["tps"] },
			{ title: "各连接", type: "line", metrics: ["conn_tps"] },
		],
	);
	// 上限 1000 个序列，tps 占 1 个：conn_tps 的第 1000 个序列被拒绝。
	agent.metrics(task, [
		["tps", unixAt(clock0, 1), 1],
		...Array.from({ length: 1000 }, (_, i) => connPoint(clock0, { host: `h${i}` }, 1, i)),
	]);
	await agent.sync();
	clock.advance(5000);
	await openMonitor(page, clock, runId, "ping");

	const ping = group(page, "ping");
	await expect(ping.getByText("序列超限", { exact: true })).toHaveCount(2);
	await expect(chart(page, "ping", "各连接")).toContainText("序列超限");
	await expect(chart(page, "ping", "合计")).not.toContainText("序列超限");
	await expect(ping).toContainText("丢弃 1 个点");
	await expect(ping).not.toContainText("截断");
});

test.describe("指标超过单任务上限", () => {
	// 每点 28 字节：一个任务最多 5 个点。
	test.use({ controlPlaneOptions: { metricLimitBytes: 28 * 5 } });

	test("任务的指标数据被截断时，组标题和每张图表都显示截断提示（每张图表各自查询，#153）", async ({
		page,
		controlPlane,
		connectAgent,
		clock,
	}) => {
		const { agent, task, runId, clock0 } = await labeledRun(
			{ controlPlane, connectAgent, clock },
			[
				{ name: "tps", unit: "req/s", kind: "gauge" },
				{ name: "conn_tps", unit: "req/s", kind: "gauge", labels: ["host"] },
			],
			[
				{ title: "合计", type: "line", metrics: ["tps"] },
				{ title: "各连接", type: "line", metrics: ["conn_tps"] },
			],
		);
		agent.metrics(
			task,
			Array.from({ length: 8 }, (_, i): [string, number, number] => [
				"tps",
				unixAt(clock0, i + 1),
				i,
			]),
		);
		await agent.sync();
		clock.advance(5000);
		await openMonitor(page, clock, runId, "ping");

		const ping = group(page, "ping");
		await expect(ping).toContainText("数据已截断");
		await expect(chart(page, "ping", "合计")).toContainText("已截断");
		await expect(chart(page, "ping", "各连接")).toContainText("已截断");
		await expect(ping).not.toContainText("序列超限");
	});
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
	await expect(ws.getByTestId("chart-count")).toContainText("来自 3 个节点");

	await ws.getByRole("button", { name: /节点：全部节点/ }).click();
	const menu = page.getByRole("dialog", { name: "按节点筛选图表" });
	// 取消整条子流程链。
	await menu.getByRole("checkbox", { name: /^子流程 sub/ }).uncheck();
	await expect(group(page, "probe")).toHaveCount(0);
	await expect(ws.getByRole("button", { name: /节点：已选 2 个节点/ })).toBeVisible();
	await expect(ws.getByTestId("chart-count")).toHaveText("10 张图表，来自 2 个节点和平台自带");

	// 搜索节点，单独勾选。
	await menu.getByRole("textbox", { name: "搜索节点 ID 或名称" }).fill("pro");
	await expect(menu.getByRole("checkbox", { name: "fetch" })).toHaveCount(0);
	await menu.getByRole("checkbox", { name: "probe" }).check();
	await expect(group(page, "probe")).toBeVisible();
	await menu.getByRole("textbox", { name: "搜索节点 ID 或名称" }).fill("");

	// 快速选择：执行中（不含平台自带图表），再单独勾上平台自带图表。
	await menu.getByRole("button", { name: "执行中", exact: true }).click();
	await expect.poll(() => groupOrder(page)).toEqual(["verify 的图表", "probe 的图表"]);
	await menu.getByRole("checkbox", { name: "平台自带图表" }).check();
	await expect
		.poll(() => groupOrder(page))
		.toEqual(["verify 的图表", "probe 的图表", "平台自带图表"]);
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
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：跟随筛选（2 个节点）");
	await timeline(page).locator('[data-node-row="verify"] button').click();
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：verify（第 2 次）");
	await timeline(page).locator('[data-node-row="verify"] button').click();
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：跟随筛选（2 个节点）");

	await ws.getByRole("button", { name: "清除筛选" }).click();
	await expect(ws.getByRole("button", { name: /节点：全部节点/ })).toBeVisible();
	await expect(ws.locator("[data-group]")).toHaveCount(4);
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：全部节点");
});

test("没有节点上报指标：图表工作区只剩一行说明和折叠的平台自带图表，剩下的高度给底部面板", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({
		name: "agent-a",
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await publishPackage(controlPlane);
	const scenarioId = await createScenario(controlPlane, "无指标", scenarioUsing("agent-a"));
	const runId = await triggerRun(controlPlane, scenarioId);
	const ping = await agent.nextAssign();
	agent.logs(ping, [logLine(clock, 1, "ping started")]);
	await agent.sync();

	await openMonitor(page, clock, runId);
	const ws = workspace(page);
	const platform = ws.getByRole("region", { name: "平台自带图表" });
	await expect(ws).toContainText("这次运行没有节点上报指标");
	await expect(ws.getByRole("toolbar", { name: "图表工具栏" })).toHaveCount(0);
	await expect(platform.getByRole("button", { expanded: false })).toBeVisible();
	await expect(panel(page).getByRole("log", { name: "日志" })).toContainText("ping started");

	const collapsed = { ws: await ws.boundingBox(), bp: await panel(page).boundingBox() };
	if (!collapsed.ws || !collapsed.bp) throw new Error("没有版面");
	// 底部面板占满剩下的高度，比默认的 28% 大得多。
	expect(collapsed.ws.height).toBeLessThan(150);
	expect(collapsed.bp.y - (collapsed.ws.y + collapsed.ws.height)).toBeLessThan(2);
	expect(collapsed.bp.y + collapsed.bp.height).toBeCloseTo(page.viewportSize()?.height ?? 0, -1);
	expect(collapsed.bp.height).toBeGreaterThan(400);

	// 底部面板让出高度，但不低于默认高度。
	await platform.getByRole("button", { expanded: false }).click();
	await expect(platform.getByRole("figure", { name: "并发任务数" })).toBeVisible();
	const expanded = { ws: await ws.boundingBox(), bp: await panel(page).boundingBox() };
	if (!expanded.ws || !expanded.bp) throw new Error("没有版面");
	expect(expanded.ws.height).toBeGreaterThan(collapsed.ws.height + 150);
	expect(expanded.bp.height).toBeLessThan(collapsed.bp.height);
	expect(expanded.bp.height).toBeGreaterThanOrEqual(230);
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
	await expect.poll(() => groupOrder(page)).toEqual(["fetch 的图表"]);
	await expect(groupToggle(page, "fetch")).toHaveAttribute("aria-expanded", "true");
	await expect(ws.getByRole("button", { name: /节点：fetch/ })).toBeVisible();
	await expect(ws.getByRole("button", { name: "只看 fetch" })).toHaveCount(0);
	await ws.getByRole("button", { name: "清除筛选" }).click();
	await expect(ws.locator("[data-group]")).toHaveCount(4);

	await ws.getByRole("textbox", { name: "搜索图表或节点" }).fill("吞吐");
	await expect.poll(() => groupOrder(page)).toEqual(["fetch 的图表"]);
	await expect(group(page, "fetch").getByRole("figure")).toHaveCount(1);
	await expect(ws.getByTestId("chart-count")).toHaveText("1 张图表，来自 1 个节点");
	await ws.getByRole("textbox", { name: "搜索图表或节点" }).fill("");

	const plot = chart(page, "verify", "level").locator("svg[data-plot]");
	await expect(plot).toHaveCSS("height", "96px");
	await ws.getByRole("button", { name: "紧凑" }).click();
	await expect(plot).toHaveCSS("height", "56px");
});

test("Agent 时间比控制面快 613 天：图表照常有数据并与时间线对齐，悬停提示同时显示控制面时间和 Agent 时间", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const FAST_S = 613 * 86_400;
	const { agent, task, runId, clock0 } = await labeledRun(
		{ controlPlane, connectAgent, clock },
		[{ name: "tps", unit: "req/s", kind: "gauge" }],
		[{ title: "合计", type: "line", metrics: ["tps"] }],
		{ agentTimeUnixMs: BigInt(clock.now().getTime() + FAST_S * 1000) },
	);
	// 每秒一个点：发生在运行开始后第 s 秒（控制面时间），Agent 上的时间是 613 天之后。
	agent.metrics(
		task,
		[1, 2, 3, 4, 5, 6, 7].map((s) => ({
			name: "tps",
			timeUnixS: BigInt(unixAt(clock0, s) + FAST_S),
			monotonicMs: agent.monotonicAt(clock0 + s * 1000),
			value: 11 * s,
			min: 11 * s,
			max: 11 * s,
		})),
	);
	await agent.sync();
	clock.advance(8000);
	await openMonitor(page, clock, runId, "ping");

	// 点没有因为 Agent 时间偏差被丢弃：图表有数据，横轴是节点运行的时段（控制面时间）。
	const total = chart(page, "ping", "合计");
	await expect(total.locator("[data-latest]")).toHaveText("77req/s");
	await expect(total.locator("[data-window]")).toHaveText("08:00:00 – 08:00:08");

	// 悬停在第 4.5 秒：读数是控制面时间第 4 秒的点，提示里同时给出两种时间。
	const plot = await total.locator("svg[data-plot]").boundingBox();
	if (!plot) throw new Error("没有绘图区");
	await page.mouse.move(plot.x + plot.width * (4.5 / 8), plot.y + plot.height / 2);
	await expect(total.locator("[data-hover-reading]")).toHaveText("08:00:04  44");
	await expect(total.locator("[data-hover-time]")).toHaveText("控制面时间 2026-01-01 08:00:04");
	await expect(total.locator("[data-hover-agent-time]")).toHaveText(
		"Agent 时间 2027-09-06 08:00:04",
	);
	// 和时间线对齐：ping 的条带是它运行的 8 秒，时间线上的竖线也在条带的 4.5 / 8 处。
	const bar = await timeline(page).locator('[data-node-row="ping"] [data-segment]').boundingBox();
	const line = await timeline(page).locator("[data-hover-line]").boundingBox();
	if (!bar || !line) throw new Error("没有竖线");
	expect((line.x - bar.x) / bar.width).toBeCloseTo(4.5 / 8, 1);

	// 实时追加的点同样按控制面时间落位，带着 Agent 时间。
	await page.mouse.move(0, 0);
	agent.metrics(task, [
		{
			name: "tps",
			timeUnixS: BigInt(unixAt(clock0, 8) + FAST_S),
			monotonicMs: agent.monotonicAt(clock0 + 8000),
			value: 99,
			min: 99,
			max: 99,
		},
	]);
	await expect(total.locator("[data-latest]")).toHaveText("99req/s");
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

	// 移到顶栏上（离开所有图表与时间线）。
	await page.mouse.move(plot.x + plot.width / 2, 8);
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

	await expect(group(page, "verify").getByTestId("node-summary")).toHaveCount(0);
	await timeline(page).locator('[data-node-row="verify"] button').click();
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

test("重试过的节点可以切换查看每次尝试的图表，默认看最新一次", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);

	const verify = group(page, "verify");
	const attempt = verify.getByRole("combobox", { name: "verify 的尝试" });
	await expect(attempt).toHaveValue("2");
	await expect(attempt.getByRole("option")).toHaveText(["第 1 次", "第 2 次（最新）"]);
	const level = chart(page, "verify", "level");
	await expect(level.locator("[data-latest]")).toHaveText("11");
	await expect(level.locator("[data-window]")).toHaveText("08:00:09 – 08:00:14");

	// 第 1 次失败、没有上报指标：显示它自己的状态与时段。
	await attempt.selectOption("1");
	await expect(verify.locator("[data-status]").first()).toHaveText("失败");
	await expect(level).toContainText("这次尝试没有上报数据");

	await attempt.selectOption("2");
	await expect(level.locator("[data-latest]")).toHaveText("11");
	// 没有重试的节点没有尝试切换。
	await expect(group(page, "probe").getByRole("combobox", { name: /的尝试/ })).toHaveCount(0);
});
