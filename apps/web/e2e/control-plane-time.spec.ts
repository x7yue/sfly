import type { Page } from "@playwright/test";
import { CONTROL_PLANE_TIME_HEADER } from "@sfly/schema";
import { expect, test } from "./fixtures";
import { runningScenario } from "./monitor-scenario";
import { advance } from "./run-records";

// 页面上的"现在"是控制面时间（ADR 0018）：浏览器所在电脑的时间偏了多少都不影响"已运行"等时长。

const DAY = 24 * 3_600_000;

/** 浏览器时间比控制面时间快 613 天（内网里实际遇到的情况）。 */
const browserAhead = (page: Page, cpNow: Date) =>
	page.clock.setFixedTime(new Date(cpNow.getTime() + 613 * DAY));

/** 区段在轨道上的位置（占轨道宽度的比例）。 */
async function segmentSpan(page: Page, nodeId: string, kind: string) {
	const row = page.locator(`[data-node-row="${nodeId}"]`);
	const track = await row.locator("> div").boundingBox();
	const seg = await row.locator(`[data-segment="${kind}"]`).boundingBox();
	if (!track || !seg) throw new Error("没有轨道或区段");
	return {
		left: (seg.x - track.x) / track.width,
		right: (seg.x + seg.width - track.x) / track.width,
	};
}

test("浏览器时间比控制面快 613 天：监控页的已运行时长和执行中的条带按控制面时间算，并随控制面时间推进", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	// 运行开始后 14 秒；verify 的重试从第 9 秒起执行中。
	const { runId, agent } = await runningScenario(controlPlane, connectAgent, clock);
	await browserAhead(page, clock.now());

	await page.goto(`/runs/${runId}`);
	const elapsed = page.getByRole("banner").getByTestId("run-elapsed");
	await expect(elapsed).toHaveText("已运行 14.0s");
	// 时间轴的范围是运行开始到现在（14 秒）："现在"线在最右端，执行中的条带占 9s–14s。
	await expect(page.locator("[data-now-line]")).toHaveAttribute("style", /left: 100%/);
	await expect
		.poll(async () => (await segmentSpan(page, "verify", "run")).left)
		.toBeCloseTo(9 / 14, 2);
	expect((await segmentSpan(page, "verify", "run")).right).toBeCloseTo(1, 2);

	// 控制面时间过去 10 秒，浏览器时间不动：页面从心跳里跟上。
	await advance(clock, agent, 10_000);
	await expect(elapsed).toHaveText("已运行 24.0s");
	await expect
		.poll(async () => (await segmentSpan(page, "verify", "run")).left)
		.toBeCloseTo(9 / 24, 2);
});

test("浏览器时间比控制面快 613 天：运行记录、场景列表和运行抽屉里的时长也按控制面时间算", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent } = await runningScenario(controlPlane, connectAgent, clock);
	await browserAhead(page, clock.now());

	await page.goto("/runs");
	const card = page.getByRole("article", { name: `运行 ${runId.slice(0, 8)}` });
	await expect(card).toContainText("14.0s");
	await expect(card).not.toContainText("613d");
	// 开始时间与控制面的"今年"同年，省略年份。
	await expect(card).toContainText("开始 01-01 08:00");

	await page.goto("/orchestrations");
	const scenario = page.getByRole("article", { name: "日终数据处理" });
	await expect(scenario).toContainText("14.0s");
	await expect(scenario).not.toContainText("613d");

	// 运行抽屉：再触发一次，摘要里的时长从 0 开始，随控制面时间推进。
	await scenario.getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 日终数据处理" });
	await drawer.getByRole("button", { name: "触发运行" }).click();
	const summary = drawer.getByRole("region", { name: "运行摘要" });
	await expect(summary.getByTestId("summary-status")).toHaveText("运行中");
	await expect(summary).toContainText("0ms");
	await advance(clock, agent, 5_000);
	await expect(summary).toContainText("5.0s");
});

test("拿不到控制面时间时按浏览器时间显示", async ({ page, controlPlane, connectAgent, clock }) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	// 旧版控制面、中间代理去掉了响应头：接口响应里没有控制面时间，SSE 也连不上。
	await page.route("**/api/**", async (route) => {
		if (route.request().headers().accept?.includes("text/event-stream")) return route.abort();
		const response = await route.fetch();
		const headers = { ...response.headers() };
		delete headers[CONTROL_PLANE_TIME_HEADER];
		await route.fulfill({ response, headers });
	});
	await page.clock.setFixedTime(new Date(clock.now().getTime() + 60_000));

	await page.goto(`/runs/${runId}`);
	await expect(page.getByRole("banner").getByTestId("run-elapsed")).toHaveText("已运行 1m 14s");
});
