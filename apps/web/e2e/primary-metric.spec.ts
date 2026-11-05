import type { AssignedTask } from "../../server/test/support/fake-agent.js";
import { createEditorScenario, editorDocument, nodeCard } from "./editor-support";
import { expect, START_TIME, test } from "./fixtures";
import { metricPackage, runningScenario, unixAt } from "./monitor-scenario";
import { createScenario, publishPackage } from "./support";

// 主指标与指标声明在各处的展示（#43）：节点包管理页、检查器「说明与指标」、画布运行状态的节点卡片、
// 运行抽屉摘要、运行记录的进行中卡片。

const START = Date.parse(START_TIME);

test("节点包管理页：每个节点类型显示声明的指标与图表（含默认生成的图表）和主指标", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane, metricPackage());
	await page.goto("/packages?name=demo-checks");
	const table = page
		.getByRole("region", { name: "demo-checks 详情" })
		.getByRole("table", { name: "节点类型" });
	await expect(table.getByRole("columnheader")).toHaveText([
		"节点类型",
		"输入",
		"输出",
		"声明的指标",
		"图表",
	]);
	const http = table.getByRole("row", { name: /http_check/ }).getByRole("cell");
	await expect(http.nth(3)).toHaveText(
		"latency_ms ms · p99_ms ms · rps req/s · requests 次 · errors 次",
	);
	await expect(http.nth(4)).toHaveText(
		"4 张 · 主指标 latency_ms延迟 · 吞吐 · 请求数 · errors 默认",
	);
	const ping = table.getByRole("row", { name: /ping/ }).getByRole("cell");
	await expect(ping.nth(3)).toHaveText("level · total");
	await expect(ping.nth(4)).toHaveText("2 张 · 主指标 levellevel 默认 · total 默认");
	await expect(ping.nth(3).getByTitle("level（瞬时值）：瞬时值")).toBeVisible();
});

test("节点包管理页：没有声明指标的节点类型只有平台自带图表", async ({ page, controlPlane }) => {
	await publishPackage(controlPlane);
	await page.goto("/packages?name=demo-checks");
	const row = page.getByRole("table", { name: "节点类型" }).getByRole("row", { name: /ping/ });
	await expect(row.getByRole("cell").nth(3)).toHaveText("—");
	await expect(row.getByRole("cell").nth(4)).toHaveText("—（平台自带图表）");
});

test("检查器「说明与指标」：包节点显示节点类型声明的指标与图表；其他节点只有「说明」", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane, metricPackage());
	const id = await createScenario(controlPlane, "日终数据处理", editorDocument);
	await page.goto(`/orchestrations/${id}`);
	await nodeCard(page, "fetch").click();
	const panel = page.getByRole("complementary", { name: "检查器" });
	await expect(panel.getByRole("tab")).toHaveText(["参数", "执行", "说明与指标"]);
	await panel.getByRole("tab", { name: "说明与指标" }).click();
	const metrics = panel.getByRole("list", { name: "声明的指标" });
	await expect(metrics.getByRole("listitem")).toHaveCount(5);
	await expect(metrics.getByRole("listitem").first()).toHaveText("latency_msms· 瞬时值主指标");
	const charts = panel.getByRole("list", { name: "图表" });
	await expect(charts.getByRole("listitem")).toHaveText([
		"延迟折线latency_ms · p99_ms",
		"吞吐面积rps",
		"请求数柱状requests",
		"errors数值卡errors默认",
	]);

	await nodeCard(page, "dispatch").click();
	await expect(panel.getByRole("tab")).toHaveText(["参数", "说明"]);
});

test("检查器「说明与指标」：节点类型没有声明指标时说明只有平台自带图表", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await page.goto(`/orchestrations/${id}`);
	await nodeCard(page, "ping").click();
	const panel = page.getByRole("complementary", { name: "检查器" });
	await panel.getByRole("tab", { name: "说明与指标" }).click();
	await expect(panel).toContainText("这个节点类型没有声明指标，运行时只显示平台自带图表。");
});

test("画布运行状态：节点卡片的指标槽显示主指标最新值与迷你趋势并实时更新；没有开始执行的节点显示关键输入", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { scenarioId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	await page.goto(`/orchestrations/${scenarioId}`);
	await page.locator("body").press("r");
	await expect(nodeCard(page, "fetch")).toHaveAttribute("data-run", "done");

	const fetch = nodeCard(page, "fetch").locator('[data-primary-metric="latency_ms"]');
	await expect(fetch).toHaveText("latency_ms 50 ms");
	await expect(fetch.locator("[data-sparkline]")).toHaveCount(1);
	await expect(nodeCard(page, "verify").locator('[data-primary-metric="level"]')).toHaveText(
		"level 11",
	);
	// cleanup 还没开始执行：沿用配置摘要（关键输入）。
	await expect(nodeCard(page, "cleanup")).toContainText("host = localhost");
	await expect(nodeCard(page, "cleanup").locator("[data-primary-metric]")).toHaveCount(0);

	// 执行中的 probe：新上报的点实时追加（运行事件流的 metrics 增量）。
	const probe = nodeCard(page, "probe").locator('[data-primary-metric="level"]');
	await expect(probe).toHaveText("level 3");
	agent.metrics(tasks.probe as AssignedTask, [["level", unixAt(START, 14), 42]]);
	await expect(probe).toHaveText("level 42");
});
