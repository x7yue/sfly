import type { Page } from "@playwright/test";
import {
	actionsScenario,
	actionsSummary,
	actionTable,
	groupRows,
	RECONNECT,
} from "./actions-support";
import { expect, test } from "./fixtures";
import { openMonitor } from "./monitor-scenario";
import { failApi } from "./support";

// 运行监控「详情」底部面板的「动作」页（规格 #345，#357）：页签上的个数、跟着范围和尝试换、三组表格、
// 往下滚动读更早的明细、只计数的一段、推送来的明细。

const panel = (page: Page) => page.getByRole("region", { name: "底部面板" });
const timeline = (page: Page) => page.getByRole("region", { name: "链路时间线" });
const nodeButton = (page: Page, id: string) =>
	timeline(page).locator(`[data-node-row="${id}"] button`);
const tabOf = (page: Page) => panel(page).getByRole("tab", { name: /^动作/ });

test("页签上写出动作的个数（标记不算）；表格分三组，各组从新到旧，前两组的动作不在「更早的明细」里重复", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await actionsScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId, "verify", "actions");
	// 「下单」1200 个加上四个正在做的子动作和「保持 4 小时」，标记不算。
	await expect(tabOf(page)).toHaveAccessibleName("动作，共 1,204 个");
	await expect(tabOf(page)).toHaveText("动作1204");
	const table = actionTable(page);
	await expect(
		table.getByRole("table", { name: "verify 的动作，按开始时间从新到旧" }),
	).toBeVisible();
	await expect(table.locator('th[scope="rowgroup"]').first()).toHaveText("正在做");

	await expect
		.poll(() => groupRows(table, "running"))
		.toEqual(["1204", "1203", "1202", "1201", "1"]);
	const running = table.locator('tbody[data-group="running"] tr[data-action-id="1"]');
	await expect(running).toContainText("保持 4 小时");
	await expect(running).toContainText("目标=200 单/s");
	await expect(running).toContainText("5.0s");
	await expect(running).toContainText("进行中");

	await table.evaluate((el) => {
		el.scrollTop = 400;
	});
	await expect(table.locator('th[scope="rowgroup"]', { hasText: "最近 20 个" })).toContainText(
		"超过上限后也一直更新",
	);
	await expect
		.poll(() => groupRows(table, "recent"))
		.toEqual(Array.from({ length: 20 }, (_, i) => String(1200 - i)));
	const failedRecent = table.locator('tbody[data-group="recent"] tr[data-action-id="1190"]');
	await expect(failedRecent).toHaveAttribute("data-result", "failed");
	await expect(failedRecent).toContainText("超时：撮合网关 3 秒没有回报");

	await table.evaluate((el) => {
		el.scrollTop = 800;
	});
	await expect
		.poll(async () => (await groupRows(table, "earlier")).slice(0, 5))
		.toEqual(["1180", "1150", "1100", "~下单", "402"]);
	// 1 在「正在做」、1190 在「最近 20 个」里：不再出现在「更早的明细」里。
	await expect(table.locator('tbody[data-group="earlier"] tr[data-action-id="1"]')).toHaveCount(0);
	await expect(table.locator('tbody[data-group="earlier"] tr[data-action-id="1190"]')).toHaveCount(
		0,
	);
});

test("失败带完整的原因；子动作按层级缩进，最多 3 层；只计数的一段写明时间段、个数和原因", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await actionsScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId, "verify", "actions");
	const table = actionTable(page);
	const name = (id: number) => table.locator(`tr[data-action-id="${id}"] td:nth-child(2) > span`);
	await expect(name(1)).toHaveCSS("padding-left", "12px");
	await expect(name(1201)).toHaveCSS("padding-left", "28px");
	await expect(name(1203)).toHaveCSS("padding-left", "60px");
	// 第 4 层画在第 3 层。
	await expect(name(1204)).toHaveCSS("padding-left", "60px");

	await table.evaluate((el) => {
		el.scrollTop = 800;
	});
	const late = table.locator('tr[data-action-id="1180"]');
	await expect(late).toHaveAttribute("data-result", "failed");
	await expect(late).toContainText(
		"拒单：余额不足（可用 1,203.55，需要 9,800.00）；撮合网关返回 REJECT_BALANCE，这一笔不再重试，等下一轮行情",
	);
	// 原因换行，不截断：这一行比只有一行字的行高。
	const height = async (id: string) =>
		(await table.locator(`tr[data-action-id="${id}"]`).boundingBox())?.height ?? 0;
	await expect
		.poll(async () => Math.min(await height("1180"), await height("1150")) - (await height("402")))
		.toBeGreaterThan(0);

	// 「下单」从 08:00:10.5 起只计数：1200 个里有明细的 404 个（只计数以前的 400 个和之后失败的 4 个）。
	await expect(table.locator('tr[data-count-only="下单"]')).toHaveText(
		"08:00:10 至今的 796 个「下单」只计数，没有明细（每种名称最多记录 5 万个，失败的动作仍有明细）",
	);
});

test("往下滚动读更早的明细；一次只渲染看得见的那些行", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await actionsScenario(controlPlane, connectAgent, clock);
	const pages: string[] = [];
	page.on("request", (r) => {
		const url = new URL(r.url());
		if (/\/api\/tasks\/[^/]+\/actions$/.test(url.pathname))
			pages.push(url.searchParams.get("before") ? "older" : "latest");
	});
	await openMonitor(page, clock, runId, "verify", "actions");
	const table = actionTable(page);
	await expect(table.locator("tr[data-action-id]").first()).toBeVisible();
	const oldest = table.locator('tr[data-action-id="2"]');
	await expect(oldest).toHaveCount(0);
	await expect
		.poll(
			async () => {
				await table.evaluate((el) => {
					el.scrollTop = el.scrollHeight;
				});
				return oldest.count();
			},
			{ timeout: 10_000 },
		)
		.toBe(1);
	// 406 条明细分三页读完（每页 200 条）。
	await expect.poll(() => pages).toEqual(["latest", "older", "older"]);
	await expect(table.getByRole("button", { name: "向下滚动或点击加载更早的明细" })).toHaveCount(0);
	// 最早的是标记：小旗、没有耗时、结果写「标记」。
	await expect(oldest).toHaveAttribute("data-result", "mark");
	await expect(oldest).toContainText("收到第一笔成交");
	await expect(oldest.locator("td").nth(3)).toHaveText("—");
	await expect(oldest.locator("td").nth(4)).toHaveText("标记");
	await expect(table.locator('tr[data-action-id="3"]')).toContainText("订单=P-0003 方向=卖");
	// 明细有四百多条，渲染出来的只是视口附近的那些。
	await expect.poll(() => table.locator("tr[data-action-id]").count()).toBeLessThan(80);
});

test("推送来的明细插到它开始的位置，同一个 ID 以后到的为准；页签上的个数跟着摘要变", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, verify, times } = await actionsScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId, "verify", "actions");
	const table = actionTable(page);
	await expect(table.locator("tr[data-action-id]").first()).toBeVisible();
	await table.evaluate((el) => {
		el.scrollTop = 800;
	});
	await expect.poll(async () => (await groupRows(table, "earlier"))[0]).toBe("1180");

	// 「重连撮合网关」在 1180 和 1150 之间开始：先只送到开始，再送到结束。
	const at = times.start + RECONNECT.at;
	agent.actions(verify, [agent.actionStart(RECONNECT.id, RECONNECT.name, at, { parent: 1 })]);
	await agent.sync();
	const row = table.locator(`tr[data-action-id="${RECONNECT.id}"]`);
	await expect(row).toHaveAttribute("data-result", "running");
	await expect
		.poll(async () => (await groupRows(table, "earlier")).slice(0, 3))
		.toEqual(["1180", "1171", "1150"]);

	agent.actions(verify, [agent.actionEnd(RECONNECT.id, "success", at + RECONNECT.took)]);
	agent.actionSummary(verify, actionsSummary(agent, times, true));
	await agent.sync();
	await expect(row).toHaveAttribute("data-result", "success");
	await expect(row).toContainText("300ms");
	await expect(row).toContainText("成功");
	await expect(table.locator(`tr[data-action-id="${RECONNECT.id}"]`)).toHaveCount(1);
	await expect(tabOf(page)).toHaveAccessibleName("动作，共 1,205 个");
});

test("范围和尝试沿用底部面板的切换；没有动作的节点写明标准节点这一轮不记录动作；没选节点时请人先选一个", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await actionsScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId, "verify", "actions");
	const bp = panel(page);
	await expect(actionTable(page)).toBeVisible();

	// verify 第 1 次失败了，没有记录动作。
	await bp.getByRole("group", { name: "尝试" }).getByRole("button", { name: "第 1 次" }).click();
	const empty = bp.getByRole("region", { name: "verify 没有记录动作" });
	await expect(empty).toContainText("标准节点这一轮不记录动作");
	await expect(tabOf(page)).toHaveAccessibleName("动作");
	await bp.getByRole("group", { name: "尝试" }).getByRole("button", { name: "第 2 次" }).click();
	await expect(actionTable(page)).toBeVisible();
	await expect(tabOf(page)).toHaveAccessibleName("动作，共 1,204 个");

	// 换一个节点：probe 还在执行，还没有记录动作。
	await nodeButton(page, "probe").click();
	await expect(bp.getByRole("region", { name: "probe 还没有记录动作" })).toBeVisible();
	await expect(tabOf(page)).toHaveAccessibleName("动作");

	// 不选节点：动作是按任务记的，先选一个节点。
	await bp.getByRole("button", { name: /^清除范围/ }).click();
	await expect(bp.getByText("在时间线上选中一个节点，查看它的动作。")).toBeVisible();
	await nodeButton(page, "verify").click();
	await expect(actionTable(page)).toBeVisible();
});

test("摘要读不到时写「无法加载动作」和错误详情，重试后显示表格", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, verify } = await actionsScenario(controlPlane, connectAgent, clock);
	const path = `/tasks/${verify.taskId}/actions`;
	// 推送连上时也会先发一份摘要：推送也连不上，摘要才只能从接口读。
	await failApi(page, `${path}/events**`);
	const summary = await failApi(page, `${path}/summary`);
	await openMonitor(page, clock, runId, "verify", "actions");
	const error = panel(page).getByRole("alert");
	await expect(error).toContainText("无法加载动作");
	await expect(error).toContainText(`GET /api${path}/summary → 503 unavailable`);

	await summary.restore();
	await error.getByRole("button", { name: "重试" }).click();
	await expect(actionTable(page).locator('tr[data-action-id="1204"]')).toBeVisible();
	await expect(error).toBeHidden();
});

test("1280×800：拖高底部面板以后能看到动作表", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	const { runId } = await actionsScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId, "verify", "actions");
	const table = actionTable(page);
	await expect(table.locator('tr[data-action-id="1204"]')).toBeVisible();
	const handle = page.getByRole("separator", { name: "调整底部面板高度" });
	const before = Number(await handle.getAttribute("aria-valuenow"));
	const b = await handle.boundingBox();
	if (!b) throw new Error("没有拖动条");
	await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
	await page.mouse.down();
	await page.mouse.move(b.x + b.width / 2, b.y - 200, { steps: 4 });
	await page.mouse.up();
	await expect
		.poll(async () => Number(await handle.getAttribute("aria-valuenow")))
		.toBeGreaterThan(before + 150);
	await expect(table.getByRole("columnheader", { name: "开始" })).toBeInViewport();
	await expect(table.locator('th[scope="rowgroup"]').first()).toBeInViewport();
	await expect(table.locator('tr[data-action-id="1204"]')).toBeInViewport();
});
