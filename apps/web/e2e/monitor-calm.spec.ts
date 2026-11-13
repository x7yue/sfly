import type { Page } from "@playwright/test";
import { type AssignedTask, ErrorKind } from "../../server/test/support/fake-agent.js";
import { expect, test } from "./fixtures";
import { openMonitor, runningScenario } from "./monitor-scenario";
import { advance } from "./run-records";

const timeline = (page: Page) => page.getByRole("region", { name: "链路时间线" });
const panel = (page: Page) => page.getByRole("region", { name: "底部面板" });
const header = (page: Page) => page.getByRole("banner");

/** 时间线主体（刻度行吸顶，它的父元素就是滚动的主体）。 */
const body = (page: Page) => timeline(page).locator("[data-axis-track]").locator("xpath=../..");

/** 区段在它所在行的轨道上的位置（占轨道宽度的比例）。 */
async function segmentLeft(page: Page, nodeId: string, kind: string) {
	const row = timeline(page).locator(`[data-node-row="${nodeId}"]`);
	const track = await row.locator("> div").boundingBox();
	const segment = await row.locator(`[data-segment="${kind}"]`).boundingBox();
	if (!track || !segment) throw new Error("没有轨道或区段");
	return (segment.x - track.x) / track.width;
}

const pulses = (page: Page) =>
	page.evaluate(
		() =>
			document
				.getAnimations()
				.filter((a) => a instanceof CSSAnimation && a.animationName === "status-pulse").length,
	);

test("运行中时间轴不随「现在」每秒压缩：右端留余量，只在「现在」越过余量时扩轴一次", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	const tl = timeline(page);
	const elapsed = header(page).getByTestId("run-elapsed");
	await expect(elapsed).toHaveText("已运行 14.0s");

	// 14 秒的运行取 20 秒的轴：verify 第 2 次从第 9 秒起，「现在」线在 70%。
	const before = await segmentLeft(page, "verify", "run");
	expect(before).toBeCloseTo(9 / 20, 2);
	const ticksBefore = await tl.locator("[data-axis-track] span").allTextContents();
	await expect(tl.locator("[data-now-line]")).toHaveAttribute("style", /left: 70%/);

	await advance(clock, agent, 2_000);
	await expect(elapsed).toHaveText("已运行 16.0s");
	await expect(tl.locator("[data-now-line]")).toHaveAttribute("style", /left: 80%/);
	expect(await segmentLeft(page, "verify", "run")).toBeCloseTo(before, 3);
	expect(await tl.locator("[data-axis-track] span").allTextContents()).toEqual(ticksBefore);

	// 越过余量（17 秒 × 1.2 > 20 秒）：扩到 30 秒，区段与刻度一次到位。
	await advance(clock, agent, 1_000);
	await expect(elapsed).toHaveText("已运行 17.0s");
	await expect.poll(() => segmentLeft(page, "verify", "run")).toBeCloseTo(9 / 30, 2);
	expect(await tl.locator("[data-axis-track] span").allTextContents()).not.toEqual(ticksBefore);
});

test("脉冲：同屏每个执行中的对象只在前沿脉冲一处；「暂停动效」停掉它们，刷新后仍然暂停", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	const tl = timeline(page);

	// 执行中的节点两个（verify、probe）：各自一个段尾脉冲头，加顶栏运行状态标签这一处整体脉冲。
	await expect(tl.locator("[data-pulse-head]")).toHaveCount(4);
	await expect.poll(() => pulses(page)).toBe(3);
	// 汇总（收起）模式下链汇总行才是它们唯一的位置：每个执行中的节点还是只有一处。
	await page.keyboard.press("t");
	await expect.poll(() => pulses(page)).toBe(3);
	await page.keyboard.press("t");

	const pause = header(page).getByRole("button", { name: "暂停动效" });
	await expect(pause).toHaveAttribute("aria-pressed", "false");
	await pause.click();
	await expect(pause).toHaveAttribute("aria-pressed", "true");
	await expect.poll(() => pulses(page)).toBe(0);
	// 停的只是脉冲：执行中的形状还在。
	await expect(tl.locator("[data-pulse-head]")).toHaveCount(4);
	await expect(header(page).getByTestId("run-status").locator("[data-status-dot]")).toBeVisible();

	await page.reload();
	await expect(header(page).getByRole("button", { name: "暂停动效" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect.poll(() => pulses(page)).toBe(0);

	await header(page).getByRole("button", { name: "暂停动效" }).click();
	await expect.poll(() => pulses(page)).toBe(3);
});

test("笔记本屏上时间线的行全部露出，不把执行中的节点藏到折叠线下面；窗口很矮时把它滚进来", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await page.setViewportSize({ width: 1024, height: 768 });
	await openMonitor(page, clock, runId);
	const main = body(page);
	// 9 行（2 条链、7 个节点）：主体的高度够放下全部行，没有滚动。
	await expect(timeline(page).locator("[data-chain-row], [data-node-row]")).toHaveCount(9);
	expect(await main.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
	await expect(timeline(page).locator('[data-node-row="probe"]')).toBeInViewport();

	// 窗口矮到放不下全部行：第一个执行中的节点（verify）自动滚进可视范围。
	await page.setViewportSize({ width: 1024, height: 300 });
	await page.reload();
	await expect(timeline(page)).toBeVisible();
	await expect
		.poll(async () =>
			main.evaluate((el) => {
				const row = el.querySelector('[data-node-row="verify"]')?.getBoundingClientRect();
				const box = el.getBoundingClientRect();
				return !!row && row.top >= box.top - 1 && row.bottom <= box.bottom + 1;
			}),
		)
		.toBe(true);
});

test("时间线的标签列随宽度伸缩，轨道的左端对齐", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	const labelWidth = async () =>
		page.evaluate(() =>
			Math.round(
				(document.querySelector("[data-axis-track]") as HTMLElement).getBoundingClientRect().left,
			),
		);
	await page.setViewportSize({ width: 1024, height: 768 });
	await openMonitor(page, clock, runId);
	const narrow = await labelWidth();
	// 最窄时标签列也放得下：行里的内容（链名、耗时）不溢出到轨道上。
	const overflowing = await timeline(page)
		.locator("[data-chain-row] > button, [data-node-row] > button")
		.evaluateAll((els) =>
			els.filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.textContent),
		);
	expect(overflowing).toEqual([]);
	await page.setViewportSize({ width: 1920, height: 1080 });
	await expect.poll(labelWidth).toBeGreaterThan(narrow + 60);
	const lefts = await timeline(page)
		.locator("[data-axis-track], [data-node-row] > div, [data-chain-row] > div:last-child")
		.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
	expect(new Set(lefts).size).toBe(1);
});

test("缩放不只能拖选：放大、缩小、缩放到所选节点都可以用键盘操作；拖选到一半按 Esc 放弃", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	const tl = timeline(page);
	const zoomRange = tl.getByTestId("zoom-range");
	await expect(tl.getByText("实时跟随")).toBeVisible();

	// 放大：以当前范围（0–20 秒）的中点为中心取一半，即 08:00:05 – 08:00:15。
	const zoomIn = tl.getByRole("button", { name: "放大时间范围" });
	await zoomIn.focus();
	await page.keyboard.press("Enter");
	await expect(zoomRange).toHaveText("08:00:05 – 08:00:15");
	await expect(tl.getByText("实时跟随")).toHaveCount(0);
	// 再放大一次：08:00:07.5 取整到秒显示。
	await page.keyboard.press("Enter");
	await expect(zoomRange).toBeVisible();
	const zoomOut = tl.getByRole("button", { name: "缩小时间范围" });
	await zoomOut.click();
	await zoomOut.click();
	await expect(zoomRange).toHaveCount(0);
	await expect(tl.getByText("实时跟随")).toBeVisible();
	await expect(zoomOut).toBeDisabled();

	// verify 两次尝试都在范围里，缩放范围比整个运行窄。
	await tl.locator('[data-node-row="verify"] button').click();
	await tl.getByRole("button", { name: "缩放到所选节点 verify" }).click();
	await expect(zoomRange).toBeVisible();
	await tl.getByRole("button", { name: "回到实时" }).click();
	await expect(zoomRange).toHaveCount(0);

	// 同一件事也有快捷键 Z（运行监控分组、命令面板）：选中节点时才绑定。
	await expect(tl.getByRole("button", { name: "缩放到所选节点 verify" })).toHaveAttribute(
		"title",
		"缩放到所选节点 verify（Z）",
	);
	await page.keyboard.press("z");
	await expect(zoomRange).toBeVisible();
	await page.keyboard.press("l");
	await expect(zoomRange).toHaveCount(0);
	await page.keyboard.press("Control+k");
	const palette = page.getByRole("dialog", { name: "命令面板" });
	await expect(
		palette
			.getByRole("group", { name: "当前页面" })
			.getByRole("option", { name: /缩放到所选节点/ }),
	).toHaveText(/Z$/);
	await page.keyboard.press("Escape");
	await expect(palette).toBeHidden();

	// Esc 只放弃拖选，不清除选中的节点。
	const track = await tl.locator('[data-node-row="fetch"] > div').boundingBox();
	if (!track) throw new Error("没有轨道");
	const y = track.y + track.height / 2;
	await page.mouse.move(track.x + track.width * 0.1, y);
	await page.mouse.down();
	await page.mouse.move(track.x + track.width * 0.5, y, { steps: 5 });
	await expect(tl.locator("[data-brush]")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(tl.locator("[data-brush]")).toHaveCount(0);
	await page.mouse.up();
	await expect(zoomRange).toHaveCount(0);
	await expect(tl.locator('[data-node-row="verify"] button')).toHaveAttribute(
		"aria-pressed",
		"true",
	);
});

test("日志列表是一个 Tab 停靠点：↑ ↓ 逐行移动，Home / End 到首尾，Tab 离开列表", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId, "fetch");
	const logs = panel(page).getByRole("log", { name: "日志" });
	const rows = logs.getByRole("button");
	await expect(rows).toHaveCount(4);
	await expect(logs.locator('[role="button"][tabindex="0"]')).toHaveCount(1);

	// 从面板头部的最后一个按钮 Tab 进来：落在停靠点（视口里第一行），不是 4 行里的每一行各停一次。
	await panel(page).getByRole("button", { name: "收起" }).focus();
	await page.keyboard.press("Tab");
	await expect(rows.nth(0)).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(rows.nth(1)).toBeFocused();
	await page.keyboard.press("End");
	await expect(rows.nth(3)).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(rows.nth(3)).toBeFocused();
	await page.keyboard.press("Home");
	await expect(rows.nth(0)).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(logs.locator('[role="button"][tabindex="0"]')).toHaveText(/load config ok/);
	await page.keyboard.press("Tab");
	await expect(logs.locator(":focus")).toHaveCount(0);
	await panel(page).getByRole("button", { name: "收起" }).focus();
	await page.keyboard.press("Tab");
	await expect(rows.nth(1)).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(rows.nth(1)).toHaveAttribute("data-marked", "true");
});

test("底部面板的页签是一个 Tab 停靠点：← → 在页签之间移动，Enter 切换", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	const tabs = panel(page).getByRole("tablist", { name: "底部面板" });
	const logsTab = tabs.getByRole("tab", { name: "日志" });
	await expect(logsTab).toHaveAttribute("aria-selected", "true");
	await expect(tabs.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);

	await logsTab.focus();
	await page.keyboard.press("ArrowRight");
	await expect(tabs.getByRole("tab", { name: "尝试" })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(tabs.getByRole("tab", { name: "尝试" })).toHaveAttribute("aria-selected", "true");
	await page.keyboard.press("End");
	await expect(tabs.getByRole("tab", { name: "产物" })).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(tabs.getByRole("tab", { name: "日志" })).toBeFocused();
	await expect(panel(page).getByRole("tabpanel")).toHaveAccessibleName("尝试");
});

test("运行失败不弹通知：页内横幅留在时间线上方，状态一直在顶栏", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	await expect(header(page).getByTestId("run-status")).toHaveText("运行中");
	await expect(page.getByRole("region", { name: "运行失败" })).toHaveCount(0);

	await agent.fail(tasks.probe as AssignedTask, "TimeoutError: probe 超时", ErrorKind.NODE_ERROR);
	await agent.fail(tasks.verify as AssignedTask, "AssertionError: 仍然漏拦", ErrorKind.NODE_ERROR);
	const cleanup = await agent.nextAssign();
	clock.advance(1000);
	await agent.succeed(cleanup);

	await expect(header(page).getByTestId("run-status")).toHaveText("失败");
	const banner = page.getByRole("region", { name: "运行失败" });
	await expect(banner).toBeVisible();
	await expect(banner).toContainText("失败于 verify（第 2 次）· AssertionError: 仍然漏拦");
	const top = await header(page).boundingBox();
	const bar = await banner.boundingBox();
	const tl = await timeline(page).boundingBox();
	if (!top || !bar || !tl) throw new Error("没有位置");
	expect(bar.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
	expect(bar.y + bar.height).toBeLessThanOrEqual(tl.y + 1);
	// 没有通知（不会盖在上面，也不会读两遍）。
	await page.waitForTimeout(500);
	await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

test("取消弹窗：影响列表在弹窗主体里，节点 ID 用等宽字体、说明用正文字体", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	await header(page).getByRole("button", { name: "取消运行" }).click();
	const dialog = page.getByRole("dialog", { name: /取消运行/ });
	const body = dialog.locator('[data-slot="dialog-body"]');
	await expect(body.getByRole("list", { name: "取消的影响" })).toBeVisible();

	const graceful = body.getByRole("listitem").filter({ hasText: "先优雅终止" });
	const family = (locator: typeof graceful) =>
		locator.evaluate((el) => getComputedStyle(el).fontFamily);
	const ids = graceful.locator(".font-mono");
	await expect(ids).toHaveText("verify、probe");
	const note = graceful.getByText("宽限期过后强制杀掉整棵进程树");
	await expect(note).toBeVisible();
	expect(await family(note)).not.toBe(await family(ids));
});
