import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { metricPackage, openMonitor, unixAt } from "./monitor-scenario";
import { createScenario, publishPackage, scenarioUsing, triggerRun } from "./support";

// Agent 的时间换算有偏差，点换算成控制面时间以后都落在尝试的时段之外（#389）：图表不写「还没有数据」，写明可能有偏差和点在哪。

const chart = (page: Page, title: string) =>
	page
		.getByRole("region", { name: "图表工作区" })
		.getByRole("region", { name: "ping 的图表" })
		.getByRole("figure", { name: title, exact: true });

test("点都在尝试的时段之外：图表写「这台 Agent 的时间换算可能有偏差」和点所在的时间范围", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({
		name: "agent-a",
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await publishPackage(controlPlane, metricPackage());
	const scenarioId = await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));
	const clock0 = clock.now().getTime();
	const runId = await triggerRun(controlPlane, scenarioId);
	const ping = await agent.nextAssign();
	clock.advance(5000);
	// 换算以后在 30 分钟之后：比「现在」还晚，不在尝试的时段里。
	agent.metrics(ping, [
		["level", unixAt(clock0, 1800), 3],
		["level", unixAt(clock0, 1810), 4],
	]);
	await agent.sync();
	await openMonitor(page, clock, runId, "ping");

	const level = chart(page, "level");
	const start = Math.floor(clock0 / 1000) * 1000 + 1_800_000;
	// 钟点按浏览器的时区写，和跑测试的进程不一定一样。
	const startText = await page.evaluate((t) => new Date(t).toTimeString().slice(0, 8), start);
	await expect(level.locator("[data-clock-offset]")).toHaveText(
		new RegExp(
			`^这台 Agent 的时间换算可能有偏差：点在 ${startText} – \\d\\d:\\d\\d:\\d\\d（控制面时间）$`,
		),
	);
	await expect(level).not.toContainText("还没有数据");
	// 没有点的图表照旧。
	await expect(chart(page, "total")).toContainText("还没有数据");
});
