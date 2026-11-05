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

// 控制台（原型 #/dashboard）：统计卡、正在运行、运行趋势、最近失败、Agent 状态、最近发布的节点包。

const stat = (page: Page, name: string) =>
	page.getByRole("region", { name: "运行统计" }).getByRole("region", { name, exact: true });
const panel = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test("统计卡：运行中、成功、失败、成功率、Agent 在线、槽位占用", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	await seedDashboard({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "控制台", exact: true })).toBeVisible();

	await expect(stat(page, "运行中")).toContainText("1");
	await expect(stat(page, "运行中")).toContainText("1 条链 · 1 个任务执行中");
	await expect(stat(page, "成功")).toContainText("1");
	await expect(stat(page, "失败")).toContainText("1含 1 个子流程");
	await expect(stat(page, "成功率")).toContainText("50.0%");
	await expect(stat(page, "Agent 在线")).toContainText("1/ 2");
	await expect(stat(page, "Agent 在线")).toContainText("agent-mac 离线");
	await expect(stat(page, "槽位占用")).toContainText("1/ 4");
	await expect(stat(page, "槽位占用")).toContainText("排队任务 0");
	await expect(
		panel(page, "运行趋势").getByRole("img", { name: /最近 24 小时：成功 1、失败 1、取消 0/ }),
	).toBeVisible();
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
	await expect(page).toHaveURL(new RegExp(`/runs/${running}$`));
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

test("Agent 状态与最近发布的节点包", async ({ page, controlPlane, connectAgent, clock }) => {
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
	const packages = panel(page, "最近发布的节点包");
	await expect(packages.getByRole("row").first().getByRole("cell")).toHaveText([
		"demo-checks",
		"1.2.0",
		"01-01 08:00 · 2 个场景锁定",
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

test("实时更新：运行结束后从正在运行中移除，计入成功", async ({
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
	await expect(stat(page, "成功")).toContainText("0");

	await agent.succeed(task);
	await expect(panel(page, "正在运行").getByRole("link")).toHaveCount(0);
	await expect(panel(page, "正在运行")).toContainText("没有正在运行的运行");
	await expect(stat(page, "成功")).toContainText("1");
});

test("没有数据时各模块显示空状态", async ({ page }) => {
	await page.goto("/");
	await expect(panel(page, "正在运行")).toContainText("没有正在运行的运行");
	await expect(panel(page, "最近失败")).toContainText("最近 24 小时没有失败");
	await expect(panel(page, "Agent 状态")).toContainText("还没有 Agent 连接");
	await expect(panel(page, "最近发布的节点包")).toContainText("还没有发布节点包");
	await expect(stat(page, "成功率")).toContainText("—");
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
