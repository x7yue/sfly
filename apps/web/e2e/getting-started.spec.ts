import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { createScenario, publishPackage, scenarioUsing, triggerRun } from "./support";

// 全新环境的控制台（外壳页方案第 5 节，原型 b-wall#empty）：只显示「开始使用」四步，
// 白色主按钮跟着第一个没完成的步骤走，出现第一个运行后面板消失。

test.use({ controlPlaneOptions: { publicHttpUrl: "http://sfly.example:8080" } });

const panel = (page: Page) => page.getByRole("region", { name: "开始使用", exact: true });
const step = (page: Page, id: "agent" | "package" | "scenario" | "run") =>
	panel(page).locator(`[data-step="${id}"]`);
/** 整个页面上的白色主按钮：每屏最多一个。 */
const whiteButtons = (page: Page) => page.locator('[data-variant="primary"]');

test("全新环境：控制台只有四步，没有统计、运行和 Agent 面板，也没有页头的计数和「运行场景」", async ({
	page,
}) => {
	await page.goto("/");

	await expect(panel(page)).toBeVisible();
	await expect(panel(page).getByRole("heading", { level: 2 })).toHaveText("开始使用");
	await expect(panel(page)).toContainText("0 / 4");
	await expect(panel(page).getByRole("heading", { level: 3 })).toHaveText([
		"接入一台 Agent",
		"发布节点包",
		"新建场景并编排",
		"触发第一次运行",
	]);
	await expect(page.getByRole("list", { name: "运行计数" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "运行场景" })).toHaveCount(0);
	for (const name of ["正在运行", "最近结束", "Agent", "场景"]) {
		await expect(page.getByRole("region", { name, exact: true })).toHaveCount(0);
	}
	await expect(page.getByRole("link", { name: "快速开始" })).toHaveCount(2);
	await expect(page.getByText("开发文档「快速开始」里有可以直接复制给它的提示词")).toBeVisible();
});

test("每完成一步，白色按钮移到下一步；出现第一个运行后面板消失", async ({
	page,
	controlPlane,
	connectAgent,
	context,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.goto("/");

	// 1. 没有 Agent：白色按钮是「复制安装命令」，把接入命令写进剪贴板。
	await expect(whiteButtons(page)).toHaveCount(1);
	await expect(step(page, "agent").getByRole("button", { name: "复制安装命令" })).toHaveAttribute(
		"data-variant",
		"primary",
	);
	await expect(step(page, "agent")).toContainText("还没有 Agent 连接");
	const command =
		"read -rs SFLY_TOKEN && export SFLY_TOKEN\ncurl -fsSL http://sfly.example:8080/install.sh | sh -s -- --name <名称>";
	await expect(step(page, "agent")).toContainText(command);
	await step(page, "agent").getByRole("button", { name: "复制安装命令" }).click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(command);

	// 2. Agent 在线：第 1 步打勾并写出事实；发布节点包没有白色按钮，只有开发文档「发布」的链接。
	await connectAgent({ name: "verify-agent", slots: 2 });
	await expect(step(page, "agent")).toHaveAttribute("data-state", "done");
	await expect(step(page, "agent")).toContainText("verify-agent 在线");
	await expect(step(page, "agent").getByText("已完成")).toBeAttached();
	await expect(step(page, "agent")).not.toContainText(command);
	await expect(panel(page)).toContainText("1 / 4");
	await expect(step(page, "package")).toHaveAttribute("data-state", "next");
	await expect(whiteButtons(page)).toHaveCount(0);
	await expect(
		step(page, "package").getByRole("link", { name: "开发文档 · 发布" }),
	).toHaveAttribute("href", "/docs/publish");
	await expect(step(page, "package")).toContainText("还没有发布节点包");

	// 3. 发布了节点包：白色按钮是「新建场景」，打开新建场景弹窗。
	await publishPackage(controlPlane);
	await expect(step(page, "package")).toHaveAttribute("data-state", "done");
	await expect(step(page, "package")).toContainText("已发布 demo-checks@1.2.0");
	await expect(step(page, "scenario")).toHaveAttribute("data-state", "next");
	await expect(whiteButtons(page)).toHaveCount(1);
	const create = step(page, "scenario").getByRole("button", { name: "新建场景" });
	await expect(create).toHaveAttribute("data-variant", "primary");
	await create.click();
	await expect(page.getByRole("dialog", { name: "新建场景" })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "新建场景" })).toHaveCount(0);

	// 4. 有了场景：白色按钮是「运行场景」，打开只列运行场景的命令面板。
	const scenario = await createScenario(controlPlane, "巡检", scenarioUsing("verify-agent"));
	await expect(step(page, "scenario")).toHaveAttribute("data-state", "done");
	await expect(step(page, "scenario")).toContainText("已新建场景「巡检」");
	await expect(step(page, "run")).toHaveAttribute("data-state", "next");
	await expect(whiteButtons(page)).toHaveCount(1);
	const run = step(page, "run").getByRole("button", { name: "运行场景" });
	await expect(run).toHaveAttribute("data-variant", "primary");
	await run.click();
	const palette = page.getByRole("dialog", { name: "命令面板" });
	await expect(palette.getByRole("option", { name: "运行「巡检」" })).toBeVisible();
	await page.keyboard.press("Escape");

	// 5. 出现第一个运行：面板消失，控制台换成运行的内容。
	await triggerRun(controlPlane, scenario);
	await expect(panel(page)).toHaveCount(0);
	await expect(page.getByRole("region", { name: "正在运行", exact: true })).toBeVisible();
	await expect(page.getByRole("list", { name: "运行计数" })).toBeVisible();
});

test("白色按钮跟着第一个没完成的步骤：Agent 掉线后回到第 1 步，后面的步骤仍保留完成状态", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "verify-agent", slots: 2 });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", scenarioUsing("verify-agent"));
	await page.goto("/");

	await expect(step(page, "run")).toHaveAttribute("data-state", "next");
	await expect(whiteButtons(page)).toHaveCount(1);
	await expect(whiteButtons(page)).toHaveText("运行场景");

	await agent.disconnect();
	await expect(step(page, "agent")).toHaveAttribute("data-state", "next");
	await expect(whiteButtons(page)).toHaveCount(1);
	await expect(whiteButtons(page)).toHaveText("复制安装命令");
	await expect(step(page, "package")).toHaveAttribute("data-state", "done");
	await expect(step(page, "scenario")).toHaveAttribute("data-state", "done");
	// 不是下一步的「运行场景」退成中性按钮，仍然可以点。
	await expect(step(page, "run").getByRole("button", { name: "运行场景" })).toHaveAttribute(
		"data-variant",
		"default",
	);
});

test("有多个 Agent、节点包和场景时，完成的步骤写出个数和最近的一个", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a", slots: 1 });
	await connectAgent({ name: "agent-b", slots: 1 });
	await publishPackage(controlPlane);
	await publishPackage(controlPlane, { name: "other-checks" });
	await createScenario(controlPlane, "巡检");
	await createScenario(controlPlane, "压测");
	await page.goto("/");

	await expect(step(page, "agent")).toContainText("agent-a 等 2 台在线");
	await expect(step(page, "package")).toContainText("已发布 2 个节点包，最近是 ");
	await expect(step(page, "scenario")).toContainText("已有 2 个场景，最近新建的是「");
});
