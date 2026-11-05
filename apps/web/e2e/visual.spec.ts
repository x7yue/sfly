import { type E2eFixtures, expect, test } from "./fixtures";
import { seedRunRecords } from "./run-records";
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
