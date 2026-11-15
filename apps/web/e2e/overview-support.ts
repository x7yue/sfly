import { expect, type Page } from "@playwright/test";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import type { E2eFixtures } from "./fixtures";
import { setFocusItems } from "./focus-support";
import { type Running, runningScenario } from "./monitor-scenario";

// 运行监控「概览」的端到端测试与视觉回归共用的场景。

/**
 * 关注项（按作者的顺序）：两项数值（probe 的累计值 total 在执行中，fetch 的 errors 已成功）和四张图表
 * （fetch 的延迟有两条线、请求数是柱状，probe 的 level 在执行中，cleanup 的 level 还没开始）。
 * 在 `runningScenario` 的状态（运行开始后 14 秒）下：probe 的 total 是 16，level 是 3，每 6 秒到 13 秒上报；
 * fetch 已成功，最后一个点在第 5 秒，errors 是 1，请求数是 520，延迟最近的点 latency_ms 是 50、p99_ms 是 95。
 */
export const OVERVIEW_ITEMS = [
	{ node_id: "fetch", chart: "延迟", title: "下单延迟" },
	{ node_id: "probe", chart: "level", title: "探活 level" },
	{ node_id: "fetch", chart: "请求数" },
	{ node_id: "probe", chart: "total" },
	{ node_id: "fetch", chart: "errors" },
	{ node_id: "cleanup", chart: "level", title: "清理 level" },
] as const;

/** `runningScenario` 加上 {@link OVERVIEW_ITEMS}：场景设了关注项。 */
export async function overviewRun(
	controlPlane: TestControlPlane,
	connectAgent: E2eFixtures["connectAgent"],
	clock: Parameters<typeof runningScenario>[2],
): Promise<Running> {
	const running = await runningScenario(controlPlane, connectAgent, clock);
	await setFocusItems(controlPlane, running.scenarioId, [...OVERVIEW_ITEMS]);
	return running;
}

/** 打开某个运行的概览；浏览器时间固定在手动时钟的当前时刻。 */
export async function openOverview(
	page: Page,
	clock: Parameters<typeof runningScenario>[2],
	runId: string,
) {
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/runs/${runId}?view=overview`);
	await expect(page.getByRole("heading", { name: "链路", level: 2, exact: true })).toBeVisible();
}

export const viewTab = (page: Page, name: "概览" | "详情") =>
	page.getByRole("tablist", { name: "运行监控视图" }).getByRole("tab", { name });
/** 关注项里数值类的一排读数。 */
export const readouts = (page: Page) => page.getByRole("list", { name: "关注项读数" });
/** 概览里一张图表的卡片，按它的名称。 */
export const focusChart = (page: Page, title: string) =>
	page.getByRole("article", { name: title, exact: true });
