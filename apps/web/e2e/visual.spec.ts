// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import {
	AgentUpdateState,
	type AssignedTask,
	LogLevel,
} from "../../server/test/support/fake-agent.js";
import { createEditorScenario, editorDocument, nodeCard } from "./editor-support";
import { type E2eFixtures, expect, test } from "./fixtures";
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
import { PARAM_SCENARIO } from "./run-drawer-scenario";
import { advance, seedRunRecords } from "./run-records";
import { stoppingRun } from "./stop-subflow-scenario";
import {
	createScenario,
	failApi,
	holdApi,
	publishPackage,
	scenarioUsing,
	seedDashboard,
	triggerRun,
} from "./support";
import { saveSecondVersion, twoVersions } from "./versions-support";

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

test("Agent 列表：版本不一致与更新状态", async ({ page, connectAgent }) => {
	await connectAgent({ name: "agent-current", os: "linux", arch: "x86_64" });
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

	await page.goto("/agents");
	await expect(page.getByRole("row", { name: /agent-failed/ })).toContainText("更新失败");
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
	// 运行 ID 是随机的。
	await expect(page).toHaveScreenshot("agents-update-now.png", {
		mask: [page.locator('ul[aria-label="会被终止的任务"] li > span.text-xs')],
	});
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
	await expect(drawer.getByRole("list", { name: "正在执行的节点" })).toContainText("执行中");
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

test("控制台", async ({ page, controlPlane, connectAgent, clock }) => {
	await seedDashboard({ page, controlPlane, connectAgent, clock });
	await page.goto("/");
	await expect(
		page.getByRole("region", { name: "最近失败", exact: true }).getByRole("link"),
	).toHaveCount(2);
	// 运行 ID 是随机的，遮住。
	await expect(page).toHaveScreenshot("dashboard.png", {
		mask: [page.locator('[data-slot="run-id"]')],
	});
});

test("控制台没有数据", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByRole("region", { name: "正在运行", exact: true })).toContainText(
		"没有正在运行的运行",
	);
	await expect(page).toHaveScreenshot("dashboard-empty.png");
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
	await expect(ws.getByText("正在加载…")).toHaveCount(0);
}

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
	await chartsLoaded(page);
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
	await chartsLoaded(page);
	await page.mouse.move(700, 870);
	await expect(page).toHaveScreenshot("monitor-failed.png", { mask: runIds(page) });
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
	// 选中的 verify 第 2 次还没有日志：底部面板自动收起，图表区高一些。
	await expect(
		page.getByRole("region", { name: "底部面板" }).getByRole("button", { name: "展开" }),
	).toBeVisible();
	const plot = ws
		.getByRole("region", { name: "probe 的图表" })
		.getByRole("figure", { name: "level", exact: true })
		.locator("svg[data-plot]");
	await plot.scrollIntoViewIfNeeded();
	const box = await plot.boundingBox();
	if (!box) throw new Error("没有绘图区");
	await page.mouse.move(box.x + box.width * (4.5 / 8), box.y + box.height / 2);
	await expect(page.locator("[data-hover-reading]").first()).toBeVisible();
	await expect(page).toHaveScreenshot("monitor-charts.png", { mask: runIds(page) });
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
	await expect(page).toHaveScreenshot("monitor-charts-series.png", { mask: runIds(page) });
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
	await expect(page).toHaveScreenshot("monitor-charts-large.png", { mask: runIds(page) });
});

test("运行监控：取消确认弹窗", async ({ page, controlPlane, connectAgent, clock }) => {
	const { runId } = await runningScenario(controlPlane, connectAgent, clock);
	await openMonitor(page, clock, runId);
	await chartsLoaded(page);
	await page.getByRole("banner").getByRole("button", { name: "取消运行" }).click();
	await expect(page.getByRole("dialog", { name: /取消运行/ })).toBeVisible();
	await expect(page).toHaveScreenshot("monitor-cancel.png", { mask: runIds(page) });
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
		// 适配视图：节点让到拖宽后的检查器左边。
		await page
			.getByRole("toolbar", { name: "画布工具" })
			.getByRole("button", { name: "适配视图" })
			.click();
		await handle.blur();
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

	test("空白处右键菜单", async ({ page }) => {
		await page.mouse.click(200, 640, { button: "right" });
		const menu = page.getByRole("menu", { name: "画布菜单" });
		await expect(menu).toBeVisible();
		await page.keyboard.press("ArrowDown");
		await expect(menu.locator('[role="menuitem"][data-highlighted]')).toContainText("添加节点");
		await expect(page).toHaveScreenshot("editor-pane-menu.png");
	});

	test("添加节点菜单：不连线", async ({ page }) => {
		await page.getByRole("button", { name: "添加节点" }).click();
		const menu = page.getByRole("dialog", { name: "添加节点" });
		await expect(menu.getByText(/^新节点不连线/)).toBeVisible();
		await idle(page);
		await expect(page).toHaveScreenshot("editor-add-menu.png");
	});

	test("语义缩放", async ({ page }) => {
		for (let i = 0; i < 3; i++) {
			await page.getByRole("button", { name: "缩小" }).click();
			await page.waitForTimeout(300); // 等缩放动画（150ms）结束，每一步都从上一步的结果开始
		}
		await expect(page.locator("[data-lod]")).toHaveAttribute("data-lod", "true");
		await idle(page);
		await expect(page).toHaveScreenshot("editor-zoomed-out.png");
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
	await nodeCard(page, "verify").click();
	await expect(page.getByTestId("run-attempts")).toHaveText("2");
	for (const id of ["fetch", "verify", "probe"]) {
		await expect(nodeCard(page, id).locator("[data-sparkline]")).toBeVisible();
	}
	await page.mouse.move(700, 760);
	await expect(page).toHaveScreenshot("editor-run-state.png", {
		mask: [
			page.getByTestId("canvas-run").locator(".font-mono").first(),
			page.getByTestId("run-summary").locator("dd").first(),
		],
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
	await expect(page).toHaveScreenshot("monitor-stopped.png", { mask: runIds(page) });
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
	await expect(dialog).toContainText("− report");
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
