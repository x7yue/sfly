import type { AssignedTask } from "../../server/test/support/fake-agent.js";
import {
	canvasFocusRun,
	cardFocusRows,
	inspectorCharts,
	openCanvasRun,
} from "./canvas-focus-support";
import { inspector, nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";
import { saveVersion, setFocusItems } from "./focus-support";
import { MONITOR_SCENARIO, metricPackage, runningScenario } from "./monitor-scenario";
import { focusChart } from "./overview-support";
import { publishPackage } from "./support";

// 编排画布运行状态里的关注项（#353）：节点卡片左上角是关注项的个数，开始执行以后底部是前两项（有异常的排前、带三角）；
// 检查器没选中节点时列出全部关注项，选中节点时列出它声明的图表，带「关注」开关。

test("卡片：眼睛图标和数量、前两项、「还有 N 个关注项」；有异常的排前、带三角；运行结束后只显示最终值", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const running = await canvasFocusRun(controlPlane, connectAgent, clock);
	const { agent, tasks } = running;
	await openCanvasRun(page, clock, running);

	// fetch 已成功：三项都是最终值，没有三角；放得下前两项（按作者的顺序），第三项只计数。
	const fetch = nodeCard(page, "fetch");
	await expect(fetch.getByTestId("node-focus-count")).toHaveText("3");
	await expect(cardFocusRows(fetch)).toHaveText([/^延迟\s*\d+\s*ms$/, /^请求数\s*520\s*次$/]);
	await expect(fetch.getByTestId("node-focus")).toContainText("还有 1 个关注项");
	await expect(fetch.locator("[data-anomaly]")).toHaveCount(0);
	// 用图表自己的标题，不用场景起的名字（「下单延迟」）。
	await expect(fetch.getByTestId("node-focus")).not.toContainText("下单延迟");

	// probe 执行中：total 没有新数据，排在作者排在它前面的 level 之前，带三角。
	const probe = nodeCard(page, "probe");
	await expect(probe.getByTestId("node-focus-count")).toHaveText("2");
	await expect(cardFocusRows(probe)).toHaveText([/^total\s*16$/, /^level\s*4$/]);
	await expect(cardFocusRows(probe).first()).toHaveAttribute("data-anomaly", "stale");
	await expect(cardFocusRows(probe).nth(1)).not.toHaveAttribute("data-anomaly");
	await expect(probe.getByTestId("node-focus")).not.toContainText("还有");
	// 「正在做」一行和关注项都在，卡片长高了，仍在子流程区域里面。
	await expect(probe.getByTestId("node-activity")).toContainText("第 3 批");
	const region = page.getByRole("region", { name: "子流程 sub" });
	await expect.poll(async () => (await probe.boundingBox())?.height).toBeGreaterThan(140);
	await expect
		.poll(async () => {
			const [card, box] = [await probe.boundingBox(), await region.boundingBox()];
			return card && box && card.y + card.height < box.y + box.height;
		})
		.toBe(true);

	// cleanup 还没开始执行：只有个数，底部照常是配置摘要。
	const cleanup = nodeCard(page, "cleanup");
	await expect(cleanup.getByTestId("node-focus-count")).toHaveText("1");
	await expect(cleanup.getByTestId("node-focus")).toHaveCount(0);

	// 运行结束：来源节点都成功了，只剩最终值，三角撤掉。
	await agent.succeed(tasks.probe as AssignedTask);
	await agent.succeed(tasks.verify as AssignedTask);
	await agent.succeed(await agent.nextAssign());
	await expect(page.getByTestId("canvas-run")).toContainText("成功");
	await expect(cardFocusRows(probe)).toHaveText([/^level\s*4$/, /^total\s*16$/]);
	await expect(probe.locator("[data-anomaly]")).toHaveCount(0);
	await expect(cardFocusRows(cleanup)).toHaveText([/^level\s*—$/]);
});

test("卡片的可访问名称里有关注项的个数和需要注意的项数", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const running = await canvasFocusRun(controlPlane, connectAgent, clock);
	await openCanvasRun(page, clock, running);
	// 卡片上的三角旁边放不下原因：原因写在名称里。
	await expect(nodeCard(page, "probe")).toHaveAccessibleName(
		/^节点 probe，.+ 执行中 正在做 第 3 批 2 个关注项，1 项需要注意：total 已 2m \d+s 无新数据$/,
	);
	await expect(nodeCard(page, "fetch")).toHaveAccessibleName(
		"节点 fetch，HTTP 检查 成功 3 个关注项",
	);
	// 没有关注项的节点名称不变。
	await expect(nodeCard(page, "verify")).toHaveAccessibleName(/^节点 verify，.+ 执行中$/);
});

test("场景没设关注项时，主指标有异常的卡片：主指标旁有琥珀三角，可访问名称写明原因；没有异常的卡片不变", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const running = await runningScenario(controlPlane, connectAgent, clock);
	await openCanvasRun(page, clock, running);
	// verify 是第 2 次尝试，10 分钟以内开始的重试算异常（别处也这样判断）；probe 的主指标没有异常。
	const verify = nodeCard(page, "verify");
	await expect(verify.locator("[data-primary-metric]")).toBeVisible();
	await expect(verify.locator('[data-status-dot="warn"]')).toHaveCount(1);
	await expect(verify).toHaveAccessibleName(
		/^节点 verify，.+ 执行中 1 项需要注意：主指标 level 重试（第 2 次尝试）· \d\d:\d\d:\d\d$/,
	);
	// 没设关注项：没有眼睛图标和个数。
	await expect(verify.getByTestId("node-focus-count")).toHaveCount(0);

	const probe = nodeCard(page, "probe");
	await expect(probe.locator("[data-primary-metric]")).toBeVisible();
	await expect(probe.locator('[data-status-dot="warn"]')).toHaveCount(0);
	await expect(probe).toHaveAccessibleName(/^节点 probe，.+ 执行中$/);
});

test("图表在这次运行的节点包版本里不存在的关注项：卡片上写明原因、不显示数值，可访问名称里也有", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const running = await runningScenario(controlPlane, connectAgent, clock);
	// 之后的版本升到 1.3.0，ping 多了一张图表「水位」，作者把它设为关注项；这次运行锁定的是 1.2.0，没有这张图表。
	const nodes = metricPackage().nodes.map((node) =>
		node.name === "ping"
			? { ...node, charts: [{ title: "水位", type: "line", metrics: ["level"] }] }
			: node,
	);
	await publishPackage(controlPlane, { version: "1.3.0", nodes });
	await saveVersion(controlPlane, running.scenarioId, 1, {
		...MONITOR_SCENARIO,
		packages: { "demo-checks": "1.3.0" },
	});
	await setFocusItems(controlPlane, running.scenarioId, [
		{ node_id: "probe", chart: "水位" },
		{ node_id: "probe", chart: "total" },
	]);
	await openCanvasRun(page, clock, running);

	const probe = nodeCard(page, "probe");
	await expect(cardFocusRows(probe)).toHaveText([
		/^水位\s*这个版本的节点没有图表 水位$/,
		/^total\s*\d+$/,
	]);
	await expect(probe.getByTestId("node-focus")).not.toContainText("—");
	await expect(probe.locator('[data-focus-row="水位"] [data-status-dot]')).toHaveCount(0);
	await expect(probe).toHaveAccessibleName(
		/^节点 probe，.+ 执行中 2 个关注项，这个版本的节点没有图表 水位$/,
	);
});

test("没有选中节点时检查器列出全部关注项（有异常的在前），点一项选中它所在的节点", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const running = await canvasFocusRun(controlPlane, connectAgent, clock);
	await openCanvasRun(page, clock, running);
	const panel = inspector(page);
	const list = panel.getByRole("list", { name: "关注项读数" });
	await expect(panel.getByRole("heading", { name: /^关注项/ })).toContainText("1 项需要注意");
	await expect(list.getByRole("button")).toHaveText([
		/^total/,
		/^下单延迟/,
		/^探活 level/,
		/^请求数/,
		/^errors/,
		/^清理 level/,
	]);
	await expect(list.getByRole("button").first()).toHaveAccessibleName(/需要注意：已 .+ 无新数据$/);

	await list.getByRole("button", { name: /^探活 level/ }).click();
	await expect(nodeCard(page, "probe")).toHaveAttribute("aria-pressed", "true");
	await expect(panel.getByTestId("run-summary")).toBeVisible();
	await expect(panel).toBeFocused();
});

test("选中节点：检查器按「有异常的关注项、其余关注项、其他图表」列出图表；在这里打开「关注」，概览里随之出现这一项", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const running = await canvasFocusRun(controlPlane, connectAgent, clock);
	await openCanvasRun(page, clock, running);
	const panel = inspector(page);

	await nodeCard(page, "probe").click();
	await expect.poll(inspectorCharts(page)).toEqual(["total", "level"]);
	// total 是累计值的默认图表（数值卡）：只显示数值，下面写异常的原因。
	const stale = panel.getByRole("article", { name: "total" });
	await expect(stale).toHaveText(/^total16关注已 .+ 无新数据$/);
	await expect(stale.getByRole("img")).toHaveCount(0);
	await expect(panel.getByRole("article", { name: "level" }).getByRole("img")).toHaveAccessibleName(
		/^探活 level 4，来自 probe（执行中），\d+s 前$/,
	);

	// cleanup 还没开始执行：没有图表可画，写明原因和其中几张是关注项。
	await nodeCard(page, "cleanup").click();
	await expect(panel).toContainText(
		"还没有开始执行。开始执行以后，这里显示它声明的图表，其中 1 张是关注项。",
	);
	await expect(panel.locator("[data-node-chart]")).toHaveCount(0);

	// fetch：三张关注项按作者的顺序，没设关注项的「吞吐」在最后；图表固定显示这次尝试的全程。
	await nodeCard(page, "fetch").click();
	await expect.poll(inspectorCharts(page)).toEqual(["延迟", "请求数", "errors", "吞吐"]);
	await expect(panel.getByRole("article", { name: "吞吐" }).getByRole("img")).toBeVisible();
	const toggle = panel.getByRole("button", { name: "把 吞吐 设为关注项" });
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expect(panel.getByText("本场景的关注项已用 7 / 8")).toBeVisible();
	// 取消「请求数」：立即排到其他图表里（按声明的顺序）。
	await panel.getByRole("button", { name: "把 请求数 设为关注项" }).click();
	await expect.poll(inspectorCharts(page)).toEqual(["延迟", "errors", "吞吐", "请求数"]);
	await expect(panel.getByText("本场景的关注项已用 6 / 8")).toBeVisible();

	// 「在运行监控详情里打开」落到详情里的这个节点。
	await expect(panel.getByRole("link", { name: "在运行监控详情里打开 fetch" })).toHaveAttribute(
		"href",
		`/runs/${running.runId}?view=detail&node=fetch`,
	);

	// 检查器的概况（Esc 回到画布上的节点，再按一次取消选中）和运行监控的概览里都有了这一项。
	await toggle.focus();
	await page.keyboard.press("Escape");
	await expect(nodeCard(page, "fetch")).toBeFocused();
	await page.keyboard.press("Escape");
	const list = panel.getByRole("list", { name: "关注项读数" });
	await expect(list).toContainText("吞吐");
	await expect(list).not.toContainText("请求数");
	await page.goto(`/runs/${running.runId}?view=overview`);
	await expect(focusChart(page, "吞吐")).toBeVisible();
	await expect(focusChart(page, "请求数")).toHaveCount(0);
});
