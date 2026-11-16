import { expect, type Page } from "@playwright/test";
import type { AssignedTask } from "../../server/test/support/fake-agent.js";
import type { ManualClock } from "../../server/test/support/manual-clock.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import type { E2eFixtures } from "./fixtures";
import { advance, type Running } from "./monitor-scenario";
import { overviewRun } from "./overview-support";

// 编排画布运行状态里的关注项（#353）：端到端测试与视觉回归共用的场景。

/**
 * `overviewRun`（关注项按作者的顺序：fetch 的延迟、probe 的 level、fetch 的请求数、probe 的 total、fetch 的 errors、
 * cleanup 的 level）再推进 2 分钟：probe 只上报 level，total 一直停在第 13 秒，于是 total 没有新数据（异常），level 照常。
 * probe 写着进度「第 3 批」。此刻 fetch 已成功（三项都是最终值），probe 与重试中的 verify 执行中，cleanup 待执行。
 */
export async function canvasFocusRun(
	controlPlane: TestControlPlane,
	connectAgent: E2eFixtures["connectAgent"],
	clock: ManualClock,
): Promise<Running> {
	const running = await overviewRun(controlPlane, connectAgent, clock);
	const { agent } = running;
	const probe = running.tasks.probe as AssignedTask;
	await advance(clock, agent, 2 * 60_000, () => {
		agent.metrics(probe, [["level", Math.floor(clock.now().getTime() / 1000), 4]]);
	});
	agent.progress(probe, 3, 10, "第 3 批");
	await agent.sync();
	return running;
}

/**
 * 打开这次运行的画布运行状态（浏览器时间固定在手动时钟的当前时刻），等跟随执行把镜头平移到执行中的节点、停下来：
 * 点击会打断还在进行的平移。
 */
export async function openCanvasRun(
	page: Page,
	clock: ManualClock,
	{ scenarioId, runId }: Pick<Running, "scenarioId" | "runId">,
) {
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/orchestrations/${scenarioId}?run=${runId}`);
	const viewport = page.locator(".react-flow__viewport");
	let last = "";
	await expect
		.poll(async () => {
			const style = (await viewport.getAttribute("style")) ?? "";
			const settled = style !== "" && style === last;
			last = style;
			return settled;
		})
		.toBe(true);
}

/** 节点卡片底部的关注项：每一行的图表标题，按显示的顺序。 */
export const cardFocusRows = (card: ReturnType<Page["locator"]>) =>
	card.getByTestId("node-focus").locator("[data-focus-row]");

/** 检查器里选中节点的图表：每张的标题，按显示的顺序（给 `expect.poll` 用）。 */
export const inspectorCharts = (page: Page) => () =>
	page
		.getByRole("complementary", { name: "检查器" })
		.locator("[data-node-chart]")
		.evaluateAll((charts) => charts.map((c) => c.getAttribute("data-node-chart")));
