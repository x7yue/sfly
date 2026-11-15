import type { Page, Request } from "@playwright/test";
import { runsApi } from "@sfly/schema";
import { type AssignedTask, LogLevel, LogSource } from "../../server/test/support/fake-agent.js";
import { expect, test } from "./fixtures";
import { runningScenario } from "./monitor-scenario";

// 运行监控页的地址能带节点、底部页签和一个时刻（控制面时间），日志定位到包含那一刻的一页（#347）：
// 正好有一行日志（1 秒以内）就高亮它（中性的白色短条），没有就在那一刻的位置插一条「这一刻」；
// 从这一页往前、往后翻页和实时接续照常。

const panel = (page: Page) => page.getByRole("region", { name: "底部面板" });
const logsOf = (page: Page) => panel(page).getByRole("log", { name: "日志" });
const scope = (page: Page) => panel(page).getByTestId("bp-scope");
/** 页面上的时刻（浏览器时区 Asia/Shanghai）：`08:00:10.000`。 */
const clockMs = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(11, 23);
/** 这些行的 Agent 时间比控制面快 3 小时 25 分 7 秒：时间列默认显示 Agent 时间，定位只看控制面时间。 */
const AGENT_AHEAD_MS = (3 * 3600 + 25 * 60 + 7) * 1000;

/** 运行监控页的地址：节点、页签、时刻（UTC 的 ISO 8601）。 */
const monitorUrl = (runId: string, query: Record<string, string>) =>
	`/runs/${runId}?${new URLSearchParams(query)}`;

/** 运行开始之后第 atMs 毫秒（控制面时间）Agent 读到的一行。 */
const logAt =
	(agent: { monotonicAt(unixMs: number): bigint }, clock0: number) =>
	(seq: number, atMs: number, text: string, level = LogLevel.INFO) => ({
		seq: BigInt(seq),
		timeUnixMs: BigInt(clock0 + atMs + AGENT_AHEAD_MS),
		monotonicMs: agent.monotonicAt(clock0 + atMs),
		source: LogSource.STDOUT,
		level,
		text,
	});

const iso = (ms: number) => new Date(ms).toISOString();

test("地址带节点、页签和时刻：选中这个节点，切到日志页签，定位到那一刻，正好有一行时高亮它", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const clock0 = clock.now().getTime();
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const at = logAt(agent, clock0);
	// probe 在第 7 秒到第 13 秒之间每 10 毫秒一行：第 k 行在第 7 + k × 0.01 秒，一共 600 行，大于一页（300 行）。
	agent.logs(
		tasks.probe as AssignedTask,
		Array.from({ length: 600 }, (_, i) => at(i + 1, 7_000 + (i + 1) * 10, `probe line ${i + 1}`)),
	);
	await agent.sync();

	// 第 300 行的时间，再偏后 4 毫秒：不是任何一行的时间，但离第 300 行最近。
	await page.goto(monitorUrl(runId, { node: "probe", tab: "logs", at: iso(clock0 + 10_004) }));
	const logs = logsOf(page);
	await expect(scope(page)).toHaveText("范围：probe");
	const located = logs.locator("[data-located]");
	await expect(located).toHaveCount(1);
	await expect(located).toContainText("probe line 300");
	await expect(located).toHaveAttribute("aria-current", "location");
	await expect(located).toBeInViewport();
	await expect(logs.locator("[data-moment]")).toHaveCount(0);
	// 这一页之前、之后都还有行，用向上、向下滚动接着读。
	await expect(logs.getByRole("button", { name: /加载更早的日志/ })).toBeVisible();
	await expect(logs.getByRole("button", { name: /加载更新的日志/ })).toBeVisible();
});

test("没有正好对应的行：在那一刻的位置插一条「这一刻」，不高亮别的行；正好有一行（1 秒以内）时高亮它、不插标记", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const clock0 = clock.now().getTime();
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const at = logAt(agent, clock0);
	agent.logs(tasks.probe as AssignedTask, [
		at(1, 7_000, "probe one"),
		at(2, 8_000, "probe two"),
		at(3, 12_000, "probe three"),
		at(4, 13_000, "probe four"),
	]);
	await agent.sync();
	const logs = logsOf(page);

	// 第 10 秒：离第二行、第三行都是 2 秒。
	await page.goto(monitorUrl(runId, { node: "probe", at: iso(clock0 + 10_000) }));
	await expect(scope(page)).toHaveText("范围：probe");
	const marker = logs.locator("[data-moment]");
	await expect(marker).toHaveCount(1);
	await expect(marker).toHaveText(`这一刻 控制面时间 ${clockMs(clock0 + 10_000)}`);
	await expect(logs.locator("[data-located]")).toHaveCount(0);
	await expect(marker).toBeInViewport();
	// 前后的行照常显示，标记在第二行和第三行之间。
	await expect(logs.locator("[data-index]")).toContainText([
		"probe one",
		"probe two",
		"这一刻",
		"probe three",
		"probe four",
	]);
	// 「这一刻」不是日志行：方向键从第二行走到第三行，跳过它。
	await logs.getByRole("button", { name: /probe two/ }).focus();
	await page.keyboard.press("ArrowDown");
	await expect(logs.getByRole("button", { name: /probe three/ })).toBeFocused();
	await page.keyboard.press("ArrowUp");
	await expect(logs.getByRole("button", { name: /probe two/ })).toBeFocused();

	// 第 8.4 秒：第二行之后 0.4 秒，算正好有这一行。
	await page.goto(monitorUrl(runId, { node: "probe", at: iso(clock0 + 8_400) }));
	await expect(logs.locator("[data-located]")).toContainText("probe two");
	await expect(logs.locator("[data-located]")).toHaveCount(1);
	await expect(logs.locator("[data-moment]")).toHaveCount(0);

	// 第 9.1 秒：离第二行 1.1 秒，已经不算正好有。
	await page.goto(monitorUrl(runId, { node: "probe", at: iso(clock0 + 9_100) }));
	await expect(logs.locator("[data-moment]")).toHaveCount(1);
	await expect(logs.locator("[data-located]")).toHaveCount(0);
});

test("时刻早于第一行、晚于最后一行时分别定位到开头和末尾，标记在最前和最后", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const clock0 = clock.now().getTime();
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const at = logAt(agent, clock0);
	agent.logs(tasks.probe as AssignedTask, [at(1, 8_000, "probe one"), at(2, 9_000, "probe two")]);
	await agent.sync();
	const logs = logsOf(page);

	await page.goto(monitorUrl(runId, { node: "probe", at: iso(clock0 + 6_500) }));
	await expect(logs.locator("[data-index]")).toContainText(["这一刻", "probe one", "probe two"]);
	await page.goto(monitorUrl(runId, { node: "probe", at: iso(clock0 + 12_000) }));
	await expect(logs.locator("[data-index]")).toContainText(["probe one", "probe two", "这一刻"]);
});

test("节点重试过：时刻落在哪一次尝试，就打开哪一次尝试的日志", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const clock0 = clock.now().getTime();
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const at = logAt(agent, clock0);
	const run = runsApi.get.response.parse(await (await controlPlane.fetch(`/runs/${runId}`)).json());
	const first = run.chains[0]?.nodes.find((n) => n.node_id === "verify")?.attempts[0];
	if (!first) throw new Error("没有 verify 的第 1 次尝试");
	// 第 1 次尝试在第 6 到 9 秒，第 2 次从第 9 秒开始。
	agent.logs({ taskId: first.task_id, attempt: 1 }, [
		at(1, 7_000, "verify 1 checking"),
		at(2, 8_500, "AssertionError: 漏拦 3 笔", LogLevel.ERROR),
	]);
	agent.logs(tasks.verify as AssignedTask, [at(1, 11_000, "verify 2 retrying")]);
	await agent.sync();
	const logs = logsOf(page);
	const attempt = (n: number) =>
		panel(page)
			.getByRole("group", { name: "尝试" })
			.getByRole("button", { name: `第 ${n} 次` });

	await page.goto(monitorUrl(runId, { node: "verify", at: iso(clock0 + 8_500) }));
	await expect(attempt(1)).toHaveAttribute("aria-pressed", "true");
	await expect(logs.locator("[data-located]")).toContainText("AssertionError: 漏拦 3 笔");
	await expect(logs).not.toContainText("verify 2 retrying");

	await page.goto(monitorUrl(runId, { node: "verify", at: iso(clock0 + 11_000) }));
	await expect(attempt(2)).toHaveAttribute("aria-pressed", "true");
	await expect(logs.locator("[data-located]")).toContainText("verify 2 retrying");

	// 手动换到第 1 次尝试：那一刻不在它的日志里，不再定位，回到它的最后一页。
	await attempt(1).click();
	await expect(logs).toContainText("AssertionError: 漏拦 3 笔");
	await expect(logs.locator("[data-located]")).toHaveCount(0);
	await expect(logs.locator("[data-moment]")).toHaveCount(0);
});

test("从定位到的那一页往前翻页、往后翻页：行连续不重复，翻到末尾后实时流才接上，新写入的行照常出现", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const clock0 = clock.now().getTime();
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const at = logAt(agent, clock0);
	const probe = tasks.probe as AssignedTask;
	agent.logs(
		probe,
		Array.from({ length: 700 }, (_, i) => at(i + 1, 7_000 + (i + 1) * 10, `probe line ${i + 1}`)),
	);
	await agent.sync();

	/** 这个任务的日志分页请求（查询参数）和实时流连接的次数。 */
	const pageQueries: string[] = [];
	let events = 0;
	page.on("request", (req: Request) => {
		const url = new URL(req.url());
		if (url.pathname === `/api/tasks/${probe.taskId}/logs`) pageQueries.push(url.search);
		if (url.pathname === `/api/tasks/${probe.taskId}/logs/events`) events++;
	});
	const read: number[] = [];
	page.on("response", async (res) => {
		const url = new URL(res.url());
		if (url.pathname !== `/api/tasks/${probe.taskId}/logs`) return;
		const body = (await res.json()) as { lines: { seq: number }[] };
		read.push(...body.lines.map((l) => l.seq));
	});

	// 第 350 行：一页是第 200 到 499 行。
	await page.goto(monitorUrl(runId, { node: "probe", at: iso(clock0 + 7_000 + 3_500) }));
	const logs = logsOf(page);
	await expect(logs.locator("[data-located]")).toContainText("probe line 350");
	// 还没读到末尾：不连实时流。
	expect(events).toBe(0);

	// 向上滚动一直读到开头。
	for (let n = 0; n < 4; n++) {
		if ((await logs.getByRole("button", { name: /加载更早的日志/ }).count()) === 0) break;
		await logs.evaluate((el) => {
			el.scrollTop = 0;
		});
		await expect(logs.getByRole("button", { name: "正在加载更早的日志…" })).toHaveCount(0);
	}
	await expect(logs.getByRole("button", { name: /加载更早的日志/ })).toHaveCount(0);
	await expect(logs).toContainText("probe line 1");
	expect(events).toBe(0);

	// 向下滚动一直读到末尾：之后才连实时流。
	for (let n = 0; n < 4; n++) {
		if ((await logs.getByRole("button", { name: /加载更新的日志/ }).count()) === 0) break;
		await logs.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		await expect(logs.getByRole("button", { name: "正在加载更新的日志…" })).toHaveCount(0);
	}
	await expect(logs.getByRole("button", { name: /加载更新的日志/ })).toHaveCount(0);
	await expect.poll(() => events).toBe(1);
	await logs.evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	await expect(logs).toContainText("probe line 700");

	// 实时接续：新写入的行出现在末尾，每一行恰好一次。
	agent.logs(probe, [at(701, 14_000, "probe live line")]);
	await expect(logs.getByRole("button", { name: /probe live line/ })).toHaveCount(1);
	await expect(logs.getByRole("button", { name: /probe line 700/ })).toHaveCount(1);
	// 定位的一页、往前翻的页、往后翻的页首尾相接：700 行每一行恰好读到一次，每页只请求一次。
	expect(read.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 700 }, (_, i) => i + 1));
	expect(new Set(pageQueries).size).toBe(pageQueries.length);
});

test("页面打开之后地址变了：选中新的节点，定位到新的时刻", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const clock0 = clock.now().getTime();
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const at = logAt(agent, clock0);
	agent.logs(tasks.probe as AssignedTask, [
		at(1, 7_000, "probe one"),
		at(2, 8_000, "probe two"),
		at(3, 12_000, "probe three"),
	]);
	await agent.sync();
	const logs = logsOf(page);
	/** 页面内的导航（不重新加载页面）：路由按地址栏的变化更新。 */
	const navigate = (query: Record<string, string>) =>
		page.evaluate(
			(url) => {
				history.pushState(null, "", url);
				dispatchEvent(new PopStateEvent("popstate"));
			},
			monitorUrl(runId, query),
		);

	await page.goto(monitorUrl(runId, { node: "fetch" }));
	await expect(scope(page)).toHaveText("范围：fetch");

	await navigate({ node: "probe", tab: "logs", at: iso(clock0 + 8_000) });
	await expect(scope(page)).toHaveText("范围：probe");
	await expect(logs.locator("[data-located]")).toContainText("probe two");

	await navigate({ node: "probe", tab: "logs", at: iso(clock0 + 12_000) });
	await expect(logs.locator("[data-located]")).toContainText("probe three");
	await expect(logs.locator("[data-located]")).toHaveCount(1);

	await navigate({ node: "probe", tab: "attempts" });
	await expect(panel(page).getByRole("tab", { name: "尝试" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
});

test("页签参数切到对应的页签；不合法的页签和时刻当作没给，没有节点时时刻不生效", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const clock0 = clock.now().getTime();
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const at = logAt(agent, clock0);
	agent.logs(tasks.probe as AssignedTask, [at(1, 7_000, "probe one"), at(2, 8_000, "probe two")]);
	await agent.sync();
	const logs = logsOf(page);
	const tab = (name: string) => panel(page).getByRole("tab", { name });

	await page.goto(monitorUrl(runId, { node: "probe", tab: "attempts" }));
	await expect(scope(page)).toHaveText("范围：probe");
	await expect(tab("尝试")).toHaveAttribute("aria-selected", "true");

	await page.goto(monitorUrl(runId, { node: "probe", tab: "wrong", at: "昨天下午" }));
	await expect(scope(page)).toHaveText("范围：probe");
	await expect(tab("日志")).toHaveAttribute("aria-selected", "true");
	await expect(logs).toContainText("probe two");
	await expect(logs.locator("[data-located]")).toHaveCount(0);
	await expect(logs.locator("[data-moment]")).toHaveCount(0);

	// 只有时刻、没有节点：合并视图不支持按时刻定位，照常显示全部节点的日志。
	await page.goto(monitorUrl(runId, { at: iso(clock0 + 8_000) }));
	await expect(scope(page)).toHaveText("范围：全部节点");
	await expect(logs).toContainText("probe two");
	await expect(logs.locator("[data-located]")).toHaveCount(0);
	await expect(logs.locator("[data-moment]")).toHaveCount(0);
});
