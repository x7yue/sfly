import type { Page } from "@playwright/test";
import type { AssignedTask } from "../../server/test/support/fake-agent.js";
import { type E2eFixtures, expect, test } from "./fixtures";
import { openMonitor, runningScenario } from "./monitor-scenario";
import { createScenario, failApi, holdApi, publishPackage, scenarioUsing } from "./support";

// 视觉回归：对固定状态截图并与 e2e/__screenshots__ 中的基线比对（见 playwright.config.ts）。
// 数据都是确定的：手动时钟、固定的浏览器时间与时区、内容相同的节点包归档（sha256 不变）。

async function twoAgents(connectAgent: E2eFixtures["connectAgent"]) {
	await connectAgent({
		name: "agent-linux",
		agentVersion: "0.1.0",
		os: "linux",
		arch: "x86_64",
		slots: 4,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	const mac = await connectAgent({
		name: "agent-mac",
		agentVersion: "0.1.0",
		os: "macos",
		arch: "aarch64",
		slots: 2,
	});
	return mac;
}

test("Agent 列表", async ({ page, connectAgent, controlPlane }) => {
	const mac = await twoAgents(connectAgent);
	await createScenario(controlPlane, "巡检", scenarioUsing("agent-linux"));
	await mac.disconnect();

	await page.goto("/agents");
	await expect(page.getByRole("row", { name: /agent-mac/ })).toContainText("离线");
	await expect(page.getByRole("row", { name: /agent-linux/ })).toContainText("1 个场景");

	await expect(page).toHaveScreenshot("agents.png");
});

test("Agent 列表为空", async ({ page }) => {
	await page.goto("/agents");
	await expect(page.getByRole("region", { name: "还没有 Agent 连接" })).toBeVisible();
	await expect(page).toHaveScreenshot("agents-empty.png");
});

test("加载骨架", async ({ page }) => {
	await holdApi(page, "/agents");
	await page.goto("/agents");
	await expect(page.getByRole("status", { name: "加载中" })).toBeVisible();
	await expect(page).toHaveScreenshot("agents-loading.png");
});

test("加载失败", async ({ page }) => {
	await failApi(page, "/agents");
	await page.goto("/agents");
	await expect(page.getByRole("alert")).toBeVisible();
	await expect(page).toHaveScreenshot("agents-error.png");
});

test("节点包列表与详情", async ({ page, controlPlane, clock }) => {
	await publishPackage(controlPlane, { version: "1.2.0" });
	clock.advance(3_600_000);
	await publishPackage(controlPlane, { version: "1.3.0" });
	await publishPackage(controlPlane, { name: "alpha-tools", version: "0.1.0" });
	await createScenario(controlPlane, "巡检", scenarioUsing("agent-linux", "1.2.0"));

	await page.goto("/packages?name=demo-checks");
	await expect(page.getByRole("table", { name: "节点类型" })).toBeVisible();
	await expect(page).toHaveScreenshot("packages.png");
});

test("命令面板", async ({ page, controlPlane }) => {
	await createScenario(controlPlane, "日终数据处理");
	await createScenario(controlPlane, "撮合压测");
	await page.goto("/agents");
	await expect(page.getByRole("heading", { name: "Agent 管理" })).toBeVisible();
	await page.keyboard.press("Control+k");
	await expect(page.getByRole("group", { name: "场景" })).toBeVisible();
	await expect(page).toHaveScreenshot("command-palette.png");
});

test("快捷键面板", async ({ page }) => {
	await page.goto("/agents");
	await expect(page.getByRole("heading", { name: "Agent 管理" })).toBeVisible();
	await page.keyboard.press("?");
	await expect(page.getByRole("dialog", { name: "快捷键" })).toBeVisible();
	await expect(page).toHaveScreenshot("shortcuts.png");
});

test("折叠的侧边栏", async ({ page, connectAgent }) => {
	await twoAgents(connectAgent);
	await page.goto("/agents");
	await page.getByRole("button", { name: "折叠侧边栏" }).click();
	await expect(page.getByRole("button", { name: "展开侧边栏" })).toBeVisible();
	await page.mouse.move(800, 600); // 不停在侧边栏上，避免截到悬浮提示
	await expect(page).toHaveScreenshot("sidebar-collapsed.png");
});

/** 运行 ID 是随机的：截图时遮住显示运行编号与子流程实例编号的地方。 */
const runIds = (page: Page) => [
	// 弹窗打开时页面其余部分对辅助技术隐藏，这里用 CSS 选择器而不是 role。
	page.locator('button[aria-label^="切换运行"]'),
	page.locator('ul[aria-label="各链状态"]'),
	page.locator('[data-chain-row] button:has-text("子流程")'),
	page.getByRole("dialog").getByRole("heading"),
	page.getByRole("dialog").locator("label .font-mono"),
];

test("运行监控：运行中（时间线、选中节点的日志）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId, "fetch");
	await expect(page.getByRole("log", { name: "日志" })).toContainText("batch committed");
	await page.mouse.move(700, 870); // 不停在时间线上，避免截到悬停竖线
	await expect(page).toHaveScreenshot("monitor-running.png", { mask: runIds(page) });
});

test("运行监控：失败的运行（尝试页签）", async ({ page, controlPlane, connectAgent, clock }) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	await agent.succeed(tasks.probe as AssignedTask);
	await agent.fail(tasks.verify as AssignedTask, "AssertionError: 仍然漏拦");
	const cleanup = await agent.nextAssign();
	clock.advance(1000);
	await agent.succeed(cleanup);
	await openMonitor(page, clock, runId);
	await page.getByRole("region", { name: "底部面板" }).getByRole("tab", { name: "尝试" }).click();
	await expect(page.getByRole("article", { name: "verify 第 2 次尝试" })).toBeVisible();
	await page.mouse.move(700, 870);
	await expect(page).toHaveScreenshot("monitor-failed.png", { mask: runIds(page) });
});

test("运行监控：取消确认弹窗", async ({ page, controlPlane, connectAgent, clock }) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	await page.getByRole("banner").getByRole("button", { name: "取消运行" }).click();
	await expect(page.getByRole("dialog", { name: /取消运行/ })).toBeVisible();
	await expect(page).toHaveScreenshot("monitor-cancel.png", { mask: runIds(page) });
});
