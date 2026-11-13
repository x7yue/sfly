import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
	type AssignedTask,
	agentClock,
	LogLevel,
	LogSource,
} from "../../server/test/support/fake-agent.js";
import { type E2eFixtures, expect, test } from "./fixtures";
import { openMonitor, runningScenario } from "./monitor-scenario";

// 日志面板的两种时间（#173，ADR 0018）：时间列默认显示 Agent 时间，可以切换成控制面时间并在本机记住；
// 点击日志在时间线上定位只用控制面时间，没有控制面时间的旧日志行不能定位。

const timeline = (page: Page) => page.getByRole("region", { name: "链路时间线" });
const panel = (page: Page) => page.getByRole("region", { name: "底部面板" });

/** Agent 时间比控制面快 613 天 3 小时 25 分 7 秒：两种时间的时分秒也不一样。 */
const AGENT_AHEAD_MS = ((613 * 24 + 3) * 3600 + 25 * 60 + 7) * 1000;
/** Agent 连上时的单调时钟读数。 */
const M0 = 40_000;
/** 页面上的时刻（浏览器时区 Asia/Shanghai）：`08:00:06.000`。 */
const clockMs = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(11, 23);
/** 带日期的时刻：`2027-09-06 11:25:13.000`。列表里有时间不在运行开始那天时，整列都这样显示。 */
const dateClockMs = (ms: number) =>
	new Date(ms + 8 * 3600_000).toISOString().slice(0, 23).replace("T", " ");

/** Agent 在连上后第 afterMs 毫秒读到的一行：Agent 时间带着偏差，单调时钟读数照实走。 */
const lineAt = (clock0: number, seq: number, afterMs: number, text: string) => ({
	seq: BigInt(seq),
	timeUnixMs: BigInt(clock0 + AGENT_AHEAD_MS + afterMs),
	monotonicMs: BigInt(M0 + afterMs),
	source: LogSource.STDOUT,
	level: LogLevel.INFO,
	text,
});

test("日志时间列默认显示 Agent 时间，切换成控制面时间后刷新页面仍保持；点一行，标记按控制面时间落在时间线上", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const clock0 = clock.now().getTime();
	// Agent 的 Hello 带 Agent 时间和单调时钟读数：控制面据此把每行的读数折算成控制面时间。
	const connect: E2eFixtures["connectAgent"] = (hello) =>
		connectAgent({ ...hello, ...agentClock(clock0 + AGENT_AHEAD_MS, M0) });
	const { runId, agent, tasks } = await runningScenario(controlPlane, connect, clock);
	const probe = tasks.probe as AssignedTask;
	// 第一行是在 fetch 结束的那一刻（触发后第 6 秒）读到的，控制面过了 8 秒才收到。
	agent.logs(probe, [
		lineAt(clock0, 1, 6_000, "probe sees fetch done"),
		lineAt(clock0, 2, 9_500, "probe keeps going"),
	]);
	await agent.sync();
	await openMonitor(page, clock, runId, "probe");
	const logs = panel(page).getByRole("log", { name: "日志" });
	const first = logs.getByRole("button", { name: /probe sees fetch done/ });
	const second = logs.getByRole("button", { name: /probe keeps going/ });
	const kind = (name: string) => panel(page).getByRole("button", { name, exact: true });

	// 默认：Agent 时间。它和运行开始那天（控制面时间 2026-01-01）不在同一天：整列带上日期。
	await expect(kind("Agent 时间")).toHaveAttribute("aria-pressed", "true");
	await expect(first.locator("[data-log-time]")).toHaveText("2027-09-06 11:25:13.000");
	await expect(second.locator("[data-log-time]")).toHaveText("2027-09-06 11:25:16.500");
	// 悬停时两种时间都给出，带日期。
	await expect(first.locator("[data-log-time]")).toHaveAttribute(
		"title",
		"Agent 时间 2027-09-06 11:25:13\n控制面时间 2026-01-01 08:00:06",
	);

	// 切换成控制面时间：都在运行开始那天，只显示时刻。
	await kind("控制面时间").click();
	await expect(first.locator("[data-log-time]")).toHaveText(clockMs(clock0 + 6_000));
	await expect(second.locator("[data-log-time]")).toHaveText(clockMs(clock0 + 9_500));

	// 刷新后保持。
	await page.reload();
	await expect(kind("控制面时间")).toHaveAttribute("aria-pressed", "true");
	await expect(first.locator("[data-log-time]")).toHaveText(clockMs(clock0 + 6_000));

	// 点第一行：标记线落在 fetch 结束的位置（它那一段的右沿），不是按 Agent 时间算出的 613 天之后。
	await first.click();
	await expect(first).toHaveAttribute("data-marked", "true");
	const marker = timeline(page).locator("[data-marker-line]");
	await expect(marker).toBeVisible();
	const done = await timeline(page)
		.locator('[data-node-row="fetch"] [data-segment="ok"]')
		.boundingBox();
	const line = await marker.boundingBox();
	if (!done || !line) throw new Error("没有 fetch 的执行段或标记线");
	expect(Math.abs(line.x + line.width / 2 - (done.x + done.width))).toBeLessThan(2);

	// 时间列换回 Agent 时间，标记不动：定位只看控制面时间。
	await kind("Agent 时间").click();
	await expect(first).toHaveAttribute("data-marked", "true");
	const still = await marker.boundingBox();
	expect(still?.x).toBe(line.x);
});

test("没有控制面时间的旧日志行：时间列显示未记录，不能在时间线上定位并说明原因", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const clock0 = clock.now().getTime();
	const connect: E2eFixtures["connectAgent"] = (hello) =>
		connectAgent({ ...hello, ...agentClock(clock0 + AGENT_AHEAD_MS, M0) });
	const { runId, agent, tasks } = await runningScenario(controlPlane, connect, clock);
	const verify = tasks.verify as AssignedTask;
	// 升级之前写入的日志文件：每行只有一个时间（当时记的是 Agent 时间）。
	const dir = join(controlPlane.dataDir, "logs", runId);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, `${verify.taskId}.jsonl`),
		`${JSON.stringify({
			seq: 1,
			time: new Date(clock0 + AGENT_AHEAD_MS + 9_000).toISOString(),
			source: "stdout",
			level: "info",
			text: "written before the upgrade",
		})}\n`,
	);
	// 之后写入的行两种时间都有。
	agent.logs(verify, [lineAt(clock0, 2, 10_000, "written after the upgrade")]);
	await agent.sync();
	await openMonitor(page, clock, runId, "verify");
	const logs = panel(page).getByRole("log", { name: "日志" });
	const old = logs.getByRole("button", { name: /written before the upgrade/ });
	const fresh = logs.getByRole("button", { name: /written after the upgrade/ });
	const reason = "这行日志没有记录控制面时间，不能在时间轴上定位";

	// 默认的 Agent 时间照常显示。
	await expect(old.locator("[data-log-time]")).toHaveText(
		dateClockMs(clock0 + AGENT_AHEAD_MS + 9_000),
	);
	// 面板顶部说清有几行、为什么；行自己的说明是单行的说法。
	await expect(panel(page).getByTestId("logs-unlocatable")).toHaveText(
		"有 1 行日志没有记录控制面时间（升级之前写入的日志只有 Agent 时间）：这些行不能在时间轴上定位，按时间范围过滤时也不显示。",
	);
	await expect(old).toHaveAttribute("aria-disabled", "true");
	await expect(old).toHaveAttribute("title", reason);
	await expect(fresh).not.toHaveAttribute("aria-disabled", "true");
	// 不能定位的行一眼能认出来：正文退到辅助色，鼠标指针是「不可用」。
	await expect(old).toHaveCSS("cursor", "not-allowed");
	await expect(fresh).toHaveCSS("cursor", "pointer");
	const textColor = (row: typeof old) =>
		row
			.locator("span")
			.last()
			.evaluate((el) => getComputedStyle(el).color);
	expect(await textColor(old)).toBe(
		await old.locator("[data-log-time]").evaluate((el) => getComputedStyle(el).color),
	);
	expect(await textColor(old)).not.toBe(await textColor(fresh));

	// 点旧行不出现标记；点新行才有。
	await expect(old).toBeDisabled();
	// 强行点下去（跳过「可点击」检查）和按回车也没有反应。
	await old.click({ force: true });
	await old.press("Enter");
	await expect(old).not.toHaveAttribute("data-marked", "true");
	await expect(timeline(page).locator("[data-marker-line]")).toHaveCount(0);
	await fresh.click();
	await expect(timeline(page).locator("[data-marker-line]")).toBeVisible();

	// 控制面时间：旧行显示未记录。
	await panel(page).getByRole("button", { name: "控制面时间", exact: true }).click();
	await expect(old.locator("[data-log-time]")).toHaveText("未记录");
	await expect(fresh.locator("[data-log-time]")).toHaveText(clockMs(clock0 + 10_000));

	// 在时间线上框选一段时间：只留下控制面时间落在范围里的行，旧行不在任何范围里。
	const track = await timeline(page).locator('[data-node-row="fetch"] > div').boundingBox();
	if (!track) throw new Error("没有轨道");
	const y = track.y + track.height / 2;
	await page.mouse.move(track.x + track.width * (8.4 / 20), y);
	await page.mouse.down();
	await page.mouse.move(track.x + track.width * (13.9 / 20), y, { steps: 5 });
	await page.mouse.up();
	await expect(panel(page).getByTestId("bp-scope")).toContainText("已按时间范围过滤");
	await expect(fresh).toBeVisible();
	await expect(old).toHaveCount(0);
});
