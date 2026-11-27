import type { Locator, Page } from "@playwright/test";
import type { AssignedTask } from "../../server/test/support/fake-agent.js";
import { nodeCard, withoutFollow } from "./editor-support";
import { expect, test } from "./fixtures";
import { MONITOR_SCENARIO, openMonitor, runningScenario } from "./monitor-scenario";

// 进度的当前值是小数（#806）：时间线、图表组、画布卡片都写成 `70/1500`，节点名不被挤没。

const NAME = "压测下单";

const scenario = {
	...MONITOR_SCENARIO,
	nodes: MONITOR_SCENARIO.nodes.map((n) => (n.id === "probe" ? { ...n, display_name: NAME } : n)),
};

/** 元素整个显示出来了：有宽度，内容没有被截断。 */
const fullyShown = (locator: Locator) =>
	locator.evaluate((el) => el.clientWidth > 0 && el.scrollWidth <= el.clientWidth);

const timelineRow = (page: Page) =>
	page.getByRole("region", { name: "链路时间线" }).locator('[data-node-row="probe"]');

test("小数进度在时间线和图表组里取整，节点名完整显示", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await runningScenario(
		controlPlane,
		connectAgent,
		clock,
		scenario,
	);
	agent.progress(tasks.probe as AssignedTask, 70.32576644897927, 1500, "已下 70 单");
	await agent.sync();
	await openMonitor(page, clock, runId, "probe");

	await expect(timelineRow(page).locator("[data-progress]")).toHaveText("70/1500");
	const name = timelineRow(page).getByText(NAME, { exact: true });
	await expect(name).toBeVisible();
	expect(await fullyShown(name)).toBe(true);
	await expect(page.getByTestId("node-summary")).toContainText("70/1500已下 70 单");

	// 很大的数照指标值的写法。
	agent.progress(tasks.probe as AssignedTask, 1_234_567.89, 5_000_000);
	await expect(timelineRow(page).locator("[data-progress]")).toHaveText("1.2M/5.0M");
	expect(await fullyShown(name)).toBe(true);
});

test("小数进度在画布卡片上取整，卡片标题完整显示", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, scenarioId, agent, tasks } = await runningScenario(
		controlPlane,
		connectAgent,
		clock,
		scenario,
	);
	agent.progress(tasks.probe as AssignedTask, 377.6008894639672, 1500);
	await agent.sync();
	await withoutFollow(page);
	await page.goto(`/orchestrations/${scenarioId}?run=${runId}`);

	const card = nodeCard(page, "probe");
	await expect(card.locator("[data-node-figure]")).toHaveText("378/1500");
	const title = card.locator('[data-slot="base-node-title"]');
	await expect(title).toHaveText(NAME);
	await expect(title).toBeVisible();
	expect(await fullyShown(title)).toBe(true);
});
