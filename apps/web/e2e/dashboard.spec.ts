import type { Locator, Page } from "@playwright/test";
import type { FakeAgent } from "../../server/test/support/fake-agent.js";
import { setAgentDisabled } from "./agent-admin-support";
import { type E2eFixtures, expect, test } from "./fixtures";
import { metricPackage } from "./monitor-scenario";
import { readouts } from "./overview-support";
import {
	createScenario,
	failApi,
	holdApi,
	publishPackage,
	scenarioUsing,
	triggerRun,
} from "./support";
import {
	focusWallRun,
	lateSubflowRun,
	longChainRun,
	mainChain,
	manyRuns,
	seedWall,
} from "./wall-support";

// 控制台的实况墙（外壳页方案 4.1）：页头一行；左栏是正在运行的运行块和最近结束，右栏是 Agent 的槽位和场景。

const header = (page: Page) =>
	page.getByRole("heading", { name: "控制台", level: 1, exact: true }).locator("..");
const counts = (page: Page) => page.getByRole("list", { name: "运行计数" });
const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
/** 一个运行块（区域名称是场景名）。 */
const block = (page: Page, scenario: string) =>
	region(page, "正在运行").getByRole("region", { name: scenario, exact: true });
/** 最近结束里的一行（失败的行里还有关注项读数的列表项，不算）。 */
const ended = (page: Page) => region(page, "最近结束").locator("li[data-run-status]");

/** 环境里出现过一个运行：触发场景，让 Agent 成功完成它。 */
async function runOnce(
	controlPlane: E2eFixtures["controlPlane"],
	agent: FakeAgent,
	name = "巡检",
): Promise<string> {
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, name, scenarioUsing(agent.name));
	await triggerRun(controlPlane, scenario);
	await agent.succeed(await agent.nextAssign());
	return scenario;
}

test("页头一行：控制面时间、此刻与最近 24 小时的计数、运行场景；没有统计卡、趋势和最近发布的节点包", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");

	const head = header(page);
	await expect(head).toContainText("控制面时间 09:05:34");
	await expect(counts(page).getByRole("listitem")).toHaveText([
		"运行中 2",
		"执行中任务 1",
		"排队 1",
		"最近 24 小时 成功 1 · 失败 1 · 取消 0",
	]);
	await expect(head.getByRole("button", { name: "运行场景" })).toBeVisible();
	await expect(head.getByRole("link", { name: "场景编排" })).toHaveCount(0);
	await expect(page.getByRole("region", { name: "运行统计" })).toHaveCount(0);
	await expect(region(page, "运行趋势")).toHaveCount(0);
	await expect(region(page, "最近发布的节点包")).toHaveCount(0);

	// 计数与页头排在同一行。
	const [title, summary, button] = await Promise.all([
		page.getByRole("heading", { name: "控制台", level: 1 }).boundingBox(),
		counts(page).boundingBox(),
		head.getByRole("button", { name: "运行场景" }).boundingBox(),
	]);
	const middle = (b: typeof title) => (b ? b.y + b.height / 2 : Number.NaN);
	expect(Math.abs(middle(summary) - middle(title))).toBeLessThan(4);
	expect(Math.abs(middle(button) - middle(title))).toBeLessThan(4);
});

test("「运行场景」打开命令面板，只列出运行场景一组，选一个场景打开它的运行抽屉", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await runOnce(controlPlane, await connectAgent({ name: "agent-a" }));
	await page.goto("/");
	await header(page).getByRole("button", { name: "运行场景" }).click();

	const palette = page.getByRole("dialog", { name: "命令面板" });
	await expect(palette.getByRole("group", { name: "运行场景" })).toBeVisible();
	await expect(palette.getByRole("group")).toHaveCount(1);
	await palette.getByRole("option", { name: "运行「巡检」" }).click();
	await expect(page.getByRole("dialog", { name: /运行/ })).toBeVisible();
});

test("运行块：场景、版本、运行编号、触发人和开始时间，右上角是大号的已运行时长；按开始时间从新到旧", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { running } = await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	const blocks = region(page, "正在运行").getByRole("heading", { level: 3 });
	await expect(blocks).toHaveText(["撮合压测", "夜间巡检"]);

	const run = block(page, "撮合压测");
	await expect(run).toContainText("运行中");
	await expect(run).toContainText("v1");
	await expect(run).toContainText(running.slice(0, 8));
	await expect(run).toContainText("tester 触发 · 开始 01-01 09:05");
	const elapsed = run.getByTestId("run-elapsed");
	await expect(elapsed).toHaveText("15s");
	await expect(run).toContainText("已运行");
	// 全站唯一的大字号（22px）。
	expect(await elapsed.evaluate((el) => getComputedStyle(el).fontSize)).toBe("22px");
});

test("线路：每条链一行，节点是站，已完成数写在右边；子流程从触发它的异步任务节点那一列分出", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	const lines = block(page, "撮合压测").getByRole("list", { name: "各链进度" });
	const rows = lines.locator(":scope > li");
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0).getByRole("listitem")).toHaveText([
		"entry（成功）",
		"spawn（成功）",
		"probe（执行中）",
	]);
	await expect(rows.nth(0)).toContainText("主链");
	await expect(rows.nth(0)).toContainText("2/3");
	await expect(rows.nth(1).getByRole("listitem")).toHaveText(["sub（成功）", "verify（失败）"]);
	await expect(rows.nth(1)).toContainText("子流程 sub");
	await expect(rows.nth(1)).toContainText("1/2");

	// 子流程的第一站和主链上的 spawn 对齐；进入执行中的 probe 的那一段是青色。
	const station = (row: number, name: string) =>
		rows.nth(row).getByRole("listitem").filter({ hasText: name });
	const [spawn, sub] = await Promise.all([
		station(0, "spawn").boundingBox(),
		station(1, "sub").boundingBox(),
	]);
	expect(Math.abs((spawn?.x ?? 0) - (sub?.x ?? Number.NaN))).toBeLessThan(1);
	const segment = (name: string) =>
		station(0, name).evaluate((li) => {
			const line = li.querySelector("[aria-hidden]:not([data-status-dot])");
			return line ? getComputedStyle(line).backgroundColor : "";
		});
	const signal = await page.evaluate(() => {
		const probe = document.createElement("i");
		probe.style.color = "var(--signal-line)";
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	});
	expect(await segment("spawn")).toBe(signal);
	expect(await segment("entry")).not.toBe(signal);
});

test("线路：链名列宽只按展开的运行块算：收起成一行的运行有很长的子流程名，不让展开的块多出空白", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent-a", slots: 12 });
	await publishPackage(controlPlane);
	// 6 个以上运行：都是收起成一行的紧凑行。其中一个的子流程名字很长（收起时看不到它的线路）。
	await manyRuns(controlPlane, agent, clock, 5);
	const longName = "一个名字特别特别长的子流程用来撑宽链名那一列";
	const base = mainChain(agent.name, ["prepare", "soak"]);
	const scenario = await createScenario(controlPlane, "浸泡 长名", {
		...base,
		nodes: [
			...base.nodes.slice(0, 2),
			{ id: "spawn", kind: "async", params: {} },
			...base.nodes.slice(2),
			{ id: "sub", kind: "subflow_entry", name: longName },
			{ id: "s1", kind: "package", package: "demo-checks", node: "ping", inputs: { host: "s1" } },
		],
		edges: [
			{ from: "entry", to: "prepare", kind: "chain" },
			{ from: "prepare", to: "spawn", kind: "chain" },
			{ from: "spawn", to: "soak", kind: "chain" },
			{ from: "sub", to: "s1", kind: "chain" },
			{ from: "spawn", to: "sub", kind: "dispatch" },
		],
	});
	await triggerRun(controlPlane, scenario);
	for (let i = 0; i < 3; i++) {
		const task = await agent.nextAssign();
		if (task.nodeId === "prepare") await agent.succeed(task);
	}
	await page.goto("/");
	const left = region(page, "正在运行");
	await expect(left.getByRole("button", { expanded: false })).toHaveCount(6);

	// 展开一个只有主链的运行块：它的链名列只按它自己（「主链」）算，不被收起的那个运行的长名字撑宽。
	await left.getByRole("button", { expanded: false }).last().click();
	const lines = left.getByRole("region").getByRole("list", { name: "各链进度" });
	await expect(lines).toHaveCount(1);
	const labelColumn = await lines.evaluate((el) => {
		const first = el.querySelector("li > span:first-child");
		return first ? first.getBoundingClientRect().width : Number.NaN;
	});
	expect(labelColumn).toBeLessThan(80);
});

test("线路：上下排着的运行块里，线路从同一个横坐标开始（链名那一列同宽），链名都完整", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	// 「撮合压测」有子流程（链名「子流程 sub」），「夜间巡检」只有主链：各块自己取链名的宽度时，线路的起点会错开。
	const lines = (scenario: string) => block(page, scenario).getByRole("list", { name: "各链进度" });
	const firstStation = (scenario: string) =>
		lines(scenario).locator(":scope > li").first().getByRole("listitem").first();
	await expect(lines("撮合压测").locator(":scope > li")).toHaveCount(2);
	await expect(lines("夜间巡检").locator(":scope > li")).toHaveCount(1);
	const [stress, nightly] = await Promise.all([
		firstStation("撮合压测").boundingBox(),
		firstStation("夜间巡检").boundingBox(),
	]);
	expect(stress?.x).toBeGreaterThan(0);
	expect(Math.abs((stress?.x ?? 0) - (nightly?.x ?? Number.NaN))).toBeLessThan(1);

	// 链名都完整（列宽按最长的链名估的，不够时末尾才省略）。
	for (const scenario of ["撮合压测", "夜间巡检"]) {
		for (const label of await lines(scenario).locator("> li > span:first-child").all()) {
			const clipped = await label.evaluate((el) =>
				[...el.querySelectorAll("[data-truncate-clip]")].some((c) => c.scrollWidth > c.clientWidth),
			);
			expect(clipped).toBe(false);
		}
	}
});

test("进行中的节点那一行：节点、Agent、尝试号、已执行时长；排队中的节点写状态；运行监控概览的链路里写法一样", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { queued } = await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	await expect(
		block(page, "撮合压测").getByRole("list", { name: "进行中的节点" }).getByRole("listitem"),
	).toHaveText(["probeagent-linux · 第 1 次尝试 · 15s"]);
	await expect(
		block(page, "夜间巡检").getByRole("list", { name: "进行中的节点" }).getByRole("listitem"),
	).toHaveText([
		// 排队中的节点写明在等什么（#601，和概览同一句话）。
		"ping第 1 次尝试 · 排队中 · 等 agent-mac（不在线，已离线 1h 05m）· 排队 20s · 9m 40s 后超时",
	]);

	// 点进概览，停在排队上的运行仍写排队中的节点，不会整行消失；概览里还写明在等谁、等了多久（#457）。
	await page.goto(`/runs/${queued}?view=overview`);
	await expect(page.getByRole("list", { name: "进行中的节点" }).getByRole("listitem")).toHaveText([
		"ping 第 1 次尝试 · 排队中 · 等 agent-mac（不在线，已离线 1h 05m）· 排队 20s · 9m 40s 后超时",
	]);
});

test("运行块的主指标：场景没设关注项时，读数区是执行中节点的主指标，点一格进入概览并定位到那个节点", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { running } = await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	const readout = block(page, "撮合压测").getByRole("region", { name: "执行中节点的主指标" });
	const cells = readout.getByRole("list", { name: "关注项读数" }).getByRole("link");
	await expect(cells).toHaveCount(1);
	await expect(cells.first()).toContainText("probe");
	await expect(cells.first()).toContainText("level");
	// 只有排队中节点的运行没有执行中的节点：标题行和「设置关注项」都在，写明原因。
	const waiting = block(page, "夜间巡检").getByRole("region", { name: "执行中节点的主指标" });
	await expect(waiting).toContainText("没有执行中的节点。");
	await expect(waiting.getByRole("link", { name: "设置关注项" })).toBeVisible();

	await cells.first().click();
	await expect(page).toHaveURL(new RegExp(`/runs/${running}\\?view=overview&node=probe$`));
	await expect(readouts(page).locator('[aria-current="location"]')).toContainText("level");
});

/** entry → s1、s2 两个异步任务节点 → probe；s1、s2 各分出一条子流程（va、vb）。三个 ping 同时执行中。 */
const threeBranches = (agent: string) => {
	const ping = (id: string) => ({
		id,
		kind: "package",
		package: "demo-checks",
		node: "ping",
		inputs: { host: id },
	});
	const chain = (from: string, to: string) => ({ from, to, kind: "chain" });
	return {
		default_agent: agent,
		nodes: [
			{ id: "entry", kind: "entry" },
			{ id: "s1", kind: "async", params: {} },
			{ id: "s2", kind: "async", params: {} },
			ping("probe"),
			{ id: "sub-a", kind: "subflow_entry", name: "甲" },
			ping("va"),
			{ id: "sub-b", kind: "subflow_entry", name: "乙" },
			ping("vb"),
		],
		edges: [
			chain("entry", "s1"),
			chain("s1", "s2"),
			chain("s2", "probe"),
			chain("sub-a", "va"),
			chain("sub-b", "vb"),
			{ from: "s1", to: "sub-a", kind: "dispatch" },
			{ from: "s2", to: "sub-b", kind: "dispatch" },
		],
		packages: { "demo-checks": "1.2.0" },
	};
};

test("运行块的主指标：和关注项一样排，3 个以上运行时只放前两项，其余写「还有 N 个主指标 · 打开概览」", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ ...FOCUS_AGENT, slots: 8 });
	await publishPackage(controlPlane, metricPackage());
	const scenario = await createScenario(controlPlane, "三路探活", threeBranches("agent-a"));
	const run = await triggerRun(controlPlane, scenario);
	for (let i = 0; i < 3; i++) await agent.nextAssign();
	await manyRuns(controlPlane, agent, clock, 2);
	await page.clock.setFixedTime(clock.now());
	await page.goto("/");
	const list = block(page, "三路探活")
		.getByRole("region", { name: "执行中节点的主指标" })
		.getByRole("list", { name: "关注项读数" });
	await expect(list.getByRole("link").filter({ hasNotText: "打开概览" })).toHaveCount(2);
	const more = list.getByRole("link", { name: "还有 1 个主指标 · 打开概览", exact: true });
	await expect(more).toBeVisible();
	await more.click();
	await expect(page).toHaveURL(new RegExp(`/runs/${run}\\?view=overview$`));
});

test("运行块的读数读取失败：保留标题行，写「无法加载关注项」，和 Agent 页的槽位格一样", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await seedWall({ page, controlPlane, connectAgent, clock });
	await failApi(page, "/runs/*/focus**");
	await page.goto("/");
	const readout = block(page, "撮合压测").getByRole("region", { name: "关注项", exact: true });
	await expect(readout).toContainText("无法加载关注项");
	// 不知道场景设没设关注项：入口只写去哪个页面。
	await expect(readout.getByRole("link", { name: "打开场景设置的「关注项」页" })).toBeVisible();
});

const FOCUS_AGENT = {
	name: "agent-a",
	slots: 4,
	installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
};
/** 运行块的读数区（场景设了关注项）。 */
const focusRegion = (run: Locator) => run.getByRole("region", { name: "关注项", exact: true });
const readoutList = (run: Locator) => focusRegion(run).getByRole("list", { name: "关注项读数" });
/** 一格一格的读数（链接），按排列的顺序，不含最后一格「还有 N 个关注项」。 */
const readings = (run: Locator) =>
	readoutList(run).getByRole("link").filter({ hasNotText: "打开概览" });
/** 最后一格：「还有 N 个关注项 · 打开概览」。 */
const moreLink = (run: Locator, count: number) =>
	readoutList(run).getByRole("link", { name: `还有 ${count} 个关注项 · 打开概览`, exact: true });
/** 连上 agent-a，跑出 {@link focusWallRun} 的状态（场景「撮合浸泡」）。 */
async function focusRun(
	{
		controlPlane,
		connectAgent,
		clock,
	}: Pick<E2eFixtures, "controlPlane" | "connectAgent" | "clock">,
	options: Parameters<typeof focusWallRun>[3] & { slots?: number } = {},
) {
	const agent = await connectAgent({ ...FOCUS_AGENT, slots: options.slots ?? FOCUS_AGENT.slots });
	return { agent, ...(await focusWallRun(controlPlane, agent, clock, options)) };
}

test("运行块的关注项读数：1440 下放 4 格，有异常的排在最前并写明原因，其余写「还有 3 个关注项 · 打开概览」，标题旁写「2 项需要注意」", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await focusRun({ controlPlane, connectAgent, clock });
	await page.goto("/");
	const run = block(page, "撮合浸泡");
	await expect(readings(run)).toHaveCount(4);
	await expect(focusRegion(run)).toContainText("2 项需要注意");
	await expect(moreLink(run, 3)).toBeVisible();
	// 控制面把有异常的排在前面：fetch2 的延迟、吞吐（写原因，不写来源），之后是作者的顺序里 fetch 的延迟、请求数（写来源和最终值）。
	await expect(readings(run)).toHaveText([
		/^延迟.*WARN · 08:00:04$/,
		/^吞吐.*WARN · 08:00:04$/,
		/^延迟.*fetch · 最终值$/,
		/^请求数.*fetch · 最终值$/,
	]);
	await expect(readings(run).first()).toHaveAccessibleName(
		/来自 fetch2（执行中），需要注意：1 条 WARN/,
	);
});

test("运行块的关注项读数：按运行块的宽度算，1280 下放 3 格，其余写「还有 4 个关注项 · 打开概览」", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await focusRun({ controlPlane, connectAgent, clock });
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto("/");
	const run = block(page, "撮合浸泡");
	await expect(readings(run)).toHaveCount(3);
	await expect(focusRegion(run)).toContainText("2 项需要注意");
	await expect(moreLink(run, 4)).toBeVisible();
	await expect(readings(run).nth(2)).toContainText("最终值");

	// 窗口变宽时跟着变：格数看运行块的宽度，不是进页面时的那一次。
	await page.setViewportSize({ width: 1440, height: 900 });
	await expect(readings(run)).toHaveCount(4);
	await expect(moreLink(run, 3)).toBeVisible();
});

test("运行块的关注项读数：有异常的总在可见的格子里，比格数多时全部显示", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	// fetch2 的四张图表都有异常（WARN），再加 ping 的 level：5 项里 4 项有异常，1280 下只有 3 格。
	await focusRun(
		{ controlPlane, connectAgent, clock },
		{
			items: [
				{ node_id: "ping", chart: "level" },
				{ node_id: "fetch2", chart: "延迟" },
				{ node_id: "fetch2", chart: "吞吐" },
				{ node_id: "fetch2", chart: "请求数" },
				{ node_id: "fetch2", chart: "errors" },
			],
		},
	);
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto("/");
	const run = block(page, "撮合浸泡");
	await expect(focusRegion(run)).toContainText("4 项需要注意");
	await expect(readings(run)).toHaveCount(4);
	for (const reading of await readings(run).all()) await expect(reading).toContainText("WARN");
	await expect(moreLink(run, 1)).toBeVisible();
});

test("运行块的关注项读数：3 个以上运行时每块只放有异常的和前两项", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { agent } = await focusRun({ controlPlane, connectAgent, clock }, { slots: 8 });
	await manyRuns(controlPlane, agent, clock, 2);
	await page.goto("/");
	const run = block(page, "撮合浸泡");
	// 两项有异常，正好两格；其余 5 项不再按宽度补格。
	await expect(readings(run)).toHaveCount(2);
	await expect(focusRegion(run)).toContainText("2 项需要注意");
	await expect(moreLink(run, 5)).toBeVisible();
	for (const reading of await readings(run).all()) await expect(reading).toContainText("WARN");
});

test("运行块的关注项读数：点一格进入运行监控概览并定位到那个节点；「还有 N 个关注项」进入概览", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await focusRun({ controlPlane, connectAgent, clock });
	await page.goto("/");
	const run = block(page, "撮合浸泡");
	await readings(run).nth(2).click();
	await expect(page).toHaveURL(new RegExp(`/runs/${runId}\\?.*view=overview`));
	await expect(page).toHaveURL(/node=fetch(&|$)/);
	// 概览里属于 fetch 的三项关注项（数值「errors」，图表「延迟」「请求数」）标出位置，fetch2 的没有。
	await expect(page.getByRole("heading", { name: "链路", level: 2 })).toBeVisible();
	const located = page.locator('[aria-current="location"]');
	await expect(located).toHaveCount(3);
	await expect(located.filter({ hasText: "fetch2" })).toHaveCount(0);

	await page.goBack();
	await moreLink(block(page, "撮合浸泡"), 3).click();
	await expect(page).toHaveURL(new RegExp(`/runs/${runId}\\?view=overview$`));
	await expect(page.locator('[aria-current="location"]')).toHaveCount(0);
});

test("运行块的读数区标题旁的入口：设了关注项是「调整关注项」，进入场景设置的关注项页", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { scenarioId } = await focusRun({ controlPlane, connectAgent, clock });
	await page.goto("/");
	const link = focusRegion(block(page, "撮合浸泡")).getByRole("link", { name: "调整关注项" });
	await expect(link).toHaveAttribute("href", `/orchestrations/${scenarioId}?settings=focus`);
	await link.click();
	await expect(page).toHaveURL(new RegExp(`/orchestrations/${scenarioId}\\?settings=focus`));
});

test("运行块的主指标：场景没设关注项时，标题旁写明并给出「设置关注项」的入口", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { stress } = await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	const primary = block(page, "撮合压测").getByRole("region", { name: "执行中节点的主指标" });
	await expect(primary).toContainText("场景没有设置关注项");
	await expect(primary.getByRole("link", { name: "设置关注项" })).toHaveAttribute(
		"href",
		`/orchestrations/${stress}?settings=focus`,
	);
});

test("最近结束的失败行：带关注项的最终值（场景现在的关注项，最多 4 项）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await focusRun({ controlPlane, connectAgent, clock }, { fail: true });
	await page.goto("/");
	const row = ended(page).filter({ hasText: runId.slice(0, 8) });
	await expect(row).toContainText("失败节点 fetch2");
	const values = row.getByRole("list", { name: "关注项读数" }).getByRole("group");
	// 作者写了 7 项，只带前 4 项：有异常的（来源节点失败）在最前，之后是成功的 fetch 的最终值。
	await expect(values).toHaveCount(4);
	await expect(values).toHaveText([
		/^延迟.*来源节点失败$/,
		/^吞吐.*来源节点失败$/,
		/^延迟.*fetch · 最终值$/,
		/^请求数.*fetch · 最终值$/,
	]);
	await expect(values.first()).toHaveAccessibleName(/来自 fetch2（失败）/);
});

test("运行块的三个按钮：打开运行监控、在画布中打开、取消运行（走现有的确认流程）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { running, stress } = await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	const run = block(page, "撮合压测");
	await expect(run.getByRole("link", { name: "打开运行监控" })).toHaveAttribute(
		"href",
		`/runs/${running}`,
	);
	await expect(run.getByRole("link", { name: "在画布中打开" })).toHaveAttribute(
		"href",
		`/orchestrations/${stress}?run=${running}`,
	);
	await run.getByRole("button", { name: "取消运行" }).click();
	await expect(page.getByRole("dialog", { name: /取消运行/ })).toBeVisible();
	await page.keyboard.press("Escape");

	await run.getByRole("link", { name: "打开运行监控" }).click();
	await expect(page).toHaveURL(new RegExp(`/runs/${running}(\\?|$)`));
});

test("最近结束：失败的写错误类型、第一个失败的节点、所在链、尝试号和错误信息；成功的只占一行", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { failed, succeeded } = await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	await expect(region(page, "最近结束")).toContainText("最近结束2");
	const [fail, ok] = [ended(page).nth(0), ended(page).nth(1)];
	await expect(fail).toContainText("失败");
	await expect(fail).toContainText("订单链路");
	await expect(fail).toContainText(failed.slice(0, 8));
	await expect(fail).toContainText("timeout");
	await expect(fail).toContainText("失败节点 submit · 主链 · 第 2 次尝试");
	await expect(fail).toContainText("结束于 01-01 08:05 · 耗时 4m 12s");
	await expect(fail).toContainText("等待响应超时：下单接口 30 秒内没有返回");

	await expect(ok).toContainText("成功");
	await expect(ok).toContainText("巡检");
	await expect(ok).toContainText(succeeded.slice(0, 8));
	await expect(ok).toContainText("耗时 2.3s");
	await expect(ok.getByRole("link", { name: "打开失败节点" })).toHaveCount(0);
	const [failBox, okBox] = await Promise.all([fail.boundingBox(), ok.boundingBox()]);
	expect(okBox?.height ?? 0).toBeLessThan((failBox?.height ?? 0) / 2);
});

test("最近结束：取消的运行也只占一行，写结束时间和耗时，没有「打开失败节点」", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	const scenario = await runOnce(controlPlane, agent);
	const run = await triggerRun(controlPlane, scenario);
	const task = await agent.nextAssign();
	clock.advance(3000);
	const cancel = await controlPlane.fetch(`/runs/${run}/cancel`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "tester" },
		body: "{}",
	});
	expect(cancel.ok).toBe(true);
	await agent.nextCancel();
	await agent.cancelled(task);
	await page.goto("/");
	const row = ended(page).filter({ hasText: "已取消" });
	await expect(row).toContainText("巡检");
	await expect(row).toContainText("耗时 3.0s");
	await expect(row.getByRole("button", { name: "再次运行" })).toBeVisible();
	await expect(row.getByRole("link", { name: "打开失败节点" })).toHaveCount(0);
	const [cancelled, succeeded] = await Promise.all([
		row.boundingBox(),
		ended(page).filter({ hasText: "成功" }).boundingBox(),
	]);
	// 只差最后一行没有的 1px 分隔线。
	expect(
		Math.abs((cancelled?.height ?? 0) - (succeeded?.height ?? Number.NaN)),
	).toBeLessThanOrEqual(1);
});

test("最近结束的失败行：「打开失败节点」进入运行监控并选中失败节点，「再次运行」打开带上次参数的运行抽屉", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { failed } = await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	const fail = ended(page).nth(0);
	await fail.getByRole("button", { name: "再次运行" }).click();
	const drawer = page.getByRole("dialog", { name: /再次运行/ });
	await expect(drawer).toContainText("订单链路");
	await drawer.getByRole("button", { name: "取消" }).click();
	await expect(drawer).toHaveCount(0);

	await fail.getByRole("link", { name: "打开失败节点" }).click();
	await expect(page).toHaveURL(new RegExp(`/runs/${failed}\\?.*node=submit`));
	await expect(page).toHaveURL(/view=detail/);
});

test("Agent 列：每台 Agent 的槽位格写节点、场景和已执行时长，空闲槽合并；不放正在做和关注项；离线的不画空闲槽、不写占用数", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { linux: agent, probe } = await seedWall({ page, controlPlane, connectAgent, clock });
	// probe 正在做一个动作、上报了进度，场景没设关注项所以有主指标：Agent 管理页的槽位格会写出这些，控制台的紧凑槽位格不写。
	agent.actionSummary(probe, {
		total: 1,
		reported: 1,
		running: [
			{
				id: 1,
				parent: null,
				depth: 0,
				name: "保持 4 小时",
				fields: {},
				...agent.stamp(clock.now().getTime()),
			},
		],
	});
	agent.progress(probe, 3, 10, "第 3 批");
	await agent.sync();
	await page.goto("/");
	const agents = region(page, "Agent");
	await expect(agents).toContainText("1 / 2 在线");
	const linux = agents.getByRole("region", { name: "agent-linux" });
	await expect(linux).toContainText("1 / 4 占用");
	const slots = linux.getByRole("list").getByRole("listitem");
	await expect(slots).toHaveText(["probe撮合压测15s", "3 个槽位空闲"]);
	await expect(slots.first()).toHaveAccessibleName("节点 probe，场景 撮合压测");
	await expect(linux.getByTestId("slot-activity")).toHaveCount(0);

	const mac = agents.getByRole("region", { name: "agent-mac" });
	await expect(mac).toContainText("离线");
	await expect(mac).not.toContainText("占用");
	await expect(mac.getByRole("listitem")).toHaveCount(0);
	await expect(agents.getByRole("link", { name: "管理" })).toHaveAttribute("href", "/agents");
});

test("Agent 列：排队等这台 Agent 的任务数写在槽位下面", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a", slots: 1 });
	await runOnce(controlPlane, agent);
	const scenario = await createScenario(controlPlane, "排队", scenarioUsing("agent-a"));
	await triggerRun(controlPlane, scenario);
	await agent.nextAssign();
	await triggerRun(controlPlane, scenario);
	await page.goto("/");
	const row = region(page, "Agent").getByRole("region", { name: "agent-a" });
	await expect(row).toContainText("1 / 1 占用");
	await expect(row).toContainText("排队 1");
	await expect(row.getByRole("listitem")).toHaveCount(1);
});

test("Agent 列：不是「在线」的状态写在名称行（安装节点包中）", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a", slots: 2 });
	await runOnce(controlPlane, agent);
	agent.send({
		case: "install",
		value: {
			package: "demo-checks",
			version: "1.2.0",
			state: 1,
			taskId: "t-1",
			installedPackages: [],
		},
	});
	await page.goto("/");
	const row = region(page, "Agent").getByRole("region", { name: "agent-a" });
	await expect(row).toContainText("安装中");
	await expect(row).toContainText("0 / 2 占用");
});

test("Agent 列：准备环境中、版本不一致的 Agent 接不了新任务，不画空闲槽、不写占用数；准备环境中写在名称行", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a", slots: 2 });
	await runOnce(controlPlane, agent);
	await connectAgent({ name: "agent-prep", slots: 2 }, { preparing: true });
	await connectAgent({ name: "agent-old", slots: 2, agentVersion: "0.0.1" });
	await page.goto("/");
	const agents = region(page, "Agent");
	await expect(agents.getByRole("region", { name: "agent-a" })).toContainText("2 个槽位空闲");
	for (const [name, status] of [
		["agent-prep", "准备环境中"],
		["agent-old", "版本不一致"],
	] as const) {
		const row = agents.getByRole("region", { name });
		await expect(row).toContainText(status);
		await expect(row).not.toContainText("占用");
		await expect(row).not.toContainText("槽位空闲");
	}
});

test("右栏没有 Agent、没有场景时写明；场景列加载中显示骨架，加载失败显示错误详情", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const scenario = await runOnce(controlPlane, await connectAgent({ name: "agent-a" }));
	// 场景全部归档：列表里没有可列的场景。
	const archived = await controlPlane.fetch(`/orchestrations/${scenario}/archive`, {
		method: "POST",
		headers: { "x-sfly-nickname": "tester" },
	});
	expect(archived.ok).toBe(true);
	// 接口没有删除 Agent 的操作：让 Agent 列表返回空，相当于一台 Agent 都没有。
	await page.route("**/api/projects/default/agents", async (route) => {
		const response = await route.fetch();
		await route.fulfill({ response, json: { ...(await response.json()), agents: [] } });
	});
	// 场景列表（不含归档）的请求先挂起，看加载状态。
	const list = (url: URL) => url.pathname === "/api/orchestrations";
	let release: () => void = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(list, async (route) => {
		await released;
		await route.continue();
	});
	await page.goto("/");
	const scenarios = region(page, "场景");
	await expect(scenarios.locator('[data-slot="skeleton"]').first()).toBeVisible();
	release();
	await expect(scenarios).toContainText("没有场景");
	const agents = region(page, "Agent");
	await expect(agents).toContainText("还没有 Agent 连接");
	await expect(agents.getByRole("link", { name: "打开 Agent 管理查看安装命令" })).toHaveAttribute(
		"href",
		"/agents",
	);

	await page.unroute(list);
	await page.route(list, (route) =>
		route.fulfill({
			status: 503,
			contentType: "application/json",
			body: JSON.stringify({ error: { code: "unavailable", message: "控制面暂时不可用" } }),
		}),
	);
	await page.reload();
	await expect(scenarios.getByRole("alert")).toContainText("无法加载场景");
});

test("场景列：按最近一次运行的时间排序，写上次运行的结果，从没运行过的写「从未运行」；点一行进入画布", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { stress } = await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	const scenarios = region(page, "场景");
	await expect(scenarios).toContainText("场景5");
	const rows = scenarios.getByRole("list").getByRole("link");
	await expect(rows).toHaveText([
		"撮合压测运行中",
		"夜间巡检运行中",
		"订单链路失败01-01 08:05",
		"巡检成功01-01 08:00",
		"草稿从未运行",
	]);
	await rows.first().click();
	await expect(page).toHaveURL(new RegExp(`/orchestrations/${stress}$`));
});

test("此刻没有运行：左栏顶部写一行「此刻没有运行」，下面是最近结束，没有白色按钮", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await runOnce(controlPlane, await connectAgent({ name: "agent-a" }));
	await page.goto("/");
	const now = region(page, "正在运行");
	await expect(now).toHaveText("正在运行此刻没有运行");
	await expect(ended(page)).toHaveCount(1);
	const [left, endedPanel] = await Promise.all([
		now.boundingBox(),
		region(page, "最近结束").boundingBox(),
	]);
	expect((endedPanel?.y ?? 0) - ((left?.y ?? 0) + (left?.height ?? 0))).toBeLessThan(20);
	await expect(page.locator('main [data-variant="primary"], main a.bg-primary')).toHaveCount(0);
});

test("实时更新：运行结束后从正在运行移到最近结束，计数里计入成功", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));
	await triggerRun(controlPlane, scenario);
	const task = await agent.nextAssign();

	await page.goto("/");
	await expect(block(page, "巡检")).toBeVisible();
	await expect(counts(page)).toContainText("运行中 1");

	await agent.succeed(task);
	await expect(block(page, "巡检")).toHaveCount(0);
	await expect(region(page, "正在运行")).toContainText("此刻没有运行");
	await expect(ended(page)).toHaveCount(1);
	await expect(ended(page).first()).toContainText("巡检");
	await expect(counts(page)).toContainText("成功 1");
});

test("运行多时：3 个以上运行时每块的进行中节点只列前 2 个，其余写「还有 N 个」", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent-a", slots: 8 });
	await publishPackage(controlPlane);
	const parallel = await createScenario(controlPlane, "并行", {
		...mainChain("agent-a", ["a"]),
		nodes: [
			{ id: "entry", kind: "entry" },
			{ id: "s1", kind: "async", params: {} },
			{ id: "s2", kind: "async", params: {} },
			{ id: "a", kind: "package", package: "demo-checks", node: "ping", inputs: { host: "a" } },
			{ id: "sa", kind: "subflow_entry", name: "甲" },
			{ id: "b", kind: "package", package: "demo-checks", node: "ping", inputs: { host: "b" } },
			{ id: "sb", kind: "subflow_entry", name: "乙" },
			{ id: "c", kind: "package", package: "demo-checks", node: "ping", inputs: { host: "c" } },
		],
		edges: [
			{ from: "entry", to: "s1", kind: "chain" },
			{ from: "s1", to: "s2", kind: "chain" },
			{ from: "s2", to: "a", kind: "chain" },
			{ from: "sa", to: "b", kind: "chain" },
			{ from: "sb", to: "c", kind: "chain" },
			{ from: "s1", to: "sa", kind: "dispatch" },
			{ from: "s2", to: "sb", kind: "dispatch" },
		],
	});
	await triggerRun(controlPlane, parallel);
	for (let i = 0; i < 3; i++) await agent.nextAssign();
	await manyRuns(controlPlane, agent, clock, 2);
	await page.goto("/");
	const nodes = block(page, "并行")
		.getByRole("list", { name: "进行中的节点" })
		.getByRole("listitem");
	await expect(nodes).toHaveCount(3);
	await expect(nodes.last()).toHaveText("还有 1 个");
});

test("运行多时：6 个以上运行时运行块换成一行一个的紧凑行，点开展开成运行块，收起后焦点回到这一行", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent-a", slots: 8 });
	await publishPackage(controlPlane);
	const runs = await manyRuns(controlPlane, agent, clock, 6);
	const focusRequests: string[] = [];
	page.on("request", (r) => {
		if (new URL(r.url()).pathname.endsWith("/focus")) focusRequests.push(r.url());
	});
	await page.goto("/");
	const left = region(page, "正在运行");
	const rows = left.getByRole("button", { expanded: false });
	await expect(rows).toHaveCount(6);
	await expect(left.getByRole("region")).toHaveCount(0);
	await expect(rows.first()).toContainText("浸泡 06");
	await expect(rows.first()).toContainText("soak");
	await expect(rows.first().getByRole("img", { name: "主链 2/4" })).toBeVisible();
	// 紧凑行不取读数：等到控制台接口又轮询了一次，仍然没有读数请求。
	await page.waitForRequest((r) => new URL(r.url()).pathname === "/api/dashboard");
	expect(focusRequests).toEqual([]);

	await rows.first().click();
	const expanded = block(page, "浸泡 06");
	await expect(expanded).toBeVisible();
	const collapse = expanded.getByRole("button", { name: "收起" });
	await expect(collapse).toBeFocused();
	await expect(left.getByRole("button", { expanded: false })).toHaveCount(5);
	await expect.poll(() => focusRequests.length).toBeGreaterThan(0);
	expect(focusRequests.every((url) => url.includes(`/runs/${runs[5]}/focus`))).toBe(true);

	await collapse.click();
	await expect(block(page, "浸泡 06")).toHaveCount(0);
	await expect(left.getByRole("button", { expanded: false }).first()).toBeFocused();
});

test("线路：站名分余量时不挤掉每条链的名称（30 个节点的长链和它的子流程）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent-a", slots: 4 });
	await publishPackage(controlPlane);
	await longChainRun(controlPlane, agent, clock);
	await page.clock.setFixedTime(clock.now());
	await page.goto("/");
	const lines = page.getByRole("list", { name: "各链进度" });
	await expect(lines).toContainText("已完成 15 个");

	// 每条链的名称整个看得见：「主链」「子流程 监控」（第一列取链名的全宽，站名那几列分余量时不和它抢）。
	const labels = lines.locator("> li > span:first-child");
	await expect(labels).toHaveCount(2);
	for (const label of await labels.all()) {
		const clipped = await label.evaluate((el) =>
			[...el.querySelectorAll("[data-truncate-clip]")].some((c) => c.scrollWidth > c.clientWidth),
		);
		expect(clipped).toBe(false);
	}
	await expect(labels.nth(1)).toContainText("子流程 监控");
});

test("线路：子流程从靠后的列分出、列很多时，线路不伸出运行块，每条链右边的计数都在运行块里", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent-a", slots: 4 });
	await publishPackage(controlPlane);
	await lateSubflowRun(controlPlane, agent);
	await page.clock.setFixedTime(clock.now());
	// 最窄的窗口：运行块最窄，11 列站名挤不下。
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto("/");
	const lines = page.getByRole("list", { name: "各链进度" });
	await expect(lines.locator("> li")).toHaveCount(2);

	// 线路自己没有溢出（站名那几列可以缩到 0，截断站名），每条链的计数落在运行块里面。
	expect(await lines.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
	const counts = lines.locator("> li > span:last-child");
	await expect(counts).toHaveText(["5/7", "1/7"]);
	for (const count of await counts.all()) {
		await expect(count).toBeInViewport({ ratio: 1 });
		const inside = await count.evaluate((el) => {
			const block = el.closest("section");
			if (!block) throw new Error("计数不在运行块里");
			return el.getBoundingClientRect().right <= block.getBoundingClientRect().right + 0.5;
		});
		expect(inside).toBe(true);
	}
});

test("加载中显示骨架，加载失败显示错误详情，重试后恢复", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await runOnce(controlPlane, await connectAgent({ name: "agent-a" }));
	const hold = await holdApi(page, "/dashboard");
	await page.goto("/");
	await expect(page.getByRole("status", { name: "加载中" }).first()).toBeVisible();
	hold.release();
	await expect(region(page, "最近结束")).toBeVisible();

	await page.unrouteAll();
	const outage = await failApi(page, "/dashboard");
	await page.reload();
	const error = page.getByRole("alert");
	await expect(error).toContainText("无法加载控制台数据");
	await expect(error).toContainText("GET /api/dashboard → 503 unavailable");
	await outage.restore();
	await error.getByRole("button", { name: "重试" }).click();
	await expect(region(page, "最近结束")).toBeVisible();
});

test("计数：失败为 0 时是中性色，有失败时才着失败色", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const RUNNING = 0;
	const FAILED = 4;
	const color = (index: number) =>
		counts(page)
			.locator("b")
			.nth(index)
			.evaluate((el) => getComputedStyle(el).color);
	const agent = await connectAgent({ name: "agent-a", slots: 2 });
	const scenario = await runOnce(controlPlane, agent);
	await page.goto("/");
	await expect(counts(page)).toContainText("失败 0");
	const neutral = await color(RUNNING);
	expect(await color(FAILED)).toBe(neutral);

	await triggerRun(controlPlane, scenario);
	await agent.fail(await agent.nextAssign(), "出错了");
	await page.reload();
	await expect(counts(page)).toContainText("失败 1");
	expect(await color(FAILED)).not.toBe(neutral);
});

test("脉冲：每个运行只在运行块的状态标签上脉冲一处；线路、进行中的节点和 Agent 列的状态点静止", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	await expect(block(page, "撮合压测")).toBeVisible();
	const pulses = await page.evaluate(() =>
		document
			.getAnimations()
			.filter((a) => a instanceof CSSAnimation && a.animationName === "status-pulse")
			.map(
				(a) =>
					((a as CSSAnimation).effect as KeyframeEffect).target?.closest("[data-status]")
						?.textContent,
			),
	);
	expect(pulses).toEqual(["运行中", "运行中"]);
});

test("Agent 面板：计数分母不含已停用的 Agent，后面写「1 台已停用」；停用的 Agent 写「已停用」，不画空闲槽（#492）", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agents = [];
	for (const name of ["agent-a", "agent-b", "agent-c"]) {
		agents.push(await connectAgent({ name, agentVersion: controlPlane.version, slots: 2 }));
	}
	// 环境里出现过一个运行，控制台才是实况墙（之前是「开始使用」）。
	await runOnce(controlPlane, agents[0] as FakeAgent);
	await page.goto("/");
	const panel = region(page, "Agent");
	// 侧栏「Agent 管理」旁的数和面板标题同一个口径：已停用的不算在总数里。
	const sidebarCount = page.getByRole("link", { name: /Agent 管理/ });
	await expect(panel).toContainText("3 / 3 在线");
	await expect(sidebarCount).toContainText("3/3");
	await expect(panel).not.toContainText("已停用");

	await setAgentDisabled(controlPlane, "agent-c", true);
	// 页面每 5 秒重新读一次 Agent 列表。
	await expect(panel).toContainText("2 / 2 在线 · 1 台已停用", { timeout: 15_000 });
	await expect(sidebarCount).toContainText("2/2");
	await expect(sidebarCount).not.toContainText("2/3");
	const stopped = panel.getByRole("region", { name: "agent-c", exact: true });
	await expect(stopped).toContainText("已停用");
	await expect(stopped).not.toContainText("离线");
	// 停用的 Agent 不接任务：不画空闲槽。
	await expect(stopped.getByRole("list")).toHaveCount(0);
	await expect(panel.getByRole("region", { name: "agent-b", exact: true })).toContainText("在线");
});
