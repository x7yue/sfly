import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type { SessionEvent, SessionEventBody } from "@sfly/schema";
import {
	recordRunSession,
	recordVersionSession,
} from "../../server/test/support/session-records.js";
import { seedSession } from "../../server/test/support/sessions.js";
import { eventAt, installSessionStream, pushEvent, streamOpens } from "./assistant-support";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage, scenarioUsing, triggerRun } from "./support";

// 会话页右侧的「成果」、时间线上平台留下的记录、运行页和版本历史上的「经 会话「…」」（#547）：都只来自控制面记下的东西——
// 会话的 `platform` 事件、运行和场景版本上记的会话——不是助手在对话里说了什么。这里的会话和记录是直接造的（用固定的平台事件、
// 直接写库），不靠会话令牌的签发：签发和吊销有控制面的测试和全栈测试守着。

const TITLE = "给 http_check 加一个超时参数";

// 平台事件（`PlatformEvent` 的三种，提交的形状是 #546 定的）。
const commitEvent = (seq: number, turn: number, hash: string): SessionEvent => ({
	type: "platform",
	kind: "commit",
	seq,
	at: eventAt(),
	turn,
	hash,
	files: [
		{ path: "nodes/http_check.py", additions: 12, deletions: 3 },
		{ path: "assets/logo.png", additions: null, deletions: null },
	],
	diff: "diff --git a/nodes/http_check.py b/nodes/http_check.py\n--- a/nodes/http_check.py\n+++ b/nodes/http_check.py\n@@ -1 +1 @@\n-a\n+b\n",
	truncated: false,
});
const versionEvent = (
	seq: number,
	scenario: string,
	name: string,
	version: number,
): SessionEvent => ({
	type: "platform",
	kind: "scenario_version",
	seq,
	at: eventAt(),
	turn: 1,
	scenario_id: scenario,
	name,
	version,
});
const runEvent = (seq: number, runId: string, name: string): SessionEvent => ({
	type: "platform",
	kind: "run",
	seq,
	at: eventAt(),
	turn: 1,
	run_id: runId,
	scenario_name: name,
});

const results = (page: Page) => page.getByTestId("session-results");
const timeline = (page: Page) => page.getByRole("list", { name: "会话的时间线" });

test("成果：没有触发运行时三块都是空的；助手说「运行成功了」没有真的触发，成果栏和时间线上都没有运行", async ({
	page,
	controlPlane,
}) => {
	const id = await seedSession(controlPlane.database.url, {
		title: TITLE,
		status: "idle",
		events: [
			{
				type: "user_message",
				message_id: randomUUID(),
				text: "跑一遍巡检",
				steer: false,
				author: "tester",
				author_user_id: null,
			},
			{ type: "turn_started", turn: 1 },
			{
				type: "assistant_message",
				text: "运行成功了，场景也已经保存。",
				usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
			},
			{
				type: "turn_end",
				turn: 1,
				outcome: "completed",
				reason: "助手已完成",
				steps: 0,
				model_calls: 1,
				duration_ms: 1000,
			},
		],
	});
	await page.goto(`/sessions/${id}`);
	await expect(timeline(page).getByTestId("assistant-message")).toContainText("运行成功了");
	await expect(results(page).getByRole("heading", { name: "成果", level: 2 })).toBeVisible();
	await expect(results(page).getByTestId("results-commits-empty")).toHaveText("还没有提交");
	await expect(results(page).getByTestId("results-versions-empty")).toHaveText(
		"还没有保存场景的版本",
	);
	await expect(results(page).getByTestId("results-runs-empty")).toHaveText("还没有触发运行");
	await expect(results(page).getByTestId("result-run")).toHaveCount(0);
	await expect(timeline(page).getByTestId("record-run")).toHaveCount(0);

	// 版面：成果在时间线的右边，输入框在时间线下面，都在窗口里（不靠截图里的眼睛，量元素的位置）。
	const box = async (locator: ReturnType<Page["locator"]>) => {
		const found = await locator.boundingBox();
		if (found === null) throw new Error("元素没有占位置");
		return found;
	};
	const list = await box(timeline(page));
	const side = await box(results(page));
	const composer = await box(page.getByRole("textbox", { name: "接着说" }));
	const viewport = page.viewportSize();
	expect(side.x).toBeGreaterThanOrEqual(list.x + list.width);
	expect(side.x + side.width).toBeLessThanOrEqual(viewport?.width ?? 0);
	expect(composer.x + composer.width).toBeLessThanOrEqual(side.x);
	expect(composer.y).toBeGreaterThanOrEqual(list.y + list.height);
});

test("成果：真的触发了运行（控制面记下的 platform 事件）：时间线上有一行、成果栏里有它，状态随运行实时变化；刷新后还在", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent", slots: 4 });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "巡检", scenarioUsing("agent"));
	const runId = await triggerRun(controlPlane, scenario);
	const assign = await agent.nextAssign();

	const id = await seedSession(controlPlane.database.url, {
		title: TITLE,
		status: "running",
		events: [
			{
				type: "user_message",
				message_id: randomUUID(),
				text: "跑一遍巡检",
				steer: false,
				author: "tester",
				author_user_id: null,
			},
			{ type: "turn_started", turn: 1 },
		],
	});
	await installSessionStream(page);
	await page.goto(`/sessions/${id}`);
	await expect.poll(async () => (await streamOpens(page)).opened).toBe(1);
	await expect(results(page).getByTestId("result-run")).toHaveCount(0);

	// 控制面记下这条记录（同一个事务里写 platform 事件）：事件流推给页面。
	await pushEvent(page, runEvent(3, runId, "巡检"));
	const row = timeline(page).getByTestId("record-run");
	await expect(row).toContainText("触发了运行");
	await expect(row).toContainText(runId.slice(0, 8));
	await expect(row).toContainText("场景「巡检」");
	await expect(row).toContainText("第 1 轮");
	const result = results(page).getByTestId("result-run");
	await expect(result).toContainText(runId.slice(0, 8));
	await expect(result).toContainText("巡检");
	await expect(result.getByTestId("result-run-status")).toHaveText("运行中");

	// 运行的状态是实时的（和运行监控共用同一份数据）：运行结束，成果栏里的状态跟着变，不用刷新。
	await agent.succeed(assign);
	await expect(result.getByTestId("result-run-status")).toHaveText("成功");

	// 点进去是运行监控。
	await result.getByRole("link").click();
	// 运行监控会把地址再补上 `?view=…`：只比路径。
	await expect.poll(() => new URL(page.url()).pathname).toBe(`/runs/${runId}`);
});

test("成果：提交（第几轮、提交号前 7 位、几个文件、增删行数、展开看差异）、场景版本（链到版本历史）、运行（链到运行监控）；刷新后读回的历史里也有", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent", slots: 4 });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "接口巡检", scenarioUsing("agent"));
	const runId = await triggerRun(controlPlane, scenario);
	await agent.succeed(await agent.nextAssign());
	const hash = "3f1c2ab9d0e4a5b6c7d8e9f0a1b2c3d4e5f60718";
	const id = await seedSession(controlPlane.database.url, {
		title: TITLE,
		status: "idle",
		events: [
			{
				type: "user_message",
				message_id: randomUUID(),
				text: "改一下巡检",
				steer: false,
				author: "tester",
				author_user_id: null,
			},
			{ type: "turn_started", turn: 1 },
			versionEvent(3, scenario, "接口巡检", 1),
			runEvent(4, runId, "接口巡检"),
			commitEvent(5, 1, hash),
			{
				type: "turn_end",
				turn: 1,
				outcome: "completed",
				reason: "助手已完成",
				steps: 1,
				model_calls: 1,
				duration_ms: 1000,
			},
		],
	});
	await page.goto(`/sessions/${id}`);

	const commits = results(page).getByTestId("results-commits");
	await expect(commits.getByTestId("result-commit-turn")).toHaveText("第 1 轮");
	await expect(commits.getByTestId("result-commit-hash")).toContainText("3f1c2ab");
	await expect(commits.getByTestId("result-commit-hash")).not.toContainText("3f1c2ab9");
	await expect(commits.getByTestId("result-commit-stat")).toHaveText("2 个文件 +12 −3");
	await expect(commits.getByTestId("result-commit-diff")).toHaveCount(0);
	await commits.getByRole("button", { name: "展开看差异" }).click();
	await expect(commits.getByTestId("result-commit-files")).toContainText("nodes/http_check.py");
	await expect(commits.getByTestId("result-commit-files")).toContainText("二进制文件");
	await expect(commits.getByTestId("result-commit-diff")).toContainText("+b");
	await commits.getByRole("button", { name: "收起差异" }).click();
	await expect(commits.getByTestId("result-commit-diff")).toHaveCount(0);

	// 时间线上运行和场景版本各一行（样式和助手的话不同）。
	await expect(timeline(page).getByTestId("record-version")).toContainText(
		"保存了场景「接口巡检」的版本 1",
	);
	await expect(timeline(page).getByTestId("record-run")).toContainText("触发了运行");

	const runResult = results(page).getByTestId("results-runs").getByTestId("result-run");
	await expect(runResult.getByTestId("result-run-status")).toHaveText("成功");
	const versionResult = results(page).getByTestId("results-versions").getByTestId("result-version");
	await expect(versionResult).toContainText("接口巡检");
	await expect(versionResult).toContainText("v1");
	await versionResult.getByRole("link").click();
	await expect
		.poll(() => new URL(page.url()).pathname)
		.toBe(`/orchestrations/${scenario}/versions`);
	expect(new URL(page.url()).searchParams.get("b")).toBe("1");
});

test("成果：只读到最近一页事件时说明更早的成果还没有列出", async ({ page, controlPlane }) => {
	// 一页 200 条持久事件：前面 1 条用户的话加 200 条助手的话把平台记录挤到更早的一页里。
	const events: SessionEventBody[] = [
		{
			type: "user_message",
			message_id: randomUUID(),
			text: "做很多事",
			steer: false,
			author: "tester",
			author_user_id: null,
		},
		{ type: "turn_started", turn: 1 },
		{
			type: "platform",
			kind: "run",
			turn: 1,
			run_id: randomUUID(),
			scenario_name: "很早以前的运行",
		},
		...Array.from({ length: 205 }, (_, n) => ({
			type: "assistant_message" as const,
			text: `第 ${n + 1} 句`,
			usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
		})),
		{
			type: "turn_end",
			turn: 1,
			outcome: "completed",
			reason: "助手已完成",
			steps: 1,
			model_calls: 1,
			duration_ms: 1000,
		},
	];
	const id = await seedSession(controlPlane.database.url, { title: TITLE, status: "idle", events });
	await page.goto(`/sessions/${id}`);
	await expect(results(page).getByTestId("results-partial")).toHaveText(
		"更早的成果在加载更早的内容后列出",
	);
	await expect(results(page).getByTestId("result-run")).toHaveCount(0);
	await page.getByRole("button", { name: "加载更早的" }).click();
	await expect(results(page).getByTestId("result-run")).toHaveCount(1);
	await expect(results(page).getByTestId("results-partial")).toHaveCount(0);
});

test("经 会话：会话触发的运行、保存的版本，运行记录、运行监控、控制台和版本历史显示「经 会话「<标题>」」，点它进会话页；人触发的不显示", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent", slots: 4 });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "巡检", scenarioUsing("agent"));
	// 会话做的：运行和第 2 个版本上记着会话（控制面按请求带的会话令牌记的，这里直接写库）。
	const sessionId = await seedSession(controlPlane.database.url, { title: TITLE, status: "idle" });
	const viaSession = await triggerRun(controlPlane, scenario);
	await agent.succeed(await agent.nextAssign());
	const byHand = await triggerRun(controlPlane, scenario);
	await agent.succeed(await agent.nextAssign());
	const running = await triggerRun(controlPlane, scenario);
	await agent.nextAssign();
	const session = { id: sessionId, title: TITLE };
	for (const run of [viaSession, running]) {
		await recordRunSession(controlPlane.database.url, run, session);
	}
	const saved = await controlPlane.fetch(`/orchestrations/${scenario}/versions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "bob" },
		body: JSON.stringify({ base_version: 1, document: scenarioUsing("agent") }),
	});
	expect(saved.status).toBe(201);
	await recordVersionSession(controlPlane.database.url, scenario, 2, session);

	const via = `经 会话「${TITLE}」`;
	await page.goto("/runs");
	const card = (id: string) => page.getByRole("article", { name: `运行 ${id.slice(0, 8)}` });
	await expect(card(running)).toContainText(`tester ${via} 触发`);
	const table = page.getByRole("table", { name: "历史运行" });
	const triggeredBy = (id: string) =>
		table
			.getByRole("row", { name: new RegExp(id.slice(0, 8)) })
			.getByRole("cell")
			.nth(5);
	await expect(triggeredBy(viaSession)).toHaveText(`tester ${via}`);
	await expect(triggeredBy(byHand)).toHaveText("tester");

	await page.goto("/");
	const block = page
		.getByRole("region", { name: "正在运行", exact: true })
		.getByRole("region", { name: "巡检", exact: true })
		.filter({ hasText: running.slice(0, 8) });
	await expect(block).toContainText(`tester ${via} 触发`);

	await page.goto(`/runs/${viaSession}`);
	await expect(page.getByRole("banner")).toContainText(`tester ${via} 触发`);
	await page.goto(`/runs/${byHand}`);
	await expect(page.getByRole("banner")).toContainText("tester 触发");
	await expect(page.getByRole("banner")).not.toContainText("经");

	await page.goto(`/orchestrations/${scenario}/versions`);
	const row = (n: number) =>
		page
			.getByRole("list", { name: "版本" })
			.getByRole("listitem")
			.filter({ has: page.getByText(`v${n}`, { exact: true }) });
	await expect(row(2)).toContainText(`bob ${via} ·`);
	await expect(row(1)).toContainText("tester ·");
	await expect(row(1)).not.toContainText("经");

	// 点标题进会话页。
	await row(2).getByRole("link", { name: TITLE }).click();
	await expect.poll(() => new URL(page.url()).pathname).toBe(`/sessions/${sessionId}`);
	await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
});
