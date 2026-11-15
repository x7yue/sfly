import type { Page } from "@playwright/test";
import type { AssignedTask } from "../../server/test/support/fake-agent.js";
import { LONG_REASON, loadSummary, REJECTS } from "./actions-support";
import { inspector, nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";
import { runningScenario } from "./monitor-scenario";
import { openOverview } from "./overview-support";
import { createScenario, publishPackage, scenarioUsing, triggerRun } from "./support";

// 画布运行状态的检查器（#360）：选中有动作的节点时，摘要下面是「正在做」，后面是「动作」区（每种名称的计数、上限说明、
// 最近的失败）；没有动作的节点只显示进度的说明。运行监控「概览」里执行中的那一行写出正在做的动作。

type Running = Awaited<ReturnType<typeof runningScenario>>;
type Clock = Parameters<typeof runningScenario>[2];

/** 打开画布的运行状态并选中一个节点：控制面时间固定，已持续多久不随真实时间跳。 */
async function openNode(page: Page, setup: Running, clock: Clock, node: string) {
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/orchestrations/${setup.scenarioId}?run=${setup.runId}`);
	await expect(nodeCard(page, node)).toBeVisible();
	await nodeCard(page, node).click();
	return inspector(page);
}

/** 一种名称的计数。 */
const counted = (name: string, total: number, failed = 0) => ({
	name,
	total,
	failed,
	reported: total,
	capped_ts: null,
	capped_mono: null,
});

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
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/orchestrations/${setup.scenarioId}?run=${setup.runId}`);
	await expect(nodeCard(page, "verify")).toHaveAttribute("data-run", "running");
	await nodeCard(page, "verify").click();
	const panel = inspector(page);

	// 正在做：三层，名称、字段、已持续多久；摘要在它上面。字段的顺序由控制面存储决定，只核对每一个。
	const doing = panel.getByRole("region", { name: "正在做" });
	const rows = doing.getByRole("listitem");
	await expect(rows).toHaveCount(3);
	await expect(rows.nth(0)).toContainText("保持 4 小时");
	await expect(rows.nth(0)).toContainText("目标=200 单/s");
	await expect(rows.nth(0)).toContainText("1h 43m");
	await expect(rows.nth(1)).toContainText("下单");
	for (const field of ["订单=P-1284814", "方向=买", "数量=300", "价格=18.36"]) {
		await expect(rows.nth(1)).toContainText(field);
	}
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

	// 动作区：重试过的节点写明这是第几次尝试；每种名称的总数和失败数。
	const area = panel.getByRole("region", { name: "动作", exact: true });
	await expect(area.getByRole("heading").first()).toContainText("第 2 次尝试");
	const counts = area.getByRole("table", { name: "每种名称的总数和失败数" });
	await expect(counts.getByRole("row")).toHaveCount(5);
	await expect(counts.getByRole("row", { name: "下单 1,284,819 17" })).toBeVisible();
	await expect(counts.getByRole("row", { name: "保持 4 小时 1 0" })).toBeVisible();
	await expect(counts.getByRole("row", { name: "连接撮合网关 1 0" })).toBeVisible();
	await expect(counts.getByRole("row", { name: "首笔成交 2 0" })).toBeVisible();

	// 上限说明：哪个名称从几点起只计数（浏览器时区 Asia/Shanghai），指向开发文档。合计没满，不说合计。
	const cap = area.getByTestId("action-cap-note");
	await expect(cap).toContainText("「下单」从 06:36:14 起只计数");
	await expect(cap).not.toContainText("合计");
	await expect(cap.getByRole("link", { name: "开发节点（SDK 参考）" })).toHaveAttribute(
		"href",
		"/docs/sdk-reference",
	);
	await expect(cap).toContainText("「数量上限」");

	// 最近的失败：五个，一共 17 个；原因单独一行、完整。
	const fails = area.getByRole("list", { name: "最近的失败" });
	await expect(fails.getByRole("listitem")).toHaveCount(5);
	await expect(area.getByRole("heading", { name: /最近的失败/ })).toContainText("17");
	await expect(area).toContainText("共 17 个，只列出最近 5 个");
	const first = fails.getByRole("listitem").nth(0);
	await expect(first).toContainText("订单=P-1284808");
	await expect(first).toContainText("3ms");
	await expect(first.getByTestId("action-reason")).toHaveText(REJECTS[0]?.reason ?? "");
	const line = await first.getByTestId("action-name").boundingBox();
	const reason = await first.getByTestId("action-reason").boundingBox();
	expect(line && reason && reason.y > line.y + line.height - 1).toBe(true);

	// 摘要里有「最近 20 个」（核对回报），检查器不画它。
	await expect(panel).not.toContainText("核对回报");
	await expect(panel).not.toContainText("最近 20 个");
});

test("检查器：4096 个字符的失败原因完整显示，不撑破版面", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const setup = await runningScenario(controlPlane, connectAgent, clock);
	const rejects = REJECTS.map((r, i) => (i === 2 ? { ...r, reason: LONG_REASON } : r));
	setup.agent.actionSummary(
		setup.tasks.verify as AssignedTask,
		loadSummary(setup.agent, clock.now().getTime(), rejects),
	);
	await setup.agent.sync();
	const panel = await openNode(page, setup, clock, "verify");

	const long = panel.getByRole("list", { name: "最近的失败" }).getByRole("listitem").nth(2);
	const reason = long.getByTestId("action-reason");
	await expect(reason).toHaveText(LONG_REASON);
	expect(LONG_REASON).toHaveLength(4096);
	// 原因折行：没有任何一处横向溢出，原因的方框在检查器里面。
	const body = panel.getByTestId("run-inspector-body");
	expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
	const box = await reason.boundingBox();
	const inspectorBox = await panel.boundingBox();
	expect(box && inspectorBox && box.x >= inspectorBox.x).toBe(true);
	expect(box && inspectorBox && box.x + box.width <= inspectorBox.x + inspectorBox.width).toBe(
		true,
	);
	expect(box?.height).toBeGreaterThan(200);

	// 多行的原因保留换行。
	const multi = panel
		.getByRole("list", { name: "最近的失败" })
		.getByRole("listitem")
		.nth(4)
		.getByTestId("action-reason");
	await expect(multi).toHaveText("TimeoutError: 200ms 内没有回报 at gateway.wait (gateway.py:88)");
	const lineHeight = await multi.evaluate((el) =>
		Number.parseFloat(getComputedStyle(el).lineHeight),
	);
	expect((await multi.boundingBox())?.height).toBeGreaterThanOrEqual(lineHeight * 2 - 1);
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
	const panel = await openNode(page, setup, clock, "probe");

	// 执行中、没有记录过动作：进度的说明。
	await expect(panel.getByTestId("run-progress")).toHaveText("第 3 批");
	await expect(panel.getByRole("region", { name: "正在做" })).toHaveCount(0);
	await expect(panel.getByRole("region", { name: "动作", exact: true })).toHaveCount(0);

	// 已经成功、没有记录过动作：什么都没有。
	await nodeCard(page, "fetch").click();
	await expect(panel.getByTestId("run-summary")).toContainText("agent-a");
	await expect(panel.getByTestId("run-progress")).toHaveCount(0);
	await expect(panel.getByRole("region", { name: "动作", exact: true })).toHaveCount(0);

	// 还没有执行的节点：同样没有。
	await nodeCard(page, "cleanup").click();
	await expect(panel.getByRole("heading", { name: "cleanup" })).toBeVisible();
	await expect(panel.getByRole("region", { name: "动作", exact: true })).toHaveCount(0);
	await expect(panel.getByTestId("run-progress")).toHaveCount(0);
});

test("检查器：记录过动作的节点此刻没有正在做的动作时，进度的说明代替「正在做」，动作区还在", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const setup = await runningScenario(controlPlane, connectAgent, clock);
	const verify = setup.tasks.verify as AssignedTask;
	setup.agent.actionSummary(verify, { total: 4, reported: 4, names: [counted("对账", 4)] });
	setup.agent.progress(verify, 4, 10, "第 4 批");
	await setup.agent.sync();
	const panel = await openNode(page, setup, clock, "verify");

	await expect(panel.getByTestId("run-progress")).toHaveText("第 4 批");
	await expect(panel.getByRole("region", { name: "正在做" })).toHaveCount(0);
	await expect(
		panel
			.getByRole("table", { name: "每种名称的总数和失败数" })
			.getByRole("row", { name: "对账 4 0" }),
	).toBeVisible();

	// 又有动作在做了：动作代替进度。
	const now = clock.now().getTime();
	setup.agent.actionSummary(verify, {
		total: 5,
		reported: 5,
		names: [counted("对账", 5)],
		running: [
			{ id: 5, parent: null, depth: 0, name: "对账", fields: {}, ...setup.agent.stamp(now) },
		],
	});
	await expect(panel.getByRole("region", { name: "正在做" })).toContainText("对账");
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
	const panel = await openNode(page, setup, clock, "verify");

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

test("检查器：每个只计数的名称都列出来；合计满了时说满了以后开始的动作，不说那个时刻之后都没有明细", async ({
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
	const capped = Array.from({ length: 7 }, (_, i) => name(`批次 ${i + 1}`, (20 + i) * 60_000));
	setup.agent.actionSummary(verify, {
		total: 120_000,
		reported: 100_000,
		capped_ts: at(30 * 60_000).ts,
		capped_mono: at(30 * 60_000).mono,
		names: [...capped, name("预热", null)],
	});
	await setup.agent.sync();
	const panel = await openNode(page, setup, clock, "verify");

	const cap = panel.getByTestId("action-cap-note");
	const items = cap.getByRole("listitem");
	// 全部七个，先超出的在前（批次 7 是 26 分钟前，最早）。
	await expect(items).toHaveCount(7);
	await expect(items.nth(0)).toHaveText("「批次 7」从 07:34:14 起只计数");
	await expect(items.nth(6)).toHaveText("「批次 1」从 07:40:14 起只计数");
	await expect(cap).toContainText(
		"全部名称合计的明细已满，满了以后开始的动作都只计数（失败的也一样）；第一个因此没有明细的动作是 07:30:14 开始的。",
	);
	await expect(cap).not.toContainText("起，失败");
	await expect(cap.getByRole("link", { name: "开发节点（SDK 参考）" })).toBeVisible();

	// 没有名称只计数、合计也没满时，没有这段说明。
	setup.agent.actionSummary(verify, {
		total: 40_000,
		reported: 40_000,
		names: [name("预热", null)],
	});
	await expect(panel.getByRole("table", { name: "每种名称的总数和失败数" })).not.toContainText(
		"批次",
	);
	await expect(panel.getByTestId("action-cap-note")).toHaveCount(0);
});

test("检查器：执行中每秒重新读取摘要，节点结束时再读一次，之后不再读", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const setup = await runningScenario(controlPlane, connectAgent, clock);
	const verify = setup.tasks.verify as AssignedTask;
	const now = clock.now().getTime();
	const phase = {
		id: 1,
		parent: null,
		depth: 0,
		name: "对账",
		fields: {},
		...setup.agent.stamp(now - 60 * 60_000),
	};
	setup.agent.actionSummary(verify, {
		total: 1,
		reported: 1,
		names: [counted("对账", 1)],
		running: [phase],
	});
	await setup.agent.sync();

	// 冻结时，读摘要拿到的永远是冻结那一刻的响应：证明结束以后看到的最后一份摘要是结束时那一次读来的。
	let frozen = false;
	let stale: { status: number; headers: Record<string, string>; body: Buffer } | undefined;
	await page.route("**/tasks/*/actions/summary", async (route) => {
		if (!frozen) return route.continue();
		if (!stale) {
			const response = await route.fetch();
			stale = {
				status: response.status(),
				headers: response.headers(),
				body: await response.body(),
			};
		}
		return route.fulfill(stale);
	});
	const requests: string[] = [];
	page.on("request", (request) => {
		if (request.url().endsWith("/actions/summary")) requests.push(request.url());
	});

	const panel = await openNode(page, setup, clock, "verify");
	const counts = panel.getByRole("table", { name: "每种名称的总数和失败数" });
	await expect(counts.getByRole("row", { name: "对账 1 0" })).toBeVisible();

	// 执行中：不用刷新，一直在读。
	const seen = requests.length;
	await expect.poll(() => requests.length).toBeGreaterThanOrEqual(seen + 2);

	// 冻结后，节点上报新的摘要并成功：检查器停在冻结的那份，直到节点结束。
	frozen = true;
	await expect.poll(() => stale !== undefined).toBe(true);
	setup.agent.actionSummary(verify, {
		total: 3,
		reported: 3,
		names: [counted("对账", 2), counted("收尾", 1, 1)],
		running: [],
	});
	await setup.agent.sync();
	frozen = false;
	await setup.agent.succeed(verify, { status: 200 });
	await expect(nodeCard(page, "verify")).toHaveAttribute("data-run", "done");

	// 结束了：「正在做」没有了，动作区是最后一份。
	await expect(counts.getByRole("row", { name: "收尾 1 1" })).toBeVisible();
	await expect(counts.getByRole("row", { name: "对账 2 0" })).toBeVisible();
	await expect(panel.getByRole("region", { name: "正在做" })).toHaveCount(0);

	// 之后不再读：等三个轮询间隔，请求数不变。
	const done = requests.length;
	await page.waitForTimeout(3_000);
	expect(requests.length).toBe(done);
});

test("检查器：结束的节点保留动作区、没有「正在做」；失败的节点也一样", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const setup = await runningScenario(controlPlane, connectAgent, clock);
	const now = clock.now().getTime();
	const stamp = (ago: number) => setup.agent.stamp(now - ago);
	const leftover = { id: 9, parent: null, depth: 0, name: "没做完", fields: {}, ...stamp(1000) };
	const summary = {
		total: 1,
		reported: 1,
		names: [counted("没做完", 1)],
		// 节点结束时还没结束的动作：控制面把它们记成未结束，摘要里的「正在做」清空。
		running: [leftover],
	};
	// fetch 早已成功；摘要在结果之后才到，也不让它重新出现。
	setup.agent.actionSummary(setup.tasks.fetch as AssignedTask, summary);
	await setup.agent.sync();
	const panel = await openNode(page, setup, clock, "fetch");
	await expect(
		panel
			.getByRole("table", { name: "每种名称的总数和失败数" })
			.getByRole("row", { name: "没做完 1 0" }),
	).toBeVisible();
	await expect(panel.getByRole("region", { name: "正在做" })).toHaveCount(0);

	// verify 在做动作时失败了。
	const verify = setup.tasks.verify as AssignedTask;
	setup.agent.actionSummary(verify, { ...summary, running: [{ ...leftover, id: 10 }] });
	await setup.agent.sync();
	await nodeCard(page, "verify").click();
	await expect(panel.getByRole("region", { name: "正在做" })).toContainText("没做完");
	await setup.agent.fail(verify, "AssertionError: 还是漏拦");
	await expect(nodeCard(page, "verify")).toHaveAttribute("data-run", "failed");
	await expect(panel.getByRole("region", { name: "正在做" })).toHaveCount(0);
	await expect(panel.getByRole("region", { name: "动作", exact: true })).toContainText("没做完");
});

test("检查器：重试的新尝试还没开始时，显示上一次尝试的动作和失败，并写明是第几次", async ({
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
	await publishPackage(controlPlane);
	const base = scenarioUsing("agent-a");
	const scenarioId = await createScenario(controlPlane, "重试", {
		...base,
		nodes: [
			base.nodes[0] as Record<string, unknown>,
			{ ...(base.nodes[1] as Record<string, unknown>), retries: 1 },
		],
	});
	const runId = await triggerRun(controlPlane, scenarioId);
	const first = await agent.nextAssign();
	const now = clock.now().getTime();
	agent.actionSummary(first, loadSummary(agent, now));
	await agent.sync();
	await agent.fail(first, "AssertionError: 漏拦 3 笔");
	// 重试的新尝试：已派发，还没开始。
	await agent.nextAssign({ start: false });

	await page.clock.setFixedTime(clock.now());
	await page.goto(`/orchestrations/${scenarioId}?run=${runId}`);
	await expect(nodeCard(page, "ping")).toHaveAttribute("data-run", "running");
	await nodeCard(page, "ping").click();
	const panel = inspector(page);
	await expect(panel.getByTestId("run-attempts")).toHaveText("2");
	await expect(
		panel.getByRole("region", { name: "动作", exact: true }).getByRole("heading").first(),
	).toContainText("第 1 次尝试");
	await expect(panel.getByRole("list", { name: "最近的失败" }).getByRole("listitem")).toHaveCount(
		5,
	);
	// 新的尝试还没开始，没有「正在做」。
	await expect(panel.getByRole("region", { name: "正在做" })).toHaveCount(0);
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
	await expect(verify).not.toContainText("保持 4 小时");
});
