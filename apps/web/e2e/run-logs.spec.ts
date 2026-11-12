import type { Page } from "@playwright/test";
import { runsApi } from "@sfly/schema";
import { type AssignedTask, LogLevel, LogSource } from "../../server/test/support/fake-agent.js";
import { expect, test } from "./fixtures";
import { openMonitor, runningScenario } from "./monitor-scenario";
import { createScenario, publishPackage, scenarioUsing, triggerRun } from "./support";

// 没选中节点时，日志页签按控制面时间合并显示整次运行全部节点的日志（#222），向上滚动加载更早的（#223）。

const timeline = (page: Page) => page.getByRole("region", { name: "链路时间线" });
const panel = (page: Page) => page.getByRole("region", { name: "底部面板" });
const nodeButton = (page: Page, id: string) =>
	timeline(page).locator(`[data-node-row="${id}"] button`);
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

test("合并视图向上滚动加载更早的日志，一直到运行开始", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const clock0 = clock.now().getTime();
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const at = (seq: number, atMs: number, text: string) => ({
		seq: BigInt(seq),
		timeUnixMs: BigInt(clock0 + atMs),
		monotonicMs: agent.monotonicAt(clock0 + atMs),
		source: LogSource.STDOUT,
		level: LogLevel.INFO,
		text,
	});
	// fetch 的 4 行之后，probe 和 verify 第 2 次各 200 行交错输出：一共 404 行，最新一页只有最后 300 行。
	const rows = (task: AssignedTask, name: string, from: number) =>
		agent.logs(
			task,
			Array.from({ length: 200 }, (_, i) => at(i + 1, from + i * 10, `${name} line ${i + 1}`)),
		);
	rows(tasks.probe as AssignedTask, "probe", 13_000);
	rows(tasks.verify as AssignedTask, "verify", 13_005);
	await agent.sync();

	await openMonitor(page, clock, runId);
	await nodeButton(page, "verify").click();
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：全部节点");
	const logs = panel(page).getByRole("log", { name: "日志" });
	await expect(logs).toContainText("verify line 200");
	await expect(logs).not.toContainText("开始执行");

	const older = logs.getByRole("button", { name: /加载更早的日志/ });
	await expect(older).toBeVisible();
	// 不用 click()：它会先把按钮滚进视口，滚到顶部本身就会触发加载、按钮随即消失，点击落空。
	await older.dispatchEvent("click");
	// 更早的 104 行一页读完，已经到了运行开始：不再有加载更早的按钮。
	await expect(older).toHaveCount(0);
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
