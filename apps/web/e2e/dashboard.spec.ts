import type { Page } from "@playwright/test";
import type { FakeAgent } from "../../server/test/support/fake-agent.js";
import { expect, test } from "./fixtures";
import {
	createScenario,
	failApi,
	holdApi,
	publishPackage,
	scenarioUsing,
	seedDashboard,
	triggerRun,
} from "./support";

// 控制台（原型 #/dashboard）：页头一行（控制面时间、计数、运行场景）、正在运行、最近失败、Agent 状态。

const header = (page: Page) =>
	page.getByRole("heading", { name: "控制台", level: 1, exact: true }).locator("..");
const counts = (page: Page) => page.getByRole("list", { name: "运行计数" });
const panel = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test("页头一行：控制面时间、此刻与最近 24 小时的计数、运行场景；没有统计卡、趋势和最近发布的节点包", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await seedDashboard({ page, controlPlane, connectAgent, clock });
	await page.goto("/");

	const head = header(page);
	await expect(head).toContainText("控制面时间 09:01:15");
	const list = counts(page);
	await expect(list.getByRole("listitem")).toHaveText([
		"运行中 1",
		"执行中任务 1",
		"排队 0",
		"最近 24 小时 成功 1 · 失败 1 · 取消 0",
	]);
	await expect(head.getByRole("button", { name: "运行场景" })).toBeVisible();
	await expect(head.getByRole("link", { name: "场景编排" })).toHaveCount(0);

	await expect(page.getByRole("region", { name: "运行统计" })).toHaveCount(0);
	await expect(page.getByRole("img", { name: /最近 24 小时：成功/ })).toHaveCount(0);
	await expect(panel(page, "运行趋势")).toHaveCount(0);
	await expect(panel(page, "最近发布的节点包")).toHaveCount(0);

	// 计数与页头排在同一行。
	const [title, summary, button] = await Promise.all([
		page.getByRole("heading", { name: "控制台", level: 1 }).boundingBox(),
		list.boundingBox(),
		head.getByRole("button", { name: "运行场景" }).boundingBox(),
	]);
	const middle = (b: typeof title) => (b ? b.y + b.height / 2 : Number.NaN);
	expect(Math.abs(middle(summary) - middle(title))).toBeLessThan(4);
	expect(Math.abs(middle(button) - middle(title))).toBeLessThan(4);
});

test("「运行场景」打开命令面板，只列出运行场景一组，选一个场景打开它的运行抽屉", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));
	await page.goto("/");
	await header(page).getByRole("button", { name: "运行场景" }).click();

	const palette = page.getByRole("dialog", { name: "命令面板" });
	await expect(palette.getByRole("group", { name: "运行场景" })).toBeVisible();
	await expect(palette.getByRole("group")).toHaveCount(1);
	await palette.getByRole("option", { name: "运行「巡检」" }).click();
	await expect(page.getByRole("dialog", { name: /运行/ })).toBeVisible();
});

test("正在运行：各链进度与当前节点，点击进入运行详情", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { running } = await seedDashboard({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	const row = panel(page, "正在运行").getByRole("link", { name: /撮合压测/ });
	await expect(row).toContainText("tester 触发 · v1");
	await expect(row).toContainText("已运行 15.0s");
	await expect(row).toContainText("执行中：probe");
	await expect(row.getByRole("img", { name: "主链 2/3" })).toBeVisible();
	await expect(row.getByRole("img", { name: "子流程 sub 1/2" })).toBeVisible();

	await row.click();
	await expect(page).toHaveURL(new RegExp(`/runs/${running}(\\?|$)`));
});

test("最近失败：失败节点与错误类型，子流程失败单独列出", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { running, failed } = await seedDashboard({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	const rows = panel(page, "最近失败").getByRole("link");
	await expect(rows).toHaveCount(2);
	await expect(rows.nth(0)).toContainText("子流程失败");
	await expect(rows.nth(0)).toContainText("撮合压测");
	await expect(rows.nth(0)).toContainText("node_error");
	await expect(rows.nth(0)).toContainText("失败节点 verify · 主链仍在运行");
	await expect(rows.nth(0)).toHaveAttribute("href", `/runs/${running}`);
	await expect(rows.nth(1)).toContainText("巡检");
	await expect(rows.nth(1)).toContainText("timeout");
	await expect(rows.nth(1)).toContainText("失败节点 ping");
	await expect(rows.nth(1)).toContainText("01-01 08:01");
	await expect(rows.nth(1)).toHaveAttribute("href", `/runs/${failed}`);
});

test("Agent 状态", async ({ page, controlPlane, connectAgent, clock }) => {
	await seedDashboard({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	const agents = panel(page, "Agent 状态");
	await expect(agents.getByRole("row", { name: /agent-linux/ }).getByRole("cell")).toHaveText([
		"agent-linux",
		"1/4",
		"在线",
	]);
	await expect(agents.getByRole("row", { name: /agent-mac/ }).getByRole("cell")).toHaveText([
		"agent-mac",
		"0/2",
		"离线 · 01-01 08:00",
	]);
});

test("正在安装节点包的 Agent", async ({ page, connectAgent }) => {
	const agent: FakeAgent = await connectAgent({ name: "agent-a", slots: 2 });
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
	await expect(
		panel(page, "Agent 状态")
			.getByRole("row", { name: /agent-a/ })
			.getByRole("cell")
			.nth(2),
	).toHaveText("正在安装 demo-checks@1.2.0");
});

test("实时更新：运行结束后从正在运行中移除，计数里计入成功", async ({
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
	await expect(panel(page, "正在运行").getByRole("link", { name: /巡检/ })).toBeVisible();
	await expect(counts(page)).toContainText("运行中 1");
	await expect(counts(page)).toContainText("成功 0");

	await agent.succeed(task);
	await expect(panel(page, "正在运行").getByRole("link")).toHaveCount(0);
	await expect(panel(page, "正在运行")).toContainText("没有正在运行的运行");
	await expect(counts(page)).toContainText("运行中 0");
	await expect(counts(page)).toContainText("成功 1");
});

test("没有数据时各模块显示空状态", async ({ page }) => {
	await page.goto("/");
	await expect(panel(page, "正在运行")).toContainText("没有正在运行的运行");
	await expect(panel(page, "最近失败")).toContainText("最近 24 小时没有失败");
	await expect(panel(page, "Agent 状态")).toContainText("还没有 Agent 连接");
	await expect(counts(page).getByRole("listitem")).toHaveText([
		"运行中 0",
		"执行中任务 0",
		"排队 0",
		"最近 24 小时 成功 0 · 失败 0 · 取消 0",
	]);
});

test("计数：失败为 0 时是中性色，有失败时才着失败色", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const RUNNING = 0;
	const FAILED = 4;
	const color = (index: number) =>
		counts(page)
			.locator("b")
			.nth(index)
			.evaluate((el) => getComputedStyle(el).color);
	await page.goto("/");
	await expect(counts(page)).toContainText("失败 0");
	const neutral = await color(RUNNING);
	expect(await color(FAILED)).toBe(neutral);

	await seedDashboard({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	await expect(counts(page)).toContainText("失败 1");
	expect(await color(FAILED)).not.toBe(neutral);
});

test("加载中显示骨架，加载失败显示错误详情，重试后恢复", async ({ page }) => {
	const hold = await holdApi(page, "/dashboard");
	await page.goto("/");
	await expect(page.getByRole("status", { name: "加载中" }).first()).toBeVisible();
	hold.release();
	await expect(panel(page, "正在运行")).toBeVisible();

	await page.unrouteAll();
	const outage = await failApi(page, "/dashboard");
	await page.reload();
	const error = page.getByRole("alert");
	await expect(error).toContainText("无法加载控制台数据");
	await expect(error).toContainText("GET /api/dashboard → 503 unavailable");
	await outage.restore();
	await error.getByRole("button", { name: "重试" }).click();
	await expect(panel(page, "正在运行")).toBeVisible();
});

test("正在运行：每个运行的状态标签脉冲一处；当前节点按状态表着色（执行中青色、排队中灰色）", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a", slots: 1 });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "排队的场景", scenarioUsing("agent-a"));
	await triggerRun(controlPlane, scenario);
	await agent.nextAssign();
	await triggerRun(controlPlane, scenario);

	await page.goto("/");
	const rows = panel(page, "正在运行").getByRole("link", { name: /排队的场景/ });
	await expect(rows).toHaveCount(2);
	const nodeColors = await rows.evaluateAll((all) =>
		all.map((row) => {
			const node = [...row.querySelectorAll("span.font-mono")].find(
				(el) => el.textContent === "ping",
			);
			return { color: node ? getComputedStyle(node).color : "", text: row.textContent ?? "" };
		}),
	);
	const running = nodeColors.find((n) => !n.text.includes("（排队）"));
	const queued = nodeColors.find((n) => n.text.includes("（排队）"));
	expect(running?.color).not.toBe(queued?.color);
	const pulses = await page.evaluate(
		() =>
			document
				.getAnimations()
				.filter((a) => a instanceof CSSAnimation && a.animationName === "status-pulse").length,
	);
	expect(pulses).toBe(2);
});
