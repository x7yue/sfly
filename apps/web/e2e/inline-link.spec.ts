import { fileURLToPath } from "node:url";
import type { Locator } from "@playwright/test";
import { IDS, seedRemovedKindScenario } from "../../server/test/support/removed-kind-scenario.js";
import { createEditorScenario, inspector, nodeCard, openEditor } from "./editor-support";
import { expect, test } from "./fixtures";
import { openMonitor, runningScenario } from "./monitor-scenario";
import {
	createFeishuBot,
	createScenario,
	publishPackage,
	scenarioUsing,
	setRunNotification,
	triggerRun,
} from "./support";

// 行内链接的样式（docs/DESIGN-SYSTEM.md 2.4「行内链接」，`lib/inline-link.ts`）：夹在一句话里的链接，文字是 `fg-1`、
// 下划线是 `fg-3`，不靠继承周围的文字色。这里读各处链接实际的颜色和下划线（不比像素）。

interface Look {
	color: string;
	decorationLine: string;
	decorationColor: string;
	surroundingColor: string;
	fg1: string;
	fg3: string;
}

/** 链接实际的文字色、下划线，周围文字的颜色，以及设计令牌 fg-1、fg-3 在这里的取值（同一种写法，能直接比较）。 */
const look = (link: Locator): Promise<Look> =>
	link.evaluate((el): Look => {
		const resolve = (token: string) => {
			const probe = document.createElement("span");
			probe.style.color = `var(${token})`;
			document.body.append(probe);
			const color = getComputedStyle(probe).color;
			probe.remove();
			return color;
		};
		const css = getComputedStyle(el);
		return {
			color: css.color,
			decorationLine: css.textDecorationLine,
			decorationColor: css.textDecorationColor,
			surroundingColor: el.parentElement ? getComputedStyle(el.parentElement).color : "",
			fg1: resolve("--color-fg-1"),
			fg3: resolve("--color-fg-3"),
		};
	});

/**
 * 文字 fg-1、有下划线、下划线 fg-3。周围是红字、灰字的地方（`dimmerAround`，缺省）还要和周围文字的颜色不一样：
 * 链接照样认得出来；周围本来就是 fg-1 的正文（文档页、列表项里的名称）只比下划线。
 */
async function expectInlineLink(link: Locator, { dimmerAround = true } = {}) {
	await expect(link).toBeVisible();
	const l = await look(link);
	expect(l.color).toBe(l.fg1);
	expect(l.decorationLine).toContain("underline");
	expect(l.decorationColor).toBe(l.fg3);
	if (dimmerAround) expect(l.surroundingColor).not.toBe(l.color);
}

test("运行通知对话框：说明里的文档链接和红字里的「飞书机器人」链接都是行内链接的样式", async ({
	page,
	controlPlane,
	feishu,
}) => {
	await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("a"));
	const scenario = await createScenario(controlPlane, "订单压测", scenarioUsing("agent-a"));
	await setRunNotification(controlPlane, scenario, {
		bot: "压测群",
		trigger: "failed_or_cancelled",
		title: "【订单压测-A 环境】",
		note: "环境 A",
	});
	await controlPlane.fetch("/feishu-bots/%E5%8E%8B%E6%B5%8B%E7%BE%A4", {
		method: "DELETE",
		headers: { "x-sfly-nickname": "tester" },
	});
	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "订单压测" }).getByLabel("更多操作").click();
	await page.getByRole("menuitem", { name: "运行通知…" }).click();
	const dialog = page.getByRole("dialog", { name: "运行通知" });
	const alert = dialog.getByRole("alert");
	await expect(alert).toContainText("已被删除");
	await expectInlineLink(alert.getByRole("link", { name: "飞书机器人" }));
	await expectInlineLink(dialog.getByRole("link", { name: /飞书通知/ }));
});

test("运行抽屉：「该场景已有运行中的运行」后面的「查看」是行内链接的样式", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));
	await triggerRun(controlPlane, id);
	await agent.nextAssign();
	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "巡检" }).getByRole("button", { name: "运行" }).click();
	const drawer = page.getByRole("dialog", { name: "运行 · 巡检" });
	const notice = drawer.getByRole("status").filter({ hasText: "运行中的运行" });
	await expectInlineLink(notice.getByRole("link", { name: "查看" }));
});

test("删除飞书机器人的对话框：引用它的场景名是行内链接的样式", async ({
	page,
	controlPlane,
	feishu,
}) => {
	await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("a"));
	const scenario = await createScenario(controlPlane, "订单压测", scenarioUsing("agent-a"));
	await setRunNotification(controlPlane, scenario, {
		bot: "压测群",
		trigger: "failed_or_cancelled",
		title: "【订单压测-A 环境】",
		note: "环境 A",
	});
	await page.goto("/feishu-bots");
	await page
		.getByRole("row", { name: /^压测群/ })
		.getByRole("button", { name: "删除" })
		.click();
	const dialog = page.getByRole("dialog", { name: "删除飞书机器人「压测群」？" });
	await expectInlineLink(
		dialog
			.getByRole("list", { name: "引用这个机器人的场景" })
			.getByRole("link", { name: "订单压测" }),
		{ dimmerAround: false },
	);
});

test.describe("登录页", () => {
	test.use({ nickname: null });

	test("没有任何用户时，卡片下面指向初始化页的链接是行内链接的样式", async ({ page }) => {
		await page.goto("/login");
		await expectInlineLink(page.getByRole("link", { name: "用初始化码创建第一个管理员" }));
	});
});

test.describe("开发文档", () => {
	test.use({
		controlPlaneOptions: { docsDir: fileURLToPath(new URL("./docs-fixture", import.meta.url)) },
	});

	test("文档页正文里的链接（文档页之间的、站内的、站外的）都是行内链接的样式", async ({ page }) => {
		await page.goto("/docs/quickstart");
		const article = page.getByRole("article", { name: "快速开始" });
		for (const name of ["安装 Agent", "节点包管理", "Python 文档"]) {
			await expectInlineLink(article.getByRole("link", { name }), { dimmerAround: false });
		}
	});
});

test.describe("昵称弹窗", () => {
	test.use({ nickname: null });

	test("「已有账号，去登录」是行内链接的样式", async ({ page }) => {
		await page.goto("/");
		const dialog = page.getByRole("dialog", { name: "欢迎使用 sfly" });
		await expectInlineLink(dialog.getByRole("link", { name: "已有账号，去登录" }), {
			dimmerAround: false,
		});
	});
});

test("检查器的警告框：「前往」是行内链接的样式（黄色警告框里文字和周围不同色）", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "sub_entry").click();
	await inspector(page).getByRole("textbox", { name: "子流程名称" }).fill("");
	// 顶栏的检查结果打开场景的检查列表，警告在这里带「前往」。
	await page.getByRole("button", { name: "1 条警告" }).click();
	const warning = inspector(page).getByRole("listitem").filter({ hasText: "没有填写名称" });
	await expectInlineLink(warning.getByRole("button", { name: "前往" }));
});

test("检查器的错误框：「前往」是行内链接的样式（红色错误框里文字和周围不同色）", async ({
	page,
	controlPlane,
}) => {
	await seedRemovedKindScenario(controlPlane);
	await openEditor(page, IDS.scenario, "notify");
	await nodeCard(page, "notify").click();
	// 保存被拦下：字段错误出现在检查器里，带「前往」。
	await page.keyboard.press("Control+s");
	await page.getByRole("button", { name: /处字段错误/ }).click();
	const error = inspector(page).getByRole("listitem").filter({ hasText: "已不再支持，不能保存" });
	// 三个已移除种类的节点各有一条错误：看第一条。
	await expectInlineLink(error.getByRole("button", { name: "前往" }).first());
});

test("运行监控底部面板：输入输出里的产物引用是行内链接的样式", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const { runId, agent, tasks } = await runningScenario(controlPlane, connectAgent, clock);
	const probe = tasks.probe as NonNullable<typeof tasks.probe>;
	await agent.succeed(probe, {
		report: `http://127.0.0.1:9/tasks/${probe.taskId}/artifacts/report.html`,
	});
	await openMonitor(page, clock, runId, "probe");
	await page
		.getByRole("region", { name: "底部面板" })
		.getByRole("tab", { name: "输入输出" })
		.click();
	await expectInlineLink(page.getByRole("link", { name: /artifacts\/report\.html/ }), {
		dimmerAround: false,
	});
});
