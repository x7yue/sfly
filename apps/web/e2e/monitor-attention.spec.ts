import type { Page } from "@playwright/test";
import { type AssignedTask, LogLevel } from "../../server/test/support/fake-agent.js";
import { expect, test } from "./fixtures";
import { setFocusItems } from "./focus-support";
import { advance, logLine, runningScenario } from "./monitor-scenario";
import {
	attention,
	focusChart,
	openOverview,
	overviewRun,
	probePoint,
	readouts,
	viewTab,
} from "./overview-support";

// 运行监控「概览」里关注项的异常（#351）：「需要注意」随手动时钟出现和撤下、直达按钮的落点、没有新数据的图表、
// 页头的「数据更新于」。异常由控制面按控制面时间判断，页面每 2 秒读一次。

const panel = (page: Page) => page.getByRole("region", { name: "底部面板" });
/** 「需要注意」里的每一行。 */
const rows = (page: Page) => attention(page).getByRole("listitem");
/** 地址的查询参数。 */
const search = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams);

test("「需要注意」只在有异常时出现：probe 打了 WARN 就列出它的两项，10 分钟后撤下；之后超过 6 倍采样间隔没有新数据又列出，有新点后撤下", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	test.setTimeout(60_000);
	const { runId, agent, tasks } = await overviewRun(controlPlane, connectAgent, clock);
	const probe = tasks.probe as AssignedTask;
	await openOverview(page, clock, runId);
	await expect(readouts(page).getByRole("button", { name: /^total 16/ })).toBeVisible();
	await expect(attention(page)).toHaveCount(0);

	// 第 14 秒（上海时间 08:00:14）probe 打了一条 WARN：它的两项关注项都列出来，排在读数和图表的最前面。
	agent.logs(probe, [logLine(clock, 1, "探活超时 3 次（阈值 2 次）", LogLevel.WARN)]);
	await agent.sync();
	await expect(rows(page)).toHaveCount(2);
	await expect(attention(page).getByRole("heading", { name: "需要注意" })).toBeVisible();
	await expect(rows(page).first()).toContainText("探活 level");
	await expect(rows(page).first()).toContainText(
		"probe 的 WARN（08:00:14）：探活超时 3 次（阈值 2 次）",
	);
	await expect(rows(page).nth(1)).toContainText("total");
	await expect(rows(page).first().getByRole("button")).toHaveText("在详情里看这条 WARN");
	const total = readouts(page).getByRole("button", {
		name: "total 16，来自 probe（执行中），需要注意：WARN · 08:00:14",
	});
	await expect(total).toContainText("WARN · 08:00:14");
	await expect(total.locator('[data-status-dot="warn"]')).toHaveCount(1);
	await expect(page.locator("[data-focus-chart] h3")).toHaveText([
		"探活 level",
		"下单延迟",
		"请求数",
		"清理 level",
	]);

	// probe 一直有新数据，WARN 过了 10 分钟：撤下，图表回到作者的顺序。
	await advance(clock, agent, 10 * 60_000 + 15_000, () => probePoint(agent, probe, clock));
	await expect(attention(page)).toHaveCount(0);
	await expect(page.locator("[data-focus-chart] h3")).toHaveText([
		"下单延迟",
		"探活 level",
		"请求数",
		"清理 level",
	]);

	// probe 不再上报：采样间隔是 15 秒，超过 90 秒没有新数据才算（进入和撤下的时刻由控制面测试逐毫秒验证）。
	await advance(clock, agent, 105_000);
	await expect(rows(page)).toHaveCount(2);
	await expect(rows(page).first()).toContainText(
		"probe 仍在执行，但最后一个点在 1m 45s 前，采样间隔 15s。可能是节点卡住了，或者 Agent 的指标上报中断了。",
	);
	await expect(rows(page).first().getByRole("button")).toHaveText("在详情里看 probe 的日志");

	probePoint(agent, probe, clock);
	await agent.sync();
	await expect(attention(page)).toHaveCount(0);
});

test("直达按钮：WARN 进详情，日志定位到那一行；没有新数据进详情，看那个节点的日志", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await overviewRun(controlPlane, connectAgent, clock);
	const probe = tasks.probe as AssignedTask;
	// 三行各差 100 毫秒（Agent 给每行带单调时钟读数），WARN 在中间。
	const now = clock.now().getTime();
	const line = (seq: number, text: string, level: LogLevel) => ({
		...logLine(clock, seq, text, level),
		monotonicMs: agent.monotonicAt(now - 300 + seq * 100),
	});
	agent.logs(probe, [
		line(1, "探活第 1 次", LogLevel.INFO),
		line(2, "探活超时 3 次（阈值 2 次）", LogLevel.WARN),
		line(3, "探活第 4 次", LogLevel.INFO),
	]);
	await agent.sync();
	const warnAt = new Date(now - 100).toISOString();
	await openOverview(page, clock, runId);

	await rows(page).first().getByRole("button", { name: "在详情里看这条 WARN" }).click();
	await expect(viewTab(page, "详情")).toHaveAttribute("aria-selected", "true");
	expect(search(page)).toEqual({ view: "detail", node: "probe", tab: "logs", at: warnAt });
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：probe");
	const located = panel(page).getByRole("log", { name: "日志" }).locator("[data-located]");
	await expect(located).toHaveCount(1);
	await expect(located).toContainText("探活超时 3 次（阈值 2 次）");

	// 回到概览；10 分钟后 WARN 撤下，再过 30 秒没有新数据（采样间隔 1 秒，按 30 秒判断）。
	await viewTab(page, "概览").click();
	await advance(clock, agent, 10 * 60_000 + 15_000);
	await expect(rows(page).first()).toContainText("probe 仍在执行，但最后一个点在");
	await rows(page).first().getByRole("button", { name: "在详情里看 probe 的日志" }).click();
	await expect(viewTab(page, "详情")).toHaveAttribute("aria-selected", "true");
	expect(search(page)).toEqual({ view: "detail", node: "probe", tab: "logs" });
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：probe");
	await expect(panel(page).getByRole("tab", { name: "日志" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(panel(page).getByRole("log", { name: "日志" })).toContainText("探活第 4 次");
});

test("「其他警告与错误」列出不在「需要注意」里的 WARN / ERROR，点一条进详情并定位到那一行；已经在「需要注意」里的不重复", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	test.setTimeout(60_000);
	const { runId, agent, tasks } = await overviewRun(controlPlane, connectAgent, clock);
	const probe = tasks.probe as AssignedTask;
	const others = page.getByRole("region", { name: "其他警告与错误" });
	// fetch 已经成功，它早先的 WARN 不会进「需要注意」，只在这里。
	await openOverview(page, clock, runId);
	await expect(attention(page)).toHaveCount(0);
	await expect(others.getByRole("listitem")).toHaveCount(1);
	await expect(others).toContainText("retrying request (1/3): connection reset");

	// probe 新打的 WARN 在「需要注意」里，这里不重复。三行各差 100 毫秒，WARN 在中间。
	const now = clock.now().getTime();
	const line = (seq: number, text: string, level: LogLevel) => ({
		...logLine(clock, seq, text, level),
		monotonicMs: agent.monotonicAt(now - 300 + seq * 100),
	});
	agent.logs(probe, [
		line(1, "探活第 1 次", LogLevel.INFO),
		line(2, "探活超时 3 次（阈值 2 次）", LogLevel.WARN),
		line(3, "探活第 4 次", LogLevel.INFO),
	]);
	await agent.sync();
	await expect(rows(page)).toHaveCount(2);
	await expect(others.getByRole("listitem")).toHaveCount(1);
	await expect(others).not.toContainText("探活超时");

	// 10 分钟后它从「需要注意」撤下，列在这里，新的在上面。
	await advance(clock, agent, 10 * 60_000 + 15_000, () => probePoint(agent, probe, clock));
	await expect(attention(page)).toHaveCount(0);
	await expect(others.getByRole("listitem")).toHaveCount(2);
	await expect(others.getByRole("listitem").first()).toContainText("probe");
	await others.getByRole("button", { name: /探活超时 3 次/ }).click();
	await expect(viewTab(page, "详情")).toHaveAttribute("aria-selected", "true");
	expect(search(page)).toMatchObject({ view: "detail", node: "probe", tab: "logs" });
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：probe");
	const located = panel(page).getByRole("log", { name: "日志" }).locator("[data-located]");
	await expect(located).toHaveCount(1);
	await expect(located).toContainText("探活超时 3 次（阈值 2 次）");
});

test("没有新数据的图表：曲线停在最后一个点，之后到现在画斜线，写明多久没有新数据，读屏也说明；页头写「数据更新于」", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent } = await overviewRun(controlPlane, connectAgent, clock);
	await openOverview(page, clock, runId);
	await expect(page.getByTestId("focus-freshness")).toHaveText("数据更新于 08:00:14");
	const level = focusChart(page, "探活 level");
	await expect(level.locator("[data-stale-gap]")).toHaveCount(0);

	// probe 最后一个点在第 13 秒，采样间隔 1 秒：30 秒以后算没有新数据。推进到第 59 秒。
	await advance(clock, agent, 45_000);
	await expect(page.getByTestId("focus-freshness")).toHaveText("数据更新于 08:00:59");
	await expect(level.locator("[data-stale-gap]")).toHaveCount(1);
	await expect(level).toContainText("已 46s 无新数据 · probe");
	await expect(level.getByRole("img")).toHaveAccessibleName(
		"探活 level 3，来自 probe（执行中），需要注意：已 46s 无新数据，曲线停在最后一个点",
	);
	// 已成功的 fetch 只显示最终值，不判断异常。
	await expect(focusChart(page, "下单延迟").locator("[data-stale-gap]")).toHaveCount(0);
	await expect(focusChart(page, "下单延迟")).toContainText("fetch · 最终值");
	// 详情里不读关注项，页头不写「数据更新于」。
	await viewTab(page, "详情").click();
	await expect(page.getByTestId("focus-freshness")).toHaveCount(0);
});

test("重试和失败：「需要注意」写明上一次失败的原因或失败的原因，直达按钮进详情看那个节点的尝试", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, scenarioId, agent, tasks } = await runningScenario(
		controlPlane,
		connectAgent,
		clock,
	);
	await setFocusItems(controlPlane, scenarioId, [
		{ node_id: "verify", chart: "level", title: "核对 level" },
	]);
	await openOverview(page, clock, runId);

	// verify 第 1 次失败，第 9 秒（上海时间 08:00:09）开始第 2 次。
	await expect(rows(page)).toHaveCount(1);
	await expect(rows(page).first()).toContainText(
		"verify 在 08:00:09 开始重试（尝试 2），上一次尝试失败：AssertionError: 漏拦 3 笔",
	);
	// verify 的 level 是瞬时值，平台给它的默认图表是折线：原因写在图表卡片上和图的可访问名称里。
	const verifyChart = focusChart(page, "核对 level");
	await expect(verifyChart).toContainText("重试（尝试 2）· 08:00:09 · verify");
	await expect(verifyChart.getByRole("img")).toHaveAccessibleName(
		/需要注意：重试（尝试 2）· 08:00:09$/,
	);
	await rows(page).first().getByRole("button", { name: "在详情里看 verify 的尝试" }).click();
	await expect(viewTab(page, "详情")).toHaveAttribute("aria-selected", "true");
	expect(search(page)).toEqual({ view: "detail", node: "verify", tab: "attempts" });
	await expect(panel(page).getByRole("tab", { name: "尝试" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(panel(page).getByRole("article", { name: "verify 第 2 次尝试" })).toBeVisible();

	// 第 2 次也失败了：写失败的原因（错误信息的第一行）。
	await agent.fail(tasks.verify as AssignedTask, "AssertionError: 仍然漏拦\n\nTraceback");
	await viewTab(page, "概览").click();
	await expect(rows(page).first()).toContainText("verify 失败：AssertionError: 仍然漏拦");
	await expect(verifyChart.getByRole("img")).toHaveAccessibleName(/需要注意：来源节点失败$/);
	await expect(rows(page).first().getByRole("button")).toHaveText("在详情里看 verify 的尝试");
});
