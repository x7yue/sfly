import { LogLevel } from "../../server/test/support/fake-agent.js";
import { expect, test } from "./fixtures";
import { logLine } from "./monitor-scenario";
import { PARAM_SCENARIO } from "./run-drawer-scenario";
import { createScenario, publishPackage, scenarioUsing, triggerRun } from "./support";

// 运行抽屉（原型 #/scenarios 的运行抽屉）：入口参数、触发前检查、触发后的运行摘要。

test("填写入口参数并触发：字段校验、检查清单，触发后抽屉显示运行摘要并实时更新", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", PARAM_SCENARIO);

	await page.goto("/orchestrations");
	const runButton = page
		.getByRole("article", { name: "巡检" })
		.getByRole("button", { name: "运行" });
	await runButton.click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await expect(drawer).toContainText("v1");
	const checks = drawer.getByRole("list", { name: "触发前检查" });
	await expect(checks).toContainText("结构、引用与输入检查通过");
	await expect(checks).toContainText("节点包版本已锁定");
	await expect(checks).toContainText("demo-checks 1.2.0");
	await expect(checks).toContainText("引用的 Agent 都在线");
	await expect(drawer).toContainText("触发人：tester");

	const host = drawer.getByLabel("host");
	await expect(drawer.getByLabel("steps")).toHaveValue("3");
	await expect(drawer.getByRole("switch", { name: "dry_run" })).not.toBeChecked();

	// 必填参数留空时不能触发，错误挂在字段上。
	await drawer.getByRole("button", { name: "触发运行" }).click();
	await expect(host).toHaveAttribute("aria-invalid", "true");
	await expect(host).toHaveAccessibleDescription("必填");
	await expect(drawer.getByRole("textbox", { name: /^api_token / })).toHaveAccessibleDescription(
		/必填/,
	);
	await drawer.getByLabel("steps").fill("很多");
	await expect(drawer.getByLabel("steps")).toHaveAccessibleDescription(/需要一个数字/);

	await host.fill("10.0.0.8");
	await expect(host).not.toHaveAttribute("aria-invalid");
	await drawer.getByLabel("steps").fill("5");
	await drawer.getByRole("switch", { name: "dry_run" }).click();
	await drawer.getByRole("textbox", { name: /^api_token / }).fill("tok-live");
	await drawer.getByRole("button", { name: "触发运行" }).click();

	const task = await agent.nextAssign();
	expect(task.inputs).toEqual({ host: "10.0.0.8" });
	const summary = drawer.getByRole("region", { name: "运行摘要" });
	await expect(summary.getByTestId("summary-status")).toHaveText("运行中");
	await expect(summary.getByRole("img", { name: "主链 1/2" })).toBeVisible();
	const active = summary.getByRole("list", { name: "正在执行的节点" });
	await expect(active).toContainText("ping");
	await expect(active).toContainText("agent-a");

	// 实时更新：进度与日志。
	agent.progress(task, 40, 100, "第 40 步");
	agent.logs(task, [
		logLine(clock, 1, "连接 10.0.0.8"),
		logLine(clock, 2, "丢包率偏高", LogLevel.WARN, 1000),
	]);
	await expect(active.getByRole("progressbar", { name: "ping 进度" })).toHaveAttribute(
		"aria-valuenow",
		"40",
	);
	await expect(active).toContainText("40 / 100 · 第 40 步");
	const logs = summary.getByRole("list", { name: "最新日志" });
	await expect(logs).toContainText("连接 10.0.0.8");
	await expect(logs).toContainText("WARN 丢包率偏高");

	await agent.succeed(task);
	await expect(summary.getByTestId("summary-status")).toHaveText("成功");
	await expect(summary.getByRole("img", { name: "主链 2/2" })).toBeVisible();
	await expect(drawer.getByRole("button", { name: "取消运行" })).toHaveCount(0);

	// 运行参数：敏感参数已打码。
	const runId = (await (await controlPlane.fetch("/runs?limit=1")).json()).runs[0].id as string;
	const run = await (await controlPlane.fetch(`/runs/${runId}`)).json();
	expect(run.params).toMatchObject({ host: "10.0.0.8", steps: 5, dry_run: true });
	expect(run.params.api_token).not.toBe("tok-live");

	await drawer.getByRole("link", { name: "打开运行详情" }).click();
	await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
	await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("摘要里可以取消运行", async ({ page, controlPlane, connectAgent }) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));

	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await drawer.getByRole("button", { name: "触发运行" }).click();
	const task = await agent.nextAssign();
	await expect(drawer.getByTestId("summary-status")).toHaveText("运行中");

	await drawer.getByRole("button", { name: "取消运行" }).click();
	const confirm = page.getByRole("dialog", { name: /取消运行/ });
	const runId = (await (await controlPlane.fetch("/runs?limit=1")).json()).runs[0].id as string;
	await confirm.getByLabel(/输入运行编号前 4 位/).fill(runId.slice(0, 4));
	await confirm.getByRole("button", { name: "取消运行" }).click();
	expect(await agent.nextCancel()).toMatchObject({ taskId: task.taskId });
	await agent.cancelled(task);
	await expect(drawer.getByTestId("summary-status")).toHaveText("已取消");
});

test("预检有阻断项时不能触发，「前往」进入编排画布并选中问题节点", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const doc = scenarioUsing("agent-a");
	const id = await createScenario(controlPlane, "巡检", {
		...doc,
		nodes: doc.nodes.map((n) => (n.id === "ping" ? { ...n, agent: "ghost" } : n)),
	});

	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	const checks = drawer.getByRole("list", { name: "触发前检查" });
	await expect(checks).toContainText("Agent 有 1 个问题");
	await expect(checks).toContainText("ghost 还没有注册过");
	await expect(checks).toContainText("结构、引用与输入检查通过");
	await expect(drawer.getByRole("button", { name: "触发运行" })).toBeDisabled();

	await checks.getByRole("button", { name: "前往 ping" }).click();
	await expect(page).toHaveURL(new RegExp(`/orchestrations/${id}\\?node=ping$`));
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.locator('[data-node-id="ping"]')).toHaveAttribute("aria-pressed", "true");
});

test("引用的 Agent 不在线时提示任务会排队，仍可触发；已有运行中的运行时显示提示与查看入口", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));
	const runId = await triggerRun(controlPlane, id);
	await agent.nextAssign();
	await agent.disconnect();

	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await expect(drawer.getByRole("list", { name: "触发前检查" })).toContainText(
		"agent-a 当前不在线",
	);
	await expect(drawer).toContainText("任务会排队");
	await expect(drawer.getByRole("button", { name: "触发运行" })).toBeEnabled();

	const notice = drawer.getByRole("status").filter({ hasText: "运行中的运行" });
	await expect(notice).toContainText(`该场景已有 1 个运行中的运行 ${runId.slice(0, 8)}`);
	await notice.getByRole("link", { name: "查看" }).click();
	await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
	await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("敏感参数默认隐藏，可以临时显示 5 秒", async ({ page, controlPlane, connectAgent }) => {
	await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", PARAM_SCENARIO);

	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	const token = drawer.getByRole("textbox", { name: /^api_token / });
	await token.fill("tok-live");
	await expect(token).toHaveAttribute("type", "password");
	await expect(token).toHaveAccessibleDescription("界面和日志中都会打码");

	await drawer.getByRole("button", { name: "临时显示 api_token 5 秒" }).click();
	await expect(token).toHaveAttribute("type", "text");
	await expect(drawer.getByRole("button", { name: "隐藏 api_token" })).toBeVisible();
	await expect(token).toHaveAttribute("type", "password", { timeout: 8000 });
});

test("抽屉锁定焦点，Esc 关闭后焦点回到「运行」按钮", async ({ page, controlPlane }) => {
	await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));
	await page.goto("/orchestrations");
	const runButton = page
		.getByRole("article", { name: "巡检" })
		.getByRole("button", { name: "运行" });
	await runButton.click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await expect(drawer.getByRole("list", { name: "触发前检查" })).toBeVisible();
	for (let i = 0; i < 8; i++) {
		await page.keyboard.press("Tab");
		await expect(drawer.locator(":focus")).toHaveCount(1);
	}
	await page.keyboard.press("Escape");
	await expect(drawer).toHaveCount(0);
	await expect(runButton).toBeFocused();
});
