import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
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
/** 时间线上平台记录下面内嵌的运行卡片。 */
const timelineCard = (page: Page, runId: string) =>
	timeline(page).locator(`[data-testid="run-card"][data-run="${runId}"]`);
/** 成果栏里的运行卡片。 */
const sideCard = (page: Page, runId: string) =>
	results(page).locator(`[data-testid="run-card"][data-run="${runId}"]`);
const cardStatus = (card: Locator) => card.getByTestId("run-card-status");
const box = async (locator: Locator) => {
	const found = await locator.boundingBox();
	if (found === null) throw new Error("元素没有占位置");
	return found;
};

/** 页面发出的请求：这个运行的事件流（`/api/runs/:id/events`）和读运行（`/api/runs/:id`）。 */
function watchRunRequests(page: Page) {
	const streams: string[] = [];
	const reads: string[] = [];
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (/^\/api\/runs\/[^/]+\/events$/.test(path)) streams.push(path.split("/")[3] ?? "");
		else if (/^\/api\/runs\/[^/]+$/.test(path)) reads.push(path.split("/")[3] ?? "");
	});
	return { streams, reads };
}

const scenarioEvents = (...events: SessionEventBody[]): SessionEventBody[] => [
	{
		type: "user_message",
		message_id: randomUUID(),
		text: "跑一遍巡检",
		steer: false,
		author: "tester",
		author_user_id: null,
	},
	{ type: "turn_started", turn: 1 },
	...events,
];

test("成果：整栏没有内容时只有一句说明，三块都不显示；助手说「运行成功了」没有真的触发，成果栏和时间线上都没有运行", async ({
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
	await expect(results(page).getByTestId("results-empty")).toHaveText(
		"助手对平台做的事会出现在这里",
	);
	// 没有内容的块不显示（连标题也没有）。
	for (const block of ["results-scenarios", "results-runs", "results-commits"]) {
		await expect(results(page).getByTestId(block)).toHaveCount(0);
	}
	await expect(results(page).getByTestId("run-card")).toHaveCount(0);
	await expect(timeline(page).getByTestId("record-run")).toHaveCount(0);

	// 版面：成果在时间线的右边，输入框在时间线下面，都在窗口里（不靠截图里的眼睛，量元素的位置）。
	const list = await box(timeline(page));
	const side = await box(results(page));
	const composer = await box(page.getByRole("textbox", { name: "接着说" }));
	const viewport = page.viewportSize();
	expect(side.x).toBeGreaterThanOrEqual(list.x + list.width);
	expect(side.x + side.width).toBeLessThanOrEqual(viewport?.width ?? 0);
	expect(composer.x + composer.width).toBeLessThanOrEqual(side.x);
	expect(composer.y).toBeGreaterThanOrEqual(list.y + list.height);
});

test("成果：真的触发了运行（控制面记下的 platform 事件）：时间线上平台记录下面和成果栏里各有一张运行卡片，状态随运行实时变化；刷新后还在", async ({
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
		events: scenarioEvents(),
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
	// 平台记录的外框里内嵌运行卡片；成果栏里是同一个组件：场景名、运行 ID 前 8 位、状态、用时。
	for (const card of [timelineCard(page, runId), sideCard(page, runId)]) {
		await expect(card).toContainText("巡检");
		await expect(card.locator('[data-slot="run-id"]')).toHaveText(runId.slice(0, 8));
		await expect(cardStatus(card)).toHaveText("运行中");
		await expect(card.getByTestId("run-card-elapsed")).toBeVisible();
	}
	await expect(row.locator('[data-testid="run-card"]')).toHaveCount(1);

	// 运行结束：两张卡片的状态跟着变，不用刷新，用时定下来。
	await agent.succeed(assign);
	for (const card of [timelineCard(page, runId), sideCard(page, runId)]) {
		await expect(cardStatus(card)).toHaveText("成功", { timeout: 5_000 });
		await expect(card.getByTestId("run-card-failure")).toHaveCount(0);
	}

	// 点卡片进运行监控。
	await sideCard(page, runId).click();
	// 运行监控会把地址再补上 `?view=…`：只比路径。
	await expect.poll(() => new URL(page.url()).pathname).toBe(`/runs/${runId}`);
});

test("运行卡片：同一次运行从运行中到失败，时间线上的、成果栏里的卡片和运行监控同时变；这次运行在会话页上只有一条事件流连接，状态是推来的不是重新读的", async ({
	page,
	context,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent", slots: 4 });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "巡检", scenarioUsing("agent"));
	const runId = await triggerRun(controlPlane, scenario);
	const assign = await agent.nextAssign();
	const id = await seedSession(controlPlane.database.url, {
		title: TITLE,
		status: "idle",
		events: scenarioEvents(
			{ type: "platform", kind: "run", turn: 1, run_id: runId, scenario_name: "巡检" },
			{
				type: "turn_end",
				turn: 1,
				outcome: "completed",
				reason: "助手已完成",
				steps: 1,
				model_calls: 1,
				duration_ms: 1000,
			},
		),
	});
	const session = watchRunRequests(page);
	await page.goto(`/sessions/${id}`);
	// 运行监控在另一个标签页里同时开着（同一个浏览器，同样的昵称和时间）。
	const monitor = await context.newPage();
	await monitor.addInitScript(() => window.localStorage.setItem("sfly.nickname", "tester"));
	await monitor.clock.setFixedTime(clock.now());
	await monitor.goto(`/runs/${runId}`);
	const banner = monitor.getByRole("banner");
	await expect(banner).toContainText("运行中");
	for (const card of [timelineCard(page, runId), sideCard(page, runId)]) {
		await expect(cardStatus(card)).toHaveText("运行中");
		await expect(card.getByTestId("run-card-failure")).toHaveCount(0);
	}
	// 时间线上一张、成果栏里一张，同一个运行在会话页上只有一条事件流连接。
	expect(session.streams).toEqual([runId]);
	const readsBefore = session.reads.length;

	// 同一次运行失败：三处同时变（卡片是事件流推来的，不等 5 秒一次的重新读）。
	await agent.fail(assign, "AssertionFailed: 成功率 97.2% 低于阈值 99%");
	await expect(banner).toContainText("失败");
	for (const card of [timelineCard(page, runId), sideCard(page, runId)]) {
		await expect(cardStatus(card)).toHaveText("失败", { timeout: 3_000 });
		// 失败时第一个失败的节点和原因一行。
		await expect(card.getByTestId("run-card-failure")).toHaveText(
			"ping：AssertionFailed: 成功率 97.2% 低于阈值 99%",
		);
	}
	expect(session.reads.length).toBe(readsBefore);
	expect(session.streams).toEqual([runId]);
});

test("运行卡片：时间线停在底部时，卡片在事件之外变高（读到状态、失败时多出一行原因）也跟到最新；往上翻看的人不被拉回去", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent", slots: 4 });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "巡检", scenarioUsing("agent"));
	const first = await triggerRun(controlPlane, scenario);
	const firstAssign = await agent.nextAssign();
	const second = await triggerRun(controlPlane, scenario);
	const secondAssign = await agent.nextAssign();
	// 够长的时间线（要滚动），最后是两条运行记录：它们的卡片在时间线的最底下。
	const talk = Array.from({ length: 40 }, (_, n) => ({
		type: "assistant_message" as const,
		text: `第 ${n + 1} 句话，说点什么占个位置。`,
		usage: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
	}));
	const id = await seedSession(controlPlane.database.url, {
		title: TITLE,
		status: "idle",
		events: [
			...scenarioEvents(
				...talk,
				{ type: "platform", kind: "run", turn: 1, run_id: first, scenario_name: "巡检" },
				{ type: "platform", kind: "run", turn: 1, run_id: second, scenario_name: "巡检" },
			),
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
	const scroller = page.getByTestId("session-scroll");
	await expect(cardStatus(timelineCard(page, second))).toHaveText("运行中");
	/** 离底部还差多少像素。 */
	const fromBottom = () =>
		scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
	await expect.poll(fromBottom).toBeLessThan(2);

	// 在底部时，第一个运行失败：卡片多出一行失败原因，时间线跟着滚，这一行和卡片的最后一行都看得见。
	await agent.fail(firstAssign, "AssertionFailed: 成功率 97.2% 低于阈值 99%");
	const failure = timelineCard(page, first).getByTestId("run-card-failure");
	await expect(failure).toBeVisible({ timeout: 3_000 });
	await expect.poll(fromBottom).toBeLessThan(2);
	const view = await box(scroller);
	const line = await box(failure);
	expect(line.y + line.height).toBeLessThanOrEqual(view.y + view.height + 1);

	// 往上翻看之后：第二个运行失败，不把人拉回底部。
	await scroller.evaluate((el) => {
		el.scrollTop = 0;
	});
	await expect.poll(fromBottom).toBeGreaterThan(200);
	await agent.fail(secondAssign, "AssertionFailed: 磁盘写满");
	await expect(cardStatus(timelineCard(page, second))).toHaveText("失败", { timeout: 3_000 });
	await expect(timelineCard(page, second).getByTestId("run-card-failure")).toBeAttached();
	expect(await scroller.evaluate((el) => el.scrollTop)).toBeLessThan(5);
});

test("运行卡片：在跑的运行多于事件流名额（3 个）：最近的三个开事件流，其余的靠定时重新读；名额让出来之后更早的接上", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	// 浏览器对同源只给 6 条连接，会话页自己的事件流占一条：在跑的运行每个开一条的话，五个就把发送、停止、结束会话的请求饿死。
	const agent = await connectAgent({ name: "agent", slots: 8 });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "巡检", scenarioUsing("agent"));
	const runs: string[] = [];
	const assigns = new Map<string, Awaited<ReturnType<typeof agent.nextAssign>>>();
	for (let n = 0; n < 6; n++) {
		runs.push(await triggerRun(controlPlane, scenario));
		const assign = await agent.nextAssign();
		assigns.set(assign.runId, assign);
	}
	const id = await seedSession(controlPlane.database.url, {
		title: TITLE,
		status: "idle",
		events: scenarioEvents(
			...runs.map((runId) => ({
				type: "platform" as const,
				kind: "run" as const,
				turn: 1,
				run_id: runId,
				scenario_name: "巡检",
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
		),
	});
	const watched = watchRunRequests(page);
	await page.goto(`/sessions/${id}`);
	for (const runId of runs) {
		await expect(cardStatus(sideCard(page, runId))).toHaveText("运行中");
		await expect(cardStatus(timelineCard(page, runId))).toHaveText("运行中");
	}
	// 事件流：最近的三个（事件序号大的），每个运行一条，时间线上的和成果栏里的共用。其余三个读到了，没有开流。
	expect([...watched.streams].sort()).toEqual(runs.slice(3).sort());
	expect(new Set(watched.reads).size).toBe(6);

	// 有事件流的最近的一个结束：马上变（推来的），名额让给更早的、还在跑的（第 3 个），它开一条事件流。
	const newest = runs[5] as string;
	await agent.succeed(assigns.get(newest) as never);
	await expect(cardStatus(sideCard(page, newest))).toHaveText("成功", { timeout: 3_000 });
	await expect.poll(() => watched.streams.includes(runs[2] as string)).toBe(true);
	expect(watched.streams.filter((runId) => runId === runs[2])).toHaveLength(1);
	expect(watched.streams).toHaveLength(4);

	// 没有名额的运行结束：下一次定时重新读（5 秒一次）时变，结束了的运行之后不再被读。
	const oldest = runs[0] as string;
	await agent.succeed(assigns.get(oldest) as never);
	await expect(cardStatus(sideCard(page, oldest))).toHaveText("成功", { timeout: 15_000 });
	await expect(cardStatus(timelineCard(page, oldest))).toHaveText("成功");
	expect(watched.streams).toHaveLength(4);
});

test("成果：场景块（场景名链到场景页；这个会话保存过的版本，多个时列出并给对比，点进版本历史选中这几个版本）；最近保存的场景在前", async ({
	page,
	controlPlane,
}) => {
	const save = async (scenarioId: string, base: number) => {
		const saved = await controlPlane.fetch(`/orchestrations/${scenarioId}/versions`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-sfly-nickname": "tester" },
			body: JSON.stringify({ base_version: base, document: scenarioUsing("agent") }),
		});
		expect(saved.status).toBe(201);
	};
	// 接口巡检：这个会话保存了 v2、v3（v1 是人建的）；磁盘巡检：保存了 v1。
	const patrol = await createScenario(controlPlane, "接口巡检", scenarioUsing("agent"));
	await save(patrol, 1);
	await save(patrol, 2);
	const disk = await createScenario(controlPlane, "磁盘巡检", scenarioUsing("agent"));
	const id = await seedSession(controlPlane.database.url, {
		title: TITLE,
		status: "idle",
		events: [
			...scenarioEvents(
				versionEvent(3, patrol, "接口巡检", 2),
				versionEvent(4, disk, "磁盘巡检", 1),
				versionEvent(5, patrol, "接口巡检", 3),
			),
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
	const block = results(page).getByTestId("results-scenarios");
	const items = block.getByTestId("result-scenario");
	// 最近保存的在前：接口巡检（最近一次是第 5 条事件）在磁盘巡检前面；每个场景一项，不是每个版本一项。
	await expect(items).toHaveCount(2);
	await expect(items.nth(0)).toContainText("接口巡检");
	await expect(items.nth(1)).toContainText("磁盘巡检");
	await expect(items.nth(0).getByTestId("result-version")).toHaveText(["v2", "v3"]);
	await expect(items.nth(0).getByTestId("result-compare")).toHaveText("对比 v2 和 v3");
	// 只保存过一个版本的没有对比。
	await expect(items.nth(1).getByTestId("result-version")).toHaveText(["v1"]);
	await expect(items.nth(1).getByTestId("result-compare")).toHaveCount(0);

	// 点只保存过一个版本的：版本历史里选中那个版本。
	await items.nth(1).getByTestId("result-version").click();
	await expect.poll(() => new URL(page.url()).pathname).toBe(`/orchestrations/${disk}/versions`);
	expect(new URL(page.url()).searchParams.get("b")).toBe("1");

	// 点对比：版本历史里选中这几个版本（最早保存的在 A，最近保存的在 B）。
	await page.goBack();
	await items.nth(0).getByTestId("result-compare").click();
	await expect.poll(() => new URL(page.url()).pathname).toBe(`/orchestrations/${patrol}/versions`);
	const search = new URL(page.url()).searchParams;
	expect([search.get("a"), search.get("b")]).toEqual(["2", "3"]);
	await expect(page.getByRole("button", { name: "把版本 2 放在左侧（A）" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.getByRole("button", { name: "把版本 3 放在右侧（B）" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	// 点场景名：场景页。
	await page.goBack();
	await items.nth(0).getByRole("link", { name: "接口巡检" }).click();
	await expect.poll(() => new URL(page.url()).pathname).toBe(`/orchestrations/${patrol}`);
});

test("成果：工作区的提交块（最近的在前；第几轮、提交号前 7 位、几个文件、增删行数、展开看差异）；只有这一块有内容时别的块不显示", async ({
	page,
	controlPlane,
}) => {
	const id = await seedSession(controlPlane.database.url, {
		title: TITLE,
		status: "idle",
		events: [
			...scenarioEvents(
				commitEvent(3, 1, "3f1c2ab9d0e4a5b6c7d8e9f0a1b2c3d4e5f60718"),
				commitEvent(4, 2, "9a8b7c6d5e4f30211203948576a1b2c3d4e5f607"),
			),
			{
				type: "turn_end",
				turn: 2,
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
	// 别的块没有内容：不显示，整栏也不写「还没有内容」的那一句。
	await expect(results(page).getByTestId("results-scenarios")).toHaveCount(0);
	await expect(results(page).getByTestId("results-runs")).toHaveCount(0);
	await expect(results(page).getByTestId("results-empty")).toHaveCount(0);
	// 最近的（第 2 轮）在前。
	await expect(commits.getByTestId("result-commit-turn")).toHaveText(["第 2 轮", "第 1 轮"]);
	const first = commits.getByTestId("result-commit").nth(1);
	await expect(first.getByTestId("result-commit-hash")).toContainText("3f1c2ab");
	await expect(first.getByTestId("result-commit-hash")).not.toContainText("3f1c2ab9");
	await expect(first.getByTestId("result-commit-stat")).toHaveText("2 个文件 +12 −3");
	await expect(first.getByTestId("result-commit-diff")).toHaveCount(0);
	await first.getByRole("button", { name: "展开看差异" }).click();
	await expect(first.getByTestId("result-commit-files")).toContainText("nodes/http_check.py");
	await expect(first.getByTestId("result-commit-files")).toContainText("二进制文件");
	await expect(first.getByTestId("result-commit-diff")).toContainText("+b");
	await first.getByRole("button", { name: "收起差异" }).click();
	await expect(first.getByTestId("result-commit-diff")).toHaveCount(0);
});

test("成果：三块都有内容时各块里最近的在前；刷新后读回的历史里也有；时间线上运行和场景版本各一行", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent", slots: 4 });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "接口巡检", scenarioUsing("agent"));
	const older = await triggerRun(controlPlane, scenario);
	await agent.succeed(await agent.nextAssign());
	const newer = await triggerRun(controlPlane, scenario);
	await agent.succeed(await agent.nextAssign());
	const id = await seedSession(controlPlane.database.url, {
		title: TITLE,
		status: "idle",
		events: [
			...scenarioEvents(
				versionEvent(3, scenario, "接口巡检", 1),
				runEvent(4, older, "接口巡检"),
				commitEvent(5, 1, "3f1c2ab9d0e4a5b6c7d8e9f0a1b2c3d4e5f60718"),
				runEvent(6, newer, "接口巡检"),
			),
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
	// 各块的次序：场景、运行、工作区的提交。
	await expect(results(page).locator("section[data-testid^='results-'] h3")).toHaveText([
		/^场景/,
		/^运行/,
		/^工作区的提交/,
	]);
	// 运行块里最近的在前。
	await expect(results(page).getByTestId("result-run")).toHaveCount(2);
	expect(
		await results(page)
			.getByTestId("result-run")
			.evaluateAll((items) => items.map((item) => item.getAttribute("data-run"))),
	).toEqual([newer, older]);
	for (const runId of [newer, older]) {
		await expect(cardStatus(sideCard(page, runId))).toHaveText("成功");
		await expect(cardStatus(timelineCard(page, runId))).toHaveText("成功");
	}
	// 时间线上运行和场景版本各一行（样式和助手的话不同）。
	await expect(timeline(page).getByTestId("record-version")).toContainText(
		"保存了场景「接口巡检」的版本 1",
	);
	await expect(timeline(page).getByTestId("record-run")).toHaveCount(2);
});

test.describe("窄窗口", () => {
	test.use({ viewport: { width: 800, height: 900 } });

	test("成果栏收到时间线和输入框下面，页面不横向滚动；时间线和输入框还在", async ({
		page,
		controlPlane,
		connectAgent,
	}) => {
		const agent = await connectAgent({ name: "agent", slots: 4 });
		await publishPackage(controlPlane);
		const scenario = await createScenario(controlPlane, "接口巡检", scenarioUsing("agent"));
		const runId = await triggerRun(controlPlane, scenario);
		await agent.nextAssign();
		const id = await seedSession(controlPlane.database.url, {
			title: TITLE,
			status: "idle",
			events: [
				...scenarioEvents(
					versionEvent(3, scenario, "接口巡检", 1),
					runEvent(4, runId, "接口巡检"),
					commitEvent(5, 1, "3f1c2ab9d0e4a5b6c7d8e9f0a1b2c3d4e5f60718"),
				),
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
		await expect(results(page).getByTestId("result-run")).toHaveCount(1);
		const list = await box(timeline(page));
		const composer = await box(page.getByRole("textbox", { name: "接着说" }));
		const side = await box(results(page));
		// 成果在时间线和输入框下面，宽度和它们差不多（不是 18rem 的窄条）。
		expect(side.y).toBeGreaterThanOrEqual(composer.y + composer.height);
		expect(side.y).toBeGreaterThanOrEqual(list.y + list.height);
		expect(side.width).toBeGreaterThan(400);
		// 时间线还有地方看（不被挤成一条缝），整页不横向滚动，成果栏在窗口里。
		expect(list.height).toBeGreaterThan(150);
		expect(side.x + side.width).toBeLessThanOrEqual(800);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
		// 成果栏自己最高占窗口高度的四成，超出的在里面滚。
		const scroller = await box(page.getByTestId("session-results-scroll"));
		expect(scroller.height).toBeLessThanOrEqual(900 * 0.4 + 1);
		await expect(sideCard(page, runId)).toBeVisible();
	});
});

test("成果：场景名当作别人写的文字、限宽：太长的在时间线的行里和成果栏里截断，悬停给全文，行还是一行、不超出成果栏", async ({
	page,
	controlPlane,
}) => {
	// 会话令牌能新建、改名场景：名字可以很长，里面也可以有看不见的字符（这里是一个从右到左的方向标记）。
	const name = `${"很长的场景名".repeat(20)}\u202e结尾`;
	const shown = name.replace("\u202e", "⟨U+202E⟩");
	const id = await seedSession(controlPlane.database.url, {
		title: TITLE,
		status: "idle",
		events: [
			{
				type: "user_message",
				message_id: randomUUID(),
				text: "做一个很长名字的场景",
				steer: false,
				author: "tester",
				author_user_id: null,
			},
			{ type: "turn_started", turn: 1 },
			{
				type: "platform",
				kind: "scenario_version",
				turn: 1,
				scenario_id: randomUUID(),
				name,
				version: 1,
			},
			{ type: "platform", kind: "run", turn: 1, run_id: randomUUID(), scenario_name: name },
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
	const panel = await box(results(page));
	// 悬停给全文；看完把鼠标移开、等提示收起，不让它挡住下一个要悬停的地方。
	const tooltip = page.locator('[data-slot="tooltip-content"]');
	const hoverShows = async (target: ReturnType<Page["locator"]>, text: string) => {
		await target.hover();
		await expect(tooltip).toContainText(text);
		await page.mouse.move(0, 0);
		await expect(tooltip).toHaveCount(0);
	};

	// 时间线上的两行：名字最宽 18rem（288px），截断了，行还是一行高。
	// （运行那一行下面内嵌的运行卡片在行里排在后面：「行」指标签那一行，名字取第一个截断层。）
	for (const kind of ["record-run", "record-version"]) {
		const row = timeline(page).getByTestId(kind);
		const clipped = row.locator('[data-slot="truncate"]').first();
		await expect(clipped).toHaveAttribute("data-truncated", "true");
		expect((await box(clipped)).width).toBeLessThanOrEqual(288);
		expect((await box(row.locator(":scope > div").first())).height).toBeLessThan(40);
		await hoverShows(clipped, shown);
	}

	// 成果栏里的场景和运行卡片：名字截断，链接不超出成果栏，悬停给全文（方向标记写成文字）。
	for (const testId of ["result-scenario", "result-run"]) {
		const item = results(page).getByTestId(testId);
		const found = await box(item);
		expect(found.x + found.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
		await hoverShows(item.getByRole("link").first(), shown);
	}
	// 时间线上的运行卡片同样：不超出时间线，悬停给全文。
	const inline = timeline(page).getByTestId("record-run").getByTestId("run-card");
	expect((await box(inline)).width).toBeLessThanOrEqual(448);
	await hoverShows(inline, shown);
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
	// 标题很长的会话（会话的标题是第一句话，别人写的）做的、还在跑的运行。
	const longTitle = `${"很长的一句话".repeat(20)}结尾`;
	const longSessionId = await seedSession(controlPlane.database.url, {
		title: longTitle,
		status: "idle",
	});
	const viaLong = await triggerRun(controlPlane, scenario);
	await agent.nextAssign();
	await recordRunSession(controlPlane.database.url, viaLong, {
		id: longSessionId,
		title: longTitle,
	});
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

	// 标题很长：「经 会话」的链接有最大宽度（14rem），放不下的截断，悬停给全文，链接还是去那个会话。
	const longLink = card(viaLong).locator('[data-via="session"] a');
	await expect(longLink).toHaveAttribute("data-truncated", "true");
	await expect(longLink).toHaveText(longTitle);
	expect((await longLink.boundingBox())?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
		224,
	);
	await longLink.hover();
	await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(longTitle);
	await expect(longLink).toHaveAttribute("href", `/sessions/${longSessionId}`);

	await page.goto("/");
	const block = page
		.getByRole("region", { name: "正在运行", exact: true })
		.getByRole("region", { name: "巡检", exact: true })
		.filter({ hasText: running.slice(0, 8) });
	await expect(block).toContainText(`tester ${via} 触发`);

	// 运行抽屉的摘要：在抽屉里触发的运行，之后记上了会话（直接写库），运行有新的变化时摘要读到它。
	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	const triggered = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" &&
			new URL(response.url()).pathname === `/api/orchestrations/${scenario}/runs`,
	);
	await drawer.getByRole("button", { name: "触发运行" }).click();
	const drawerRun = ((await (await triggered).json()) as { id: string }).id;
	const summary = drawer.getByRole("region", { name: "运行摘要" });
	await expect(summary).toContainText("tester 触发");
	await expect(summary).not.toContainText("经");
	await recordRunSession(controlPlane.database.url, drawerRun, session);
	await agent.succeed(await agent.nextAssign());
	await expect(summary).toContainText(`tester ${via} 触发`);
	await expect(summary.locator('[data-via="session"] a')).toHaveAttribute(
		"href",
		`/sessions/${sessionId}`,
	);

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
	// 下面并排的两个版本（默认是 v1 和最新的 v2），右边（B）的标题行也写「经 会话」，左边（A）是人保存的，不写。
	const paneOf = (n: number) => page.getByText("只读", { exact: true }).nth(n).locator("..");
	const left = paneOf(0);
	const pane = paneOf(1);
	await expect(left).toContainText("tester ·");
	await expect(left).not.toContainText("经");
	await expect(pane).toContainText(`bob ${via} ·`);
	await expect(pane.locator('[data-via="session"] a')).toHaveAttribute(
		"href",
		`/sessions/${sessionId}`,
	);

	// 点标题进会话页。
	await row(2).getByRole("link", { name: TITLE }).click();
	await expect.poll(() => new URL(page.url()).pathname).toBe(`/sessions/${sessionId}`);
	await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
});
