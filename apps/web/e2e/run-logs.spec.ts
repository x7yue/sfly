import { readFile } from "node:fs/promises";
import type { Locator, Page, Request } from "@playwright/test";
import { logsApi, RunLogDownloadRow, runsApi } from "@sfly/schema";
import {
	type AssignedTask,
	type FakeAgent,
	LogLevel,
	LogSource,
} from "../../server/test/support/fake-agent.js";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { expect, test } from "./fixtures";
import { openMonitor, type Running, runningScenario } from "./monitor-scenario";
import { createScenario, publishPackage, scenarioUsing, triggerRun } from "./support";

// 没选中节点时，日志页签按控制面时间合并显示整次运行全部节点的日志（#222），向上滚动加载更早的（#223）；
// 有节点筛选时只合并显示筛选出的节点，可以按级别筛选，点来源节点名切到这个节点（#224）；
// 运行执行中时实时显示新写入的行，晚到的行插到它按控制面时间应在的位置（#225）；
// 合并视图下的下载按钮下载范围内整次运行合并后的日志（#226）。

const timeline = (page: Page) => page.getByRole("region", { name: "链路时间线" });
const panel = (page: Page) => page.getByRole("region", { name: "底部面板" });
const nodeButton = (page: Page, id: string) =>
	timeline(page).locator(`[data-node-row="${id}"] button`);
const workspace = (page: Page) => page.getByRole("region", { name: "图表工作区" });
const levelFilter = (page: Page) => panel(page).getByRole("group", { name: "日志级别" });
/** 页面上的时刻（浏览器时区 Asia/Shanghai）：`08:00:11.000`。 */
const clockMs = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(11, 23);
/** 这些行的 Agent 时间比控制面快 3 小时 25 分 7 秒（同一天）：两种时间的时分秒不一样。 */
const AGENT_AHEAD_MS = (3 * 3600 + 25 * 60 + 7) * 1000;

test("没选中节点时合并显示全部节点的日志：按控制面时间交错排列，每行标出来源节点；选中节点只看它，取消后回到合并", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const clock0 = clock.now().getTime();
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const run = runsApi.get.response.parse(await (await controlPlane.fetch(`/runs/${runId}`)).json());
	const verify1 = run.chains[0]?.nodes.find((n) => n.node_id === "verify")?.attempts[0];
	if (!verify1) throw new Error("没有 verify 的第 1 次尝试");
	/** Agent 在控制面时间（运行开始后第 atMs 毫秒）读到的一行。 */
	const at = (seq: number, atMs: number, text: string, level = LogLevel.INFO) => ({
		seq: BigInt(seq),
		timeUnixMs: BigInt(clock0 + atMs + AGENT_AHEAD_MS),
		monotonicMs: agent.monotonicAt(clock0 + atMs),
		source: LogSource.STDOUT,
		level,
		text,
	});
	// fetch 在第 2 秒写了 4 行（runningScenario）；之后 verify 第 1 次、子流程的 probe、verify 第 2 次交错输出。
	agent.logs({ taskId: verify1.task_id, attempt: 1 }, [
		at(1, 7_000, "verify 1 checking"),
		at(2, 8_500, "AssertionError: 漏拦 3 笔", LogLevel.ERROR),
	]);
	agent.logs(tasks.probe as AssignedTask, [
		at(1, 7_500, "probe started"),
		at(2, 12_500, "probe tick"),
	]);
	agent.logs(tasks.verify as AssignedTask, [at(1, 11_000, "verify 2 retrying")]);
	await agent.sync();

	await openMonitor(page, clock, runId);
	const scope = panel(page).getByTestId("bp-scope");
	const logs = panel(page).getByRole("log", { name: "日志" });
	// 默认选中执行中的 verify：只看它这一次尝试，没有来源节点列。
	await expect(scope).toHaveText("范围：verify（第 2 次）");
	await expect(logs.getByRole("button")).toHaveCount(1);
	await expect(logs.locator("[data-log-origin]")).toHaveCount(0);

	await nodeButton(page, "verify").click();
	await expect(scope).toHaveText("范围：全部节点");
	const rows = logs.getByRole("button");
	await expect(rows).toContainText([
		"开始执行",
		"load config ok",
		"retrying request (1/3): connection reset",
		"batch committed",
		"verify 1 checking",
		"probe started",
		"AssertionError: 漏拦 3 笔",
		"verify 2 retrying",
		"probe tick",
	]);
	await expect(rows).toHaveCount(9);
	// 主链只有一次尝试的节点只写节点 ID；有多次尝试的带上序号；子流程里的节点前面是子流程名。
	await expect(logs.locator("[data-log-origin]")).toHaveText([
		"fetch",
		"fetch",
		"fetch",
		"fetch",
		"verify #1",
		"sub / probe",
		"verify #1",
		"verify #2",
		"sub / probe",
	]);

	// 时间列照常切换：默认 Agent 时间，切到控制面时间。
	const retrying = logs.getByRole("button", { name: /verify 2 retrying/ });
	await expect(retrying.locator("[data-log-time]")).toHaveText(
		clockMs(clock0 + 11_000 + AGENT_AHEAD_MS),
	);
	await panel(page).getByRole("button", { name: "控制面时间", exact: true }).click();
	await expect(retrying.locator("[data-log-time]")).toHaveText(clockMs(clock0 + 11_000));

	// 点一行：时间线上标出这一刻，选中的节点不变（仍是全部节点）。
	await retrying.click();
	await expect(retrying).toHaveAttribute("data-marked", "true");
	await expect(timeline(page).locator("[data-marker-line]")).toBeVisible();
	await expect(timeline(page).locator('[data-node-row] button[aria-pressed="true"]')).toHaveCount(
		0,
	);
	await expect(scope).toHaveText("范围：全部节点");
	await retrying.click();
	await expect(timeline(page).locator("[data-marker-line]")).toHaveCount(0);

	// 在时间线上框选后半段：合并视图只留下这段时间里的行。
	const track = await timeline(page).locator('[data-node-row="fetch"] > div').boundingBox();
	if (!track) throw new Error("没有轨道");
	const y = track.y + track.height / 2;
	await page.mouse.move(track.x + track.width * 0.7, y);
	await page.mouse.down();
	await page.mouse.move(track.x + track.width * 0.99, y, { steps: 5 });
	await page.mouse.up();
	await expect(scope).toHaveText("范围：全部节点 · 已按时间范围过滤");
	await expect(rows).toContainText(["verify 2 retrying", "probe tick"]);
	await expect(rows).toHaveCount(2);
	await timeline(page).getByRole("button", { name: "回到实时" }).click();
	await expect(rows).toHaveCount(9);

	// 选中 fetch：只看它，没有来源节点列；再点一次取消选中，回到合并视图。
	await nodeButton(page, "fetch").click();
	await expect(scope).toHaveText("范围：fetch");
	await expect(rows).toHaveCount(4);
	await expect(logs.locator("[data-log-origin]")).toHaveCount(0);
	await nodeButton(page, "fetch").click();
	await expect(scope).toHaveText("范围：全部节点");
	await expect(rows).toHaveCount(9);
	await expect(logs.locator("[data-log-origin]").first()).toHaveText("fetch");
});

test("合并视图向上滚动一页页加载更早的日志，一直到运行开始：控制面返回的每行只出现一次，同一个游标只请求一次", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const clock0 = clock.now().getTime();
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const at = logAt(agent, clock0);
	// fetch 的 4 行之后，probe 和 verify 第 2 次各 500 行交错输出：一共 1004 行，最新一页 300 行，再往前翻三页。
	const rows = (task: AssignedTask, name: string, from: number) =>
		agent.logs(
			task,
			Array.from({ length: 500 }, (_, i) => at(i + 1, from + i * 10, `${name} line ${i + 1}`)),
		);
	rows(tasks.probe as AssignedTask, "probe", 13_000);
	rows(tasks.verify as AssignedTask, "verify", 13_005);
	await agent.sync();

	const pageRequests = new Set<Request>();
	page.on("request", (req) => {
		if (new URL(req.url()).pathname === `/api/runs/${runId}/logs`) pageRequests.add(req);
	});
	const received: string[] = [];
	const befores: string[] = [];
	page.on("response", async (res) => {
		if (!pageRequests.has(res.request())) return;
		befores.push(new URL(res.url()).searchParams.get("before") ?? "（最新一页）");
		const body = logsApi.runPage.response.parse(await res.json());
		received.push(...body.lines.map((l) => `${l.task_id}:${l.seq}`));
	});

	await openMonitor(page, clock, runId);
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：verify（第 2 次）");
	await nodeButton(page, "verify").click();
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：全部节点");
	const logs = panel(page).getByRole("log", { name: "日志" });
	await expect(logs).toContainText("verify line 500");
	await expect(logs).not.toContainText("开始执行");

	const older = logs.getByRole("button", { name: /加载更早的日志/ });
	const loadingOlder = logs.getByRole("button", { name: "正在加载更早的日志…" });
	for (let pages = 1; (await older.count()) > 0; pages++) {
		expect(pages, "三页之内应读到运行开始").toBeLessThanOrEqual(3);
		const before = befores.length;
		// 滚到顶部，并在同一刻连续触发几次滚动：重新渲染之前的几次滚动也只发一次请求。
		await logs.evaluate((el) => {
			for (let i = 0; i < 5; i++) {
				el.scrollTop = 0;
				el.dispatchEvent(new Event("scroll"));
			}
		});
		await expect.poll(() => befores.length).toBeGreaterThan(before);
		await expect(loadingOlder).toHaveCount(0);
	}
	await expect.poll(() => received.length).toBe(1004);
	expect(new Set(received).size).toBe(1004);
	expect(befores).toHaveLength(4);
	expect(new Set(befores).size).toBe(4);

	await logs.evaluate((el) => {
		el.scrollTop = 0;
	});
	await expect(logs.getByRole("button")).toContainText([
		"开始执行",
		"load config ok",
		"retrying request (1/3): connection reset",
		"batch committed",
		"probe line 1",
		"verify line 1",
		"probe line 2",
		"verify line 2",
	]);
	await expect(logs.locator("[data-log-origin]").first()).toHaveText("fetch");
});

test("合并视图里没有任何日志时底部面板自动收起，展开后说明这次运行没有日志输出", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({
		name: "agent-a",
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await publishPackage(controlPlane);
	const scenarioId = await createScenario(controlPlane, "无日志", scenarioUsing("agent-a"));
	const runId = await triggerRun(controlPlane, scenarioId);
	clock.advance(1_000);
	await agent.succeed(await agent.nextAssign());

	// 运行成功、没有失败或执行中的节点：默认不选中节点，日志页签是全部节点。
	await openMonitor(page, clock, runId);
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：全部节点");
	await expect(panel(page).getByRole("button", { name: "展开" })).toBeVisible();
	await panel(page).getByRole("button", { name: "展开" }).click();
	await expect(panel(page).getByRole("tabpanel")).toHaveText("这次运行没有日志输出。");
});

test("执行中的运行：合并视图实时显示新写入的行，晚到的行按控制面时间插到它应在的位置，之后才开始的节点的行也出现", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const clock0 = clock.now().getTime();
	const running = await runningScenario(controlPlane, connectAgent, clock);
	await interleavedLogs(controlPlane, running, clock0);
	const { runId, agent, tasks } = running;
	const at = logAt(agent, clock0);

	await openMonitor(page, clock, runId);
	await nodeButton(page, "verify").click();
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：全部节点");
	const logs = panel(page).getByRole("log", { name: "日志" });
	const rows = logs.getByRole("button");
	await expect(rows).toHaveCount(9);

	// probe 接着输出；之后 verify 第 2 次补发一行比 probe 已显示的两行都早的（晚到的行）。
	agent.logs(tasks.probe as AssignedTask, [at(3, 13_500, "probe tock")]);
	await expect(rows).toHaveCount(10);
	agent.logs(tasks.verify as AssignedTask, [at(2, 11_500, "verify 2 late")]);
	// verify 第 2 次成功后，always 节点 cleanup 才开始执行并输出。
	await agent.succeed(tasks.verify as AssignedTask);
	const cleanup = await agent.nextAssign();
	agent.logs(cleanup, [at(1, 15_000, "cleanup done")]);

	await expect(rows).toHaveCount(12);
	await expect(rows).toContainText([
		"开始执行",
		"load config ok",
		"retrying request (1/3): connection reset",
		"batch committed",
		"verify 1 checking",
		"probe started",
		"AssertionError: 漏拦 3 笔",
		"verify 2 retrying",
		"verify 2 late",
		"probe tick",
		"probe tock",
		"cleanup done",
	]);
	await expect(logs.locator("[data-log-origin]")).toHaveText([
		"fetch",
		"fetch",
		"fetch",
		"fetch",
		"verify #1",
		"sub / probe",
		"verify #1",
		"verify #2",
		"verify #2",
		"sub / probe",
		"sub / probe",
		"cleanup",
	]);
});

test("实时推送的行多到超过浏览器保留的 5000 行时，从最新一页重新读再接上：最新的行还在，向上滚动读得回更早的，之后的新行照常出现", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const clock0 = clock.now().getTime();
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const at = logAt(agent, clock0);
	let latestPages = 0;
	page.on("request", (req) => {
		const url = new URL(req.url());
		if (url.pathname === `/api/runs/${runId}/logs` && !url.searchParams.has("before")) {
			latestPages++;
		}
	});

	await openMonitor(page, clock, runId);
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：verify（第 2 次）");
	await nodeButton(page, "verify").click();
	const logs = panel(page).getByRole("log", { name: "日志" });
	await expect(logs.getByRole("button")).toHaveCount(4);
	await expect.poll(() => latestPages).toBe(1);

	agent.logs(
		tasks.probe as AssignedTask,
		Array.from({ length: 5_001 }, (_, i) => at(i + 1, 13_000 + i, `probe line ${i + 1}`)),
	);
	await expect.poll(() => latestPages).toBe(2);
	await expect(logs).toContainText("probe line 5001");
	agent.logs(tasks.probe as AssignedTask, [at(5_002, 19_000, "probe line 5002")]);
	await expect(logs).toContainText("probe line 5002");
	expect(latestPages).toBe(2);

	// 新的最新一页是第 4702–5001 行；向上滚动读回之前的一页。
	await expect(logs).not.toContainText("probe line 4701");
	await logs.evaluate((el) => {
		el.scrollTop = 0;
	});
	await expect(logs).toContainText("probe line 4701");
});

test("执行中的运行在合并视图里还没有日志时底部面板自动收起，日志到了自动展开", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({
		name: "agent-a",
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await publishPackage(controlPlane);
	const scenarioId = await createScenario(controlPlane, "稍后输出", scenarioUsing("agent-a"));
	const clock0 = clock.now().getTime();
	const runId = await triggerRun(controlPlane, scenarioId);
	const ping = await agent.nextAssign();

	await openMonitor(page, clock, runId);
	// 默认选中执行中的 ping；取消选中后是全部节点，还没有任何日志：自动收起。
	await nodeButton(page, "ping").click();
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：全部节点");
	await expect(panel(page).getByRole("button", { name: "展开" })).toBeVisible();

	agent.logs(ping, [logAt(agent, clock0)(1, 1_000, "ping started")]);
	await expect(panel(page).getByRole("button", { name: "收起" })).toBeVisible();
	await expect(panel(page).getByRole("log", { name: "日志" }).getByRole("button")).toHaveText([
		/ping started/,
	]);
});

test("合并视图筛选了节点、筛选出的节点里没有日志时底部面板自动收起（别的节点有日志也一样），日志到了自动展开；筛选了级别时不收起", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const clock0 = clock.now().getTime();
	// fetch 有 4 行日志，verify 第 2 次、子流程的 probe 执行中，都还没有日志。
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	const scope = panel(page).getByTestId("bp-scope");
	await nodeButton(page, "verify").click();
	await expect(scope).toHaveText("范围：全部节点");
	await expect(panel(page).getByRole("button", { name: "收起" })).toBeVisible();

	// 只看 verify：它还没有日志，别的节点有也不算，自动收起（没有展开过，说明文字留在隐藏的面板里）。
	await workspace(page)
		.getByRole("button", { name: /节点：全部节点/ })
		.click();
	const menu = page.getByRole("dialog", { name: "按节点筛选图表" });
	await menu.getByRole("button", { name: "清空", exact: true }).click();
	await menu.getByRole("checkbox", { name: "verify" }).check();
	await expect(scope).toHaveText("范围：跟随筛选（1 个节点）");
	await expect(panel(page).getByRole("button", { name: "展开" })).toBeVisible();
	await expect(panel(page).getByRole("tabpanel", { includeHidden: true })).toHaveText(
		"没有符合条件的日志。",
	);

	// verify 输出了日志：自动展开。
	agent.logs(tasks.verify as AssignedTask, [logAt(agent, clock0)(1, 11_000, "verify 2 retrying")]);
	await expect(panel(page).getByRole("button", { name: "收起" })).toBeVisible();
	await expect(panel(page).getByRole("log", { name: "日志" }).getByRole("button")).toHaveText([
		/verify 2 retrying/,
	]);

	// 筛选了级别：筛掉的是用户自己要的，没有符合条件的行时面板不收起。
	await levelFilter(page).getByRole("button", { name: "ERROR", exact: true }).click();
	await expect(panel(page).getByRole("tabpanel")).toHaveText("没有符合条件的日志。");
	await expect(panel(page).getByRole("button", { name: "收起" })).toBeVisible();
});

test("打开监控页时默认选中了节点：不会先挂上合并视图、白发一次合并日志的请求", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	const requested: string[] = [];
	page.on("request", (req) => {
		if (new URL(req.url()).pathname === `/api/runs/${runId}/logs`) requested.push(req.url());
	});

	await openMonitor(page, clock, runId);
	// 默认选中执行中的 verify（还没有日志）：显示的是它的单节点日志。
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：verify（第 2 次）");
	await expect(panel(page).getByRole("tabpanel", { includeHidden: true })).toHaveText(
		"还没有日志输出。",
	);
	expect(requested).toEqual([]);

	// 取消选中之后才读合并日志。
	await nodeButton(page, "verify").click();
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：全部节点");
	await expect.poll(() => requested.length).toBe(1);
});

/** Agent 在运行开始后第 atMs 毫秒（控制面时间）读到的一行。 */
const logAt =
	(agent: FakeAgent, clock0: number) =>
	(seq: number, atMs: number, text: string, level = LogLevel.INFO) => ({
		seq: BigInt(seq),
		timeUnixMs: BigInt(clock0 + atMs),
		monotonicMs: agent.monotonicAt(clock0 + atMs),
		source: LogSource.STDOUT,
		level,
		text,
	});

/** verify 第 1 次尝试（runningScenario 里它失败了，之后重试）。 */
async function firstVerify(
	controlPlane: TestControlPlane,
	runId: string,
): Promise<{ taskId: string; attempt: number }> {
	const run = runsApi.get.response.parse(await (await controlPlane.fetch(`/runs/${runId}`)).json());
	const attempt = run.chains[0]?.nodes.find((n) => n.node_id === "verify")?.attempts[0];
	if (!attempt) throw new Error("没有 verify 的第 1 次尝试");
	return { taskId: attempt.task_id, attempt: 1 };
}

/**
 * 在 runningScenario（fetch 的 4 行）之后，verify 第 1 次、子流程 probe、verify 第 2 次交错输出共 5 行：
 * verify 第 1 次的第二行是 ERROR，probe 的第二行是 WARN。
 */
async function interleavedLogs(
	controlPlane: TestControlPlane,
	{ runId, agent, tasks }: Running,
	clock0: number,
) {
	const at = logAt(agent, clock0);
	agent.logs(await firstVerify(controlPlane, runId), [
		at(1, 7_000, "verify 1 checking"),
		at(2, 8_500, "AssertionError: 漏拦 3 笔", LogLevel.ERROR),
	]);
	agent.logs(tasks.probe as AssignedTask, [
		at(1, 7_500, "probe started"),
		at(2, 12_500, "probe tick", LogLevel.WARN),
	]);
	agent.logs(tasks.verify as AssignedTask, [at(1, 11_000, "verify 2 retrying")]);
	await agent.sync();
}

test("合并视图跟随节点筛选：范围标签与日志随筛选变化，级别在服务端筛选，筛选后没有匹配时说明原因", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const clock0 = clock.now().getTime();
	const running = await runningScenario(controlPlane, connectAgent, clock);
	await interleavedLogs(controlPlane, running, clock0);
	const { runId } = running;

	await openMonitor(page, clock, runId);
	await nodeButton(page, "verify").click();
	const scope = panel(page).getByTestId("bp-scope");
	const logs = panel(page).getByRole("log", { name: "日志" });
	const rows = logs.getByRole("button");
	const origins = logs.locator("[data-log-origin]");
	await expect(scope).toHaveText("范围：全部节点");
	await expect(rows).toHaveCount(9);

	// 图表工作区取消子流程：没有选中节点时，日志页签只合并显示筛选出的节点。
	await workspace(page)
		.getByRole("button", { name: /节点：全部节点/ })
		.click();
	const menu = page.getByRole("dialog", { name: "按节点筛选图表" });
	await menu.getByRole("checkbox", { name: /^子流程 sub/ }).uncheck();
	await expect(scope).toHaveText("范围：跟随筛选（2 个节点）");
	await expect(origins).toHaveText([
		"fetch",
		"fetch",
		"fetch",
		"fetch",
		"verify #1",
		"verify #1",
		"verify #2",
	]);

	// 级别在服务端筛选：WARN 起只剩 fetch 的重试提示和 verify 第 1 次的错误。
	await levelFilter(page).getByRole("button", { name: "WARN", exact: true }).click();
	await expect(rows).toContainText([
		"retrying request (1/3): connection reset",
		"AssertionError: 漏拦 3 笔",
	]);
	await expect(rows).toHaveCount(2);
	await expect(origins).toHaveText(["fetch", "verify #1"]);

	// 再取消 verify（点日志级别时筛选菜单已经收起，重新打开）：筛选出的节点里没有 ERROR 级别的行，说明原因，面板不收起。
	await workspace(page)
		.getByRole("button", { name: /节点：已选 2 个节点/ })
		.click();
	await menu.getByRole("checkbox", { name: "verify" }).uncheck();
	await expect(scope).toHaveText("范围：跟随筛选（1 个节点）");
	await levelFilter(page).getByRole("button", { name: "ERROR", exact: true }).click();
	await expect(panel(page).getByRole("tabpanel")).toHaveText("没有符合条件的日志。");
	await levelFilter(page).getByRole("button", { name: "全部", exact: true }).click();
	await expect(rows).toHaveCount(4);
	await expect(origins).toHaveText(["fetch", "fetch", "fetch", "fetch"]);

	// 清除筛选：回到全部节点，级别照旧是全部。
	await workspace(page).getByRole("button", { name: "清除筛选" }).click();
	await expect(scope).toHaveText("范围：全部节点");
	await expect(rows).toHaveCount(9);

	// 合并视图里按级别筛选：全部节点里只看 ERROR，只有 verify 第 1 次那一行。
	await levelFilter(page).getByRole("button", { name: "ERROR", exact: true }).click();
	await expect(rows).toHaveCount(1);
	await expect(rows.first()).toContainText("AssertionError: 漏拦 3 笔");
	await expect(origins).toHaveText(["verify #1"]);
});

test("合并视图点来源节点名，或在行上打开菜单，选中这个节点并切到它的单节点日志；点行的其他位置只标出时刻", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const clock0 = clock.now().getTime();
	const running = await runningScenario(controlPlane, connectAgent, clock);
	await interleavedLogs(controlPlane, running, clock0);
	const { runId } = running;

	await openMonitor(page, clock, runId);
	await nodeButton(page, "verify").click();
	const scope = panel(page).getByTestId("bp-scope");
	const logs = panel(page).getByRole("log", { name: "日志" });
	const rows = logs.getByRole("button");
	await expect(scope).toHaveText("范围：全部节点");
	await expect(rows).toHaveCount(9);

	// 点行的其他位置：只标出时刻，范围不变。
	const failure = rows.filter({ hasText: "AssertionError: 漏拦 3 笔" });
	await failure.getByText("AssertionError: 漏拦 3 笔").click();
	await expect(failure).toHaveAttribute("data-marked", "true");
	await expect(scope).toHaveText("范围：全部节点");

	// 点来源节点名：选中这个节点，看到的是这一行所在的那次尝试（verify 第 1 次，不是最近一次）。
	await failure.locator("[data-log-origin]").click();
	await expect(scope).toHaveText("范围：verify（第 1 次）");
	await expect(rows).toContainText(["verify 1 checking", "AssertionError: 漏拦 3 笔"]);
	await expect(rows).toHaveCount(2);
	await expect(logs.locator("[data-log-origin]")).toHaveCount(0);
	await expect(nodeButton(page, "verify")).toHaveAttribute("aria-pressed", "true");

	// 取消选中回到合并视图；右键行打开菜单，选「只看 …… 的日志」，子流程里的节点同样。
	await nodeButton(page, "verify").click();
	await expect(rows).toHaveCount(9);
	await rows.filter({ hasText: "probe tick" }).click({ button: "right" });
	const rowMenu = page.getByRole("menu", { name: "日志行菜单" });
	await expect(rowMenu.getByRole("menuitem")).toHaveText("只看 sub / probe 的日志");
	await rowMenu.getByRole("menuitem").click();
	await expect(scope).toHaveText("范围：probe");
	await expect(rows).toContainText(["probe started", "probe tick"]);
	await expect(rows).toHaveCount(2);

	// 键盘：行上按 Shift+F10 打开同一个菜单。
	await nodeButton(page, "probe").click();
	await expect(rows).toHaveCount(9);
	await rows.filter({ hasText: "load config ok" }).focus();
	await page.keyboard.press("Shift+F10");
	await expect(rowMenu.getByRole("menuitem")).toHaveText("只看 fetch 的日志");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	await expect(scope).toHaveText("范围：fetch");
	await expect(rows).toHaveCount(4);
});

test("合并视图下的下载按钮下载范围内整次运行合并后的日志：顺序和来源与合并视图相同，跟随节点筛选，不受级别筛选影响；单节点视图下载这次尝试的原始日志", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const clock0 = clock.now().getTime();
	const running = await runningScenario(controlPlane, connectAgent, clock);
	await interleavedLogs(controlPlane, running, clock0);
	const { runId, tasks } = running;

	await openMonitor(page, clock, runId);
	const scope = panel(page).getByTestId("bp-scope");
	const merged = panel(page).getByRole("link", { name: "下载合并日志" });
	const single = panel(page).getByRole("link", { name: "下载原始日志" });
	/** 点下载按钮，读下载到的文件；文件名要带运行编号（单节点是节点 ID 与尝试序号）。 */
	const downloaded = async (link: Locator, filename: string) => {
		const [file] = await Promise.all([page.waitForEvent("download"), link.click()]);
		expect(file.suggestedFilename()).toBe(filename);
		const text = await readFile(await file.path(), "utf8");
		expect(text.endsWith("\n")).toBe(true);
		return text
			.trimEnd()
			.split("\n")
			.map((l): unknown => JSON.parse(l));
	};
	/** 合并日志的一行：字段恰好是契约里的。 */
	const mergedRows = async (filename: string) =>
		(await downloaded(merged, filename)).map((r) => RunLogDownloadRow.strict().parse(r));
	const brief = (rows: RunLogDownloadRow[]) =>
		rows.map((r) => [r.subflow, r.node_id, r.attempt, r.text]);

	// 默认选中 verify：单节点视图，只有原来的下载按钮。
	await expect(scope).toHaveText("范围：verify（第 2 次）");
	await expect(merged).toHaveCount(0);
	await expect(single).toHaveAttribute("href", `/api/tasks/${tasks.verify?.taskId}/logs/download`);
	expect(await downloaded(single, "verify-2.log.jsonl")).toMatchObject([
		{ seq: 1, text: "verify 2 retrying" },
	]);

	// 取消选中：合并视图。先按 ERROR 筛选，下载仍是全部级别的行，顺序与合并视图相同，每行带来源。
	await nodeButton(page, "verify").click();
	await expect(scope).toHaveText("范围：全部节点");
	await expect(single).toHaveCount(0);
	await expect(merged).toHaveAttribute("href", `/api/runs/${runId}/logs/download`);
	await levelFilter(page).getByRole("button", { name: "ERROR", exact: true }).click();
	await expect(panel(page).getByRole("log", { name: "日志" }).getByRole("button")).toHaveCount(1);
	const all = await mergedRows(`run-${runId}.log.jsonl`);
	expect(brief(all)).toEqual([
		[null, "fetch", 1, "开始执行"],
		[null, "fetch", 1, "load config ok"],
		[null, "fetch", 1, "retrying request (1/3): connection reset"],
		[null, "fetch", 1, "batch committed"],
		[null, "verify", 1, "verify 1 checking"],
		["sub", "probe", 1, "probe started"],
		[null, "verify", 1, "AssertionError: 漏拦 3 笔"],
		[null, "verify", 2, "verify 2 retrying"],
		["sub", "probe", 1, "probe tick"],
	]);
	expect(new Set(all.map((r) => r.level))).toEqual(new Set(["debug", "info", "warn", "error"]));
	expect(all[0]?.task_id).toBe(tasks.fetch?.taskId);

	// 图表工作区取消子流程：下载跟随筛选，只含筛选出的节点。
	await workspace(page)
		.getByRole("button", { name: /节点：全部节点/ })
		.click();
	await page
		.getByRole("dialog", { name: "按节点筛选图表" })
		.getByRole("checkbox", { name: /^子流程 sub/ })
		.uncheck();
	await expect(scope).toHaveText("范围：跟随筛选（2 个节点）");
	await expect(merged).toHaveAttribute(
		"href",
		new RegExp(`^/api/runs/${runId}/logs/download\\?nodes=`),
	);
	const followed = await mergedRows(`run-${runId}.log.jsonl`);
	expect(brief(followed).map(([subflow]) => subflow)).toEqual(Array(7).fill(null));
	expect(followed.map((r) => r.node_id)).toEqual([
		"fetch",
		"fetch",
		"fetch",
		"fetch",
		"verify",
		"verify",
		"verify",
	]);
});

test.describe("筛选很少匹配时", () => {
	// 按运行读日志时单次请求最多扫描 2000 字节，由 4 个有日志的任务分摊：每个任务一次只读得到几行。
	test.use({ controlPlaneOptions: { logScanBytes: 2_000 } });

	test("合并视图自动接着往前读，直到读到匹配的行，不显示成没有日志", async ({
		page,
		controlPlane,
		connectAgent,
		clock,
	}) => {
		const clock0 = clock.now().getTime();
		const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
		const at = logAt(agent, clock0);
		// 唯一的 ERROR 是 verify 第 1 次的第一行，后面还有 12 行：最新一页（每个任务只读最后几行）里一行都没有。
		agent.logs(await firstVerify(controlPlane, runId), [
			at(1, 6_000, "AssertionError: 漏拦 3 笔", LogLevel.ERROR),
			...Array.from({ length: 12 }, (_, i) =>
				at(i + 2, 6_100 + i * 100, `verify 1 cleanup ${i + 1}`),
			),
		]);
		agent.logs(tasks.probe as AssignedTask, [
			at(1, 7_000, "probe started"),
			at(2, 12_500, "probe tick"),
		]);
		await agent.sync();

		await openMonitor(page, clock, runId);
		await nodeButton(page, "verify").click();
		const logs = panel(page).getByRole("log", { name: "日志" });
		await levelFilter(page).getByRole("button", { name: "ERROR", exact: true }).click();
		await expect(logs.getByRole("button")).toHaveCount(1);
		await expect(logs.getByRole("button")).toContainText("AssertionError: 漏拦 3 笔");
		await expect(panel(page).getByRole("tabpanel")).not.toContainText("没有符合条件的日志");
		// 读到了开头：没有「加载更早的日志」。
		await expect(logs.getByRole("button", { name: /加载更早的日志/ })).toHaveCount(0);
	});
});
