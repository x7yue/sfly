import { truncate, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { type AssignedTask, LogLevel, LogSource } from "../../server/test/support/fake-agent.js";
import { expect, test } from "./fixtures";
import { openMonitor, runningScenario } from "./monitor-scenario";

// 日志文件不在了、变短了的时候（#669 之后下载会说，#721 起分页读取和实时流也说）：日志面板在读到的行上面说明原因，
// 没有行时不再显示成「这次尝试没有日志输出」。主人看到的是「日志没了」，而不是「节点没有输出」。

const panel = (page: Page) => page.getByRole("region", { name: "底部面板" });

const lines = (task: string, count: number) =>
	Array.from({ length: count }, (_, i) => ({
		seq: BigInt(i + 1),
		timeUnixMs: BigInt(1_000 + i),
		monotonicMs: BigInt(1_000 + i),
		source: LogSource.STDOUT,
		level: LogLevel.INFO,
		text: `${task} 第 ${i + 1} 行`,
	}));

test("单个任务：日志文件不见了，面板说明原因，不显示成「这次尝试没有日志输出」", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const probe = tasks.probe as AssignedTask;
	agent.logs(probe, lines("probe", 3));
	await agent.sync();
	await unlink(join(controlPlane.dataDir, "logs", runId, `${probe.taskId}.jsonl`));

	await openMonitor(page, clock, runId, "probe");

	const notice = panel(page).getByTestId("logs-file-problem");
	await expect(notice).toBeVisible();
	await expect(notice).toContainText("日志文件不在了");
	await expect(notice).toContainText("掉电");
	// 说明读者现在能做什么：这里没有内容、下载会失败、只能从备份恢复；实时流晚到时读屏会念。
	await expect(notice).toContainText("下载这份日志也会失败");
	await expect(notice).toContainText("从备份恢复数据目录");
	await expect(notice).toHaveAttribute("role", "status");
	// 空态说的是文件的问题，不是「没有日志输出」；种类上面那一行已经说了，这里用中性的一句。
	await expect(panel(page).getByText("这次尝试没有日志输出")).toHaveCount(0);
	await expect(panel(page).getByRole("tabpanel")).toContainText("没有可显示的日志。");
});

test("单个任务：日志文件比记录的短，剩下的行照常显示，面板上说明变短了", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const probe = tasks.probe as AssignedTask;
	agent.logs(probe, lines("probe", 3));
	await agent.sync();
	await truncate(join(controlPlane.dataDir, "logs", runId, `${probe.taskId}.jsonl`), 0);

	await openMonitor(page, clock, runId, "probe");

	await expect(panel(page).getByTestId("logs-file-problem")).toContainText("比记录的短");
});

test("单个任务：文件截到 0 字节（比记录的短、一行也没有）：上面一行说变短了，空态不再说「不在了」（两句对得上）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const probe = tasks.probe as AssignedTask;
	agent.logs(probe, lines("probe", 3));
	await agent.sync();
	await truncate(join(controlPlane.dataDir, "logs", runId, `${probe.taskId}.jsonl`), 0);

	await openMonitor(page, clock, runId, "probe");

	await expect(panel(page).getByTestId("logs-file-problem")).toContainText("比记录的短");
	const body = panel(page).getByRole("tabpanel");
	await expect(body).toContainText("没有可显示的日志。");
	await expect(body).not.toContainText("不在了");
});

test("没有问题的任务：没有这一行", async ({ page, controlPlane, connectAgent, clock }) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const probe = tasks.probe as AssignedTask;
	agent.logs(probe, lines("probe", 3));
	await agent.sync();

	await openMonitor(page, clock, runId, "probe");

	await expect(panel(page).getByRole("log", { name: "日志" })).toContainText("probe 第 3 行");
	await expect(panel(page).getByTestId("logs-file-problem")).toHaveCount(0);
});

test("合并视图：有任务的文件变短了，列出是哪个任务，别的任务的行照常显示", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const probe = tasks.probe as AssignedTask;
	const verify = tasks.verify as AssignedTask;
	agent.logs(probe, lines("probe", 2));
	agent.logs(verify, lines("verify", 2));
	await agent.sync();
	await truncate(join(controlPlane.dataDir, "logs", runId, `${verify.taskId}.jsonl`), 0);

	await openMonitor(page, clock, runId);

	const notice = panel(page).getByTestId("logs-file-problem");
	await expect(notice).toContainText("1 个任务的日志文件有问题");
	// 每个任务写明是不在了还是变短了（这里是 verify 的文件被截到 0）。
	await expect(notice).toContainText("verify");
	await expect(notice).toContainText("比记录的短");
	await expect(notice).toContainText("下载整个运行的日志也会失败");
	await expect(panel(page).getByRole("log", { name: "日志" })).toContainText("probe 第 2 行");
	await expect(panel(page).getByRole("log", { name: "日志" })).not.toContainText("verify 第 1 行");
});

test("合并视图：一个任务的文件不在了、别的任务好好的，筛选 ERROR 之后没有行：空态是「没有符合条件的日志」，不是「日志文件不在了」", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const probe = tasks.probe as AssignedTask;
	const verify = tasks.verify as AssignedTask;
	agent.logs(probe, lines("probe", 2));
	agent.logs(verify, lines("verify", 2));
	await agent.sync();
	await unlink(join(controlPlane.dataDir, "logs", runId, `${verify.taskId}.jsonl`));
	await openMonitor(page, clock, runId);
	await expect(panel(page).getByTestId("logs-file-problem")).toBeVisible();

	// 筛选 ERROR：别的任务里本来就没有 ERROR，这不是「日志没了」。
	await panel(page)
		.getByRole("group", { name: "日志级别" })
		.getByRole("button", { name: "ERROR", exact: true })
		.click();

	await expect(panel(page).getByRole("tabpanel")).toContainText("没有符合条件的日志。");
	await expect(panel(page).getByRole("tabpanel")).not.toContainText("没有可显示的日志");
	// 文件的问题照旧在上面说明。
	await expect(panel(page).getByTestId("logs-file-problem")).toContainText(
		"1 个任务的日志文件有问题",
	);
});
