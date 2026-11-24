import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import {
	AgentUpdateState,
	type AssignedTask,
	LogLevel,
} from "../../server/test/support/fake-agent.js";
import { actionsScenario, actionTable, loadSummary } from "./actions-support";
import { annotated, annotationBand } from "./annotation-support";
import { canvasFocusRun, openCanvasRun } from "./canvas-focus-support";
import {
	createEditorScenario,
	editorDocument,
	inspector,
	nodeCard,
	typedDocument,
	typedNodes,
	zoomOut,
} from "./editor-support";
import { type E2eFixtures, expect, test } from "./fixtures";
import {
	createFocusScenario,
	focusDocument,
	openFocusList,
	saveVersion,
	selectMetricsTab,
	setFocusItems,
} from "./focus-support";
import { failedRun, openFailedOverview } from "./monitor-failure-scenario";
import { queuedOffline, queuedSlotsFull } from "./monitor-queue-scenario";
import {
	connPoint,
	labeledRun,
	largeScenario,
	logLine,
	metricPackage,
	openMonitor,
	pingPoints,
	runningScenario,
	unixAt,
} from "./monitor-scenario";
import { attention, attentionRun, openOverview, overviewRun, readouts } from "./overview-support";
import { driveToRetry, FIRST, namedScenario } from "./run-display-name-scenario";
import { PARAM_SCENARIO } from "./run-drawer-scenario";
import { advance, seedRunRecords } from "./run-records";
import { stoppingRun } from "./stop-subflow-scenario";
import {
	createFeishuBot,
	createScenario,
	elapseWithHeartbeats,
	failApi,
	failRun,
	holdApi,
	publishPackage,
	scenarioUsing,
	setRunNotification,
	triggerRun,
	withSubflow,
} from "./support";
import { saveSecondVersion, twoVersions } from "./versions-support";
import { focusWallRun, longChainRun, manyRuns, seedWall } from "./wall-support";

// 视觉回归：对固定状态截图并与 e2e/__screenshots__ 中的基线比对（见 playwright.config.ts）。
// 数据都是确定的：手动时钟、固定的浏览器时间与时区、内容相同的节点包归档（sha256 不变）、
// 固定的控制面对外地址（页面上的 install.sh 命令不随端口变化）与版本号（Agent 列表里的版本不随发版变化）。
test.use({ controlPlaneOptions: { publicHttpUrl: "http://sfly.example:8080", version: "0.1.0" } });

async function twoAgents(connectAgent: E2eFixtures["connectAgent"]) {
	await connectAgent({
		name: "agent-linux",
		agentVersion: "0.1.0",
		os: "linux",
		arch: "x86_64",
		slots: 4,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
		capabilities: [{ name: "files", version: 1 }],
		peer: { port: 50052 },
	});
	const mac = await connectAgent({
		name: "agent-mac",
		agentVersion: "0.1.0",
		os: "macos",
		arch: "aarch64",
		slots: 2,
		capabilities: [{ name: "files", version: 1 }],
		peer: { port: 50052, publicAddress: "10.20.30.40" },
	});
	return mac;
}

test("Agent 列表", async ({ page, connectAgent, controlPlane, clock }) => {
	const linux = await connectAgent({
		name: "agent-linux",
		agentVersion: "0.1.0",
		os: "linux",
		arch: "x86_64",
		slots: 4,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
		capabilities: [{ name: "files", version: 1 }],
		peer: { port: 50052 },
	});
	const mac = await connectAgent({
		name: "agent-mac",
		agentVersion: "0.1.0",
		os: "macos",
		arch: "aarch64",
		slots: 1,
		capabilities: [{ name: "files", version: 1 }],
		peer: { port: 50052, publicAddress: "10.20.30.40" },
	});
	const retired = await connectAgent({
		name: "agent-retired",
		agentVersion: "0.1.0",
		os: "linux",
		arch: "x86_64",
	});
	await retired.disconnect();
	await publishPackage(controlPlane, metricPackage());
	const soakScenario = await createScenario(
		controlPlane,
		"撮合浸泡",
		withSubflow("agent-linux", { probe: "探测主机", subflow: "巡检子流程" }),
	);
	await setFocusItems(controlPlane, soakScenario, [
		{ node_id: "probe", chart: "level", title: "探活 level" },
		{ node_id: "probe", chart: "total" },
		{ node_id: "verify", chart: "level", title: "核对 level" },
	]);
	const soak = await triggerRun(controlPlane, soakScenario);
	const assigned = [await linux.nextAssign(), await linux.nextAssign()];
	const probe = assigned.find((t) => t.nodeId === "probe") as AssignedTask;
	const verify = assigned.find((t) => t.nodeId === "verify") as AssignedTask;
	const inspect = await createScenario(controlPlane, "巡检", scenarioUsing("agent-mac"));
	const running = await triggerRun(controlPlane, inspect);
	const inspecting = await mac.nextAssign();
	await elapseWithHeartbeats(clock, [linux, mac], 95_000);
	const waiting = await triggerRun(controlPlane, inspect);
	await elapseWithHeartbeats(clock, [linux, mac], 65_000);

	// 槽位格里的内容：probe 在做动作、关注项有新数据；verify 只报告了进度，关注项已经 100 秒没有新数据；
	// 巡检没设关注项，显示主指标。
	const now = clock.now().getTime();
	const nowSeconds = Math.floor(now / 1000);
	linux.actionSummary(probe, {
		total: 1,
		reported: 1,
		running: [
			{
				id: 1,
				parent: null,
				depth: 0,
				name: "保持 4 小时",
				fields: {},
				...linux.stamp(now - 150_000),
			},
		],
	});
	linux.metrics(probe, [
		["level", nowSeconds, 4],
		["total", nowSeconds, 1_284_814],
	]);
	linux.progress(verify, 3, 10, "已校验 3 / 10 批");
	linux.metrics(verify, [["level", nowSeconds - 100, 3]]);
	mac.metrics(inspecting, [["level", nowSeconds, 2]]);
	await linux.sync();
	await mac.sync();

	// 三个机架一屏放下。
	await page.setViewportSize({ width: 1440, height: 960 });
	await page.goto("/agents");
	await expect(page.getByRole("region", { name: "agent-retired", exact: true })).toContainText(
		"离线",
	);
	await expect(page.getByRole("region", { name: "agent-mac", exact: true })).toContainText(
		"排队 1",
	);
	// 运行编号是随机的。
	await expect(page).toHaveScreenshot("agents.png", {
		mask: [soak, running, waiting].map((id) => page.getByText(id.slice(0, 8))),
	});
});

test("Agent 列表：版本不一致与更新状态", async ({ page, connectAgent }) => {
	await connectAgent({
		name: "agent-current",
		os: "linux",
		arch: "x86_64",
		peer: { port: 50052, listenError: "端口 50052 已被占用" },
	});
	const states = [
		["agent-old", { state: AgentUpdateState.NONE }],
		["agent-waiting", { state: AgentUpdateState.WAITING_FOR_TASKS, remainingTasks: 2 }],
		[
			"agent-manual",
			{
				state: AgentUpdateState.MANUAL_UPGRADE_REQUIRED,
				reason:
					"Agent 二进制 /usr/local/bin/sfly-agent 不在 /home/qa/.sfly/bin 下（只更新安装脚本安装的 Agent）",
			},
		],
		["agent-failed", { state: AgentUpdateState.FAILED, reason: "sha256 不匹配" }],
	] as const;
	for (const [name, update] of states) {
		const agent = await connectAgent({ name, agentVersion: "0.0.9", os: "linux", arch: "x86_64" });
		agent.send({ case: "heartbeat", value: { runningTasks: [], update } });
		await agent.sync();
	}

	// 五个机架一屏放下，包括头部放不下时换行的那一台。
	await page.setViewportSize({ width: 1440, height: 1280 });
	await page.goto("/agents");
	await expect(page.getByRole("region", { name: "agent-failed", exact: true })).toContainText(
		"更新失败",
	);
	await expect(page).toHaveScreenshot("agents-update.png");
});

test("Agent 列表：立即更新确认框", async ({ page, controlPlane, connectAgent }) => {
	await publishPackage(controlPlane);
	const current = await connectAgent({ name: "agent-linux", os: "linux", arch: "x86_64" });
	await triggerRun(
		controlPlane,
		await createScenario(controlPlane, "巡检", scenarioUsing("agent-linux")),
	);
	const held = await current.nextAssign();
	await current.disconnect();
	const old = await connectAgent({
		name: "agent-linux",
		agentVersion: "0.0.9",
		os: "linux",
		arch: "x86_64",
		runningTasks: [{ taskId: held.taskId, attempt: held.attempt, started: true }],
	});
	old.send({
		case: "heartbeat",
		value: {
			runningTasks: [],
			update: { state: AgentUpdateState.WAITING_FOR_TASKS, remainingTasks: 1 },
		},
	});
	await old.sync();

	await page.goto("/agents");
	await page.getByRole("button", { name: "立即更新" }).click();
	const dialog = page.getByRole("dialog", { name: "立即更新 agent-linux？" });
	await expect(dialog.getByRole("listitem")).toHaveCount(1);
	// 运行 ID 是随机的：确认框里和后面机架的槽位格里各有一处。
	await expect(page).toHaveScreenshot("agents-update-now.png", {
		mask: [page.getByText(held.runId.slice(0, 8))],
	});
});

test("飞书机器人：列表与测试结果", async ({ page, controlPlane, connectAgent, feishu }) => {
	await createFeishuBot(
		controlPlane,
		"压测群",
		feishu.webhookUrl("4f9a8c71-e2b0-43d6-9a55-0a1b2c3d4e5f"),
	);
	await createFeishuBot(
		controlPlane,
		"告警群",
		feishu.webhookUrl("7d02c1b9-5e3a-4c88-b6f1-9e8d7c6b5a40"),
	);
	await createFeishuBot(
		controlPlane,
		"日报群",
		feishu.webhookUrl("c3a1e9d4-0b7f-4a52-8d6e-1f2a3b4c5d6e"),
	);

	// 投递：压测群的消息送达；告警群的消息遇到 HTTP 503，在等重试（积压 1 条）；日报群还没有投递。
	// 消息来源是运行通知（只在失败或取消时发）：场景的节点失败，运行结束时向机器人发一张卡片。
	feishu.replyTo("7d02c1b9-5e3a-4c88-b6f1-9e8d7c6b5a40", { status: 503 });
	await publishPackage(controlPlane);
	const agent = await connectAgent({ name: "agent-a" });
	for (const bot of ["压测群", "告警群"]) {
		const scenario = await createScenario(controlPlane, bot, scenarioUsing("agent-a"));
		await setRunNotification(controlPlane, scenario, { bot });
		await failRun(controlPlane, agent, scenario);
	}

	await page.goto("/feishu-bots");
	const result = (name: string) => page.getByRole("row", { name: new RegExp(`^${name}`) });
	await expect(result("压测群")).toContainText("已送达", { timeout: 15_000 });
	await expect(result("告警群")).toContainText("投递失败", { timeout: 15_000 });
	await result("压测群").getByRole("button", { name: "发送测试消息" }).click();
	await expect(result("压测群")).toContainText("测试消息已送达");
	feishu.reply({ code: 19024, msg: "Key Words Not Found" });
	await result("告警群").getByRole("button", { name: "发送测试消息" }).click();
	await expect(result("告警群")).toContainText("飞书错误码 19024");

	await expect(page).toHaveScreenshot("feishu-bots.png");
});

test("飞书机器人：登记弹窗", async ({ page }) => {
	await page.goto("/feishu-bots");
	await page.getByRole("button", { name: "登记机器人" }).click();
	const dialog = page.getByRole("dialog", { name: "登记飞书机器人" });
	await dialog.getByLabel("名称").fill("压测群");
	await dialog.getByLabel("Webhook 地址").fill("ftp://feishu.example/hook/1");
	await dialog.getByLabel("名称").focus();
	await expect(dialog).toContainText("Webhook 地址必须是 http 或 https 地址");
	await expect(page).toHaveScreenshot("feishu-bots-register.png");
});

test("飞书机器人：还没有登记", async ({ page }) => {
	await page.goto("/feishu-bots");
	await expect(page.getByRole("region", { name: "还没有登记飞书机器人" })).toBeVisible();
	await expect(page).toHaveScreenshot("feishu-bots-empty.png");
});

test("Agent 列表为空", async ({ page }) => {
	await page.goto("/agents");
	const empty = page.getByRole("region", { name: "还没有 Agent 连接" });
	await expect(empty).toContainText("http://sfly.example:8080/install.sh");
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
	// 1.3.0 的节点类型声明了指标与图表（详情里的「声明的指标」「图表」两列）。
	await publishPackage(controlPlane, { version: "1.3.0", ...metricPackage() });
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
	await expect(page.getByRole("group", { name: "运行场景" })).toBeVisible();
	await expect(page).toHaveScreenshot("command-palette.png");
});

test("快捷键面板", async ({ page }) => {
	// 1440×900（默认的视口）：宽到排五列，整个面板放得下、不需要滚动。
	await page.goto("/agents");
	await expect(page.getByRole("heading", { name: "Agent 管理" })).toBeVisible();
	await page.keyboard.press("?");
	const dialog = page.getByRole("dialog", { name: "快捷键" });
	await expect(dialog).toBeVisible();
	await expect
		.poll(() =>
			dialog.locator("div.overflow-y-auto").evaluate((el) => el.scrollHeight - el.clientHeight),
		)
		.toBeLessThanOrEqual(0);
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

/** 场景列表的固定数据：运行中、最近失败、带子流程且 Agent 离线、还没有版本的场景。 */
async function scenarios(
	controlPlane: E2eFixtures["controlPlane"],
	connectAgent: E2eFixtures["connectAgent"],
	clock: E2eFixtures["clock"],
) {
	const linux = await connectAgent({ name: "agent-linux", slots: 4 });
	await (await connectAgent({ name: "agent-mac" })).disconnect();
	await publishPackage(controlPlane);
	const describe = (id: string, description: string) =>
		controlPlane.fetch(`/orchestrations/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", "x-sfly-nickname": "tester" },
			body: JSON.stringify({ description }),
		});
	const ping = (id: string, agent?: string) => ({
		id,
		kind: "package",
		package: "demo-checks",
		node: "ping",
		inputs: { host: "h" },
		...(agent ? { agent } : {}),
	});
	const chain = (ids: string[]) =>
		ids.slice(1).map((to, i) => ({ from: ids[i], to, kind: "chain" }));

	const stress = await createScenario(controlPlane, "撮合压测 · 高并发下单", {
		default_agent: "agent-linux",
		nodes: [
			{ id: "entry", kind: "entry" },
			ping("prepare"),
			{ id: "fan", kind: "async" },
			...["warmup", "load", "verify", "report", "cleanup"].map((id) => ping(id)),
			{ id: "risk", kind: "subflow_entry" },
			ping("rk_watch", "agent-mac"),
			ping("rk_verify", "agent-mac"),
		],
		edges: [
			...chain(["entry", "prepare", "fan", "warmup", "load", "verify", "report", "cleanup"]),
			...chain(["risk", "rk_watch", "rk_verify"]),
			{ from: "fan", to: "risk", kind: "dispatch" },
		],
		packages: { "demo-checks": "1.2.0" },
	});
	await describe(stress, "模拟早高峰下单流量，同时由风控子流程核对拦截结果。");
	const daily = await createScenario(controlPlane, "日终数据处理", {
		...scenarioUsing("agent-linux"),
		nodes: [{ id: "entry", kind: "entry" }, ping("extract"), ping("load"), ping("check")],
		edges: chain(["entry", "extract", "load", "check"]),
	});
	await describe(daily, "每日 18:00 抽取交易数据、入库并核对总账。");
	await createScenario(controlPlane, "登录冒烟");

	await triggerRun(controlPlane, daily);
	await linux.fail(await linux.nextAssign());
	clock.advance(120_000);
	await triggerRun(controlPlane, stress);
	await linux.succeed(await linux.nextAssign());
	await linux.nextAssign();
	clock.advance(20_000); // 不超过租约（30 秒），warmup 仍在执行
}

test("场景卡片", async ({ page, controlPlane, connectAgent, clock }) => {
	await scenarios(controlPlane, connectAgent, clock);
	await page.clock.setFixedTime(clock.now());
	await page.goto("/orchestrations");
	await expect(page.getByRole("article")).toHaveCount(3);
	await expect(page.getByRole("article", { name: "日终数据处理" })).toContainText("失败");
	await expect(page).toHaveScreenshot("scenarios.png");
});

test("场景表格", async ({ page, controlPlane, connectAgent, clock }) => {
	await scenarios(controlPlane, connectAgent, clock);
	await page.clock.setFixedTime(clock.now());
	await page.goto("/orchestrations?view=table");
	await expect(page.getByRole("row")).toHaveCount(4);
	await expect(page).toHaveScreenshot("scenarios-table.png");
});

test("场景的更多菜单", async ({ page, controlPlane, connectAgent, clock }) => {
	await scenarios(controlPlane, connectAgent, clock);
	await page.clock.setFixedTime(clock.now());
	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "撮合压测 · 高并发下单" }).getByLabel("更多操作").click();
	await expect(page.getByRole("menu")).toBeVisible();
	await expect(page).toHaveScreenshot("scenarios-menu.png");
});

test("还没有场景", async ({ page }) => {
	await page.goto("/orchestrations");
	await expect(page.getByRole("region", { name: "还没有场景" })).toBeVisible();
	await expect(page).toHaveScreenshot("scenarios-empty.png");
});

test("运行抽屉：入口参数与触发前检查", async ({ page, controlPlane, connectAgent }) => {
	await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", PARAM_SCENARIO);
	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await drawer.getByRole("textbox", { name: /^api_token / }).fill("tok-live");
	// 必填的 host 留空：显示字段错误。
	await drawer.getByRole("button", { name: "触发运行" }).click();
	await expect(drawer.getByText("必填")).toBeVisible();
	// 只截抽屉：背后的列表定时刷新，与抽屉无关。
	await expect(drawer).toHaveScreenshot("run-drawer-form.png");
});

test("运行抽屉：运行摘要", async ({ page, controlPlane, connectAgent, clock }) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane, metricPackage());
	await createScenario(controlPlane, "巡检", PARAM_SCENARIO);
	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await drawer.getByRole("textbox", { name: /^host/ }).fill("10.0.0.8");
	await drawer.getByRole("textbox", { name: /^api_token / }).fill("tok-live");
	await drawer.getByRole("button", { name: "触发运行" }).click();
	const task = await agent.nextAssign();
	// 等实时推送接上（节点显示为执行中）再上报进度与日志。
	await expect(drawer.getByRole("list", { name: "进行中的节点" })).toContainText("执行中");
	agent.progress(task, 40, 100, "第 40 步");
	agent.logs(task, [
		logLine(clock, 1, "连接 10.0.0.8"),
		logLine(clock, 2, "丢包率偏高", LogLevel.WARN, 1000),
	]);
	agent.metrics(task, pingPoints(clock.now().getTime(), 0, 20));
	await expect(drawer.getByRole("list", { name: "最新日志" })).toContainText("丢包率偏高");
	await expect(drawer).toContainText("40 / 100");
	await expect(drawer.locator('[data-primary-metric="level"] [data-sparkline]')).toBeVisible();
	// 只截抽屉（背后的列表与触发通知不在内）；运行 ID 是随机的，遮住。
	await expect(drawer).toHaveScreenshot("run-drawer-summary.png", {
		mask: [drawer.locator('[data-slot="run-id"]')],
	});
});

test("运行抽屉：运行通知的状态", async ({ page, controlPlane, connectAgent, feishu }) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createFeishuBot(
		controlPlane,
		"压测群",
		feishu.webhookUrl("5b1c7e90-3d42-4a6f-8e0b-9c2d4f6a8b10"),
	);
	const scenario = await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));
	await setRunNotification(controlPlane, scenario, { bot: "压测群" });
	feishu.reply({ code: 19024, msg: "Key Words Not Found" });
	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	await drawer.getByRole("button", { name: "触发运行" }).click();
	await agent.fail(await agent.nextAssign(), "boom");
	await expect(drawer.getByRole("group", { name: "运行通知" })).toContainText("投递失败", {
		timeout: 15_000,
	});
	await expect(drawer).toHaveScreenshot("run-drawer-notification.png", {
		mask: [drawer.locator('[data-slot="run-id"]')],
	});
});

test("场景的运行通知设置：机器人已被删除时的提示", async ({ page, controlPlane, feishu }) => {
	await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("a"));
	await createFeishuBot(controlPlane, "告警群", feishu.webhookUrl("b"));
	const scenario = await createScenario(controlPlane, "订单压测", scenarioUsing("agent-a"));
	await setRunNotification(controlPlane, scenario, {
		bot: "压测群",
		trigger: "failed_or_cancelled",
		title: "【订单压测-A 环境】",
		note: "环境 A，负责人 <at id=ou_1></at>",
	});
	await controlPlane.fetch("/feishu-bots/%E5%8E%8B%E6%B5%8B%E7%BE%A4", {
		method: "DELETE",
		headers: { "x-sfly-nickname": "tester" },
	});
	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "订单压测" }).getByLabel("更多操作").click();
	await page.getByRole("menuitem", { name: "运行通知…" }).click();
	const dialog = page.getByRole("dialog", { name: "运行通知" });
	await expect(dialog.getByRole("alert")).toContainText("已被删除");
	await expect(dialog).toHaveScreenshot("run-notification-dialog.png");
});

test("控制台", async ({ page, controlPlane, connectAgent, clock }) => {
	const { stress, orders } = await seedWall({ page, controlPlane, connectAgent, clock });
	// 撮合压测的 probe 在执行中、verify 失败（来源节点失败，有异常）；订单链路失败，带关注项的最终值。
	await setFocusItems(controlPlane, stress, [
		{ node_id: "probe", chart: "level" },
		{ node_id: "probe", chart: "total" },
		{ node_id: "verify", chart: "level" },
		{ node_id: "verify", chart: "total" },
	]);
	await setFocusItems(controlPlane, orders, [
		{ node_id: "submit", chart: "level" },
		{ node_id: "submit", chart: "total" },
	]);
	// 页面在外壳里滚动，整页截图截不到：窗口加高，让失败行的最终值也在画面里。
	await page.setViewportSize({ width: 1440, height: 1100 });
	await page.goto("/");
	await expect(
		page.getByRole("region", { name: "最近结束", exact: true }).locator("li[data-run-status]"),
	).toHaveCount(2);
	await expect(page.getByRole("region", { name: "关注项", exact: true })).toContainText(
		"2 项需要注意",
	);
	await expect(
		page.getByRole("region", { name: "最近结束", exact: true }).getByRole("group"),
	).toHaveCount(2);
	await expect(
		page.getByRole("region", { name: "场景", exact: true }).getByRole("link"),
	).toHaveCount(6);
	// 运行 ID 是随机的，遮住。
	await expect(page).toHaveScreenshot("dashboard.png", {
		mask: [page.locator('[data-slot="run-id"]')],
	});
});

test("控制台：关注项读数按运行块的宽度放 3 格，有异常的排在最前，其余写「还有 N 个关注项」", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({
		name: "agent-a",
		slots: 4,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await focusWallRun(controlPlane, agent, clock);
	await page.clock.setFixedTime(clock.now());
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto("/");
	const readout = page.getByRole("list", { name: "关注项读数" });
	await expect(readout.getByRole("link")).toHaveCount(4);
	await expect(readout).toContainText("还有 4 个关注项");
	await expect(page).toHaveScreenshot("dashboard-focus-1280.png", {
		mask: [page.locator('[data-slot="run-id"]')],
	});
});

test("控制台：全新环境的「开始使用」", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByRole("region", { name: "开始使用", exact: true })).toContainText(
		"还没有 Agent 连接",
	);
	await expect(page).toHaveScreenshot("dashboard-empty.png");
});

test("控制台：「开始使用」第 1、2 步已完成，白色按钮在第 3 步", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "verify-agent", slots: 2 });
	await publishPackage(controlPlane);
	await page.goto("/");
	await expect(page.locator('[data-step="scenario"]')).toHaveAttribute("data-state", "next");
	await expect(page).toHaveScreenshot("dashboard-empty-progress.png");
});

test("控制台：多个运行时换成紧凑行，点开一行展开成运行块；Agent 很多时只列要看的，其余合并成「N 台空闲」", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent-a", slots: 8 });
	// 另外 6 台：3 台在线空闲，1 台离线，1 台版本不一致，1 台还在准备环境。
	for (const name of ["agent-b", "agent-c", "agent-d"]) await connectAgent({ name, slots: 4 });
	await (await connectAgent({ name: "agent-e", slots: 4 })).disconnect();
	await connectAgent({ name: "agent-f", slots: 4, agentVersion: "0.0.1" });
	await connectAgent({ name: "agent-g", slots: 4 }, { preparing: true });
	await publishPackage(controlPlane);
	await manyRuns(controlPlane, agent, clock, 7);
	await page.clock.setFixedTime(clock.now());
	await page.goto("/");
	const left = page.getByRole("region", { name: "正在运行", exact: true });
	await left.getByRole("button", { name: /浸泡 06/ }).click();
	await expect(left.getByRole("region", { name: "浸泡 06", exact: true })).toBeVisible();
	await expect(left.getByRole("button", { expanded: false })).toHaveCount(6);
	const agents = page.getByRole("region", { name: "Agent", exact: true });
	await expect(agents.getByRole("heading", { level: 3 })).toHaveText([
		"agent-a",
		"agent-e",
		"agent-f",
		"agent-g",
	]);
	await expect(agents).toContainText("3 台空闲");
	await expect(page).toHaveScreenshot("dashboard-many.png", {
		mask: [page.locator('[data-slot="run-id"]')],
	});
});

test("控制台：30 个节点的长链只画当前站附近几站，其余折成「已完成 N 个」「还有 N 个」", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent-a", slots: 4 });
	await publishPackage(controlPlane);
	await longChainRun(controlPlane, agent, clock);
	await page.clock.setFixedTime(clock.now());
	await page.goto("/");
	const lines = page.getByRole("list", { name: "各链进度" });
	await expect(lines).toContainText("已完成 15 个");
	await expect(lines).toContainText("还有 13 个");
	await expect(page).toHaveScreenshot("dashboard-long-chain.png", {
		mask: [page.locator('[data-slot="run-id"]')],
	});
});

test("运行记录", async ({ page, controlPlane, connectAgent, clock }) => {
	const agent = await connectAgent({ name: "agent", slots: 4 });
	await seedRunRecords(controlPlane, clock, agent);
	await advance(clock, agent, 42_000);
	await page.goto("/runs");
	await expect(page.getByRole("article")).toHaveCount(2);
	await expect(page.getByRole("table", { name: "历史运行" }).getByRole("row")).toHaveCount(5);
	await expect(page.getByRole("article").nth(1).getByRole("listitem")).toContainText("37 / 120");
	await expect(page.getByRole("article").first().locator("[data-sparkline]")).toBeVisible();
	// 运行 ID 是随机的，遮住。
	await expect(page).toHaveScreenshot("runs.png", {
		fullPage: true,
		mask: [page.locator('[data-slot="run-id"]')],
	});
});

test("运行记录为空", async ({ page }) => {
	await page.goto("/runs");
	await expect(page.getByRole("region", { name: "没有运行记录" })).toBeVisible();
	await expect(page).toHaveScreenshot("runs-empty.png");
});

/** 等图表工作区加载完（目录与各组的序列）。 */
async function chartsLoaded(page: Page) {
	const ws = page.getByRole("region", { name: "图表工作区" });
	await expect(ws.locator("[data-group]").first()).toBeVisible();
	await expect(ws.getByText("加载中")).toHaveCount(0);
}

/**
 * 这个元素是不是被滚动区裁掉了（整个在某个祖先的可视范围之外）：遮罩画在元素原来的位置，不管它有没有被裁掉，
 * 滚出可视范围的元素的遮罩会盖住别的东西（时间线里滚出去的子流程行，遮罩落在图表工具栏上），所以只遮看得见的。
 */
const clippedOut = (el: Element): boolean => {
	const r = el.getBoundingClientRect();
	if (r.width === 0 || r.height === 0) return true;
	for (let p = el.parentElement; p; p = p.parentElement) {
		const style = getComputedStyle(p);
		if (style.overflowX === "visible" && style.overflowY === "visible") continue;
		const q = p.getBoundingClientRect();
		if (r.bottom <= q.top || r.top >= q.bottom || r.right <= q.left || r.left >= q.right)
			return true;
	}
	return false;
};

/** 定位到的元素里没有被裁掉的那几个（逐个判断，用在 `mask` 上）。 */
async function shown(locator: Locator): Promise<Locator[]> {
	const result: Locator[] = [];
	for (const item of await locator.all()) {
		if (!(await item.evaluate(clippedOut))) result.push(item);
	}
	return result;
}

/** 失败的节点出错之前写的一行 WARN（概览的「其他警告与错误」里留下的那一行）。 */
const WARN_LINE = "重试间隔偏长，已放宽到 5s";

/** 运行 ID 是随机的：截图时遮住显示运行编号与子流程实例编号的地方（只遮看得见的，见 {@link clippedOut}）。 */
const runIds = async (page: Page): Promise<Locator[]> =>
	(
		await Promise.all(
			[
				// 弹窗打开时页面其余部分对辅助技术隐藏，这里用 CSS 选择器而不是 role。
				page.locator('button[aria-label^="切换运行"]'),
				page.locator('ul[aria-label="各链状态"]'),
				page.locator('[data-chain-row] button:has-text("子流程")'),
				page.getByRole("dialog").getByRole("heading"),
				page.getByRole("dialog").locator("label .font-mono"),
			].map(shown),
		)
	).flat();

test("运行监控：运行中（时间线、选中节点的日志）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId, "fetch");
	await expect(page.getByRole("log", { name: "日志" })).toContainText("batch committed");
	await chartsLoaded(page);
	await page.mouse.move(700, 870); // 不停在时间线上，避免截到悬停竖线
	await expect(page).toHaveScreenshot("monitor-running.png", { mask: await runIds(page) });
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
	await chartsLoaded(page);
	await page.mouse.move(700, 870);
	await expect(page).toHaveScreenshot("monitor-failed.png", { mask: await runIds(page) });
});

test("运行监控：详情的「动作」页签（正在做的按层级缩进、最近 20 个）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await actionsScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId, "verify", "actions");
	await expect(actionTable(page).locator('tr[data-action-id="1204"]')).toBeVisible();
	await expect(actionTable(page).locator('tbody[data-group="recent"]')).toBeVisible();
	await chartsLoaded(page);
	await page.mouse.move(700, 870);
	await expect(page).toHaveScreenshot("monitor-actions.png", { mask: await runIds(page) });
});

test("运行监控：概览（关注项的读数和图表，没有异常）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await overviewRun(controlPlane, connectAgent, clock);
	await openOverview(page, clock, runId);
	await expect(readouts(page).getByRole("button")).toHaveCount(2);
	await expect(page.locator('[data-focus-chart] svg[role="img"]')).toHaveCount(3);
	await page.mouse.move(20, 880);
	await expect(page).toHaveScreenshot("monitor-overview.png", {
		mask: [...(await runIds(page)), page.locator("[data-chain-id]")],
	});
});

test("运行监控：概览（有异常：「需要注意」、WARN 的读数、没有新数据的图表）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await attentionRun(controlPlane, connectAgent, clock);
	await openOverview(page, clock, runId);
	await expect(attention(page).getByRole("listitem")).toHaveCount(3);
	await expect(page.locator('[data-focus-chart] svg[role="img"]')).toHaveCount(4);
	await expect(page.locator("[data-stale-gap]")).toHaveCount(1);
	await page.mouse.move(20, 880);
	await expect(page).toHaveScreenshot("monitor-overview-attention.png", {
		mask: [...(await runIds(page)), page.locator("[data-chain-id]")],
	});
});

// 失败的运行（#458）：概览首屏最上面是失败区域；链路卡片的站名用上整行的宽度，被跳过的节点单独计数；
// 顶栏里预设名和耗时不被挤掉；时间线的名称列显示名称优先。两个视口都截图。
for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
] as const) {
	test(`运行监控：概览（失败的运行：首屏最上面是失败区域）${viewport.width}×${viewport.height}`, async ({
		page,
		controlPlane,
		connectAgent,
		clock,
	}) => {
		// 失败的节点在出错之前写了一行 WARN：「其他警告与错误」里只剩它（失败区域写了的 ERROR 和出错位置不再列一遍），
		// 基线里看得到节点名一列。
		const { runId } = await failedRun(controlPlane, connectAgent, clock, {
			cleanupDone: true,
			warn: WARN_LINE,
		});
		await page.setViewportSize(viewport);
		await openFailedOverview(page, clock, runId);
		await expect(page.getByTestId("failure-area")).toBeVisible();
		await expect(
			page.getByRole("region", { name: "其他警告与错误" }).getByRole("button"),
		).toHaveCount(1);
		// 运行已经结束：读数不再刷新，顶栏不写「数据更新于」；失败区域已经写着失败，顶栏也不重复摘要。
		await expect(page.getByTestId("focus-freshness")).toHaveCount(0);
		await expect(page.getByRole("banner").getByTestId("run-failure")).toHaveCount(0);
		await page.mouse.move(20, viewport.height - 20);
		await expect(page).toHaveScreenshot(`monitor-overview-failed-${viewport.width}.png`, {
			mask: await runIds(page),
		});
	});

	test(`运行监控：概览（运行还在进行、已有节点失败）${viewport.width}×${viewport.height}`, async ({
		page,
		controlPlane,
		connectAgent,
		clock,
	}) => {
		const { runId } = await failedRun(controlPlane, connectAgent, clock, {
			cleanupDone: false,
			warn: WARN_LINE,
		});
		await page.setViewportSize(viewport);
		await openFailedOverview(page, clock, runId);
		await expect(page.getByTestId("failure-area")).toBeVisible();
		await expect(page.getByTestId("focus-freshness")).toBeVisible();
		await expect(
			page.getByRole("region", { name: "其他警告与错误" }).getByRole("button"),
		).toHaveCount(1);
		await page.mouse.move(20, viewport.height - 20);
		await expect(page).toHaveScreenshot(`monitor-overview-failed-running-${viewport.width}.png`, {
			mask: await runIds(page),
		});
	});

	test(`运行监控：详情的时间线名称列（显示名称优先，节点 ID 让位）${viewport.width}×${viewport.height}`, async ({
		page,
		controlPlane,
		connectAgent,
		clock,
	}) => {
		const { runId } = await failedRun(controlPlane, connectAgent, clock);
		await page.setViewportSize(viewport);
		await openMonitor(page, clock, runId);
		await expect(page.getByRole("region", { name: "图表工作区" })).toBeVisible();
		await page.mouse.move(20, viewport.height - 20);
		await expect(page).toHaveScreenshot(`monitor-failure-timeline-${viewport.width}.png`, {
			mask: await runIds(page),
		});
	});
}

// 排队中的节点写明在等谁（#457）：Agent 不在线、槽位占满；详情的尝试卡片写同样的话。
for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 800 },
] as const) {
	test(`运行监控：概览（节点在排队，等的 Agent 不在线）${viewport.width}×${viewport.height}`, async ({
		page,
		controlPlane,
		connectAgent,
		clock,
	}) => {
		const { runId } = await queuedOffline(controlPlane, connectAgent, clock);
		await page.setViewportSize(viewport);
		await openFailedOverview(page, clock, runId);
		await expect(page.getByTestId("waiting-nodes")).toBeVisible();
		await page.mouse.move(20, viewport.height - 20);
		await expect(page).toHaveScreenshot(`monitor-overview-queued-offline-${viewport.width}.png`, {
			mask: await runIds(page),
		});
	});
}

test("运行监控：概览（节点在排队，Agent 在线但槽位占满，写明占着槽位的任务）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await queuedSlotsFull(controlPlane, connectAgent, clock);
	await openFailedOverview(page, clock, runId);
	await expect(page.getByTestId("queue-wait-holders").first()).toBeVisible();
	await page.mouse.move(20, 880);
	await expect(page).toHaveScreenshot("monitor-overview-queued-slots.png", {
		// 占着槽位的任务写着运行编号（随机的）：和别处的运行编号一样遮住。
		mask: [...(await runIds(page)), page.getByTestId("queue-wait-holders").getByRole("link")],
	});
});

test("运行监控：详情（选中排队中的节点，尝试卡片写明在等谁）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await queuedOffline(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId, "a", "attempts");
	await expect(page.getByRole("article", { name: "准备环境（a） 第 1 次尝试" })).toBeVisible();
	await expect(page.getByRole("region", { name: "图表工作区" })).toBeVisible();
	await page.mouse.move(20, 880);
	await expect(page).toHaveScreenshot("monitor-queued-attempt.png", { mask: await runIds(page) });
});

test("运行监控：图表工作区（小型运行，全部展开，悬停联动）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	const ws = page.getByRole("region", { name: "图表工作区" });
	await ws.getByRole("button", { name: "全部展开" }).click();
	await expect(ws.getByRole("figure")).toHaveCount(12);
	await chartsLoaded(page);
	const plot = ws
		.getByRole("region", { name: "probe 的图表" })
		.getByRole("figure", { name: "level", exact: true })
		.locator("svg[data-plot]");
	await plot.scrollIntoViewIfNeeded();
	const box = await plot.boundingBox();
	if (!box) throw new Error("没有绘图区");
	await page.mouse.move(box.x + box.width * (4.5 / 8), box.y + box.height / 2);
	await expect(page.locator("[data-hover-reading]").first()).toBeVisible();
	await expect(page).toHaveScreenshot("monitor-charts.png", { mask: await runIds(page) });
});

test("运行监控：多序列图表（超过 10 个序列时置灰的图例、悬停提示）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { agent, task, runId, clock0 } = await labeledRun(
		{ controlPlane, connectAgent, clock },
		[
			{ name: "tps", unit: "req/s", kind: "gauge" },
			{ name: "conn_tps", unit: "req/s", kind: "gauge", labels: ["host"] },
		],
		[
			{ title: "各连接", type: "line", metrics: ["conn_tps"] },
			{ title: "合计与各连接", type: "area", metrics: ["tps", "conn_tps"] },
		],
	);
	// 14 个连接、第 1–8 秒，各自围绕不同的水平起伏。
	const hosts = Array.from({ length: 14 }, (_, i) => `10.0.0.${i + 1}`);
	const level = (i: number, s: number) => 10 + i * 6 + ((i * 7 + s * 5) % 11);
	agent.metrics(
		task,
		[1, 2, 3, 4, 5, 6, 7, 8].flatMap((s) => [
			...hosts.map((h, i) => connPoint(clock0, { host: h }, s, level(i, s))),
			["tps", unixAt(clock0, s), 200 + s * 4] as [string, number, number],
		]),
	);
	await agent.sync();
	clock.advance(9000);
	await openMonitor(page, clock, runId, "ping");
	await chartsLoaded(page);
	// ping 没有日志：底部面板自动收起，图表区高一些。
	await expect(
		page.getByRole("region", { name: "底部面板" }).getByRole("button", { name: "展开" }),
	).toBeVisible();
	const plot = page
		.getByRole("region", { name: "ping 的图表" })
		.getByRole("figure", { name: "各连接", exact: true })
		.locator("svg[data-plot]");
	const box = await plot.boundingBox();
	if (!box) throw new Error("没有绘图区");
	await page.mouse.move(box.x + box.width * (6.5 / 9), box.y + box.height / 2);
	await expect(page.locator("[data-hover-values]")).toBeVisible();
	await expect(page).toHaveScreenshot("monitor-charts-series.png", { mask: await runIds(page) });
});

test("运行监控：图表工作区（大型运行，定位到失败的组）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	test.setTimeout(90_000);
	const { runId } = await largeScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	const failed = page.getByRole("region", { name: "s08 的图表" });
	await expect(failed.getByTestId("node-summary")).toBeVisible();
	await chartsLoaded(page);
	await expect(failed.getByRole("figure", { name: "level", exact: true })).toContainText("8");
	await page.mouse.move(700, 870);
	await expect(page).toHaveScreenshot("monitor-charts-large.png", { mask: await runIds(page) });
});

test("运行监控：取消确认弹窗", async ({ page, controlPlane, connectAgent, clock }) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	await chartsLoaded(page);
	await page.getByRole("banner").getByRole("button", { name: "取消运行" }).click();
	await expect(page.getByRole("dialog", { name: /取消运行/ })).toBeVisible();
	await expect(page).toHaveScreenshot("monitor-cancel.png", { mask: await runIds(page) });
});

test("命令面板：运行监控页的「当前页面」", async ({ page, controlPlane, connectAgent, clock }) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	await agent.succeed(tasks.probe as AssignedTask);
	await agent.fail(tasks.verify as AssignedTask, "AssertionError: 仍然漏拦");
	const cleanup = await agent.nextAssign();
	clock.advance(1000);
	await agent.succeed(cleanup);
	await openMonitor(page, clock, runId);
	await chartsLoaded(page);
	await page.keyboard.press("Control+k");
	const palette = page.getByRole("dialog", { name: "命令面板" });
	await expect(palette.getByRole("group", { name: "当前页面" })).toBeVisible();
	await expect(palette.getByRole("group", { name: "运行", exact: true })).toBeVisible();
	await expect(page).toHaveScreenshot("command-palette-monitor.png", {
		mask: [
			...(await runIds(page)),
			palette.getByRole("group", { name: "运行", exact: true }).locator(".font-mono"),
		],
	});
});

test.describe("编排画布", () => {
	test.beforeEach(async ({ page, connectAgent, controlPlane }) => {
		await twoAgents(connectAgent);
		const id = await createEditorScenario(controlPlane);
		await page.goto(`/orchestrations/${id}`);
		await expect(nodeCard(page, "sub_ping")).toBeVisible();
		await expect(page.getByRole("toolbar", { name: "画布工具" })).toBeVisible();
	});
	// 鼠标停在空白处，避免截到悬停样式与提示。
	const idle = (page: import("@playwright/test").Page) => page.mouse.move(700, 760);

	test("打开时适配视图", async ({ page }) => {
		await idle(page);
		await expect(page).toHaveScreenshot("editor.png");
	});

	test("选中节点与检查器", async ({ page }) => {
		await nodeCard(page, "fetch").click();
		await page.getByRole("textbox", { name: "输入 expect" }).fill("abc");
		await page.getByRole("textbox", { name: "输入 expect" }).blur();
		await idle(page);
		await expect(page.getByText("1 处字段错误")).toBeVisible();
		await expect(page).toHaveScreenshot("editor-inspector.png");
	});

	test("拖宽后的检查器", async ({ page }) => {
		await nodeCard(page, "fetch").click();
		const handle = page.getByRole("separator", { name: "调整检查器宽度" });
		await handle.focus();
		for (let i = 0; i < 14; i++) await page.keyboard.press("ArrowLeft");
		await expect(handle).toHaveAttribute("aria-valuenow", "596");
		// 刷新后保存的宽度仍然生效，打开时的适配视图让到拖宽后的检查器左边。
		// 不点工具条的「适配视图」再截图：它有缩放动画，画布文字的字号随缩放逐帧变化（语义缩放），
		// Chromium 的字体缓存会留下中间帧的字号，最终画面里文字的抗锯齿取决于动画碰巧经过了哪些帧，
		// 截图不稳定。打开时的适配视图没有动画。点击的效果由 panel-resize.spec.ts 的功能用例检查。
		await page.reload();
		await nodeCard(page, "fetch").click();
		await expect(handle).toHaveAttribute("aria-valuenow", "596");
		await idle(page);
		await expect(page).toHaveScreenshot("editor-inspector-wide.png");
	});

	test("引用补全与引用高亮", async ({ page }) => {
		await nodeCard(page, "fetch").click();
		const url = page.getByRole("combobox", { name: "输入 url" });
		await url.fill(
			"curl -H 'X-Token: ${{ params.api_token }}' https://example.test/${{ params.biz_date }}/",
		);
		await page.keyboard.type("$");
		await idle(page);
		await expect(url.locator("[data-reference]")).toHaveCount(2);
		await expect(page.getByRole("listbox", { name: "可引用的值" })).toBeVisible();
		await expect(page).toHaveScreenshot("editor-references.png");
	});

	test("放大编辑弹窗", async ({ page }) => {
		await nodeCard(page, "fetch").click();
		await page.getByRole("button", { name: "放大编辑 url" }).click();
		const dialog = page.getByRole("dialog", { name: "编辑 url" });
		const big = dialog.getByRole("combobox", { name: "输入 url（放大编辑）" });
		await big.fill(
			[
				"set -euo pipefail",
				"curl -fsS -H 'X-Token: ${{ params.api_token }}' \\",
				"  https://example.test/snap/${{ params.biz_date }}/ > snap.json",
				"echo $HOME",
				"",
			].join("\n"),
		);
		await page.keyboard.type("date=$");
		await idle(page);
		await expect(big.locator("[data-reference]")).toHaveCount(2);
		await expect(dialog.getByRole("listbox", { name: "可引用的值" })).toBeVisible();
		await expect(page).toHaveScreenshot("editor-zoom.png");
	});

	test("入口参数与敏感参数", async ({ page }) => {
		await nodeCard(page, "entry").click();
		await idle(page);
		await expect(page.getByRole("group", { name: "参数 api_token" })).toBeVisible();
		await expect(page).toHaveScreenshot("editor-entry.png");
	});

	test("子流程名称：检查器字段与警告", async ({ page }) => {
		await nodeCard(page, "sub_entry").click();
		await page.getByRole("textbox", { name: "子流程名称" }).fill("");
		await idle(page);
		await expect(page.getByText("子流程入口节点 sub_entry 没有填写名称")).toBeVisible();
		await expect(page).toHaveScreenshot("editor-subflow-name.png");
	});

	test("新建子流程：填写名称", async ({ page }) => {
		await page.getByRole("button", { name: "添加节点" }).click();
		const menu = page.getByRole("dialog", { name: "添加节点" });
		await menu.getByRole("option", { name: /子流程入口/ }).click();
		await menu.getByRole("textbox", { name: "子流程名称" }).fill("sub_entry");
		await idle(page);
		await expect(menu.getByText("子流程入口节点 sub_entry 已使用名称「sub_entry」")).toBeVisible();
		await expect(page).toHaveScreenshot("editor-new-subflow.png");
	});

	test("添加异步任务：同时新建子流程", async ({ page }) => {
		await page.getByRole("button", { name: "添加节点" }).click();
		const menu = page.getByRole("dialog", { name: "添加节点" });
		await menu.getByRole("option", { name: /异步任务/ }).click();
		await menu.getByRole("checkbox", { name: "同时新建子流程" }).check();
		await menu.getByRole("textbox", { name: "子流程名称" }).fill("sub_entry");
		await idle(page);
		await expect(menu.getByText("子流程入口节点 sub_entry 已使用名称「sub_entry」")).toBeVisible();
		await expect(page).toHaveScreenshot("editor-new-async.png");
	});

	test("空白处右键菜单", async ({ page }) => {
		await page.mouse.click(200, 640, { button: "right" });
		const menu = page.getByRole("menu", { name: "画布菜单" });
		// 菜单出现后 Base UI 才把焦点移进菜单：等焦点到位再按键，否则方向键会落在画布上（选中入口节点、关掉菜单）。
		await expect(menu).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(menu.locator('[role="menuitem"][data-highlighted]')).toContainText("添加节点");
		await expect(page).toHaveScreenshot("editor-pane-menu.png");
	});

	test("节点右键菜单：复制输出引用", async ({ page }) => {
		await nodeCard(page, "fetch").click({ button: "right" });
		const menu = page.getByRole("menu", { name: "节点菜单" });
		await expect(menu).toBeVisible();
		await menu.getByRole("menuitem", { name: "复制输出引用" }).click();
		const outputs = page.getByRole("menu", { name: "复制输出引用" });
		await expect(outputs.getByRole("menuitem", { name: "status" })).toBeVisible();
		await outputs.getByRole("menuitem", { name: "status" }).hover();
		await expect(page).toHaveScreenshot("editor-node-menu.png");
	});

	test("连线右键菜单与中点的「＋」", async ({ page }) => {
		// 连线上离起点三成处右键：鼠标停在连线上，中点的「＋」也显示出来。
		const at = await page.locator('[data-edge="chain:fetch->dispatch"]').evaluate((el) => {
			const path = el as SVGPathElement;
			const ctm = path.getScreenCTM();
			if (!ctm) throw new Error("连线不可见");
			const p = path.getPointAtLength(path.getTotalLength() * 0.3).matrixTransform(ctm);
			return { x: p.x, y: p.y };
		});
		await page.mouse.click(at.x, at.y, { button: "right" });
		const menu = page.getByRole("menu", { name: "连线菜单" });
		await expect(page.getByRole("button", { name: "在此插入节点" })).toBeVisible();
		// 菜单出现后 Base UI 才把焦点移进菜单：等焦点到位再按键，否则方向键会落在画布上。
		await expect(menu).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(menu.locator('[role="menuitem"][data-highlighted]')).toContainText("在此插入节点");
		await expect(page).toHaveScreenshot("editor-edge-menu.png");
	});

	test("添加节点菜单：不连线", async ({ page }) => {
		await page.getByRole("button", { name: "添加节点" }).click();
		const menu = page.getByRole("dialog", { name: "添加节点" });
		await expect(menu.getByText(/^新节点不连线/)).toBeVisible();
		await idle(page);
		await expect(page).toHaveScreenshot("editor-add-menu.png");
	});

	test("添加节点菜单：最近使用", async ({ page }) => {
		await page.evaluate(() =>
			window.localStorage.setItem(
				"sfly.addNode.recent",
				JSON.stringify([
					"package:demo-checks/http_check",
					"builtin:stop_subflow",
					"package:demo-checks/ping",
				]),
			),
		);
		await page.reload();
		await expect(nodeCard(page, "sub_ping")).toBeVisible();
		await page.getByRole("button", { name: "添加节点" }).click();
		const menu = page.getByRole("dialog", { name: "添加节点" });
		await expect(menu.getByRole("group", { name: "最近使用" })).toBeVisible();
		await idle(page);
		await expect(page).toHaveScreenshot("editor-add-menu-recent.png");
	});

	test("语义缩放", async ({ page }) => {
		await zoomOut(page, 3);
		await expect(page.locator("[data-lod]")).toHaveAttribute("data-lod", "true");
		await idle(page);
		await expect(page).toHaveScreenshot("editor-zoomed-out.png");
	});
});

test("编排画布：非字符串参数的引用标签与 JSON 输入框", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await twoAgents(connectAgent);
	await publishPackage(controlPlane, { nodes: typedNodes });
	const id = await createScenario(controlPlane, "各种类型的参数", typedDocument);
	await page.goto(`/orchestrations/${id}`);
	await nodeCard(page, "typed").click();
	await expect(page.getByRole("group", { name: "输入 count" })).toBeVisible();
	await expect(page.getByRole("combobox", { name: "输入 options" })).toBeVisible();
	await page.mouse.move(700, 760);
	await expect(page).toHaveScreenshot("editor-reference-chip.png");
});

test("编排画布：检查器参数标签页里输入的说明", async ({ page, controlPlane, connectAgent }) => {
	await twoAgents(connectAgent);
	const described = {
		count: "重试的次数，0 表示不重试",
		ratio: "采样比例，0 到 1 之间；超出范围按最近的边界取",
		level: "low 只记录失败，high 记录每次请求",
	} as const;
	await publishPackage(controlPlane, {
		nodes: typedNodes.map((node) =>
			node.name === "typed"
				? {
						...node,
						inputs: {
							...node.inputs,
							properties: Object.fromEntries(
								Object.entries(node.inputs.properties).map(([name, schema]) => [
									name,
									name in described
										? { ...schema, description: described[name as keyof typeof described] }
										: schema,
								]),
							),
						},
					}
				: node,
		),
	});
	const id = await createScenario(controlPlane, "带说明的参数", typedDocument);
	await page.goto(`/orchestrations/${id}`);
	await nodeCard(page, "typed").click();
	await expect(page.getByText(described.ratio)).toBeVisible();
	await page.mouse.move(700, 760);
	await expect(page).toHaveScreenshot("editor-inspector-input-docs.png");
});

/** demo-checks：http_check 的输出有的写了说明，有的没写。 */
const documentedOutputs = [
	{
		name: "http_check",
		title: "HTTP 检查",
		entry: "demo_checks.http:http_check",
		inputs: {
			type: "object",
			properties: { url: { type: "string" }, expect: { type: "integer", default: 200 } },
			required: ["url"],
			order: ["url", "expect"],
		},
		outputs: {
			type: "object",
			properties: {
				status: { type: "integer", description: "HTTP 状态码" },
				report: {
					type: "string",
					description: "检查报告的文字，包含每一步的耗时；响应超时时只有失败原因，没有耗时",
				},
				body_file: { type: "string" },
			},
		},
	},
	{
		name: "ping",
		title: "ping",
		entry: "demo_checks.http:ping_host",
		inputs: { type: "object", properties: { host: { type: "string" } }, required: ["host"] },
		outputs: { type: "object", properties: { alive: {} } },
	},
];

test("编排画布：检查器「说明与指标」里输出的说明", async ({ page, controlPlane, connectAgent }) => {
	await twoAgents(connectAgent);
	await publishPackage(controlPlane, { nodes: documentedOutputs });
	const id = await createScenario(controlPlane, "日终数据处理", editorDocument);
	await page.goto(`/orchestrations/${id}`);
	await nodeCard(page, "fetch").click();
	await page.getByRole("tab", { name: "说明与指标" }).click();
	await expect(page.getByRole("table", { name: "输出" })).toBeVisible();
	await page.mouse.move(700, 760);
	await expect(page).toHaveScreenshot("editor-inspector-output-docs.png");
});

test("编排画布：引用补全里输出的说明", async ({ page, controlPlane, connectAgent }) => {
	await twoAgents(connectAgent);
	await publishPackage(controlPlane, { nodes: documentedOutputs });
	const id = await createScenario(controlPlane, "日终数据处理", editorDocument);
	await page.goto(`/orchestrations/${id}`);
	await nodeCard(page, "ping").click();
	await page.getByRole("combobox", { name: "输入 host" }).fill("");
	await page.keyboard.type("$");
	await expect(page.getByRole("listbox", { name: "可引用的值" })).toBeVisible();
	await page.mouse.move(700, 760);
	await expect(page).toHaveScreenshot("editor-reference-output-docs.png");
});

test.describe("编排画布：节点的备注", () => {
	const notes = {
		fetch: "每天 8 点拉取快照\n超时设为 600 秒：镜像很大，冷启动要 5 分钟",
		ping: "先确认 fetch 的结果",
	};
	test.beforeEach(async ({ page, controlPlane, connectAgent }) => {
		await twoAgents(connectAgent);
		await publishPackage(controlPlane);
		const id = await createScenario(controlPlane, "带备注的场景", {
			...editorDocument,
			nodes: editorDocument.nodes.map((n) =>
				n.id === "fetch" || n.id === "ping" ? { ...n, note: notes[n.id] } : n,
			),
		});
		await page.goto(`/orchestrations/${id}`);
		await expect(nodeCard(page, "sub_ping")).toBeVisible();
		await expect(page.getByRole("toolbar", { name: "画布工具" })).toBeVisible();
	});

	test("卡片头部的备注图标，检查器顶部的备注", async ({ page }) => {
		await nodeCard(page, "fetch").click();
		await expect(page.getByRole("textbox", { name: "备注" })).toHaveValue(notes.fetch);
		await page.mouse.move(700, 760);
		await expect(page).toHaveScreenshot("editor-node-notes.png");
	});

	test("悬停备注图标显示全文", async ({ page }) => {
		await nodeCard(page, "fetch").locator('[data-slot="note-icon"]').hover();
		await expect(page.getByRole("tooltip")).toHaveText(notes.fetch);
		await expect(page).toHaveScreenshot("editor-node-note-tooltip.png");
	});

	test("缩小后图标仍在", async ({ page }) => {
		await zoomOut(page, 3);
		await expect(page.locator("[data-lod]")).toHaveAttribute("data-lod", "true");
		await page.mouse.move(700, 760);
		await expect(page).toHaveScreenshot("editor-node-notes-zoomed-out.png");
	});
});

test.describe("编排画布：注释框", () => {
	test.beforeEach(async ({ page, controlPlane, connectAgent }) => {
		await twoAgents(connectAgent);
		await publishPackage(controlPlane);
		const id = await createScenario(
			controlPlane,
			"带注释框的场景",
			annotated([
				{ id: "annotation_1", title: "派发对账", nodes: ["dispatch", "sub_entry"] },
				{
					id: "annotation_2",
					title: "收尾：通知和对账子流程",
					nodes: ["ping"],
					subflows: ["sub_entry"],
				},
				// 备注放在不和别的框交叠的框上：交叠的框，后画的那个的标题会压在前一个框的备注上（#337 同一类）。
				{
					id: "annotation_3",
					title: "拉取快照",
					note: "先拉取当天的快照，再派发对账",
					nodes: ["entry", "fetch"],
				},
			]),
		);
		await page.goto(`/orchestrations/${id}`);
		await expect(nodeCard(page, "sub_ping")).toBeVisible();
		await expect(page.getByRole("toolbar", { name: "画布工具" })).toBeVisible();
	});

	test("注释框和子流程区域交叠，选中其中一个", async ({ page }) => {
		await annotationBand(page, "收尾：通知和对账子流程").click();
		await page.mouse.move(700, 760);
		await expect(page).toHaveScreenshot("editor-annotations.png");
	});

	test("左侧的大纲：按注释框分组，小地图上画出注释框", async ({ page }) => {
		await page
			.getByRole("toolbar", { name: "画布工具" })
			.getByRole("button", { name: "大纲" })
			.click();
		await expect(page.getByRole("complementary", { name: "大纲" })).toBeVisible();
		await page.mouse.move(700, 760);
		await expect(page).toHaveScreenshot("editor-outline.png");
	});

	test("缩小后的标题", async ({ page }) => {
		await zoomOut(page, 3);
		await expect(page.locator("[data-lod]")).toHaveAttribute("data-lod", "true");
		await page.mouse.move(700, 760);
		await expect(page).toHaveScreenshot("editor-annotations-zoomed-out.png");
	});
});

test.describe("编排画布：注释框的成员", () => {
	test.beforeEach(async ({ page, controlPlane, connectAgent }) => {
		await twoAgents(connectAgent);
		await publishPackage(controlPlane);
		// fetch 和 ping 是成员，夹在中间的 dispatch 不是；子流程在框外。
		const id = await createScenario(
			controlPlane,
			"带注释框的场景",
			annotated([{ id: "annotation_1", title: "首尾两步", nodes: ["fetch", "ping"] }]),
		);
		await page.goto(`/orchestrations/${id}`);
		await expect(nodeCard(page, "sub_ping")).toBeVisible();
		await expect(page.getByRole("toolbar", { name: "画布工具" })).toBeVisible();
	});

	test("选中注释框：成员高亮，框里夹着的非成员节点变淡", async ({ page }) => {
		await annotationBand(page, "首尾两步").click();
		await page.mouse.move(700, 760);
		await expect(page).toHaveScreenshot("editor-annotation-members-selected.png");
	});

	test("悬停注释框的标题带（没有选中）", async ({ page }) => {
		await annotationBand(page, "首尾两步").hover();
		await expect(page).toHaveScreenshot("editor-annotation-members-hovered.png");
	});

	test("拖动夹在框里的非成员：框高亮，卡片下面写着松手会加入", async ({ page }) => {
		const card = await nodeCard(page, "dispatch").boundingBox();
		if (!card) throw new Error("没有 dispatch 的卡片");
		await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
		await page.mouse.down();
		await page.mouse.move(card.x + card.width / 2 + 24, card.y + card.height / 2 + 30, {
			steps: 6,
		});
		await expect(
			page.getByRole("status").filter({ hasText: "松手加入「首尾两步」" }),
		).toBeVisible();
		await expect(page).toHaveScreenshot("editor-annotation-drop.png");
		await page.mouse.up();
	});

	test("多选节点：上方的工具条", async ({ page }) => {
		await nodeCard(page, "entry").click();
		await nodeCard(page, "dispatch").click({ modifiers: ["ControlOrMeta"] });
		await expect(page.getByRole("toolbar", { name: "选中节点的工具条" })).toBeVisible();
		await page.mouse.move(700, 760);
		await expect(page).toHaveScreenshot("editor-selection-toolbar.png");
	});
});

test("编排画布：检查器「说明与指标」", async ({ page, controlPlane, connectAgent }) => {
	await twoAgents(connectAgent);
	await publishPackage(controlPlane, metricPackage());
	const id = await createScenario(controlPlane, "日终数据处理", editorDocument);
	await page.goto(`/orchestrations/${id}`);
	await nodeCard(page, "fetch").click();
	await page.getByRole("tab", { name: "说明与指标" }).click();
	await expect(page.getByRole("list", { name: "图表" })).toBeVisible();
	await page.mouse.move(700, 760);
	await expect(page).toHaveScreenshot("editor-inspector-metrics.png");
});

test("编排画布：检查器「说明与指标」里的关注开关（已按下、禁用，名额已满且含失效的项）", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await twoAgents(connectAgent);
	const id = await createFocusScenario(controlPlane);
	await setFocusItems(controlPlane, id, [
		...["延迟", "吞吐", "请求数", "errors"].map((chart) => ({ node_id: "fetch", chart })),
		...["延迟", "吞吐"].map((chart) => ({ node_id: "fetch2", chart })),
		...["level", "total"].map((chart) => ({ node_id: "ping", chart })),
	]);
	await saveVersion(controlPlane, id, 1, {
		...focusDocument,
		nodes: focusDocument.nodes.filter((n) => n.id !== "ping"),
		edges: focusDocument.edges.filter((e) => e.to !== "ping"),
	});
	await page.goto(`/orchestrations/${id}`);
	await expect(nodeCard(page, "fetch2")).toBeVisible();
	await selectMetricsTab(page, "fetch2");
	await page.mouse.move(700, 760);
	await expect(page).toHaveScreenshot("editor-inspector-focus-toggles.png");
});

test("编排画布：场景设置的「关注项」页（排序列表、最后修改、失效的项）", async ({
	page,
	controlPlane,
}) => {
	const id = await createFocusScenario(controlPlane);
	const throughput = { node_id: "fetch", chart: "吞吐", title: "母单量" };
	const rejects = { node_id: "fetch2", chart: "errors", title: "拒单数" };
	const latency = { node_id: "fetch", chart: "延迟", title: "下单延迟" };
	const rest = [
		{ node_id: "fetch2", chart: "请求数" },
		{ node_id: "ping", chart: "level" },
	];
	await setFocusItems(controlPlane, id, [throughput, rejects, latency, ...rest], "lin");
	// 最后一次修改：lin 把「下单延迟」移到第 2 位。
	await setFocusItems(controlPlane, id, [throughput, latency, rejects, ...rest], "lin");
	// 第 2 版去掉了 ping，它的关注项失效。
	await saveVersion(controlPlane, id, 1, {
		...focusDocument,
		nodes: focusDocument.nodes.filter((n) => n.id !== "ping"),
		edges: focusDocument.edges.filter((e) => e.to !== "ping"),
	});
	await openFocusList(page, id, "fetch2");
	await page.mouse.move(700, 760);
	await expect(page).toHaveScreenshot("editor-scene-focus-list.png");
});

test("编排画布：运行状态（选中失败尝试后重试中的节点）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, scenarioId } = await runningScenario(controlPlane, connectAgent, clock);
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/orchestrations/${scenarioId}?run=${runId}`);
	await expect(nodeCard(page, "verify")).toHaveAttribute("data-run", "running");
	// 跟随执行把镜头平移到执行中的节点（缩放正好到 100%）：等平移停下再点节点，点击会打断还在进行的平移。
	await expect(page.locator(".react-flow__viewport")).toHaveAttribute("style", /scale\(1\)/);
	await nodeCard(page, "verify").click();
	await expect(page.getByTestId("run-attempts")).toHaveText("2");
	for (const id of ["fetch", "verify", "probe"]) {
		await expect(nodeCard(page, id).locator("[data-sparkline]")).toBeVisible();
	}
	// verify 声明的图表：level 是折线（画出来），total 是数值卡。
	await expect(inspector(page).locator('[data-node-chart] svg[role="img"]')).toHaveCount(1);
	await page.mouse.move(700, 760);
	await expect(page).toHaveScreenshot("editor-run-state.png", {
		mask: [
			page.getByTestId("canvas-run").locator(".font-mono").first(),
			page.getByTestId("run-summary").locator("dd").first(),
		],
	});
});

test("编排画布：运行状态（检查器的「正在做」和「动作」：计数、上限说明、折行的失败原因）", async ({
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
	agent.actionSummary(tasks.verify as AssignedTask, loadSummary(agent, clock.now().getTime()));
	await agent.sync();
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/orchestrations/${scenarioId}?run=${runId}`);
	await expect(nodeCard(page, "verify")).toHaveAttribute("data-run", "running");
	// 跟随执行把镜头平移到执行中的节点（缩放正好到 100%）：等平移停下再点节点，点击会打断还在进行的平移。
	await expect(page.locator(".react-flow__viewport")).toHaveAttribute("style", /scale\(1\)/);
	await nodeCard(page, "verify").click();
	const area = page.getByRole("region", { name: "动作", exact: true });
	await expect(area.getByRole("table")).toContainText("1,284,819");
	// 从「正在做」的标题起往下看：摘要已经滚出去，正在做、动作区和前几个失败都在。
	await page
		.getByRole("region", { name: "正在做" })
		.getByRole("heading")
		.evaluate((el) => el.scrollIntoView({ block: "start" }));
	await page.mouse.move(700, 760);
	// 摘要滚出去了，只有顶栏里的运行编号要遮住。
	await expect(page).toHaveScreenshot("editor-run-actions.png", {
		mask: [page.getByTestId("canvas-run").locator(".font-mono").first()],
	});
});

test("编排画布：运行状态（选中有关注项的节点：卡片上的前两项、检查器里排好序的图表）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const running = await canvasFocusRun(controlPlane, connectAgent, clock);
	await openCanvasRun(page, clock, running);
	await nodeCard(page, "probe").click();
	await expect(inspector(page).getByRole("article", { name: "total" })).toContainText("无新数据");
	await expect(inspector(page).locator('[data-node-chart] svg[role="img"]')).toHaveCount(1);
	for (const id of ["fetch", "probe"]) {
		await expect(nodeCard(page, id).getByTestId("node-focus")).toBeVisible();
	}
	await page.mouse.move(700, 760);
	await expect(page).toHaveScreenshot("editor-run-focus.png", {
		mask: [
			page.getByTestId("canvas-run").locator(".font-mono").first(),
			page.getByTestId("run-summary").locator("dd").first(),
		],
	});
});

/** 几个节点有显示名称：一个正常，一个 40 个字符（卡片上被截断），一个是异步任务。 */
const displayNamedDocument = {
	...editorDocument,
	nodes: editorDocument.nodes.map((node) => {
		const names: Record<string, string> = {
			fetch: "创建测试用户",
			dispatch: "派发对账子流程",
			ping: "一二三四五六七八九十".repeat(4),
		};
		return node.id in names ? { ...node, display_name: names[node.id] } : node;
	}),
};

test.describe("编排画布：显示名称", () => {
	test.beforeEach(async ({ page, connectAgent, controlPlane }) => {
		await twoAgents(connectAgent);
		await publishPackage(controlPlane);
		const id = await createScenario(controlPlane, "日终数据处理", displayNamedDocument);
		await page.goto(`/orchestrations/${id}`);
		await expect(nodeCard(page, "sub_ping")).toBeVisible();
		await expect(page.getByRole("toolbar", { name: "画布工具" })).toBeVisible();
	});

	test("卡片标题、头部的原标题、被截断的名称与检查器顶部的输入框", async ({ page }) => {
		await nodeCard(page, "fetch").click();
		await expect(page.getByRole("textbox", { name: "显示名称" })).toHaveValue("创建测试用户");
		await page.mouse.move(700, 760);
		await expect(page).toHaveScreenshot("editor-display-names.png");
	});

	test("原地改名：输入框占着卡片标题的位置，卡片大小不变", async ({ page }) => {
		await nodeCard(page, "fetch").locator('[data-slot="base-node-title"]').dblclick();
		await expect(nodeCard(page, "fetch").getByRole("textbox", { name: "显示名称" })).toBeFocused();
		await page.mouse.move(700, 760);
		await expect(page).toHaveScreenshot("editor-rename-in-place.png");
	});

	test("语义缩放：缩小后显示名称仍然看得清", async ({ page }) => {
		await zoomOut(page, 3);
		await expect(page.locator("[data-lod]")).toHaveAttribute("data-lod", "true");
		await page.mouse.move(700, 760);
		await expect(page).toHaveScreenshot("editor-display-names-zoomed-out.png");
	});
});

test("运行监控：子流程被停止（停止子流程节点的尝试）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, finish } = await stoppingRun(controlPlane, connectAgent, clock);
	await finish();
	await openMonitor(page, clock, runId, "stop");
	await page.getByRole("region", { name: "底部面板" }).getByRole("tab", { name: "尝试" }).click();
	await expect(page.getByRole("article", { name: "stop 第 1 次尝试" })).toBeVisible();
	await expect(page.getByRole("banner").getByTestId("run-status")).toHaveText("成功");
	await page.mouse.move(700, 870);
	await expect(page).toHaveScreenshot("monitor-stopped.png", { mask: await runIds(page) });
});

test("运行监控：显示名称与备注图标（名称放不下时截断显示名称，节点 ID 完整）", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { agent, scenarioId } = await namedScenario(controlPlane, connectAgent, {
		...FIRST,
		verify: "核对结果：对比订单库与支付流水的差异，超过阈值时报警",
	});
	const runId = await triggerRun(controlPlane, scenarioId);
	await driveToRetry(agent, clock, await agent.nextAssign());
	await openMonitor(page, clock, runId, "verify", "attempts");
	await expect(page.getByRole("article", { name: /第 2 次尝试$/ })).toBeVisible();
	await chartsLoaded(page);
	await page.mouse.move(700, 870);
	await expect(page).toHaveScreenshot("monitor-display-names.png", { mask: await runIds(page) });
});

test("编排画布：运行状态（子流程被停止）", async ({ page, controlPlane, connectAgent, clock }) => {
	const { runId, scenarioId, finish } = await stoppingRun(controlPlane, connectAgent, clock);
	await finish();
	await page.clock.setFixedTime(clock.now());
	await page.goto(`/orchestrations/${scenarioId}?run=${runId}`);
	await expect(nodeCard(page, "watch")).toHaveAttribute("data-run", "stopped");
	await nodeCard(page, "watch").click();
	await expect(page.getByTestId("run-summary")).toContainText("agent-a");
	await page.mouse.move(700, 760);
	await expect(page).toHaveScreenshot("editor-run-state-stopped.png", {
		mask: [
			page.getByTestId("canvas-run").locator(".font-mono").first(),
			page.getByTestId("run-summary").locator("dd").first(),
		],
	});
});

test("版本历史：并排对比两个版本", async ({ page, controlPlane, connectAgent, clock }) => {
	await twoAgents(connectAgent);
	const id = await twoVersions(controlPlane, clock);
	await page.goto(`/orchestrations/${id}/versions`);
	await expect(page.getByRole("region", { name: "版本 1（只读）" })).toBeVisible();
	await expect(
		page.getByRole("region", { name: "版本 2（只读）" }).locator('[data-node-id="report"]'),
	).toHaveAttribute("data-mark", "added");
	await page.mouse.move(700, 880);
	await expect(page).toHaveScreenshot("versions.png");
});

test("保存冲突弹窗", async ({ page, controlPlane, connectAgent, clock }) => {
	await twoAgents(connectAgent);
	const id = await createEditorScenario(controlPlane);
	await page.goto(`/orchestrations/${id}`);
	await nodeCard(page, "sub_ping").click();
	await page.getByRole("tab", { name: "执行" }).click();
	await page.getByRole("switch", { name: "always" }).click();
	clock.advance(5 * 60_000);
	await saveSecondVersion(controlPlane, id, "bob");
	await page.keyboard.press("Control+s");
	const dialog = page.getByRole("dialog", { name: "保存被拦截：场景已有更新的版本" });
	await expect(dialog).toContainText("+ report");
	await page.mouse.move(700, 880);
	await expect(page).toHaveScreenshot("editor-conflict.png");
});

test.describe("开发文档", () => {
	// 固定的文档、地址和版本号：替换出来的内容不随端口和发版变化。
	test.use({
		controlPlaneOptions: {
			docsDir: fileURLToPath(new URL("./docs-fixture", import.meta.url)),
			publicHttpUrl: "http://sfly.example:8080",
			version: "1.2.3",
		},
	});

	const openDocs = async (page: Page) => {
		await page.goto("/docs/quickstart");
		await expect(page.getByRole("article", { name: "快速开始" }).getByRole("table")).toBeVisible();
	};

	test("文档页", async ({ page }) => {
		await openDocs(page);
		await expect(page).toHaveScreenshot("docs.png");
	});

	// 应用只有深色主题（tokens.css 的 color-scheme: dark），系统偏好浅色时也要可读。
	test("系统偏好浅色时的文档页", async ({ page }) => {
		await page.emulateMedia({ colorScheme: "light" });
		await openDocs(page);
		await expect(page).toHaveScreenshot("docs-light-scheme.png");
	});

	// 最小支持宽度（docs/DESIGN-SYSTEM.md：1280）：长命令在代码块里横向滚动，不撑宽页面。
	test("窄屏下的文档页", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openDocs(page);
		await expect(page).toHaveScreenshot("docs-narrow.png");
	});
});

// 本地账号与登录（ADR 0029，#490）：登录页、初始化页、账号菜单、修改密码弹窗。
test.describe("账号与登录", () => {
	const ADMIN = { loginName: "root", password: "admin-password-1", displayName: "管理员" };
	// 没有预先写昵称：登录页和初始化页上没有昵称弹窗，登录之后也没有。
	test.use({ nickname: null });

	const signIn = async (page: Page) => {
		await page.goto("/login");
		await page.getByLabel("登录名").fill(ADMIN.loginName);
		await page.getByLabel("密码").fill(ADMIN.password);
		await page.getByRole("button", { name: "登录" }).click();
		await expect(page.getByRole("banner").getByRole("button", { name: /管理员/ })).toBeVisible();
	};

	test.describe("已经有用户", () => {
		test.use({
			controlPlaneOptions: {
				publicHttpUrl: "http://sfly.example:8080",
				version: "0.1.0",
				initialAdmin: ADMIN,
			},
		});
		test("登录页", async ({ page }) => {
			await page.goto("/login");
			await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
			await expect(page).toHaveScreenshot("login.png");
		});

		test("登录页：登录名或密码不对", async ({ page }) => {
			await page.goto("/login");
			await page.getByLabel("登录名").fill(ADMIN.loginName);
			await page.getByLabel("密码").fill("不对的密码");
			await page.getByRole("button", { name: "登录" }).click();
			await expect(page.getByRole("alert")).toContainText("登录名或密码不对");
			await expect(page).toHaveScreenshot("login-error.png");
		});

		test("账号菜单", async ({ page }) => {
			await signIn(page);
			await page
				.getByRole("banner")
				.getByRole("button", { name: /管理员/ })
				.click();
			await expect(page.getByRole("menu")).toBeVisible();
			await expect(page).toHaveScreenshot("account-menu.png");
		});

		test("修改密码弹窗", async ({ page }) => {
			await signIn(page);
			await page
				.getByRole("banner")
				.getByRole("button", { name: /管理员/ })
				.click();
			await page.getByRole("menuitem", { name: "修改密码…" }).click();
			const dialog = page.getByRole("dialog", { name: "修改密码" });
			await dialog.getByRole("button", { name: "修改密码" }).click();
			await expect(dialog.getByLabel("旧密码")).toHaveAccessibleDescription("填写旧密码");
			await expect(page).toHaveScreenshot("account-change-password.png");
		});

		/**
		 * 令牌页的数据：一个已过期（1 天有效期，控制面时钟走过 2 天多）、一个用过的、一个限定项目只要部分范围的、一个已吊销的。
		 * 签发走页面里的同源请求（登录 Cookie 带着浏览器自己的来源信息），时间都是手动时钟给的，每次一样。
		 */
		/** 令牌的前缀里有随机字符（前缀加原值开头的几位），每次不一样：基线里打码。 */
		const tokenPrefixes = (page: Page) => page.locator('[data-slot="token-prefix"]');

		const seedTokens = async (page: Page, clock: E2eFixtures["clock"]) => {
			const issue = (body: object) =>
				page.evaluate(async (payload) => {
					const response = await fetch("/api/account/tokens", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload),
					});
					return (await response.json()) as { id: string; token: string };
				}, body);
			await issue({ name: "试用", expires_in_days: 1 });
			// 登录的空闲期限是 12 小时：分几步走，每步之后用一次登录（续期），走过 2 天。
			for (let hours = 0; hours < 50; hours += 10) {
				clock.advance(10 * 3600 * 1000);
				await page.evaluate(() => fetch("/api/auth/me"));
			}
			// 每个令牌隔一分钟签发：列表按创建时间倒排，同一时刻的几个靠随机的 ID 排先后，基线就不稳定了。
			const laptop = await issue({ name: "laptop", expires_in_days: 90 });
			clock.advance(60_000);
			await issue({
				name: "ci-bot",
				scopes: ["read", "run"],
				project: "default",
				expires_in_days: 30,
			});
			clock.advance(60_000);
			const old = await issue({ name: "old-script" });
			// 用一下 laptop：「最后使用」有了时间。
			await page.request.get("/api/account/tokens", {
				headers: { authorization: `Bearer ${laptop.token}` },
			});
			await page.evaluate(async (id) => {
				await fetch(`/api/account/tokens/${id}`, { method: "DELETE" });
			}, old.id);
		};

		test("令牌页：个人令牌的各种状态（有效、已过期、已吊销，最后使用）", async ({
			page,
			clock,
		}) => {
			await signIn(page);
			await seedTokens(page, clock);
			await page.goto("/account/tokens");
			await expect(page.locator('[data-token="laptop"]')).toBeVisible();
			await expect(page.locator('[data-token="试用"]')).toContainText("已过期");
			await expect(page.locator('[data-token="old-script"]')).toContainText("已吊销");
			await expect(page).toHaveScreenshot("tokens.png", { mask: [tokenPrefixes(page)] });
		});

		test("令牌页：1280 宽（用过的令牌、过期时间、六个范围：时间折成两行，表格不超出面板）", async ({
			page,
			clock,
		}) => {
			await page.setViewportSize({ width: 1280, height: 800 });
			await signIn(page);
			await seedTokens(page, clock);
			await page.goto("/account/tokens");
			await expect(page.locator('[data-token="laptop"]')).toBeVisible();
			await expect(page.locator('[data-token="laptop"]')).not.toContainText("从未使用");
			await expect(page).toHaveScreenshot("tokens-1280.png", { mask: [tokenPrefixes(page)] });
		});

		test("令牌页：空状态", async ({ page }) => {
			await signIn(page);
			await page.goto("/account/tokens");
			await expect(page.getByText("还没有个人令牌")).toBeVisible();
			await expect(page).toHaveScreenshot("tokens-empty.png");
		});

		test("签发个人令牌弹窗：只选一部分范围，项目标识写法不对时「签发」不可用", async ({ page }) => {
			await signIn(page);
			await page.goto("/account/tokens");
			await page.getByRole("button", { name: "签发令牌" }).click();
			const dialog = page.getByRole("dialog", { name: "签发个人令牌" });
			await dialog.getByLabel("名称").fill("ci-bot");
			await dialog.getByRole("button", { name: "只选一部分" }).click();
			await dialog.getByLabel("运行", { exact: false }).first().check();
			await dialog.getByLabel("限定项目").fill("Bad_Project");
			// 提交一次，标出问题之后「签发」不可用。
			await dialog.getByRole("button", { name: "签发", exact: true }).click();
			await expect(dialog.getByLabel("限定项目")).toHaveAccessibleDescription(/小写字母/);
			await expect(dialog.getByRole("button", { name: "签发", exact: true })).toBeDisabled();
			await expect(page).toHaveScreenshot("tokens-issue.png");
		});

		test("令牌签发之后：原值只显示这一次（原值打码，每次不一样）", async ({ page }) => {
			await signIn(page);
			await page.goto("/account/tokens");
			await page.getByRole("button", { name: "签发令牌" }).click();
			const dialog = page.getByRole("dialog", { name: "签发个人令牌" });
			await dialog.getByLabel("名称").fill("laptop");
			await dialog.getByRole("button", { name: "签发" }).click();
			const issued = page.getByRole("dialog", { name: "令牌「laptop」已签发" });
			await expect(issued.getByLabel("令牌原值")).toHaveValue(/^sfly_pat_/);
			await expect(page).toHaveScreenshot("tokens-issued.png", {
				mask: [issued.getByLabel("令牌原值"), tokenPrefixes(page)],
			});
		});

		test("吊销令牌确认弹窗", async ({ page, clock }) => {
			await signIn(page);
			await seedTokens(page, clock);
			await page.goto("/account/tokens");
			await page.locator('[data-token="laptop"]').getByRole("button", { name: "吊销" }).click();
			const dialog = page.getByRole("dialog", { name: "吊销令牌「laptop」？" });
			await expect(dialog).toBeVisible();
			// 遮罩只盖值：表格里的前缀在弹窗底下的看不见，遮罩画在它原来的位置、会盖到弹窗上的字（表格的列右移之后，盖住了弹窗那一行
			// 开头的「前缀」两个字）：整个在弹窗里面的不遮；跨在弹窗边缘上、露出一截的要遮（行高一变，露出的就是随机的字符，
			// 基线不稳）；弹窗里自己的只遮前缀的值。
			await page.evaluate(() => {
				const box = document.querySelector('[role="dialog"]')?.getBoundingClientRect();
				for (const el of document.querySelectorAll('[data-slot="token-prefix"]')) {
					const r = el.getBoundingClientRect();
					const inside =
						box !== undefined &&
						r.left >= box.left &&
						r.right <= box.right &&
						r.top >= box.top &&
						r.bottom <= box.bottom;
					if (!inside || el.closest('[role="dialog"]')) el.setAttribute("data-mask", "");
				}
			});
			await expect(page).toHaveScreenshot("tokens-revoke.png", {
				mask: [page.locator('[data-slot="token-prefix"][data-mask]')],
			});
		});

		test("项目令牌页", async ({ page, clock }) => {
			await signIn(page);
			const issue = (body: object) =>
				page.evaluate(async (payload) => {
					await fetch("/api/projects/default/tokens", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload),
					});
				}, body);
			await issue({ name: "nightly", scopes: ["read", "run"], expires_in_days: 365 });
			// 隔一分钟：列表按创建时间倒排，同一时刻的靠随机的 ID 排先后。
			clock.advance(60_000);
			await issue({ name: "docs-publisher", scopes: ["read", "publish"] });
			await page.goto("/projects/default/tokens");
			await expect(page.locator('[data-token="nightly"]')).toBeVisible();
			await expect(page).toHaveScreenshot("tokens-project.png", { mask: [tokenPrefixes(page)] });
		});
	});

	test.describe("公开地址对不上", () => {
		test.use({
			controlPlaneOptions: {
				publicHttpUrl: "http://sfly.example:8080",
				version: "0.1.0",
				initialAdmin: ADMIN,
			},
		});

		test("登录页：提示请用公开地址打开", async ({ page }) => {
			// 提示针对内网 http 加 IP 访问（不是安全上下文）；e2e 的 127.0.0.1 是安全上下文，用初始化脚本模拟。
			await page.addInitScript(() => {
				Object.defineProperty(window, "isSecureContext", { value: false });
			});
			await page.goto("/login");
			await expect(page.locator('[data-slot="origin-notice"]')).toContainText(
				"请用 http://sfly.example:8080 打开",
			);
			await expect(page).toHaveScreenshot("login-origin-notice.png");
		});
	});

	test.describe("还没有任何用户", () => {
		test("初始化页：提交时每个必填字段写明原因", async ({ page }) => {
			await page.goto("/setup");
			await expect(page.getByRole("heading", { name: "创建第一个管理员" })).toBeVisible();
			await page.getByRole("button", { name: "创建并登录" }).click();
			await expect(page.getByLabel("初始化码")).toHaveAccessibleDescription("填写初始化码");
			await expect(page).toHaveScreenshot("setup.png");
		});
	});
});
