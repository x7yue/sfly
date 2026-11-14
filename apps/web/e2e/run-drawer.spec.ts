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
	await expect(checks).toContainText("结构与引用检查通过");
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
	await expect(active).toContainText("执行中");

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
	// 时间都在运行开始那天：只显示时刻。
	await expect(logs.getByRole("listitem")).toHaveText([
		/^\d{2}:\d{2}:\d{2} INFO 连接 10\.0\.0\.8$/,
		/^\d{2}:\d{2}:\d{2} WARN 丢包率偏高$/,
	]);
	// 有一行的时间不在那一天（Agent 时间被改到 613 天后）：每一行都带上日期。
	agent.logs(task, [logLine(clock, 3, "时间被改了", LogLevel.INFO, 613 * 24 * 3600 * 1000)]);
	await expect(logs.getByRole("listitem")).toHaveText([
		/^2026-01-01 \d{2}:\d{2}:\d{2} INFO 连接 10\.0\.0\.8$/,
		/^2026-01-01 \d{2}:\d{2}:\d{2} WARN 丢包率偏高$/,
		/^2027-09-06 \d{2}:\d{2}:\d{2} INFO 时间被改了$/,
	]);

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

test("同一个运行在页面上只开一条事件流（摘要、底部按钮共用；指标增量只追加一次）", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));
	const streams: string[] = [];
	page.on("request", (request) => {
		if (/\/api\/runs\/[^/]+\/events/.test(request.url())) streams.push(request.url());
	});

	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await drawer.getByRole("button", { name: "触发运行" }).click();
	await agent.nextAssign();
	await expect(drawer.getByTestId("summary-status")).toHaveText("运行中");
	await expect(drawer.getByRole("button", { name: "取消运行" })).toBeVisible();
	await page.waitForTimeout(300);
	expect(streams).toHaveLength(1);
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

	await expect(drawer.getByRole("button", { name: "取消运行" })).toHaveAttribute(
		"data-variant",
		"default",
	);
	await drawer.getByRole("button", { name: "取消运行" }).click();
	const confirm = page.getByRole("dialog", { name: /取消运行/ });
	await confirm.getByRole("button", { name: "取消运行" }).click();
	expect(await agent.nextCancel()).toMatchObject({ taskId: task.taskId });
	await agent.cancelled(task);
	await expect(drawer.getByTestId("summary-status")).toHaveText("已取消");
});

test("取消请求的响应晚于运行结束到达：摘要保持「已取消」，不被运行结束前生成的响应覆盖（#47）", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));
	// 取消请求照常到达控制面（响应里是「运行中、取消中」），响应先扣住，等事件流推送了最终状态再交给页面。
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(/\/api\/runs\/[^/]+\/cancel$/, async (route) => {
		const response = await route.fetch();
		await held;
		await route.fulfill({ response });
	});

	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await drawer.getByRole("button", { name: "触发运行" }).click();
	const task = await agent.nextAssign();
	await expect(drawer.getByTestId("summary-status")).toHaveText("运行中");
	await drawer.getByRole("button", { name: "取消运行" }).click();
	const confirm = page.getByRole("dialog", { name: /取消运行/ });
	await confirm.getByRole("button", { name: "取消运行" }).click();
	expect(await agent.nextCancel()).toMatchObject({ taskId: task.taskId });
	await agent.cancelled(task);
	const status = drawer.getByTestId("summary-status");
	await expect(status).toHaveText("已取消");

	// 记录之后每一次渲染出的状态：旧响应覆盖最终状态时会闪回「取消中」。闪回与事件流推送落在
	// 同一次渲染里时实时连接不会重连，就永远停在「取消中」（CI 上的偶发失败）。
	const history = await drawer.evaluateHandle((root) => {
		const seen: string[] = [];
		new MutationObserver(() => {
			const text = root.querySelector('[data-testid="summary-status"]')?.textContent ?? "";
			if (seen.at(-1) !== text) seen.push(text);
		}).observe(root, { childList: true, subtree: true, characterData: true });
		return seen;
	});
	release();
	// 确认弹窗在处理响应时关闭：关闭之后，运行结束前生成的响应已经处理完。
	await expect(confirm).toBeHidden();
	await expect(status).toHaveText("已取消");
	expect(await history.jsonValue()).not.toContain("取消中");
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
	await expect(checks).toContainText("结构与引用检查通过");
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

test("编排画布的「运行」打开同一个抽屉，「前往」在画布上选中问题节点", async ({
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

	await page.goto(`/orchestrations/${id}`);
	const runButton = page.getByRole("button", { name: "运行", exact: true });
	await runButton.click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await expect(drawer.getByRole("button", { name: "触发运行" })).toBeDisabled();
	await drawer.getByRole("button", { name: "前往 ping" }).click();
	await expect(drawer).toHaveCount(0);
	await expect(page).toHaveURL(new RegExp(`/orchestrations/${id}$`));
	await expect(page.locator('[data-node-id="ping"]')).toHaveAttribute("aria-pressed", "true");

	await runButton.click();
	await page.keyboard.press("Escape");
	await expect(drawer).toHaveCount(0);
	await expect(runButton).toBeFocused();
});

test("打开抽屉时焦点不落在「取消」上：检查加载完后交给第一个参数，没有参数就交给「触发运行」，再按 Enter 直接触发", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", PARAM_SCENARIO);
	await createScenario(controlPlane, "冒烟", scenarioUsing("agent-a"));
	await page.goto("/orchestrations");

	const inspect = page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" });
	await inspect.focus();
	await page.keyboard.press("Enter");
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await expect(drawer.getByRole("textbox", { name: /^host/ })).toBeFocused();
	await expect(drawer.getByRole("button", { name: "取消" })).not.toBeFocused();
	await page.keyboard.press("Escape");
	await expect(drawer).toHaveCount(0);
	await expect(inspect).toBeFocused();

	const smoke = page.getByRole("article", { name: "冒烟" }).getByRole("button", { name: "运行" });
	await smoke.focus();
	await page.keyboard.press("Enter");
	const quick = page.getByRole("dialog", { name: "运行 · 冒烟" });
	await expect(quick.getByRole("button", { name: "触发运行" })).toBeFocused();
	await page.keyboard.press("Enter");
	await agent.nextAssign();
	await expect(quick.getByTestId("summary-status")).toHaveText("运行中");
	// 触发成功后抽屉里就地显示运行摘要，不再发「已触发运行」的通知。
	await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

test("提交没有通过校验时，焦点移到第一个出错的字段", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", PARAM_SCENARIO);
	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await expect(drawer.getByRole("textbox", { name: /^host/ })).toBeFocused();

	await drawer.getByRole("button", { name: "触发运行" }).click();
	await expect(drawer.getByRole("textbox", { name: /^host/ })).toHaveAttribute(
		"aria-invalid",
		"true",
	);
	await expect(drawer.getByRole("textbox", { name: /^host/ })).toBeFocused();
	await drawer.getByRole("textbox", { name: /^host/ }).fill("10.0.0.8");
	await drawer.getByRole("button", { name: "触发运行" }).click();
	await expect(drawer.getByRole("textbox", { name: /^api_token / })).toBeFocused();
});

test("入口参数名不被截断：长参数名折行、必填星号还在，输入框左沿对齐", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const params = [
		{ name: "release_file", type: "string", required: true },
		{ name: "request_timeout_ms", type: "number", default: 3000 },
		{ name: "queue_timeout_seconds_for_the_slow_consumers", type: "number", default: 30 },
		{ name: "dry_run", type: "boolean", default: false },
	];
	await createScenario(controlPlane, "长参数名", {
		...PARAM_SCENARIO,
		nodes: PARAM_SCENARIO.nodes.map((n) => (n.id === "entry" ? { ...n, params } : n)),
	});
	await page.goto("/orchestrations");
	await page
		.getByRole("article", { name: "长参数名" })
		.getByRole("button", { name: "运行" })
		.click();
	const drawer = page.getByRole("dialog", { name: "运行 · 长参数名" });
	await expect(drawer.getByRole("textbox", { name: /^release_file/ })).toBeVisible();

	const labels = drawer.locator("form label");
	const clipped = await labels.evaluateAll((els) =>
		els.filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.textContent),
	);
	expect(clipped).toEqual([]);
	await expect(labels.first()).toContainText("release_file*");
	await expect(labels.nth(2)).toContainText("queue_timeout_seconds_for_the_slow_consumers");
	const formWidth = await drawer.locator("form").evaluate((el) => el.getBoundingClientRect().width);
	const widths = await labels.evaluateAll((els) =>
		els.map((el) => el.getBoundingClientRect().width),
	);
	expect(Math.max(...widths)).toBeLessThanOrEqual(formWidth * 0.4 + 1);
	const lefts = await drawer
		.locator('form [data-slot="input"]')
		.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
	expect(new Set(lefts).size).toBe(1);
});

test("摘要里节点的进度条随轮询平滑推进（clip-path 过渡），按进度占比露出", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));
	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await drawer.getByRole("button", { name: "触发运行" }).click();
	const task = await agent.nextAssign();
	agent.progress(task, 25, 100, "第 25 步");
	const bar = drawer.getByRole("progressbar", { name: "ping 进度" });
	await expect(bar).toHaveAttribute("aria-valuenow", "25");
	const fill = bar.locator("i");
	await expect(fill).toHaveCSS("clip-path", /inset\(0px 75% 0px 0px\)/);
	await expect(fill).toHaveCSS("transition-property", "clip-path");
	agent.progress(task, 80, 100, "第 80 步");
	await expect(fill).toHaveCSS("clip-path", /inset\(0px 20% 0px 0px\)/);
});
