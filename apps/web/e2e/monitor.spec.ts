import type { Page } from "@playwright/test";
import {
	type AssignedTask,
	agentClock,
	ErrorKind,
	LogLevel,
	LogSource,
} from "../../server/test/support/fake-agent.js";
import { type E2eFixtures, expect, test } from "./fixtures";
import { logLine, openMonitor, runningScenario } from "./monitor-scenario";
import { createScenario, publishPackage, scenarioUsing, triggerRun } from "./support";

// 运行监控页（原型 #/monitor/:runId）：顶栏、链路时间线、底部面板、取消。

const timeline = (page: Page) => page.getByRole("region", { name: "链路时间线" });
const panel = (page: Page) => page.getByRole("region", { name: "底部面板" });
const nodeButton = (page: Page, id: string) =>
	timeline(page).locator(`[data-node-row="${id}"] button`);

test("顶栏：场景名、版本、触发人、已运行时长、各链状态；运行中只有取消", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);

	const header = page.getByRole("banner");
	await expect(header.getByRole("heading", { name: /日终数据处理/ })).toContainText("v1");
	await expect(header).toContainText("tester 触发");
	await expect(header.getByTestId("run-elapsed")).toHaveText("已运行 14.0s");
	await expect(header.getByRole("list", { name: "各链状态" }).getByRole("listitem")).toHaveCount(2);
	await expect(header.getByRole("button", { name: "取消运行" })).toBeVisible();
	// 运行进行中的取消按钮是中性样式，危险强调留在确认弹窗里。
	await expect(header.getByRole("button", { name: "取消运行" })).toHaveAttribute(
		"data-variant",
		"default",
	);
	await expect(header.getByRole("button", { name: "再次运行" })).toHaveCount(0);
	await expect(header.getByRole("link", { name: "在画布中查看" })).toHaveAttribute(
		"href",
		/\/orchestrations\//,
	);
});

test("链路时间线：链汇总与节点行，排队、执行、失败尝试分段；子流程实例跟在派发它的链后面；悬停竖线", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	const tl = timeline(page);

	await expect(tl).toContainText("2 条链 · 7 个节点");
	const rows = tl.locator("[data-chain-row], [data-node-row]");
	await expect(rows).toHaveCount(9);
	// 主链 5 个节点，然后是子流程实例（由 spawn 派发）和它的 2 个节点。
	const order = await rows.evaluateAll((els) =>
		els.map((el) => (el as HTMLElement).dataset.nodeRow ?? "chain"),
	);
	expect(order).toEqual([
		"chain",
		"entry",
		"fetch",
		"spawn",
		"verify",
		"cleanup",
		"chain",
		"sub",
		"probe",
	]);
	await expect(tl.locator("[data-chain-row]").nth(1)).toContainText("← spawn");
	await expect(tl.locator("[data-dispatch-line]")).toHaveCount(1);

	// 节点 ID 完整显示。
	await expect(nodeButton(page, "cleanup")).toContainText("cleanup");
	await expect(nodeButton(page, "cleanup")).toContainText("always");
	await expect(nodeButton(page, "verify")).toContainText("×2");

	const fetchRow = tl.locator('[data-node-row="fetch"]');
	await expect(fetchRow.locator("[data-segment]")).toHaveCount(2);
	await expect(fetchRow.locator('[data-segment="queue"]')).toHaveCount(1);
	await expect(fetchRow.locator('[data-segment="ok"]')).toHaveCount(1);
	const verifyRow = tl.locator('[data-node-row="verify"]');
	await expect(verifyRow.locator('[data-segment="fail"]')).toHaveCount(1);
	await expect(verifyRow.locator('[data-segment="run"]')).toHaveCount(1);
	await expect(tl.locator('[data-node-row="cleanup"] [data-segment]')).toHaveCount(0);
	await expect(nodeButton(page, "cleanup")).toHaveAccessibleName(/待执行/);

	// 悬停：轨道上出现竖线，移到标签列上消失。
	const track = await fetchRow.locator("div").last().boundingBox();
	if (!track) throw new Error("没有轨道");
	await page.mouse.move(track.x + track.width / 2, track.y + track.height / 2);
	await expect(tl.locator("[data-hover-line]")).toBeVisible();
	await page.mouse.move(track.x - 100, track.y + track.height / 2);
	await expect(tl.locator("[data-hover-line]")).toHaveCount(0);

	// 汇总：只剩链行；点一条链只展开它。
	await tl.getByRole("button", { name: "汇总" }).click();
	await expect(tl.locator("[data-node-row]")).toHaveCount(0);
	await tl.getByRole("button", { name: /子流程 sub/ }).click();
	await expect(tl.locator("[data-node-row]")).toHaveCount(2);
	await page.keyboard.press("t");
	await expect(tl.locator("[data-node-row]")).toHaveCount(0);
});

test("拖选缩放：缩放后暂停实时跟随并显示「回到实时」，回到实时后恢复", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	const tl = timeline(page);
	await expect(tl.getByText("实时跟随")).toBeVisible();
	const ticksBefore = await tl.locator("[data-axis-track] span").allTextContents();

	const track = await tl.locator('[data-node-row="fetch"] > div').boundingBox();
	if (!track) throw new Error("没有轨道");
	const y = track.y + track.height / 2;
	await page.mouse.move(track.x + track.width * 0.1, y);
	await page.mouse.down();
	await page.mouse.move(track.x + track.width * 0.3, y, { steps: 5 });
	await expect(tl.locator("[data-brush]")).toBeVisible();
	await page.mouse.move(track.x + track.width * 0.5, y, { steps: 5 });
	await page.mouse.up();

	await expect(tl.getByRole("button", { name: "回到实时" })).toBeVisible();
	await expect(tl.getByText("实时跟随")).toHaveCount(0);
	// 运行开始于 08:00:00（东八区），总长 14 秒：拖选 10%–50% 即 08:00:01 – 08:00:07。
	await expect(tl.getByTestId("zoom-range")).toHaveText("08:00:01 – 08:00:07");
	expect(await tl.locator("[data-axis-track] span").allTextContents()).not.toEqual(ticksBefore);

	await tl.getByRole("button", { name: "回到实时" }).click();
	await expect(tl.getByText("实时跟随")).toBeVisible();
	await expect(tl.getByTestId("zoom-range")).toHaveCount(0);
});

test("点选节点：时间线行高亮，底部面板切换到该节点；尝试页签显示错误类型与堆栈", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	await expect(timeline(page).locator('[data-node-row] button[aria-pressed="true"]')).toHaveCount(
		0,
	);
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：全部节点");

	await nodeButton(page, "fetch").click();
	await expect(nodeButton(page, "fetch")).toHaveAttribute("aria-pressed", "true");
	await expect(timeline(page).locator('[data-node-row="fetch"]')).toHaveAttribute(
		"data-selected",
		"true",
	);
	await expect(nodeButton(page, "verify")).toHaveAttribute("aria-pressed", "false");
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：fetch");

	// 点时间线上的区段也能选中。
	const seg = timeline(page).locator('[data-node-row="verify"] [data-segment="fail"]');
	await seg.click();
	await expect(nodeButton(page, "verify")).toHaveAttribute("aria-pressed", "true");
	await expect(panel(page).getByTestId("bp-scope")).toHaveText("范围：verify（第 2 次）");

	await panel(page).getByRole("tab", { name: "尝试" }).click();
	const first = panel(page).getByRole("article", { name: "verify 第 1 次尝试" });
	await expect(first).toContainText("失败");
	await expect(first).toContainText("节点错误");
	await expect(first).toContainText("node_error");
	await expect(first).toContainText("AssertionError: 漏拦 3 笔");
	await expect(first.locator("pre")).toContainText('File "verify.py", line 42');
	await expect(first).toContainText("agent-a");
	await expect(panel(page).getByRole("article", { name: "verify 第 2 次尝试" })).toContainText(
		"执行中",
	);

	// 已解析的输入里，引用敏感参数的值打码。
	await nodeButton(page, "fetch").click();
	await panel(page).getByRole("tab", { name: "输入输出" }).click();
	const io = panel(page).getByRole("tabpanel");
	await expect(io).toContainText('"url": "https://example.test/cn-east"');
	await expect(io).toContainText('"token": "••••••"');
	await expect(io).not.toContainText("s3cr3t-token");
	await expect(io).toContainText('"status": 200');
});

test("取消选中：范围标签上的 × 与 Esc 都回到全部节点；弹窗打开时的 Esc 只关闭弹窗", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	const scope = panel(page).getByTestId("bp-scope");
	const pressed = timeline(page).locator('[data-node-row] button[aria-pressed="true"]');
	const clear = panel(page).getByRole("button", { name: /^清除范围/ });

	await expect(scope).toHaveText("范围：全部节点");
	await expect(clear).toHaveCount(0);

	await nodeButton(page, "fetch").click();
	await expect(scope).toHaveText("范围：fetch");
	await expect(clear).toHaveAccessibleName("清除范围，不再只看 fetch");
	await clear.click();
	await expect(scope).toHaveText("范围：全部节点");
	await expect(pressed).toHaveCount(0);

	await nodeButton(page, "verify").click();
	await expect(scope).toHaveText("范围：verify（第 2 次）");
	await page.keyboard.press("Escape");
	await expect(scope).toHaveText("范围：全部节点");
	await expect(pressed).toHaveCount(0);

	await nodeButton(page, "verify").click();
	await page.getByRole("banner").getByRole("button", { name: "取消运行" }).click();
	const dialog = page.getByRole("dialog", { name: /取消运行/ });
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await expect(scope).toHaveText("范围：verify（第 2 次）");
	await page.keyboard.press("Escape");
	await expect(scope).toHaveText("范围：全部节点");
});

test("时间线行标签在耗时旁显示节点的进度，没有进度的节点不显示，进度实时更新", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	agent.progress(tasks.probe as AssignedTask, 308, 3000);
	agent.progress(tasks.verify as AssignedTask, 12);
	await agent.sync();
	await openMonitor(page, clock, runId);
	const progress = (id: string) =>
		timeline(page).locator(`[data-node-row="${id}"] [data-progress]`);

	await expect(progress("probe")).toHaveText("308/3000");
	await expect(progress("verify")).toHaveText("12");
	await expect(progress("fetch")).toHaveCount(0);
	await expect(nodeButton(page, "probe")).toHaveAccessibleName(/进度 308\/3000$/);
	await expect(nodeButton(page, "fetch")).not.toHaveAccessibleName(/进度/);

	agent.progress(tasks.probe as AssignedTask, 400, 3000);
	await expect(progress("probe")).toHaveText("400/3000");
});

test("已结束的短运行按实际时长定轴：运行占满轨道，刻度细到 0.1 秒", async ({
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
	const scenarioId = await createScenario(controlPlane, "冒烟", scenarioUsing("agent-a"));
	const runId = await triggerRun(controlPlane, scenarioId);
	const ping = await agent.nextAssign();
	clock.advance(436);
	await agent.succeed(ping);

	await openMonitor(page, clock, runId);
	const tl = timeline(page);
	await expect(page.getByRole("banner").getByTestId("run-status")).toHaveText("成功");
	const track = await tl.locator("[data-axis-track]").boundingBox();
	const segment = await tl.locator('[data-node-row="ping"] [data-segment="ok"]').boundingBox();
	if (!track || !segment) throw new Error("没有轨道或区段");
	// 436ms 的运行 + 8% 空白：占轨道的 92% 左右，而不是 10 秒轴上的 4%。
	expect(segment.width / track.width).toBeGreaterThan(0.85);
	expect(segment.width / track.width).toBeLessThan(0.97);
	await expect(tl.locator("[data-axis-track] span")).toHaveText([
		"+0s",
		"+0.1s",
		"+0.2s",
		"+0.3s",
		"+0.4s",
	]);
});

test("日志：级别筛选、点一行在时间轴上标出该时刻、实时接续、向上加载更早的日志、下载原始日志", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const probe = tasks.probe as AssignedTask;
	// probe 先写 350 行（第一页只读最后 300 行）。
	agent.logs(
		probe,
		Array.from({ length: 350 }, (_, i) =>
			logLine(clock, i + 1, `probe line ${i + 1}`, LogLevel.INFO, -4000),
		),
	);
	await agent.sync();
	await openMonitor(page, clock, runId, "fetch");
	const logs = panel(page).getByRole("log", { name: "日志" });
	await expect(logs).toContainText("batch committed");
	await expect(logs).toContainText("load config ok");

	await panel(page).getByRole("button", { name: "WARN", exact: true }).click();
	await expect(logs).toContainText("retrying request");
	await expect(logs).not.toContainText("batch committed");
	await panel(page).getByRole("button", { name: "全部", exact: true }).click();
	await expect(logs).toContainText("batch committed");

	// 点一行：时间轴上出现标记线，该行高亮；再点一次取消。
	const line = logs.getByRole("button", { name: /retrying request/ });
	await line.click();
	await expect(line).toHaveAttribute("data-marked", "true");
	await expect(timeline(page).locator("[data-marker-line]")).toBeVisible();
	await line.click();
	await expect(timeline(page).locator("[data-marker-line]")).toHaveCount(0);

	await expect(panel(page).getByRole("link", { name: "下载原始日志" })).toHaveAttribute(
		"href",
		`/api/tasks/${tasks.fetch?.taskId}/logs/download`,
	);

	// 执行中的节点：先读最后一页，向上加载更早的，之后的输出实时接上。
	await nodeButton(page, "probe").click();
	await expect(logs).toContainText("probe line 350");
	await expect(logs).not.toContainText("probe line 50\n");
	const older = logs.getByRole("button", { name: /加载更早的日志/ });
	await expect(older).toBeVisible();
	// 不用 click()：它会先把按钮滚进视口，滚到顶部本身就会触发加载、按钮随即消失，点击落空。
	await older.dispatchEvent("click");
	await expect(older).toHaveCount(0);
	await logs.evaluate((el) => {
		el.scrollTop = 0;
	});
	await expect(logs).toContainText("probe line 1");
	await logs.evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	agent.logs(probe, [logLine(clock, 351, "probe live line", LogLevel.ERROR)]);
	await expect(logs).toContainText("probe live line");
});

test("日志：Agent 时间跳变时 Agent 写入的提示行来源显示为 agent，与节点自己的输出区分开", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const probe = tasks.probe as AssignedTask;
	const notice = "Agent 时间向后跳了 613 天（2026-01-01 08:00:13 → 2027-09-06 08:00:13）";
	agent.logs(probe, [
		logLine(clock, 1, "probe started"),
		{
			seq: 2n,
			timeUnixMs: BigInt(clock.now().getTime() + 613 * 24 * 3600 * 1000),
			source: LogSource.AGENT,
			level: LogLevel.WARN,
			text: notice,
		},
	]);
	await agent.sync();
	await openMonitor(page, clock, runId, "probe");
	const logs = panel(page).getByRole("log", { name: "日志" });

	const jumped = logs.getByRole("button", { name: notice });
	await expect(jumped).toHaveAttribute("data-source", "agent");
	await expect(jumped).toHaveAttribute("data-level", "warn");
	await expect(jumped.locator("[data-log-source]")).toHaveText("agent");
	const own = logs.getByRole("button", { name: /probe started/ });
	await expect(own).toHaveAttribute("data-source", "stdout");
	await expect(own.locator("[data-log-source]")).toHaveText("stdout");
	// 跳变后的时间和运行开始那天不在同一天：整列带上日期，跳变前后的行才看得出差别。
	await expect(logs.locator("[data-log-time]")).toHaveText([
		"2026-01-01 08:00:14.000",
		"2027-09-06 08:00:14.000",
	]);
	// 控制面时间都在同一天：只显示时刻。
	await panel(page).getByRole("button", { name: "控制面时间", exact: true }).click();
	await expect(logs.locator("[data-log-time]")).toHaveText(["08:00:14.000", "08:00:14.000"]);
	await panel(page).getByRole("button", { name: "Agent 时间", exact: true }).click();

	// 只看 WARN 时提示行还在；之后的输出实时接上，提示行留在原来的位置。
	await panel(page).getByRole("button", { name: "WARN", exact: true }).click();
	await expect(jumped).toBeVisible();
	await expect(own).toHaveCount(0);
	await panel(page).getByRole("button", { name: "全部", exact: true }).click();
	agent.logs(probe, [logLine(clock, 3, "probe after the jump")]);
	await expect(logs.getByRole("button")).toContainText([
		"probe started",
		notice,
		"probe after the jump",
	]);
});

test("产物：列出选中尝试的产物并可下载", async ({ page, controlPlane, connectAgent, clock }) => {
	const { runId, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const res = await controlPlane.fetch(`/tasks/${tasks.probe?.taskId}/artifacts/report.html`, {
		method: "PUT",
		body: "<html>report</html>",
	});
	expect(res.status).toBe(201);
	await openMonitor(page, clock, runId, "probe");
	await panel(page).getByRole("tab", { name: "产物" }).click();
	const list = panel(page).getByRole("list", { name: "产物" });
	await expect(list).toContainText("report.html");
	await expect(list).toContainText("19 B");
	await expect(list.getByRole("link", { name: "下载 report.html" })).toHaveAttribute(
		"href",
		`/api/tasks/${tasks.probe?.taskId}/artifacts/report.html`,
	);
	await nodeButton(page, "cleanup").click();
	await expect(panel(page).getByRole("tabpanel")).toContainText("cleanup 还没有开始执行。");
});

test("产物：同时显示文件在 Agent 上的修改时间和上传时间，没有修改时间的显示未记录", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const put = (name: string, headers: Record<string, string> = {}) =>
		controlPlane.fetch(`/tasks/${tasks.probe?.taskId}/artifacts/${name}`, {
			method: "PUT",
			headers,
			body: "x",
		});
	// Agent 的时间被改到了 2099 年；控制面时间是 2026-01-01 08:00:14（场景跑了 14 秒，浏览器在东八区）。
	expect((await put("dump.bin", { "x-sfly-agent-modified-ms": "4070908800123" })).status).toBe(201);
	// 旧版本 Agent 不带修改时间。
	expect((await put("legacy.bin")).status).toBe(201);
	await openMonitor(page, clock, runId, "probe");
	await panel(page).getByRole("tab", { name: "产物" }).click();
	const list = panel(page).getByRole("list", { name: "产物" });
	const dump = list.getByRole("listitem").filter({ hasText: "dump.bin" });
	await expect(dump.getByTitle("文件在 Agent 上的修改时间")).toHaveText("2099-01-01 08:00:00");
	await expect(dump.getByTitle("上传到控制面的时间")).toHaveText("2026-01-01 08:00:14");
	const legacy = list.getByRole("listitem").filter({ hasText: "legacy.bin" });
	await expect(legacy.getByTitle("文件在 Agent 上的修改时间")).toHaveText("未记录");
	await expect(legacy.getByTitle("上传到控制面的时间")).toHaveText("2026-01-01 08:00:14");
});

test("时间线下沿与底部面板上沿可以拖动调整高度，双击恢复默认", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	const bp = panel(page);
	// 打开时合并日志里有 fetch 的日志，面板是展开的；选中还没开始的 cleanup 就没有日志可看，面板自动收起。
	await expect(bp.getByRole("button", { name: "收起" })).toBeVisible();
	await nodeButton(page, "cleanup").click();
	// 拖动后展开，双击恢复默认（又自动收起）。
	await expect(bp.getByRole("button", { name: "展开" })).toBeVisible();
	const before = (await bp.boundingBox())?.height ?? 0;
	const handle = page.getByRole("separator", { name: "调整底部面板高度" });
	const box = await handle.boundingBox();
	if (!box) throw new Error("没有拖动条");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2, box.y - 80, { steps: 4 });
	await page.mouse.up();
	await expect.poll(async () => (await bp.boundingBox())?.height).toBeCloseTo(before + 80, -1);
	await handle.dblclick();
	await expect.poll(async () => (await bp.boundingBox())?.height).toBeCloseTo(before, 0);

	const tlHandle = page.getByRole("separator", { name: "调整时间线高度" });
	const tlBox = await tlHandle.boundingBox();
	if (!tlBox) throw new Error("没有拖动条");
	const tlBefore = (await timeline(page).boundingBox())?.height ?? 0;
	await page.mouse.move(tlBox.x + tlBox.width / 2, tlBox.y + tlBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(tlBox.x + tlBox.width / 2, tlBox.y + 60, { steps: 4 });
	await page.mouse.up();
	await expect
		.poll(async () => (await timeline(page).boundingBox())?.height)
		.toBeGreaterThan(tlBefore + 40);
	await tlHandle.dblclick();
	await expect
		.poll(async () => (await timeline(page).boundingBox())?.height)
		.toBeCloseTo(tlBefore, 0);
});

test("取消：确认弹窗列出影响，默认焦点在「继续运行」；取消中不显示为运行中；清理期间再次取消即强制终止", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	const header = page.getByRole("banner");
	await header.getByRole("button", { name: "取消运行" }).click();

	const dialog = page.getByRole("dialog", { name: /取消运行/ });
	const impact = dialog.getByRole("list", { name: "取消的影响" });
	await expect(impact).toContainText("执行中的 2 个任务先优雅终止");
	await expect(impact).toContainText("verify、probe");
	await expect(impact).toContainText("always 节点照常执行清理");
	await expect(impact).toContainText("cleanup");
	// 不用输入运行编号：焦点默认在「继续运行」，误按 Enter 不会取消。
	await expect(dialog.getByRole("button", { name: "继续运行" })).toBeFocused();
	await dialog.getByRole("button", { name: "取消运行" }).click();
	await expect(dialog).toBeHidden();

	// 执行中的任务被 Agent 终止后，always 节点开始清理。
	for (let i = 0; i < 2; i++) await agent.nextCancel();
	await agent.cancelled(tasks.verify as AssignedTask);
	await agent.cancelled(tasks.probe as AssignedTask);
	const cleanup = await agent.nextAssign();
	expect(cleanup.nodeId).toBe("cleanup");

	await expect(header.getByTestId("run-status")).toHaveText("取消中");
	await expect(header).not.toContainText("运行中");
	await expect(nodeButton(page, "verify")).toHaveAccessibleName(/已取消/);
	await expect(
		timeline(page).locator('[data-node-row="verify"] [data-segment="cancel"]'),
	).toHaveCount(1);

	await header.getByRole("button", { name: "强制终止" }).click();
	const force = page.getByRole("dialog", { name: /强制终止运行/ });
	await expect(force).toContainText("执行中的 1 个任务立即终止");
	await expect(force).toContainText("cleanup");
	await force.getByRole("button", { name: "强制终止" }).click();
	expect(await agent.nextCancel()).toMatchObject({ taskId: cleanup.taskId, force: true });

	await expect(header.getByTestId("run-status")).toHaveText("已取消");
	await expect(header.getByRole("button", { name: "再次运行" })).toBeVisible();
	await expect(header.getByRole("button", { name: /取消运行|强制终止/ })).toHaveCount(0);
});

test("失败的运行：默认选中失败的节点，顶栏有失败摘要；再次运行沿用上次的参数（敏感参数除外）进入新运行；运行切换列出同场景的运行", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	await agent.succeed(tasks.probe as AssignedTask);
	await agent.fail(tasks.verify as AssignedTask, "AssertionError: 仍然漏拦", ErrorKind.NODE_ERROR);
	const cleanup = await agent.nextAssign();
	clock.advance(1000);
	await agent.succeed(cleanup);
	await openMonitor(page, clock, runId);

	const header = page.getByRole("banner");
	await expect(header.getByTestId("run-status")).toHaveText("失败");
	await expect(header.getByTestId("run-elapsed")).toHaveText("耗时 15.0s");
	await expect(nodeButton(page, "verify")).toHaveAttribute("aria-pressed", "true");
	await expect(timeline(page).getByText("实时跟随")).toHaveCount(0);
	await expect(page).toHaveTitle("✕ 失败 · 日终数据处理 · sfly");

	// 失败摘要：第一个失败的节点、第几次尝试、错误信息的第一行；点击切到它的「尝试」页签。
	const failure = header.getByTestId("run-failure");
	await expect(failure).toHaveText("失败于 verify（第 2 次）· AssertionError: 仍然漏拦");
	await failure.click();
	await expect(panel(page).getByRole("tab", { name: "尝试" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(panel(page).getByRole("article", { name: "verify 第 2 次尝试" })).toContainText(
		"仍然漏拦",
	);

	await header.getByRole("button", { name: "再次运行" }).click();
	const rerun = page.getByRole("dialog", { name: "再次运行 · 日终数据处理" });
	await expect(rerun.getByRole("textbox", { name: /^region/ })).toHaveValue("cn-east");
	await expect(rerun.getByRole("textbox", { name: /^token/ })).toHaveValue("s3cr3t-token");
	await rerun.getByRole("button", { name: "触发运行" }).click();
	await expect(page).not.toHaveURL(new RegExp(runId));
	await expect(rerun).toHaveCount(0);
	await expect(header.getByRole("button", { name: "取消运行" })).toBeVisible();

	await header.getByRole("button", { name: /切换运行/ }).click();
	const menu = page.getByRole("menu");
	await expect(menu.getByRole("menuitem")).toHaveCount(2);
	await menu.getByRole("menuitem", { name: new RegExp(runId.slice(0, 8)) }).click();
	await expect(page).toHaveURL(new RegExp(`/runs/${runId}`));
	await expect(header.getByTestId("run-status")).toHaveText("失败");
});

test("运行切换菜单里，已请求取消、还在等待清理的运行显示「取消中」", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	const res = await controlPlane.fetch(`/runs/${runId}/cancel`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "tester" },
		body: "{}",
	});
	expect(res.ok).toBe(true);
	await openMonitor(page, clock, runId);

	const header = page.getByRole("banner");
	await expect(header.getByTestId("run-status")).toHaveText("取消中");
	await header.getByRole("button", { name: /切换运行/ }).click();
	const item = page
		.getByRole("menu")
		.getByRole("menuitem", { name: new RegExp(runId.slice(0, 8)) });
	await expect(item).toContainText("取消中");
	await expect(item).not.toContainText("运行中");
});

// 节点详情里任务开始和结束时的时钟偏差（#175，ADR 0018）。
test.describe("尝试页签的 Agent 时间", () => {
	const DAY = 86_400_000;

	/** agent-a 的时间比控制面快 offsetMs：ping 节点执行 10 秒后成功，打开监控页的「尝试」页签。 */
	async function finishedPing(
		{
			page,
			controlPlane,
			connectAgent,
			clock,
		}: Pick<E2eFixtures, "controlPlane" | "connectAgent" | "clock"> & { page: Page },
		offsetMs: number,
	) {
		const start = clock.now().getTime();
		// 单调时钟读数 5000 对应控制面时间 start。
		const reading = () => {
			const now = clock.now().getTime();
			return agentClock(now + offsetMs, 5_000 + now - start);
		};
		const agent = await connectAgent({
			name: "agent-a",
			installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
			...reading(),
		});
		await publishPackage(controlPlane);
		const runId = await triggerRun(
			controlPlane,
			await createScenario(controlPlane, "改时间测试", scenarioUsing("agent-a")),
		);
		const task = await agent.nextAssign({ clock: reading() });
		clock.advance(10_000);
		await agent.succeed(task, {}, reading());

		await openMonitor(page, clock, runId, "ping");
		await panel(page).getByRole("tab", { name: "尝试" }).click();
		return panel(page).getByRole("article", { name: "ping 第 1 次尝试" });
	}

	test("偏差 613 天：开始和结束同时显示控制面时间和 Agent 时间，并提示不一致", async ({
		page,
		controlPlane,
		connectAgent,
		clock,
	}) => {
		const attempt = await finishedPing({ page, controlPlane, connectAgent, clock }, 613 * DAY);

		await expect(attempt.getByRole("definition")).toHaveText([
			"08:00:00",
			"08:00:00（Agent 时间 2027-09-06 08:00:00）",
			"08:00:10（Agent 时间 2027-09-06 08:00:10）",
		]);
		const notice = attempt.getByText("这个任务执行期间 Agent 时间与控制面不一致");
		await expect(notice).toHaveText(
			"这个任务执行期间 Agent 时间与控制面不一致：开始时比控制面快 613 天，结束时快 613 天",
		);
		// 提示换行时不留孤字（「天」单独掉到下一行），窄窗口里也一样；两行的 Agent 时间左边对齐。
		for (const size of [
			{ width: 1440, height: 900 },
			{ width: 1024, height: 768 },
		]) {
			await page.setViewportSize(size);
			const lines = await notice.evaluate((el) => {
				const range = document.createRange();
				const counts = new Map<number, number>();
				const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
				for (let node = walker.nextNode(); node; node = walker.nextNode()) {
					for (let i = 0; i < (node.textContent ?? "").length; i++) {
						range.setStart(node, i);
						range.setEnd(node, i + 1);
						const top = Math.round(range.getBoundingClientRect().top);
						counts.set(top, (counts.get(top) ?? 0) + 1);
					}
				}
				return [...counts.values()];
			});
			expect(Math.min(...lines), `${size.width} 宽时每行的字数 ${lines}`).toBeGreaterThan(4);
			const agentTimes = attempt.locator("[data-agent-time]");
			await expect(agentTimes).toHaveCount(2);
			const [start, end] = await Promise.all([
				agentTimes.nth(0).boundingBox(),
				agentTimes.nth(1).boundingBox(),
			]);
			expect(start?.x).toBe(end?.x);
			expect(start?.height).toBe(end?.height);
		}
	});

	test("偏差 1 秒：只显示一个时间，没有不一致的提示", async ({
		page,
		controlPlane,
		connectAgent,
		clock,
	}) => {
		const attempt = await finishedPing({ page, controlPlane, connectAgent, clock }, 1_000);

		await expect(attempt.getByRole("definition")).toHaveText(["08:00:00", "08:00:00", "08:00:10"]);
		await expect(attempt).not.toContainText("Agent 时间");
	});
});
