import { expect, type Page } from "@playwright/test";
import {
	type AssignedTask,
	type FakeAgent,
	LogLevel,
} from "../../server/test/support/fake-agent.js";
import type { ManualClock } from "../../server/test/support/manual-clock.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import type { E2eFixtures } from "./fixtures";
import { setFocusItems } from "./focus-support";
import { advance, logLine, type Running, runningScenario } from "./monitor-scenario";

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

/** probe 在手动时钟的当前这一秒上报一组点（level、total），它就一直有新数据。 */
export function probePoint(agent: FakeAgent, probe: AssignedTask, clock: ManualClock) {
	const s = Math.floor(clock.now().getTime() / 1000);
	agent.metrics(probe, [
		["level", s, 4],
		["total", s, 20],
	]);
}

/** 概览的「需要注意」一段（只在有异常时出现）。 */
export const attention = (page: Page) => page.getByRole("region", { name: "需要注意" });

/**
 * {@link OVERVIEW_ITEMS} 再加上执行中的 verify（第 2 次尝试）的 level。推进 10 分钟（probe 每 15 秒上报一组点，verify 不再上报）：
 * verify 的重试已经过了 10 分钟，只剩没有新数据；然后 probe 打了一条 WARN。「需要注意」里是 probe 的两项（WARN）和
 * verify 的一项（无新数据），fetch 早先的 WARN 在「其他警告与错误」里。
 */
export async function attentionRun(
	controlPlane: TestControlPlane,
	connectAgent: E2eFixtures["connectAgent"],
	clock: ManualClock,
): Promise<Running> {
	const running = await runningScenario(controlPlane, connectAgent, clock);
	await setFocusItems(controlPlane, running.scenarioId, [
		...OVERVIEW_ITEMS,
		{ node_id: "verify", chart: "level", title: "核对 level" },
	]);
	const { agent, tasks } = running;
	const probe = tasks.probe as AssignedTask;
	await advance(clock, agent, 10 * 60_000, () => probePoint(agent, probe, clock));
	agent.logs(probe, [logLine(clock, 1, "探活超时 3 次（阈值 2 次）", LogLevel.WARN)]);
	await agent.sync();
	return running;
}
