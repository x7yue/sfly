import { type E2eFixtures, expect, test } from "./fixtures";
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
