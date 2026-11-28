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
	const [startText, endText] = await page.evaluate(
		(ts) => ts.map((t) => new Date(t).toTimeString().slice(0, 8)),
		[start, start + 11_000],
	);
	// 范围是数据桶的：第一个桶的开始到最后一个桶（1 秒宽）的结束。
	await expect(level.locator("[data-clock-offset]")).toHaveText(
		`这台 Agent 的时间换算可能有偏差：数据桶范围 ${startText} – ${endText}（控制面时间）`,
	);
	await expect(level).not.toContainText("还没有数据");
	// 没有点的图表照旧。
	await expect(chart(page, "total")).toContainText("还没有数据");
});

test("尝试里有正常的点、开始之前另有离群的点：不提示偏差；缩放到只有离群点的那段，写选区里没有数据", async ({
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
	const ping = await agent.nextAssign({ start: false });
	clock.advance(8000);
	await agent.started(ping);
	// 第 2 秒的点在尝试开始（第 8 秒）之前，第 10 秒的在尝试里。
	agent.metrics(ping, [
		["level", unixAt(clock0, 2), 9],
		["level", unixAt(clock0, 10), 3],
	]);
	await agent.sync();
	clock.advance(6000);
	await openMonitor(page, clock, runId, "ping");

	const level = chart(page, "level");
	await expect(level.locator("svg[data-plot]")).toBeVisible();
	await expect(level.locator("[data-clock-offset]")).toHaveCount(0);

	// 运行了 14 秒，时间轴取 20 秒：拖选 1–5 秒，只含离群的点。
	const track = await page
		.getByRole("region", { name: "链路时间线" })
		.locator('[data-node-row="ping"] > div')
		.boundingBox();
	if (!track) throw new Error("没有轨道");
	const y = track.y + track.height / 2;
	await page.mouse.move(track.x + track.width * (1.1 / 20), y);
	await page.mouse.down();
	await page.mouse.move(track.x + track.width * (3.1 / 20), y, { steps: 5 });
	await page.mouse.move(track.x + track.width * (5.1 / 20), y, { steps: 5 });
	await page.mouse.up();
	await expect(page.getByTestId("zoom-range")).toContainText("–");
	await expect(level).toContainText("所选时间段内无数据");
	await expect(level.locator("[data-clock-offset]")).toHaveCount(0);
});
