import type { Page } from "@playwright/test";
import type { AssignedTask } from "../../server/test/support/fake-agent.js";
import { createEditorScenario, nodeCard } from "./editor-support";
import { type E2eFixtures, expect, test } from "./fixtures";
import { openMonitor, runningScenario } from "./monitor-scenario";
import { seedRunRecords } from "./run-records";
import {
	createScenario,
	failApi,
	holdApi,
	publishPackage,
	scenarioUsing,
	seedDashboard,
	triggerRun,
} from "./support";

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
	const last = await seedRunRecords(controlPlane, clock, agent);
	await page.clock.setFixedTime(new Date(last.getTime() + 42_000));
	await page.goto("/runs");
	await expect(page.getByRole("article")).toHaveCount(2);
	await expect(page.getByRole("table", { name: "历史运行" }).getByRole("row")).toHaveCount(5);
	await expect(page.getByRole("article").nth(1).getByRole("listitem")).toContainText("37 / 120");
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

	test("引用补全", async ({ page }) => {
		await nodeCard(page, "ping").click();
		const host = page.getByRole("combobox", { name: "输入 host" });
		await host.fill("");
		await host.focus();
		await idle(page);
		await expect(page.getByRole("listbox", { name: "可引用的值" })).toBeVisible();
		await expect(page).toHaveScreenshot("editor-references.png");
	});

	test("入口参数与敏感参数", async ({ page }) => {
		await nodeCard(page, "entry").click();
		await idle(page);
		await expect(page.getByRole("group", { name: "参数 api_token" })).toBeVisible();
		await expect(page).toHaveScreenshot("editor-entry.png");
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
	await page.mouse.move(700, 760);
	await expect(page).toHaveScreenshot("editor-run-state.png", {
		mask: [
			page.getByTestId("canvas-run").locator(".font-mono").first(),
			page.getByTestId("run-summary").locator("dd").first(),
		],
	});
});
