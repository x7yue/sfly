import type { Page } from "@playwright/test";
import { actionTable } from "./actions-support";
import { expect, test } from "./fixtures";
import { openMonitor } from "./monitor-scenario";
import {
	brush,
	FAILED,
	nodeRow,
	timeline,
	timelineBody,
	tracksOf,
	tracksScenario,
} from "./timeline-tracks-support";

// 运行监控「详情」时间线上的动作轨道（规格 #345，#359）：有动作的节点下面多「动作」「子动作」两条轨道，
// 全程看时太密的画成密度带，放大后一个个画出来；范围里的节点用白色短条标出，打开和换范围时滚到它。

const panel = (page: Page) => page.getByRole("region", { name: "底部面板" });

test("有动作的节点下面多两条轨道，随链一起收起；可访问名称概括轨道、指向下方的动作表", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await tracksScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	const tracks = tracksOf(page, "verify");
	await expect(tracks).toHaveAccessibleName(
		new RegExp(
			`^verify 的动作轨道：正在做「保持 4 小时」；「下单」从 \\d\\d:\\d\\d:\\d\\d 起只计数；${FAILED} 个失败的动作；` +
				"少见的动作「重连撮合网关」；1 个标记。逐个查看见下方动作表$",
		),
	);
	await expect(tracks).toHaveRole("img");
	await expect(tracks.locator('[data-track="top"]')).toContainText("动作");
	await expect(tracks.locator('[data-track="child"]')).toContainText("└ 子动作");
	// 只有 verify 记录了动作：fetch、probe 下面没有轨道。
	await expect(timeline(page).locator("[data-action-tracks]")).toHaveCount(1);

	const top = tracks.locator('[data-track="top"]');
	const child = tracks.locator('[data-track="child"]');
	// 最外层三个动作一条条画出来，进行中的「保持 4 小时」写着名字。
	await expect(top.locator("[data-track-item]")).toHaveCount(3);
	await expect(top).toContainText("保持 4 小时");
	// 全程：每 5ms 一个的「下单」太密，画成密度带；第 3.5 秒起只计数，画成斜线；失败的是红色短线，「重连撮合网关」
	// 是白色短线，标记是小旗。
	await expect(child.locator("[data-band]").first()).toBeVisible();
	await expect(child.locator("[data-count-only]")).toHaveCount(1);
	await expect(child.locator('[data-tone="failed"]')).toHaveCount(FAILED);
	await expect(child.locator('[data-tone="rare"]')).toHaveCount(1);
	await expect(child.locator("svg[data-track-item]")).toHaveCount(1);

	// 收起主链：verify 那一行和它的轨道一起收起；汇总模式也一样。
	const main = timeline(page).locator("[data-chain-row]").first().getByRole("button");
	await main.click();
	await expect(tracks).toHaveCount(0);
	await main.click();
	await expect(tracks).toBeVisible();
	await timeline(page).getByRole("button", { name: "汇总" }).click();
	await expect(tracks).toHaveCount(0);
	await timeline(page).getByRole("button", { name: "展开节点" }).click();
	await expect(tracks).toBeVisible();
});

test("放大以后分得开的一个个画出来，窗口外的不画", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await tracksScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	const child = tracksOf(page, "verify").locator('[data-track="child"]');
	await expect(child.locator("[data-band]").first()).toBeVisible();
	// 运行已经 14 秒，时间轴是 20 秒；verify 第 2 次在第 9 秒开始。拖选第 11.1 到 12.1 秒：它开始后的 2.1 到 3.1 秒。
	await brush(page, child, 0.555, 0.605);
	await expect(page.getByTestId("zoom-range")).toBeVisible();
	await expect(child.locator("[data-band]")).toHaveCount(0);
	// 每 5ms 一个，1 秒里 200 个左右，一个个画出来；窗口外的 400 多个不画。
	await expect.poll(() => child.locator('[data-tone="plain"]').count()).toBeGreaterThanOrEqual(190);
	expect(await child.locator('[data-tone="plain"]').count()).toBeLessThanOrEqual(205);
	// 最外层只有「保持 4 小时」在窗口里，裁到窗口的右端；结束在窗口以前的「预热」不画。
	const top = tracksOf(page, "verify").locator('[data-track="top"]');
	await expect(top.locator("[data-track-item]")).toHaveCount(1);
	await expect(top).toContainText("保持 4 小时");
});

test("打开时滚到地址里的节点并用白色短条标出；轨道晚到、版面变高以后仍然对准", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	const { runId } = await tracksScenario(controlPlane, connectAgent, clock);
	// 摘要晚 1 秒才到：页面先按没有轨道的版面滚到 probe，轨道出现后 verify 下面多出两行，把 probe 往下推。
	await page.route("**/api/tasks/*/actions/summary", async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		await route.continue();
	});
	await openMonitor(page, clock, runId, "probe");
	const probe = nodeRow(page, "probe");
	await expect(probe).toHaveAttribute("data-selected", "true");
	await expect(probe).toHaveCSS("box-shadow", /2px 0px 0px 0px inset/);
	await expect(probe).toBeInViewport({ ratio: 1 });
	await expect(tracksOf(page, "verify")).toBeVisible();
	await expect(probe).toBeInViewport({ ratio: 1 });
	await expect(nodeRow(page, "verify")).not.toHaveAttribute("data-selected");
});

test("在「动作」页换范围（切尝试）时，时间线滚回那个节点", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	const { runId } = await tracksScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId, "verify", "actions");
	await expect(actionTable(page)).toBeVisible();
	const verify = nodeRow(page, "verify");
	await expect(verify).toBeInViewport({ ratio: 1 });
	// 时间线调矮，再自己往下滚：verify 滚出了视野。
	const handle = page.getByRole("separator", { name: "调整时间线高度" });
	await handle.focus();
	for (let i = 0; i < 6; i++) await handle.press("ArrowUp");
	const body = await timelineBody(page).boundingBox();
	if (!body) throw new Error("没有时间线");
	await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2);
	await page.mouse.wheel(0, 400);
	await expect(verify).not.toBeInViewport();

	const attempts = panel(page).getByRole("group", { name: "尝试" });
	await attempts.getByRole("button", { name: "第 1 次" }).click();
	await expect(verify).toBeInViewport({ ratio: 1 });
	await expect(verify).toHaveAttribute("data-selected", "true");

	await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2);
	await page.mouse.wheel(0, 400);
	await expect(verify).not.toBeInViewport();
	await attempts.getByRole("button", { name: "第 2 次" }).click();
	await expect(verify).toBeInViewport({ ratio: 1 });
});

test("1280×800：版面分成几段，首屏就能看到动作表；收起时间线、拖高底部面板都不把面板挤出窗口", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	const { runId } = await tracksScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId, "verify", "actions");
	const table = actionTable(page);
	await expect(table.getByRole("columnheader", { name: "开始" })).toBeInViewport();
	await expect(table.locator("tr[data-action-id]").first()).toBeInViewport();
	// 时间线主体最高是视口的 30%（800 的 30% 是 240px），刻度吸在主体顶端。
	const body = await timelineBody(page).boundingBox();
	expect(body?.height).toBeLessThanOrEqual(240);

	const bp = panel(page);
	const bottom = async () => {
		const box = await bp.boundingBox();
		return box ? box.y + box.height : Number.POSITIVE_INFINITY;
	};
	const handle = page.getByRole("separator", { name: "调整底部面板高度" });
	const b = await handle.boundingBox();
	if (!b) throw new Error("没有拖动条");
	await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
	await page.mouse.down();
	await page.mouse.move(b.x + b.width / 2, b.y - 400, { steps: 6 });
	await page.mouse.up();
	await expect.poll(bottom).toBeLessThanOrEqual(800);
	await expect(table.locator("tr[data-action-id]").first()).toBeInViewport();

	// 收起时间线：只剩标题行，让出的高度给下面的图表和底部面板。
	const charts = page.getByRole("region", { name: "图表工作区" });
	const below = async () =>
		((await charts.boundingBox())?.height ?? 0) + ((await bp.boundingBox())?.height ?? 0);
	const belowBefore = await below();
	await timeline(page).getByRole("button", { name: "收起时间线" }).click();
	await expect(timelineBody(page)).toBeHidden();
	await expect(timeline(page).getByRole("button", { name: "展开时间线" })).toHaveAttribute(
		"aria-expanded",
		"false",
	);
	await expect.poll(below).toBeGreaterThan(belowBefore + 200);
	await expect.poll(bottom).toBeLessThanOrEqual(800);
	await timeline(page).getByRole("button", { name: "展开时间线" }).click();
	await expect(nodeRow(page, "verify")).toBeInViewport({ ratio: 1 });
});
