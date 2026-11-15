import type { AssignedTask } from "../../server/test/support/fake-agent.js";
import { LONG_REASON, loadSummary } from "./actions-support";
import { inspector, nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";
import { runningScenario } from "./monitor-scenario";
import { openOverview } from "./overview-support";

// 画布运行状态的检查器（#360）：选中有动作的节点时，摘要下面是「正在做」，后面是「动作」区（每种名称的计数、上限说明、
// 最近的失败）；没有动作的节点只显示进度的说明。运行监控「概览」里执行中的那一行写出正在做的动作。

/** 打开画布的运行状态，选中 verify（有动作）：控制面时间固定，已持续多久不随真实时间跳。 */
async function openVerify(
	page: import("@playwright/test").Page,
	setup: Awaited<ReturnType<typeof runningScenario>>,
	clock: Parameters<typeof runningScenario>[2],
) {
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/orchestrations/${setup.scenarioId}?run=${setup.runId}`);
	await expect(nodeCard(page, "verify")).toHaveAttribute("data-run", "running");
	await nodeCard(page, "verify").click();
	return inspector(page);
}

test("检查器：正在做按层级缩进，动作区有每种名称的计数、上限说明和最近的失败", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const setup = await runningScenario(controlPlane, connectAgent, clock);
	const verify = setup.tasks.verify as AssignedTask;
	setup.agent.actionSummary(verify, loadSummary(setup.agent, clock.now().getTime()));
	await setup.agent.sync();
	const panel = await openVerify(page, setup, clock);

	// 正在做：三层，名称、字段、已持续多久；摘要在它上面。
	const doing = panel.getByRole("region", { name: "正在做" });
	const rows = doing.getByRole("listitem");
	await expect(rows).toHaveCount(3);
	await expect(rows.nth(0)).toContainText("保持 4 小时");
	await expect(rows.nth(0)).toContainText("目标=200 单/s");
	await expect(rows.nth(0)).toContainText("1h 43m");
	await expect(rows.nth(1)).toContainText("下单");
	await expect(rows.nth(1)).toContainText("订单=P-1284814 方向=买 数量=300 价格=18.36");
	await expect(rows.nth(1)).toContainText(/\dms/);
	await expect(rows.nth(2)).toContainText("等回报");
	const names = await Promise.all(
		[0, 1, 2].map((i) => rows.nth(i).getByTestId("action-name").boundingBox()),
	);
	expect(
		names[0] && names[1] && names[2] && names[0].x < names[1].x && names[1].x < names[2].x,
	).toBe(true);
	const summary = await panel.getByTestId("run-summary").boundingBox();
	const doingBox = await doing.boundingBox();
	expect(summary && doingBox && summary.y + summary.height <= doingBox.y).toBe(true);

	// 动作区：每种名称的总数和失败数。
	const area = panel.getByRole("region", { name: "动作" });
	const counts = area.getByRole("table", { name: "每种名称的总数和失败数" });
	await expect(counts.getByRole("row")).toHaveCount(5);
	await expect(counts.getByRole("row", { name: "下单 1,284,819 17" })).toBeVisible();
	await expect(counts.getByRole("row", { name: "保持 4 小时 1 0" })).toBeVisible();
	await expect(counts.getByRole("row", { name: "连接撮合网关 1 0" })).toBeVisible();
	await expect(counts.getByRole("row", { name: "首笔成交 2 0" })).toBeVisible();

	// 上限说明：哪个名称从几点起只计数（浏览器时区 Asia/Shanghai），指向开发文档。
	const cap = area.getByTestId("action-cap-note");
	await expect(cap).toContainText("「下单」从 06:36:14 起只计数");
	await expect(cap).not.toContainText("合计");
	await expect(cap.getByRole("link", { name: "开发节点（SDK 参考）" })).toHaveAttribute(
		"href",
		"/docs/sdk-reference",
	);
	await expect(cap).toContainText("「数量上限」");

	// 最近的失败：五个，原因单独一行、完整。
	const fails = area.getByRole("list", { name: "最近的失败" });
	await expect(fails.getByRole("listitem")).toHaveCount(5);
	await expect(area.getByRole("heading", { name: "最近的失败" })).toContainText("17");
	await expect(area).toContainText("共 17 个，只列出最近 5 个");
	const first = fails.getByRole("listitem").nth(0);
	await expect(first).toContainText("订单=P-1284808");
	await expect(first).toContainText("3ms");
	await expect(first.getByTestId("action-reason")).toHaveText(
		"拒单：价格超出涨跌停（报价 18.17，下限 18.20）",
	);
	const line = await first.getByTestId("action-name").boundingBox();
	const reason = await first.getByTestId("action-reason").boundingBox();
	expect(line && reason && reason.y > line.y + line.height - 1).toBe(true);

	// 没有「最近 20 个」。
	await expect(panel).not.toContainText("最近 20 个");
});

test("检查器：4096 个字符的失败原因完整显示，不撑破版面", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const setup = await runningScenario(controlPlane, connectAgent, clock);
	setup.agent.actionSummary(
		setup.tasks.verify as AssignedTask,
		loadSummary(setup.agent, clock.now().getTime()),
	);
	await setup.agent.sync();
	const panel = await openVerify(page, setup, clock);

	const long = panel.getByRole("list", { name: "最近的失败" }).getByRole("listitem").nth(2);
	const reason = long.getByTestId("action-reason");
	await expect(reason).toHaveText(LONG_REASON);
	expect(LONG_REASON).toHaveLength(4096);
	// 原因折行，没有任何一处横向溢出；同一行的名称、字段、耗时仍然在原因上面。
	const body = panel.getByTestId("run-inspector-body");
	const overflow = await body.evaluate((el) => el.scrollWidth - el.clientWidth);
	expect(overflow).toBe(0);
	const box = await reason.boundingBox();
	const inspectorBox = await panel.boundingBox();
	expect(box && inspectorBox && box.x >= inspectorBox.x).toBe(true);
	expect(box && inspectorBox && box.x + box.width <= inspectorBox.x + inspectorBox.width).toBe(
		true,
	);
	expect(box?.height).toBeGreaterThan(200);

	// 多行的原因保留换行。
	const multi = panel.getByRole("list", { name: "最近的失败" }).getByRole("listitem").nth(4);
	await expect(multi.getByTestId("action-reason")).toHaveText(
		"TimeoutError: 200ms 内没有回报 at gateway.wait (gateway.py:88)",
	);
	const lineHeight = await multi
		.getByTestId("action-reason")
		.evaluate((el) => Number.parseFloat(getComputedStyle(el).lineHeight));
	const multiBox = await multi.getByTestId("action-reason").boundingBox();
	expect(multiBox?.height).toBeGreaterThanOrEqual(lineHeight * 2 - 1);
});

test("检查器：没有动作的节点不显示「正在做」和「动作」，只显示进度的说明", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const setup = await runningScenario(controlPlane, connectAgent, clock);
	setup.agent.progress(setup.tasks.probe as AssignedTask, 3, 10, "第 3 批");
	await setup.agent.sync();
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/orchestrations/${setup.scenarioId}?run=${setup.runId}`);
	const panel = inspector(page);

	// 执行中、没有记录过动作：进度的说明。
	await nodeCard(page, "probe").click();
	await expect(panel.getByTestId("run-progress")).toHaveText("第 3 批");
	await expect(panel.getByRole("region", { name: "正在做" })).toHaveCount(0);
	await expect(panel.getByRole("region", { name: "动作" })).toHaveCount(0);
	await expect(panel.getByRole("heading", { name: "正在做" })).toHaveCount(0);

	// 已经成功、没有记录过动作：什么都没有。
	await nodeCard(page, "fetch").click();
	await expect(panel.getByTestId("run-summary")).toContainText("agent-a");
	await expect(panel.getByTestId("run-progress")).toHaveCount(0);
	await expect(panel.getByRole("region", { name: "动作" })).toHaveCount(0);

	// 还没有执行的节点：同样没有。
	await nodeCard(page, "cleanup").click();
	await expect(panel.getByRole("region", { name: "动作" })).toHaveCount(0);
	await expect(panel.getByTestId("run-progress")).toHaveCount(0);
});

test("检查器：正在做列满 50 个时写明可能有遗漏", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const setup = await runningScenario(controlPlane, connectAgent, clock);
	const verify = setup.tasks.verify as AssignedTask;
	const now = clock.now().getTime();
	const worker = (id: number) => ({
		id,
		parent: null,
		depth: 0,
		name: `任务 ${id}`,
		fields: {},
		...setup.agent.stamp(now - id * 60_000),
	});
	setup.agent.actionSummary(verify, {
		total: 50,
		reported: 50,
		running: Array.from({ length: 50 }, (_, i) => worker(i + 1)),
	});
	await setup.agent.sync();
	const panel = await openVerify(page, setup, clock);

	const doing = panel.getByRole("region", { name: "正在做" });
	await expect(doing.getByRole("listitem")).toHaveCount(50);
	await expect(doing).toContainText("列满 50 个，可能还有没列出的");

	// 不到 50 个就是全部。
	setup.agent.actionSummary(verify, {
		total: 49,
		reported: 49,
		running: Array.from({ length: 49 }, (_, i) => worker(i + 1)),
	});
	await expect(doing.getByRole("listitem")).toHaveCount(49);
	await expect(doing).not.toContainText("可能还有没列出的");
});

test("检查器：合计的明细满了，写明哪个时刻起开始只计数；多个名称一条一条列出", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const setup = await runningScenario(controlPlane, connectAgent, clock);
	const verify = setup.tasks.verify as AssignedTask;
	const now = clock.now().getTime();
	const at = (ago: number) => setup.agent.stamp(now - ago);
	const name = (n: string, cappedAgo: number | null) => ({
		name: n,
		total: 40_000,
		failed: 0,
		reported: cappedAgo === null ? 40_000 : 30_000,
		capped_ts: cappedAgo === null ? null : at(cappedAgo).ts,
		capped_mono: cappedAgo === null ? null : at(cappedAgo).mono,
	});
	setup.agent.actionSummary(verify, {
		total: 120_000,
		reported: 100_000,
		capped_ts: at(30 * 60_000).ts,
		capped_mono: at(30 * 60_000).mono,
		names: [name("下单", 20 * 60_000), name("撤单", 30 * 60_000), name("预热", null)],
	});
	await setup.agent.sync();
	const panel = await openVerify(page, setup, clock);

	const cap = panel.getByTestId("action-cap-note");
	const items = cap.getByRole("listitem");
	await expect(items).toHaveCount(2);
	// 先超出的在前。
	await expect(items.nth(0)).toHaveText("「撤单」从 07:30:14 起只计数");
	await expect(items.nth(1)).toHaveText("「下单」从 07:40:14 起只计数");
	await expect(cap).toContainText("全部名称合计的明细已满，最早从 07:30:14 起，失败的动作也只计数");
	await expect(cap.getByRole("link", { name: "开发节点（SDK 参考）" })).toBeVisible();

	// 没有名称只计数、合计也没满时，没有这段说明。
	setup.agent.actionSummary(verify, {
		total: 40_000,
		reported: 40_000,
		names: [name("预热", null)],
	});
	await expect(panel.getByRole("table", { name: "每种名称的总数和失败数" })).toContainText("预热");
	await expect(panel.getByTestId("action-cap-note")).toHaveCount(0);
});

test("检查器：摘要每秒重新读取，节点结束后「正在做」消失、动作区保留最后的计数", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const setup = await runningScenario(controlPlane, connectAgent, clock);
	const verify = setup.tasks.verify as AssignedTask;
	const now = clock.now().getTime();
	const stamp = (ago: number) => setup.agent.stamp(now - ago);
	const count = (total: number, failed = 0) => ({
		name: "对账",
		total,
		failed,
		reported: total,
		capped_ts: null,
		capped_mono: null,
	});
	const phase = (id: number, name: string) => ({
		id,
		parent: null,
		depth: 0,
		name,
		fields: {},
		...stamp(60 * 60_000),
	});
	setup.agent.actionSummary(verify, {
		total: 1,
		reported: 1,
		names: [count(1)],
		running: [phase(1, "对账")],
	});
	await setup.agent.sync();
	const panel = await openVerify(page, setup, clock);
	const doing = panel.getByRole("region", { name: "正在做" });
	const counts = panel.getByRole("table", { name: "每种名称的总数和失败数" });
	await expect(doing.getByRole("listitem")).toContainText(["对账"]);
	await expect(counts.getByRole("row", { name: "对账 1 0" })).toBeVisible();

	// 节点上报了新的摘要：不用刷新，检查器跟着变（节点卡片也是）。
	setup.agent.actionSummary(verify, {
		total: 3,
		reported: 3,
		names: [count(2), { ...count(1, 1), name: "收尾" }],
		running: [phase(3, "收尾")],
	});
	await expect(doing.getByRole("listitem")).toContainText(["收尾"]);
	await expect(counts.getByRole("row", { name: "对账 2 0" })).toBeVisible();
	await expect(counts.getByRole("row", { name: "收尾 1 1" })).toBeVisible();

	// 节点成功：「正在做」没有了，计数还在。
	setup.agent.actionSummary(verify, {
		total: 3,
		reported: 3,
		names: [count(2), { ...count(1, 1), name: "收尾" }],
		running: [],
	});
	await setup.agent.succeed(verify, { status: 200 });
	await expect(nodeCard(page, "verify")).toHaveAttribute("data-run", "done");
	await expect(panel.getByRole("region", { name: "正在做" })).toHaveCount(0);
	await expect(counts.getByRole("row", { name: "收尾 1 1" })).toBeVisible();
});

test("概览：执行中那一行在节点后面写「正在 动作名称」，没有动作时写进度的说明", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const setup = await runningScenario(controlPlane, connectAgent, clock);
	const now = clock.now().getTime();
	setup.agent.actionSummary(setup.tasks.verify as AssignedTask, {
		total: 2,
		reported: 2,
		running: [
			{
				id: 1,
				parent: null,
				depth: 0,
				name: "保持 4 小时",
				fields: {},
				...setup.agent.stamp(now - 103 * 60_000),
			},
			{ id: 2, parent: 1, depth: 1, name: "下单", fields: {}, ...setup.agent.stamp(now - 3) },
		],
	});
	setup.agent.progress(setup.tasks.probe as AssignedTask, 3, 10, "第 3 批");
	await setup.agent.sync();
	await openOverview(page, clock, setup.runId);

	const rows = page.getByRole("list", { name: "执行中的节点" }).getByRole("listitem");
	await expect(rows).toHaveCount(2);
	const verify = rows.filter({ hasText: "verify" });
	await expect(verify).toContainText("正在 保持 4 小时");
	// 最外层开始得最早的那个，不是最里层的。
	await expect(verify).not.toContainText("下单");
	const probe = rows.filter({ hasText: "probe" });
	await expect(probe).toContainText("第 3 批");
	await expect(probe).not.toContainText("正在");

	// 动作都结束了：这一段撤掉，同一行不再写正在做什么。
	setup.agent.actionSummary(setup.tasks.verify as AssignedTask, { total: 2, reported: 2 });
	await expect(verify).not.toContainText("正在 保持 4 小时");
	await expect(verify).not.toContainText("保持 4 小时");
});
