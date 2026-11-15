import type { Page } from "@playwright/test";
import type { FakeAgent } from "../../server/test/support/fake-agent.js";
import { type E2eFixtures, expect, test } from "./fixtures";
import {
	createScenario,
	failApi,
	holdApi,
	publishPackage,
	scenarioUsing,
	triggerRun,
} from "./support";
import { mainChain, manyRuns, seedWall } from "./wall-support";

// 控制台的实况墙（外壳页方案 4.1）：页头一行；左栏是正在运行的运行块和最近结束，右栏是 Agent 的槽位和场景。

const header = (page: Page) =>
	page.getByRole("heading", { name: "控制台", level: 1, exact: true }).locator("..");
const counts = (page: Page) => page.getByRole("list", { name: "运行计数" });
const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
/** 一个运行块（区域名称是场景名）。 */
const block = (page: Page, scenario: string) =>
	region(page, "正在运行").getByRole("region", { name: scenario, exact: true });
const ended = (page: Page) => region(page, "最近结束").getByRole("listitem");

/** 环境里出现过一个运行：触发场景，让 Agent 成功完成它。 */
async function runOnce(
	controlPlane: E2eFixtures["controlPlane"],
	agent: FakeAgent,
	name = "巡检",
): Promise<string> {
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, name, scenarioUsing(agent.name));
	await triggerRun(controlPlane, scenario);
	await agent.succeed(await agent.nextAssign());
	return scenario;
}

test("页头一行：控制面时间、此刻与最近 24 小时的计数、运行场景；没有统计卡、趋势和最近发布的节点包", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");

	const head = header(page);
	await expect(head).toContainText("控制面时间 09:05:34");
	await expect(counts(page).getByRole("listitem")).toHaveText([
		"运行中 2",
		"执行中任务 1",
		"排队 0",
		"最近 24 小时 成功 1 · 失败 1 · 取消 0",
	]);
	await expect(head.getByRole("button", { name: "运行场景" })).toBeVisible();
	await expect(head.getByRole("link", { name: "场景编排" })).toHaveCount(0);
	await expect(page.getByRole("region", { name: "运行统计" })).toHaveCount(0);
	await expect(region(page, "运行趋势")).toHaveCount(0);
	await expect(region(page, "最近发布的节点包")).toHaveCount(0);

	// 计数与页头排在同一行。
	const [title, summary, button] = await Promise.all([
		page.getByRole("heading", { name: "控制台", level: 1 }).boundingBox(),
		counts(page).boundingBox(),
		head.getByRole("button", { name: "运行场景" }).boundingBox(),
	]);
	const middle = (b: typeof title) => (b ? b.y + b.height / 2 : Number.NaN);
	expect(Math.abs(middle(summary) - middle(title))).toBeLessThan(4);
	expect(Math.abs(middle(button) - middle(title))).toBeLessThan(4);
});

test("「运行场景」打开命令面板，只列出运行场景一组，选一个场景打开它的运行抽屉", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await runOnce(controlPlane, await connectAgent({ name: "agent-a" }));
	await page.goto("/");
	await header(page).getByRole("button", { name: "运行场景" }).click();

	const palette = page.getByRole("dialog", { name: "命令面板" });
	await expect(palette.getByRole("group", { name: "运行场景" })).toBeVisible();
	await expect(palette.getByRole("group")).toHaveCount(1);
	await palette.getByRole("option", { name: "运行「巡检」" }).click();
	await expect(page.getByRole("dialog", { name: /运行/ })).toBeVisible();
});

test("运行块：场景、版本、运行编号、触发人和开始时间，右上角是大号的已运行时长；按开始时间从新到旧", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { running } = await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	const blocks = region(page, "正在运行").getByRole("heading", { level: 3 });
	await expect(blocks).toHaveText(["撮合压测", "定时巡检"]);

	const run = block(page, "撮合压测");
	await expect(run).toContainText("运行中");
	await expect(run).toContainText("v1");
	await expect(run).toContainText(running.slice(0, 8));
	await expect(run).toContainText("tester 触发 · 开始 01-01 09:05");
	const elapsed = run.getByTestId("run-elapsed");
	await expect(elapsed).toHaveText("15.0s");
	await expect(run).toContainText("已运行");
	// 全站唯一的大字号（22px）。
	expect(await elapsed.evaluate((el) => getComputedStyle(el).fontSize)).toBe("22px");
});

test("线路：每条链一行，节点是站，已完成数写在右边；子流程从触发它的异步任务节点那一列分出", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	const lines = block(page, "撮合压测").getByRole("list", { name: "各链进度" });
	const rows = lines.locator(":scope > li");
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0).getByRole("listitem")).toHaveText([
		"entry（成功）",
		"spawn（成功）",
		"probe（执行中）",
	]);
	await expect(rows.nth(0)).toContainText("主链");
	await expect(rows.nth(0)).toContainText("2/3");
	await expect(rows.nth(1).getByRole("listitem")).toHaveText(["sub（成功）", "verify（失败）"]);
	await expect(rows.nth(1)).toContainText("子流程 sub");
	await expect(rows.nth(1)).toContainText("1/2");

	// 子流程的第一站和主链上的 spawn 对齐；进入执行中的 probe 的那一段是青色。
	const station = (row: number, name: string) =>
		rows.nth(row).getByRole("listitem").filter({ hasText: name });
	const [spawn, sub] = await Promise.all([
		station(0, "spawn").boundingBox(),
		station(1, "sub").boundingBox(),
	]);
	expect(Math.abs((spawn?.x ?? 0) - (sub?.x ?? Number.NaN))).toBeLessThan(1);
	const segment = (name: string) =>
		station(0, name).evaluate((li) => {
			const line = li.querySelector("[aria-hidden]:not([data-status-dot])");
			return line ? getComputedStyle(line).backgroundColor : "";
		});
	const signal = await page.evaluate(() => {
		const probe = document.createElement("i");
		probe.style.color = "var(--signal-line)";
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	});
	expect(await segment("spawn")).toBe(signal);
	expect(await segment("entry")).not.toBe(signal);
});

test("进行中的节点那一行：节点、Agent、尝试号、已执行时长；等待节点写唤醒时间", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	await expect(
		block(page, "撮合压测").getByRole("list", { name: "进行中的节点" }).getByRole("listitem"),
	).toHaveText(["probeagent-linux · 尝试 1 · 15.0s"]);
	await expect(
		block(page, "定时巡检").getByRole("list", { name: "进行中的节点" }).getByRole("listitem"),
	).toHaveText(["nap等待中 · 唤醒 09:15:14"]);
});

test("运行块的主指标：场景没设关注项时，读数区是执行中节点的主指标", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	const readout = block(page, "撮合压测").getByRole("region", { name: "执行中节点的主指标" });
	await expect(readout.getByRole("group")).toHaveCount(1);
	await expect(readout.getByRole("group").first()).toContainText("probe");
	await expect(readout.getByRole("group").first()).toContainText("level");
	// 等待中的运行没有执行中的节点，也就没有读数区。
	await expect(
		block(page, "定时巡检").getByRole("region", { name: "执行中节点的主指标" }),
	).toHaveCount(0);
});

test("运行块的三个按钮：打开运行监控、在画布中查看、取消运行（走现有的确认流程）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { running, stress } = await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	const run = block(page, "撮合压测");
	await expect(run.getByRole("link", { name: "打开运行监控" })).toHaveAttribute(
		"href",
		`/runs/${running}`,
	);
	await expect(run.getByRole("link", { name: "在画布中查看" })).toHaveAttribute(
		"href",
		`/orchestrations/${stress}?run=${running}`,
	);
	await run.getByRole("button", { name: "取消运行" }).click();
	await expect(page.getByRole("dialog", { name: /取消运行/ })).toBeVisible();
	await page.keyboard.press("Escape");

	await run.getByRole("link", { name: "打开运行监控" }).click();
	await expect(page).toHaveURL(new RegExp(`/runs/${running}(\\?|$)`));
});

test("最近结束：失败的写错误类型、第一个失败的节点、所在链、尝试号和错误信息；成功的只占一行", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { failed, succeeded } = await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	await expect(region(page, "最近结束")).toContainText("最近结束2");
	const [fail, ok] = [ended(page).nth(0), ended(page).nth(1)];
	await expect(fail).toContainText("失败");
	await expect(fail).toContainText("订单链路");
	await expect(fail).toContainText(failed.slice(0, 8));
	await expect(fail).toContainText("timeout");
	await expect(fail).toContainText("失败节点 submit · 主链 · 尝试 2");
	await expect(fail).toContainText("结束于 01-01 08:05 · 耗时 4m 12s");
	await expect(fail).toContainText("等待响应超时：下单接口 30 秒内没有返回");

	await expect(ok).toContainText("成功");
	await expect(ok).toContainText("巡检");
	await expect(ok).toContainText(succeeded.slice(0, 8));
	await expect(ok).toContainText("耗时 2.3s");
	await expect(ok.getByRole("link", { name: "打开失败节点" })).toHaveCount(0);
	const [failBox, okBox] = await Promise.all([fail.boundingBox(), ok.boundingBox()]);
	expect(okBox?.height ?? 0).toBeLessThan((failBox?.height ?? 0) / 2);
});

test("最近结束：取消的运行也只占一行，写结束时间和耗时，没有「打开失败节点」", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	const scenario = await runOnce(controlPlane, agent);
	const run = await triggerRun(controlPlane, scenario);
	const task = await agent.nextAssign();
	clock.advance(3000);
	const cancel = await controlPlane.fetch(`/runs/${run}/cancel`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "tester" },
		body: "{}",
	});
	expect(cancel.ok).toBe(true);
	await agent.nextCancel();
	await agent.cancelled(task);
	await page.goto("/");
	const row = ended(page).filter({ hasText: "已取消" });
	await expect(row).toContainText("巡检");
	await expect(row).toContainText("耗时 3.0s");
	await expect(row.getByRole("button", { name: "再次运行" })).toBeVisible();
	await expect(row.getByRole("link", { name: "打开失败节点" })).toHaveCount(0);
	const [cancelled, succeeded] = await Promise.all([
		row.boundingBox(),
		ended(page).filter({ hasText: "成功" }).boundingBox(),
	]);
	// 只差最后一行没有的 1px 分隔线。
	expect(
		Math.abs((cancelled?.height ?? 0) - (succeeded?.height ?? Number.NaN)),
	).toBeLessThanOrEqual(1);
});

test("最近结束的失败行：「打开失败节点」进入运行监控并选中失败节点，「再次运行」打开带上次参数的运行抽屉", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { failed } = await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	const fail = ended(page).nth(0);
	await fail.getByRole("button", { name: "再次运行" }).click();
	const drawer = page.getByRole("dialog", { name: /再次运行/ });
	await expect(drawer).toContainText("订单链路");
	await drawer.getByRole("button", { name: "取消" }).click();
	await expect(drawer).toHaveCount(0);

	await fail.getByRole("link", { name: "打开失败节点" }).click();
	await expect(page).toHaveURL(new RegExp(`/runs/${failed}\\?.*node=submit`));
	await expect(page).toHaveURL(/view=detail/);
});

test("Agent 列：每台 Agent 的槽位格写节点、场景和已执行时长，空闲槽合并；离线的不画空闲槽、不写占用数", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	const agents = region(page, "Agent");
	await expect(agents).toContainText("1 / 2 在线");
	const linux = agents.getByRole("region", { name: "agent-linux" });
	await expect(linux).toContainText("1 / 4 占用");
	const slots = linux.getByRole("list").getByRole("listitem");
	await expect(slots).toHaveText(["probe撮合压测15.0s", "3 个槽位空闲"]);
	await expect(slots.first()).toHaveAccessibleName("节点 probe，场景 撮合压测");

	const mac = agents.getByRole("region", { name: "agent-mac" });
	await expect(mac).toContainText("离线");
	await expect(mac).not.toContainText("占用");
	await expect(mac.getByRole("listitem")).toHaveCount(0);
	await expect(agents.getByRole("link", { name: "管理" })).toHaveAttribute("href", "/agents");
});

test("Agent 列：排队等这台 Agent 的任务数写在槽位下面", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a", slots: 1 });
	await runOnce(controlPlane, agent);
	const scenario = await createScenario(controlPlane, "排队", scenarioUsing("agent-a"));
	await triggerRun(controlPlane, scenario);
	await agent.nextAssign();
	await triggerRun(controlPlane, scenario);
	await page.goto("/");
	const row = region(page, "Agent").getByRole("region", { name: "agent-a" });
	await expect(row).toContainText("1 / 1 占用");
	await expect(row).toContainText("排队 1");
	await expect(row.getByRole("listitem")).toHaveCount(1);
});

test("Agent 列：不是「在线」的状态写在名称行（安装节点包中）", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a", slots: 2 });
	await runOnce(controlPlane, agent);
	agent.send({
		case: "install",
		value: {
			package: "demo-checks",
			version: "1.2.0",
			state: 1,
			taskId: "t-1",
			installedPackages: [],
		},
	});
	await page.goto("/");
	const row = region(page, "Agent").getByRole("region", { name: "agent-a" });
	await expect(row).toContainText("安装中");
	await expect(row).toContainText("0 / 2 占用");
});

test("场景列：按最近一次运行的时间排序，写上次运行的结果，从没运行过的写「从未运行」；点一行进入画布", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { stress } = await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	const scenarios = region(page, "场景");
	await expect(scenarios).toContainText("场景5");
	const rows = scenarios.getByRole("list").getByRole("link");
	await expect(rows).toHaveText([
		"撮合压测运行中",
		"定时巡检运行中",
		"订单链路失败01-01 08:05",
		"巡检成功01-01 08:00",
		"草稿从未运行",
	]);
	await rows.first().click();
	await expect(page).toHaveURL(new RegExp(`/orchestrations/${stress}$`));
});

test("此刻没有运行：左栏顶部写一行「此刻没有运行」，下面是最近结束，没有白色按钮", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await runOnce(controlPlane, await connectAgent({ name: "agent-a" }));
	await page.goto("/");
	const now = region(page, "正在运行");
	await expect(now).toHaveText("正在运行此刻没有运行");
	await expect(ended(page)).toHaveCount(1);
	const [left, endedPanel] = await Promise.all([
		now.boundingBox(),
		region(page, "最近结束").boundingBox(),
	]);
	expect((endedPanel?.y ?? 0) - ((left?.y ?? 0) + (left?.height ?? 0))).toBeLessThan(20);
	await expect(page.locator('main [data-variant="primary"], main a.bg-primary')).toHaveCount(0);
});

test("实时更新：运行结束后从正在运行移到最近结束，计数里计入成功", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));
	await triggerRun(controlPlane, scenario);
	const task = await agent.nextAssign();

	await page.goto("/");
	await expect(block(page, "巡检")).toBeVisible();
	await expect(counts(page)).toContainText("运行中 1");

	await agent.succeed(task);
	await expect(block(page, "巡检")).toHaveCount(0);
	await expect(region(page, "正在运行")).toContainText("此刻没有运行");
	await expect(ended(page)).toHaveCount(1);
	await expect(ended(page).first()).toContainText("巡检");
	await expect(counts(page)).toContainText("成功 1");
});

test("运行多时：3 个以上运行时每块的进行中节点只列前 2 个，其余写「还有 N 个」", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent-a", slots: 8 });
	await publishPackage(controlPlane);
	const parallel = await createScenario(controlPlane, "并行", {
		...mainChain("agent-a", ["a"]),
		nodes: [
			{ id: "entry", kind: "entry" },
			{ id: "s1", kind: "async", params: {} },
			{ id: "s2", kind: "async", params: {} },
			{ id: "a", kind: "package", package: "demo-checks", node: "ping", inputs: { host: "a" } },
			{ id: "sa", kind: "subflow_entry", name: "甲" },
			{ id: "b", kind: "package", package: "demo-checks", node: "ping", inputs: { host: "b" } },
			{ id: "sb", kind: "subflow_entry", name: "乙" },
			{ id: "c", kind: "package", package: "demo-checks", node: "ping", inputs: { host: "c" } },
		],
		edges: [
			{ from: "entry", to: "s1", kind: "chain" },
			{ from: "s1", to: "s2", kind: "chain" },
			{ from: "s2", to: "a", kind: "chain" },
			{ from: "sa", to: "b", kind: "chain" },
			{ from: "sb", to: "c", kind: "chain" },
			{ from: "s1", to: "sa", kind: "dispatch" },
			{ from: "s2", to: "sb", kind: "dispatch" },
		],
	});
	await triggerRun(controlPlane, parallel);
	for (let i = 0; i < 3; i++) await agent.nextAssign();
	await manyRuns(controlPlane, agent, clock, 2);
	await page.goto("/");
	const nodes = block(page, "并行")
		.getByRole("list", { name: "进行中的节点" })
		.getByRole("listitem");
	await expect(nodes).toHaveCount(3);
	await expect(nodes.last()).toHaveText("还有 1 个");
});

test("运行多时：6 个以上运行时运行块换成一行一个的紧凑行，点开展开成运行块，收起后焦点回到这一行", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent-a", slots: 8 });
	await publishPackage(controlPlane);
	const runs = await manyRuns(controlPlane, agent, clock, 6);
	const focusRequests: string[] = [];
	page.on("request", (r) => {
		if (new URL(r.url()).pathname.endsWith("/focus")) focusRequests.push(r.url());
	});
	await page.goto("/");
	const left = region(page, "正在运行");
	const rows = left.getByRole("button", { expanded: false });
	await expect(rows).toHaveCount(6);
	await expect(left.getByRole("region")).toHaveCount(0);
	await expect(rows.first()).toContainText("浸泡 06");
	await expect(rows.first()).toContainText("soak");
	await expect(rows.first().getByRole("img", { name: "主链 2/4" })).toBeVisible();
	// 紧凑行不取读数：等到控制台接口又轮询了一次，仍然没有读数请求。
	await page.waitForRequest((r) => new URL(r.url()).pathname === "/api/dashboard");
	expect(focusRequests).toEqual([]);

	await rows.first().click();
	const expanded = block(page, "浸泡 06");
	await expect(expanded).toBeVisible();
	const collapse = expanded.getByRole("button", { name: "收起" });
	await expect(collapse).toBeFocused();
	await expect(left.getByRole("button", { expanded: false })).toHaveCount(5);
	await expect.poll(() => focusRequests.length).toBeGreaterThan(0);
	expect(focusRequests.every((url) => url.includes(`/runs/${runs[5]}/focus`))).toBe(true);

	await collapse.click();
	await expect(block(page, "浸泡 06")).toHaveCount(0);
	await expect(left.getByRole("button", { expanded: false }).first()).toBeFocused();
});

test("加载中显示骨架，加载失败显示错误详情，重试后恢复", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await runOnce(controlPlane, await connectAgent({ name: "agent-a" }));
	const hold = await holdApi(page, "/dashboard");
	await page.goto("/");
	await expect(page.getByRole("status", { name: "加载中" }).first()).toBeVisible();
	hold.release();
	await expect(region(page, "最近结束")).toBeVisible();

	await page.unrouteAll();
	const outage = await failApi(page, "/dashboard");
	await page.reload();
	const error = page.getByRole("alert");
	await expect(error).toContainText("无法加载控制台数据");
	await expect(error).toContainText("GET /api/dashboard → 503 unavailable");
	await outage.restore();
	await error.getByRole("button", { name: "重试" }).click();
	await expect(region(page, "最近结束")).toBeVisible();
});

test("计数：失败为 0 时是中性色，有失败时才着失败色", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const RUNNING = 0;
	const FAILED = 4;
	const color = (index: number) =>
		counts(page)
			.locator("b")
			.nth(index)
			.evaluate((el) => getComputedStyle(el).color);
	const agent = await connectAgent({ name: "agent-a", slots: 2 });
	const scenario = await runOnce(controlPlane, agent);
	await page.goto("/");
	await expect(counts(page)).toContainText("失败 0");
	const neutral = await color(RUNNING);
	expect(await color(FAILED)).toBe(neutral);

	await triggerRun(controlPlane, scenario);
	await agent.fail(await agent.nextAssign(), "出错了");
	await page.reload();
	await expect(counts(page)).toContainText("失败 1");
	expect(await color(FAILED)).not.toBe(neutral);
});

test("脉冲：每个运行只在运行块的状态标签上脉冲一处；线路、进行中的节点和 Agent 列的状态点静止", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await seedWall({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	await expect(block(page, "撮合压测")).toBeVisible();
	const pulses = await page.evaluate(() =>
		document
			.getAnimations()
			.filter((a) => a instanceof CSSAnimation && a.animationName === "status-pulse")
			.map(
				(a) =>
					((a as CSSAnimation).effect as KeyframeEffect).target?.closest("[data-status]")
						?.textContent,
			),
	);
	expect(pulses).toEqual(["运行中", "运行中"]);
});
