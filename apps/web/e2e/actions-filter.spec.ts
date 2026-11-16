import type { Locator, Page } from "@playwright/test";
import {
	type AssignedTask,
	agentClock,
	type FakeAgent,
	LogLevel,
	LogSource,
} from "../../server/test/support/fake-agent.js";
import { actionsScenario, actionsSummary, actionTable, groupRows } from "./actions-support";
import { type E2eFixtures, expect, test } from "./fixtures";
import { openMonitor } from "./monitor-scenario";
import { createScenario, publishPackage, scenarioUsing, triggerRun } from "./support";

// 运行监控「动作」页的筛选、表格里的时间和点开始时间跳到日志（规格 #345，#358）。

const panel = (page: Page) => page.getByRole("region", { name: "底部面板" });
const toolbar = (page: Page) => panel(page).getByRole("group", { name: "筛选动作" });
const nameSelect = (page: Page) => toolbar(page).getByRole("combobox", { name: "按名称筛选" });
const failedToggle = (page: Page) => toolbar(page).getByRole("button", { name: "只看失败" });
const counts = (page: Page) => panel(page).getByRole("group", { name: "各名称的个数" });
const countButton = (page: Page, name: string) =>
	counts(page).getByRole("button", { name, exact: true });
/** 读屏的播报（实时区域）：只取筛选的那一条，不和加载骨架、顶栏的运行状态混。 */
const announced = (page: Page) =>
	panel(page)
		.getByRole("status")
		.filter({ hasText: /^(筛选后|已清除筛选)/ });
/**
 * 播报的话（可能带一个句号：两次播报的话一样时交替加句号，读屏才会再读，见 ActionsTab）。
 */
const expectAnnounced = (page: Page, text: string) =>
	expect(announced(page)).toHaveText(new RegExp(`^${text}。?$`));
const tab = (page: Page, name: string | RegExp) => panel(page).getByRole("tab", { name });
/** 页面上的时刻（浏览器时区 Asia/Shanghai）：`08:00:10.000`。 */
const clockMs = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(11, 23);

/** 打开 verify 第 2 次尝试的「动作」页：「下单」1200 个、其中 9 个失败，只有 404 个有明细。 */
async function openActions({
	page,
	controlPlane,
	connectAgent,
	clock,
}: {
	page: Page;
	controlPlane: Parameters<typeof actionsScenario>[0];
	connectAgent: E2eFixtures["connectAgent"];
	clock: Parameters<typeof actionsScenario>[2];
}) {
	const scenario = await actionsScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, scenario.runId, "verify", "actions");
	await expect(actionTable(page).locator('tr[data-action-id="1204"]')).toBeVisible();
	return scenario;
}

test("按名称筛选：下拉和计数按钮是同一个条件；三组只留这个名称，焦点留在刚操作的控件上，读屏播报个数", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await openActions({ page, controlPlane, connectAgent, clock });
	const table = actionTable(page);
	// 一行总数；每种名称的个数是按钮，「失败 9」也是。
	await expect(panel(page)).toContainText("共 1,204 个动作、1 个标记");
	await expect(countButton(page, "下单 1,200")).toHaveAttribute("aria-pressed", "false");
	await expect(countButton(page, "失败 9")).toBeVisible();

	await nameSelect(page).focus();
	await nameSelect(page).selectOption("下单");
	await expect(nameSelect(page)).toBeFocused();
	await expect(nameSelect(page)).toHaveValue("下单");
	await expect(countButton(page, "下单 1,200")).toHaveAttribute("aria-pressed", "true");
	// 任务里有标记，名称的个数里可能有标记：不说成都是动作。
	await expectAnnounced(page, "筛选后 1,200 个动作和标记");
	// 「保持 4 小时」和标记不在表里了：正在做只剩「下单」1201 和它的子动作不是「下单」所以也不在。
	await expect.poll(() => groupRows(table, "running")).toEqual(["1201"]);
	await expect(table.locator('tr[data-action-id="1"]')).toHaveCount(0);
	await expect(table.locator('tr[data-action-id="2"]')).toHaveCount(0);

	// 点已经选中的名称取消筛选：焦点还在这个按钮上。
	await countButton(page, "下单 1,200").click();
	await expect(countButton(page, "下单 1,200")).toBeFocused();
	await expect(countButton(page, "下单 1,200")).toHaveAttribute("aria-pressed", "false");
	await expect(nameSelect(page)).toHaveValue("");
	await expectAnnounced(page, "已清除筛选");
	await expect
		.poll(() => groupRows(table, "running"))
		.toEqual(["1204", "1203", "1202", "1201", "1"]);

	// 点另一种名称的按钮：下拉跟着变。
	await countButton(page, "收到第一笔成交 1").click();
	await expect(countButton(page, "收到第一笔成交 1")).toBeFocused();
	await expect(nameSelect(page)).toHaveValue("收到第一笔成交");
	await expectAnnounced(page, "筛选后 1 个动作和标记");
});

test("只看失败：工具条的开关和「失败 N」按钮是同一个开关；正在做的不算失败，最近 20 个和更早的明细只留失败的", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await openActions({ page, controlPlane, connectAgent, clock });
	const table = actionTable(page);
	await expect(failedToggle(page)).toHaveAttribute("aria-pressed", "false");

	await failedToggle(page).click();
	await expect(failedToggle(page)).toBeFocused();
	await expect(failedToggle(page)).toHaveAttribute("aria-pressed", "true");
	await expect(countButton(page, "失败 9")).toHaveAttribute("aria-pressed", "true");
	await expectAnnounced(page, "筛选后 9 个动作");
	// 正在做的动作还没有结果：「正在做」这一组不出现。
	await expect(table.locator('tbody[data-group="running"]')).toHaveCount(0);
	await expect.poll(() => groupRows(table, "recent")).toEqual(["1190"]);
	await expect(table.locator('th[scope="rowgroup"]', { hasText: "更早的失败" })).toContainText(
		"失败的动作仍有明细",
	);
	await table.evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	await expect
		.poll(async () => (await groupRows(table, "earlier")).filter((id) => !id.startsWith("~")))
		.toEqual(["1180", "1150", "1100", "400", "320", "240", "160", "80"]);
	await expect(table.locator('tr[data-result="success"]')).toHaveCount(0);
	// 合计没满、失败的动作都有明细：没有只计数的一行。
	await expect(table.locator("tr[data-count-only]")).toHaveCount(0);

	// 再点一次，从「失败 9」这个按钮关掉：焦点留在它上面。
	await countButton(page, "失败 9").click();
	await expect(countButton(page, "失败 9")).toBeFocused();
	await expect(failedToggle(page)).toHaveAttribute("aria-pressed", "false");
	await expectAnnounced(page, "已清除筛选");
	await expect
		.poll(() => groupRows(table, "running"))
		.toEqual(["1204", "1203", "1202", "1201", "1"]);
});

test("两次筛选的播报一样时读屏也要再读：第二次的文字和上一次不同", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await openActions({ page, controlPlane, connectAgent, clock });
	await failedToggle(page).click();
	await expect(announced(page)).toHaveText("筛选后 9 个动作");
	// 「下单」的失败也是 9 个：播报的话一样，实时区域的文字要变一下读屏才会读。
	await nameSelect(page).focus();
	await nameSelect(page).selectOption("下单");
	await expect(announced(page)).toHaveText("筛选后 9 个动作。");
	await countButton(page, "下单 1,200").click();
	await expect(announced(page)).toHaveText("筛选后 9 个动作");
});

test("名称和只看失败一起用；筛选后没有行时写明并给出「清除筛选」，点它以后焦点回到名称下拉", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await openActions({ page, controlPlane, connectAgent, clock });
	await nameSelect(page).selectOption("下单");
	await failedToggle(page).click();
	await expectAnnounced(page, "筛选后 9 个动作");
	await expect.poll(() => groupRows(actionTable(page), "recent")).toEqual(["1190"]);

	// 「保持 4 小时」一个都没有失败。
	await nameSelect(page).selectOption("保持 4 小时");
	await expectAnnounced(page, "筛选后 0 个动作");
	const empty = panel(page).getByText("没有符合条件的动作。");
	await expect(empty).toBeVisible();
	await expect(actionTable(page)).toHaveCount(0);
	// 工具条还在：选了什么看得见。
	await expect(nameSelect(page)).toHaveValue("保持 4 小时");
	await expect(failedToggle(page)).toHaveAttribute("aria-pressed", "true");

	const clear = panel(page).getByRole("button", { name: "清除筛选" });
	await clear.focus();
	await page.keyboard.press("Enter");
	await expectAnnounced(page, "已清除筛选");
	// 按钮已经换掉了：焦点不留在 body 上。
	await expect(nameSelect(page)).toBeFocused();
	await expect(nameSelect(page)).toHaveValue("");
	await expect(failedToggle(page)).toHaveAttribute("aria-pressed", "false");
	await expect(empty).toHaveCount(0);
	await expect(actionTable(page).locator('tr[data-action-id="1204"]')).toBeVisible();
});

test("只计数的一行里有「只看失败」：点它以后焦点回到工具条的开关；合计没满时失败的都有明细，这一行不再出现", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await openActions({ page, controlPlane, connectAgent, clock });
	const table = actionTable(page);
	await table.evaluate((el) => {
		el.scrollTop = 800;
	});
	const row = table.locator('tr[data-count-only="下单"]');
	await expect(row).toHaveText(
		"08:00:10 至今的 796 个「下单」只计数，没有明细（每种名称最多记录 5 万个，失败的动作仍有明细） 只看失败",
	);
	await row.getByRole("button", { name: "只看失败" }).click();
	await expect(failedToggle(page)).toBeFocused();
	await expect(failedToggle(page)).toHaveAttribute("aria-pressed", "true");
	await expectAnnounced(page, "筛选后 9 个动作");
	await expect(table.locator("tr[data-count-only]")).toHaveCount(0);
});

test("合计已满时只看失败：只计数的个数里有成功的，写明其中失败的个数不知道和这个名称一共失败多少个", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { agent, verify, times } = await openActions({
		page,
		controlPlane,
		connectAgent,
		clock,
	});
	const table = actionTable(page);
	// 合计满了 10 万个：之后失败的动作也没有明细。
	const full = agent.stamp(times.start + 3_000);
	agent.actionSummary(verify, {
		...actionsSummary(agent, times),
		capped_ts: full.ts,
		capped_mono: full.mono,
	});
	await agent.sync();
	await table.evaluate((el) => {
		el.scrollTop = 800;
	});
	const row = table.locator('tr[data-count-only="下单"]');
	// 名称上限的段：合计也满了，不能再说失败的动作仍有明细。
	await expect(row).toContainText(
		"每种名称最多记录 5 万个；合计满 10 万个以后，失败的动作也没有明细",
	);
	await expect(row).not.toContainText("失败的动作仍有明细");

	await failedToggle(page).click();
	await expectAnnounced(page, "筛选后 9 个动作");
	await expect(row).toHaveText(
		"08:00:10 至今的 796 个「下单」只计数，没有明细（每种名称最多记录 5 万个；合计满 10 万个以后，失败的动作也没有明细）；其中有多少个失败不知道（「下单」一共失败 9 个）",
	);
	// 已经只看失败：这一行不再给「只看失败」。
	await expect(row.getByRole("button")).toHaveCount(0);
	await expect(table.locator('th[scope="rowgroup"]', { hasText: "更早的失败" })).toContainText(
		"合计满 10 万个以后，失败的动作也没有明细",
	);
});

test("没有失败过的名称：只看失败时它没有失败的明细缺口，只计数的一行不出现", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { agent, verify, times } = await openActions({ page, controlPlane, connectAgent, clock });
	const table = actionTable(page);
	// 「下单」之外「读取缓存」也超出了合计的上限，但它一个都没失败过。
	const full = agent.stamp(times.start + 3_000);
	const base = actionsSummary(agent, times);
	const capped = agent.stamp(times.start + 4_000);
	agent.actionSummary(verify, {
		...base,
		capped_ts: full.ts,
		capped_mono: full.mono,
		names: (base.names ?? []).map((n) =>
			n.name === "读取缓存"
				? { ...n, total: 50, reported: 1, capped_ts: capped.ts, capped_mono: capped.mono }
				: n,
		),
	});
	await agent.sync();
	await table.evaluate((el) => {
		el.scrollTop = 800;
	});
	await expect(table.locator('tr[data-count-only="读取缓存"]')).toContainText("49 个「读取缓存」");

	await failedToggle(page).click();
	await expect(table.locator('tr[data-count-only="下单"]')).toBeVisible();
	await expect(table.locator('tr[data-count-only="读取缓存"]')).toHaveCount(0);
});

test("时间一列：Tab 只停在一个开始时间上，方向键、Home、End 在行间移动；换了行也能回来", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await openActions({ page, controlPlane, connectAgent, clock });
	const table = actionTable(page);
	const stops = table.locator("button[data-locate]");
	await expect(stops.first()).toBeVisible();
	await expect(table.locator('button[data-locate][tabindex="0"]')).toHaveCount(1);
	// 工具条和个数按钮之后按一次 Tab 进入表格，落在视口里的第一行。
	await countButton(page, "失败 9").focus();
	await page.keyboard.press("Tab");
	await expect(table.locator('tr[data-action-id="1204"] button[data-locate]')).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(table.locator('tr[data-action-id="1203"] button[data-locate]')).toBeFocused();
	await page.keyboard.press("ArrowUp");
	await expect(table.locator('tr[data-action-id="1204"] button[data-locate]')).toBeFocused();

	// End 到最后一行：虚拟滚动把它滚进来、再聚焦。更早的明细还没读完时，先到最后读到的那一行，
	// 同时读下一页，再按一次到新的最后一行；最早的是标记「收到第一笔成交」。
	const focused = () =>
		page.evaluate(
			() => (document.activeElement?.closest("tr") as HTMLElement | null)?.dataset.actionId,
		);
	await expect
		.poll(
			async () => {
				await page.keyboard.press("End");
				return focused();
			},
			{ timeout: 10_000 },
		)
		.toBe("2");
	const last = table.locator('tr[data-action-id="2"] button[data-locate]');
	await expect(last).toBeFocused();
	await expect(last).toBeInViewport();
	// 往上滚走、最后一行被虚拟滚动卸掉以后，停靠点退回视口里的第一行：Tab 仍然只有一个停靠点，进来落在它上面。
	await table.evaluate((el) => {
		el.scrollTop = 0;
	});
	await expect(table.locator('tr[data-action-id="1204"]')).toBeVisible();
	await expect(table.locator('tr[data-action-id="2"]')).toHaveCount(0);
	await expect(table.locator('button[data-locate][tabindex="0"]')).toHaveCount(1);
	await countButton(page, "失败 9").focus();
	await page.keyboard.press("Tab");
	await expect(table.locator('tr[data-action-id="1204"] button[data-locate]')).toBeFocused();
	await page.keyboard.press("Home");
	await expect(table.locator('tr[data-action-id="1204"] button[data-locate]')).toBeFocused();

	// 滚下去以后 Tab 进来，落在视口里的行，不是视口上方多渲染的行：视口不会被拉回去。
	await table.evaluate((el) => {
		el.scrollTop = 600;
	});
	await expect(table.locator('tr[data-action-id="1204"]')).toHaveCount(0);
	await countButton(page, "失败 9").focus();
	await page.keyboard.press("Tab");
	const landed = page.locator("[data-locate]:focus");
	await expect(landed).toBeInViewport();
	// 为了看得见，浏览器最多把它滚进视口（表头盖住的那一截），视口不会被拉走。
	expect(Math.abs((await table.evaluate((el) => el.scrollTop)) - 600)).toBeLessThan(60);
});

// 下面用一个 Agent 时间比控制面快 3 小时的节点：ping 执行了 10 秒，记了动作和几行日志。

/** Agent 时间比控制面快 3 小时 25 分 7 秒。 */
const AHEAD_MS = (3 * 3600 + 25 * 60 + 7) * 1000;
/** Agent 连上时的单调时钟读数。 */
const M0 = 5_000;

/** 一行日志：控制面时间 `at`（毫秒），Agent 时间带着偏差。 */
const logAt = (agent: FakeAgent, at: number, seq: number, text: string, skew: number) => ({
	seq: BigInt(seq),
	timeUnixMs: BigInt(at + skew),
	monotonicMs: agent.monotonicAt(at),
	source: LogSource.STDOUT,
	level: LogLevel.INFO,
	text,
});

interface Ping {
	runId: string;
	agent: FakeAgent;
	task: AssignedTask;
	/** 尝试开始的时刻（控制面时间，毫秒）。 */
	t0: number;
	skew: number;
}

/**
 * 一台时钟偏差为 `skew` 的 Agent 上的 ping 节点，执行了 10 秒（没有结束）：
 *
 * - 动作：「保持」（第 1 秒起，进行中）、「下单」（第 2 秒、第 6 秒，第二个失败）、标记「首笔成交」（第 3 秒）；
 * - 日志：第 2.3 秒和第 9 秒各一行。
 *
 * 第 2 秒的「下单」离第一行日志 0.3 秒（算正好有这一行），第 6 秒的离两行日志都是几秒远（没有）。
 */
async function pingWithActions(
	{
		controlPlane,
		connectAgent,
		clock,
	}: Pick<E2eFixtures, "controlPlane" | "connectAgent" | "clock">,
	skew: number,
): Promise<Ping> {
	const t0 = clock.now().getTime();
	const reading = () => {
		const now = clock.now().getTime();
		return agentClock(now + skew, M0 + now - t0);
	};
	const agent = await connectAgent({
		name: "agent-a",
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
		...reading(),
	});
	await publishPackage(controlPlane);
	const runId = await triggerRun(
		controlPlane,
		await createScenario(controlPlane, "动作时间", scenarioUsing("agent-a")),
	);
	const task = await agent.nextAssign({ clock: reading() });
	clock.advance(10_000);
	const at = (ms: number) => ({ ...agent.stamp(t0 + ms), ts: t0 + ms + skew });
	agent.actions(task, [
		agent.actionStart(1, "保持", at(1_000), { fields: { 目标: "200 单/s" } }),
		agent.actionStart(2, "下单", at(2_000), { parent: 1, fields: { 订单: "P-0002" } }),
		agent.actionEnd(2, "success", at(2_030)),
		agent.actionMark(3, "首笔成交", at(3_000), { parent: 1 }),
		agent.actionStart(4, "下单", at(6_000), { parent: 1, fields: { 订单: "P-0004" } }),
		agent.actionEnd(4, "failed", at(6_040), { reason: "拒单：余额不足" }),
	]);
	const ended = (
		id: number,
		from: number,
		took: number,
		result: "success" | "failed",
		reason: string | null,
	) => {
		const begin = at(from);
		const end = at(from + took);
		return {
			id,
			parent: 1,
			depth: 1,
			name: "下单",
			fields: { 订单: `P-000${id}` },
			...begin,
			end_ts: end.ts,
			end_mono: end.mono,
			result,
			reason,
		} as const;
	};
	const failed = ended(4, 6_000, 40, "failed", "拒单：余额不足");
	agent.actionSummary(task, {
		total: 4,
		marks: 1,
		reported: 4,
		names: [
			{ name: "保持", total: 1, failed: 0, reported: 1, capped_ts: null, capped_mono: null },
			{ name: "下单", total: 2, failed: 1, reported: 2, capped_ts: null, capped_mono: null },
			{ name: "首笔成交", total: 1, failed: 0, reported: 1, capped_ts: null, capped_mono: null },
		],
		running: [
			{ id: 1, parent: null, depth: 0, name: "保持", fields: { 目标: "200 单/s" }, ...at(1_000) },
		],
		recent: [failed, ended(2, 2_000, 30, "success", null)],
		recent_failed: [failed],
	});
	agent.logs(task, [
		logAt(agent, t0 + 2_300, 1, "下单 P-0002 已发出", skew),
		logAt(agent, t0 + 9_000, 2, "继续保持", skew),
	]);
	await agent.sync();
	return { runId, agent, task, t0, skew };
}

const rowTime = (page: Page, id: number): Locator =>
	actionTable(page).locator(`tr[data-action-id="${id}"] button[data-locate]`);

test("切到 Agent 时间：开始一列显示 Agent 时间，表头写明时钟偏差；时间线始终按控制面时间画；选择刷新后保持", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, t0 } = await pingWithActions({ controlPlane, connectAgent, clock }, AHEAD_MS);
	await openMonitor(page, clock, runId, "ping", "actions");
	const table = actionTable(page);
	const header = table.getByRole("columnheader").first();
	const times = panel(page).getByRole("group", { name: "表格里的时间" });

	// 默认是控制面时间，表头只写「开始」。
	await expect(times.getByRole("button", { name: "控制面时间" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(header).toHaveText("开始");
	await expect(rowTime(page, 2)).toHaveText(clockMs(t0 + 2_000));
	await expect(rowTime(page, 3)).toHaveText(clockMs(t0 + 3_000));

	await times.getByRole("button", { name: "Agent 时间" }).click();
	await expect(times.getByRole("button", { name: "Agent 时间" })).toBeFocused();
	await expect(rowTime(page, 2)).toHaveText(clockMs(t0 + 2_000 + AHEAD_MS));
	await expect(rowTime(page, 3)).toHaveText(clockMs(t0 + 3_000 + AHEAD_MS));
	// 表头写明 Agent 时间，和这次尝试开始时的时钟偏差（还在执行，只有开始的）。
	await expect(header).toHaveText("开始（Agent 时间）时钟偏差：开始时比控制面快 3 小时");
	// 跳到日志用的是控制面时间，和这一列显示哪种时间无关。
	await expect(rowTime(page, 2)).toHaveAccessibleName(
		`在日志里跳到 ${clockMs(t0 + 2_000 + AHEAD_MS)}`,
	);
	// 时间线不跟着切：它画的是控制面时间（刻度和执行段位置都不变）。
	const timeline = page.getByRole("region", { name: "链路时间线" });
	const segment = timeline.locator('[data-node-row="ping"] [data-segment]').first();
	const before = await segment.boundingBox();
	expect(before).not.toBeNull();
	await times.getByRole("button", { name: "控制面时间" }).click();
	await expect(header).toHaveText("开始");
	expect(await segment.boundingBox()).toEqual(before);
	await times.getByRole("button", { name: "Agent 时间" }).click();
	await expect(header).toHaveText("开始（Agent 时间）时钟偏差：开始时比控制面快 3 小时");
	expect(await segment.boundingBox()).toEqual(before);

	await page.reload();
	await expect(
		panel(page)
			.getByRole("group", { name: "表格里的时间" })
			.getByRole("button", { name: "Agent 时间" }),
	).toHaveAttribute("aria-pressed", "true");
	await expect(rowTime(page, 2)).toHaveText(clockMs(t0 + 2_000 + AHEAD_MS));
	// 日志的时间有自己的选择，不受这里影响（日志默认也是 Agent 时间，不用切）。
	await tab(page, "日志").click();
	await expect(
		panel(page)
			.getByRole("group", { name: "日志时间" })
			.getByRole("button", { name: "Agent 时间" }),
	).toHaveAttribute("aria-pressed", "true");
});

test("显示 Agent 时间时只计数的一行写 Agent 时间的起点和「起」；Agent 时间带日期的规则同日志", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	// 偏差 613 天：Agent 时间不在运行开始那天，整列带日期。
	const days = 613 * 86_400_000;
	const { runId, t0 } = await pingWithActions({ controlPlane, connectAgent, clock }, days);
	await openMonitor(page, clock, runId, "ping", "actions");
	await panel(page)
		.getByRole("group", { name: "表格里的时间" })
		.getByRole("button", { name: "Agent 时间" })
		.click();
	await expect(rowTime(page, 2)).toHaveText(
		new Date(t0 + 2_000 + days + 8 * 3600_000).toISOString().slice(0, 23).replace("T", " "),
	);
	await expect(actionTable(page).getByRole("columnheader").first()).toHaveText(
		"开始（Agent 时间）时钟偏差：开始时比控制面快 613 天",
	);
});

test("点开始时间跳到日志：正好有那一行（1 秒以内）就高亮它，没有就在那一刻插一条「这一刻」；焦点交给日志页签", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, t0 } = await pingWithActions({ controlPlane, connectAgent, clock }, AHEAD_MS);
	await openMonitor(page, clock, runId, "ping", "actions");
	const logs = panel(page).getByRole("log", { name: "日志" });

	// 第 2 秒的「下单」：第一行日志在它后面 0.3 秒，算正好有这一行。
	await rowTime(page, 2).click();
	await expect(tab(page, "日志")).toHaveAttribute("aria-selected", "true");
	await expect(tab(page, "日志")).toBeFocused();
	const located = logs.locator("[data-located]");
	await expect(located).toHaveCount(1);
	await expect(located).toContainText("下单 P-0002 已发出");
	await expect(logs.locator("[data-moment]")).toHaveCount(0);

	// 回到动作页，点第 6 秒失败的「下单」：前后的日志离它都远，在它的位置插「这一刻」，不高亮别的行。
	await tab(page, /^动作/).click();
	await rowTime(page, 4).click();
	const moment = logs.locator("[data-moment]");
	await expect(moment).toHaveCount(1);
	await expect(moment).toHaveText(`这一刻 控制面时间 ${clockMs(t0 + 6_000)}`);
	await expect(logs.locator("[data-located]")).toHaveCount(0);
	await expect(logs.locator("[data-index]")).toContainText([
		"下单 P-0002 已发出",
		"这一刻",
		"继续保持",
	]);
	// 前后的日志照常能看。
	await expect(logs).toContainText("继续保持");
});

test("显示 Agent 时间时点开始时间，跳到的仍是控制面时间的那一刻：标记也能点", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await pingWithActions({ controlPlane, connectAgent, clock }, AHEAD_MS);
	await openMonitor(page, clock, runId, "ping", "actions");
	await panel(page)
		.getByRole("group", { name: "表格里的时间" })
		.getByRole("button", { name: "Agent 时间" })
		.click();
	const logs = panel(page).getByRole("log", { name: "日志" });
	// 第 3 秒的标记「首笔成交」：第一行日志在它前面 0.7 秒，算正好有这一行。按 Agent 时间去找（快 3 小时）就找不到。
	await rowTime(page, 3).click();
	await expect(logs.locator("[data-located]")).toContainText("下单 P-0002 已发出");
	await expect(logs.locator("[data-moment]")).toHaveCount(0);
});

test("筛选条件记在底部面板里：跳到日志再回到「动作」页还在", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await pingWithActions({ controlPlane, connectAgent, clock }, 0);
	await openMonitor(page, clock, runId, "ping", "actions");
	await failedToggle(page).click();
	await expectAnnounced(page, "筛选后 1 个动作");
	await expect.poll(() => groupRows(actionTable(page), "recent")).toEqual(["4"]);

	await rowTime(page, 4).click();
	await expect(tab(page, "日志")).toHaveAttribute("aria-selected", "true");
	await tab(page, /^动作/).click();
	await expect(failedToggle(page)).toHaveAttribute("aria-pressed", "true");
	await expect.poll(() => groupRows(actionTable(page), "recent")).toEqual(["4"]);
});
