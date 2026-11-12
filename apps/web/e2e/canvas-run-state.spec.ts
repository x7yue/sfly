import type { Page } from "@playwright/test";
import type { AssignedTask } from "../../server/test/support/fake-agent.js";
import { inspector, modes, nodeCard, switchMode } from "./editor-support";
import { expect, test } from "./fixtures";
import { MONITOR_SCENARIO, openMonitor, runningScenario } from "./monitor-scenario";
import { createScenario, expectFocusVisible, publishPackage, triggerRun } from "./support";

// 编排画布的「运行状态」模式（原型 #/editor/:id?run=<id>）：节点叠加运行状态，检查器给出运行摘要与监控页入口。

const edge = (page: Page, from: string, to: string) =>
	page.locator(`[data-edge="chain:${from}->${to}"]`);

test("切换到运行状态：叠加最近一次运行的节点状态，进入执行中节点的连线为 live；检查器显示运行摘要，不显示日志与尝试详情；E / R 切换", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, scenarioId, agent, tasks } = await runningScenario(
		controlPlane,
		connectAgent,
		clock,
	);
	await page.goto(`/orchestrations/${scenarioId}`);
	await expect(nodeCard(page, "verify")).toBeVisible();
	await expect(nodeCard(page, "verify")).not.toHaveAttribute("data-run");

	await modes(page)
		.getByRole("button", { name: /运行状态/ })
		.click();
	await expect(modes(page).getByRole("button", { name: /运行状态/ })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.getByTestId("canvas-run")).toContainText(runId.slice(0, 8));
	await expect(nodeCard(page, "fetch")).toHaveAttribute("data-run", "done");
	await expect(nodeCard(page, "fetch")).toContainText("成功");
	await expect(nodeCard(page, "fetch")).toHaveAccessibleName("节点 fetch，HTTP 检查 成功");
	await expect(nodeCard(page, "verify")).toHaveAttribute("data-run", "running");
	await expect(nodeCard(page, "verify")).toContainText("执行中");
	await expect(nodeCard(page, "verify")).toHaveAccessibleName(/^节点 verify，.+ 执行中$/);
	await expect(nodeCard(page, "cleanup")).toHaveAttribute("data-run", "pending");
	await expect(edge(page, "spawn", "verify")).toHaveAttribute("data-run", "live");
	await expect(edge(page, "fetch", "spawn")).not.toHaveAttribute("data-run");
	// 子流程区域标题显示实例状态。
	await expect(page.getByRole("region", { name: "子流程 sub" })).toContainText("运行中");
	// 运行状态下只读：没有保存按钮。
	await expect(page.getByRole("button", { name: /保存/ })).toHaveCount(0);
	await expect(page.getByRole("link", { name: "打开运行监控" })).toHaveAttribute(
		"href",
		`/runs/${runId}`,
	);

	await nodeCard(page, "fetch").click();
	const panel = inspector(page);
	await expect(panel.getByRole("heading")).toBeVisible();
	await expect(panel.getByTestId("run-summary")).toContainText(`${runId.slice(0, 8)} · v1`);
	await expect(panel.getByTestId("run-summary")).toContainText("agent-a");
	await expect(panel.getByTestId("run-summary")).toContainText("4.0s");
	await expect(panel.getByTestId("run-attempts")).toHaveText("1");
	await expect(panel).toContainText("日志、图表和每次尝试的详情都在运行监控页里");
	await expect(panel.getByRole("tab")).toHaveCount(0);

	// 实时更新：verify 第 2 次失败后，卡片与检查器显示失败与错误摘要（不显示堆栈）。
	await nodeCard(page, "verify").click();
	await expect(panel.getByTestId("run-attempts")).toHaveText("2");
	await agent.fail(tasks.verify as AssignedTask, "AssertionError: 还是漏拦\n\nTraceback: stack");
	await expect(nodeCard(page, "verify")).toHaveAttribute("data-run", "failed");
	await expect(panel.getByRole("alert")).toContainText("AssertionError: 还是漏拦");
	await expect(panel).not.toContainText("Traceback");
	await expect(edge(page, "spawn", "verify")).toHaveAttribute("data-run", "failed");

	// E 回到编辑模式，R 再切回来。
	await switchMode(page, "edit");
	await expect(nodeCard(page, "verify")).not.toHaveAttribute("data-run");
	await expect(page.getByRole("button", { name: /保存/ })).toBeVisible();
	await switchMode(page, "run");
	await expect(nodeCard(page, "verify")).toHaveAttribute("data-run", "failed");
});

test("运行状态下 Enter 把焦点移到检查器、Esc 回到画布上的节点，焦点环都可见", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { scenarioId } = await runningScenario(controlPlane, connectAgent, clock);
	await page.goto(`/orchestrations/${scenarioId}`);
	await modes(page)
		.getByRole("button", { name: /运行状态/ })
		.click();
	await expect(nodeCard(page, "fetch")).toHaveAttribute("data-run", "done");
	await nodeCard(page, "fetch").click();

	await page.keyboard.press("Enter");
	await expectFocusVisible(inspector(page));
	await page.keyboard.press("Escape");
	await expectFocusVisible(nodeCard(page, "fetch"));
});

test("从监控页「在画布中查看」带入该运行（不是最近一次），「在监控页中打开」跳转后定位到该节点", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, scenarioId } = await runningScenario(controlPlane, connectAgent, clock);
	// 再触发一次：最近一次运行变成新的这一次（fetch 还在排队）。
	const latest = await triggerRun(controlPlane, scenarioId);
	await openMonitor(page, clock, runId);

	await page.getByRole("banner").getByRole("link", { name: "在画布中查看" }).click();
	await expect(page).toHaveURL(`/orchestrations/${scenarioId}?run=${runId}`);
	await expect(modes(page).getByRole("button", { name: /运行状态/ })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.getByTestId("canvas-run")).toContainText(runId.slice(0, 8));
	await expect(page.getByTestId("canvas-run")).not.toContainText(latest.slice(0, 8));
	await expect(nodeCard(page, "fetch")).toHaveAttribute("data-run", "done");

	await nodeCard(page, "fetch").click();
	await inspector(page).getByRole("link", { name: "在监控页中打开 fetch" }).click();
	await expect(page).toHaveURL(`/runs/${runId}?node=fetch`);
	await expect(page.locator('[data-node-row="fetch"] button')).toHaveAttribute(
		"aria-pressed",
		"true",
	);
});

test("场景还没有运行过：运行状态模式给出提示，节点不叠加状态", async ({ page, controlPlane }) => {
	await publishPackage(controlPlane);
	const scenarioId = await createScenario(controlPlane, "空场景", MONITOR_SCENARIO);
	await page.goto(`/orchestrations/${scenarioId}`);
	await expect(nodeCard(page, "fetch")).toBeVisible();
	await switchMode(page, "run");
	await expect(page.getByTestId("canvas-run")).toHaveText("还没有运行");
	await expect(nodeCard(page, "fetch")).not.toHaveAttribute("data-run");
	await expect(inspector(page)).toContainText("这个场景还没有运行过");
});
