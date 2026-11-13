import { chromium } from "@playwright/test";
import { expect, test } from "./fixtures";
import { box, createScenario, publishPackage, scenarioUsing } from "./support";

// 通用组件：弹窗、通知、菜单、提示、表格、页头、复制（docs/DESIGN-SYSTEM.md「组件清单」「通知与横幅」）。

test("弹窗输入过内容后点遮罩不关闭、Esc 照常关闭；没输入过时点遮罩就关闭；说明是 13px 正文", async ({
	page,
}) => {
	await page.goto("/orchestrations");
	await expect(page.getByRole("heading", { name: "场景编排" })).toBeVisible();
	const dialog = page.getByRole("dialog", { name: "新建场景" });

	await page.keyboard.press("n");
	await expect(dialog).toBeVisible();
	await page.mouse.click(10, 10);
	await expect(dialog).toBeHidden();

	await page.keyboard.press("n");
	await dialog.getByLabel("名称").fill("写了一半的场景");
	await page.mouse.click(10, 10);
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel("名称")).toHaveValue("写了一半的场景");
	const description = dialog.locator('[data-slot="dialog-description"]');
	await expect(description).toHaveCSS("font-size", "13px");
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
});

test("弹窗内容变高时按钮行仍在弹窗里看得见；弹窗描边与菜单同一档", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "压测", scenarioUsing("agent-a"));
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "压测" }).getByLabel("更多操作").click();
	const menu = page.getByRole("menu");
	const menuBorder = await menu.evaluate((el) => getComputedStyle(el).borderTopColor);
	await page.getByRole("menuitem", { name: /运行通知/ }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toHaveCSS("border-top-color", menuBorder);

	await dialog
		.getByRole("textbox")
		.last()
		.evaluate((el) => {
			(el as HTMLElement).style.height = "420px";
		});
	const save = dialog.getByRole("button", { name: "保存" });
	const panel = await box(dialog);
	const button = await box(save);
	expect(button.y + button.height).toBeLessThanOrEqual(panel.y + panel.height);
	expect(panel.y + panel.height).toBeLessThanOrEqual(720);
	await save.click({ trial: true });
});

test("归档之后焦点落到下一张卡片；带「撤销」的通知在右下角、不自动消失，Alt+T 跳过去用键盘撤销；最后一张也归档后焦点回到页面标题", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "甲", scenarioUsing("agent-a"));
	await createScenario(controlPlane, "乙", scenarioUsing("agent-a"));
	await page.goto("/orchestrations");
	const cards = page.locator("article[data-list-item]");
	await expect(cards).toHaveCount(2);
	const [first, second] = await cards.evaluateAll((all) => all.map((a) => a.ariaLabel ?? ""));

	const archive = async (name: string) => {
		await page.getByRole("article", { name }).getByLabel("更多操作").focus();
		await page.keyboard.press("Enter");
		await page.getByRole("menuitem", { name: /归档/ }).focus();
		await page.keyboard.press("Enter");
		const confirm = page.getByRole("dialog", { name: `归档「${name}」？` });
		await confirm.getByRole("button", { name: "归档", exact: true }).focus();
		await page.keyboard.press("Enter");
		await expect(page.getByRole("article", { name })).toBeHidden();
	};

	await archive(first ?? "");
	const next = page.getByRole("article", { name: second }).locator("[data-list-primary]");
	await expect(next).toBeFocused();

	const toast = page.getByRole("region", { name: /通知/ }).locator("[data-sonner-toast]");
	await expect(toast).toContainText(`已归档「${first}」`);
	const at = await box(toast);
	const viewport = page.viewportSize() ?? { width: 0, height: 0 };
	expect(at.x).toBeGreaterThan(viewport.width / 2);
	expect(at.y).toBeGreaterThan(viewport.height / 2);
	await expect(toast.getByRole("button", { name: "关闭通知" })).toBeVisible();
	await page.waitForTimeout(7_000);
	await expect(toast).toBeVisible();

	await page.keyboard.press("Alt+t");
	const undo = toast.getByRole("button", { name: "撤销" });
	for (let i = 0; i < 4 && !(await undo.evaluate((el) => el === document.activeElement)); i++) {
		await page.keyboard.press("Tab");
	}
	await expect(undo).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("article", { name: first })).toBeVisible();

	await archive(first ?? "");
	await archive(second ?? "");
	await expect(page.getByRole("heading", { name: "场景编排", level: 1 })).toBeFocused();
});

test("下拉菜单的禁用项不降整项透明度，原因读得清；菜单不是模态，打开时页面照常可滚动", async ({
	page,
	controlPlane,
}) => {
	await createScenario(controlPlane, "压测");
	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "压测" }).getByLabel("更多操作").click();
	await expect(page.getByRole("menu")).toBeVisible();
	expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe("hidden");
	const item = page.getByRole("menuitem", { name: /版本历史/ });
	await expect(item).toHaveCSS("opacity", "1");
});

test("列表表格的表头吸在页面主区域顶端；表头不加粗", async ({ page, connectAgent }) => {
	for (const name of ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]) {
		await connectAgent({ name: `agent-${name}` });
	}
	await page.setViewportSize({ width: 1280, height: 400 });
	await page.goto("/agents");
	const table = page.getByRole("table", { name: "Agent 列表" });
	await expect(table.getByRole("row")).toHaveCount(9);
	const head = table.getByRole("columnheader", { name: "名称" });
	await expect(head).toHaveCSS("font-weight", "400");
	const main = page.locator("#main");
	await main.evaluate((el) => el.scrollTo(0, 260));
	const [mainTop, headTop] = await Promise.all([
		main.evaluate((el) => el.getBoundingClientRect().top),
		head.evaluate((el) => el.getBoundingClientRect().top),
	]);
	expect(Math.round(headTop)).toBe(Math.round(mainTop));
});

test("页头有没有右侧按钮，标题都在同一高度", async ({ page, connectAgent }) => {
	await connectAgent({ name: "agent-a" });
	const top = async (path: string, title: string) => {
		await page.goto(path);
		const heading = page.getByRole("heading", { name: title, level: 1 });
		await expect(heading).toBeVisible();
		return (await box(heading)).y;
	};
	expect(await top("/agents", "Agent 管理")).toBe(await top("/packages", "节点包管理"));
});

test("提示在相邻按钮之间切换时新提示直接出现，不与旧提示叠着做淡入淡出", async ({ page }) => {
	await page.goto("/agents");
	await expect(page.getByRole("heading", { name: "Agent 管理", level: 1 })).toBeVisible();
	await page.keyboard.press("Control+b");
	await expect(page.getByRole("complementary", { name: "侧边栏" })).toHaveAttribute(
		"data-collapsed",
		"true",
	);
	const nav = page.getByRole("navigation", { name: "主导航" });
	const links = nav.getByRole("link");
	await links.nth(0).hover();
	const tips = page.locator('[data-slot="tooltip-content"]');
	await expect(tips).toHaveCount(1);
	await links.nth(1).hover();
	const instant = tips.and(page.locator("[data-instant]")).last();
	await expect(instant).toBeVisible();
	await expect(instant).toHaveCSS("transition-property", "none");
	await expect(tips).toHaveCount(1);
});

test("内网用 http 访问（没有 Clipboard API）时，复制按钮照样把文字写进剪贴板", async ({
	controlPlane,
}) => {
	const port = new URL(controlPlane.httpUrl).port;
	const browser = await chromium.launch({
		args: ["--host-resolver-rules=MAP sfly.test 127.0.0.1"],
	});
	try {
		const insecure = await (await browser.newContext()).newPage();
		await insecure.addInitScript(() => window.localStorage.setItem("sfly.nickname", "tester"));
		await insecure.goto(`http://sfly.test:${port}/agents`);
		expect(
			await insecure.evaluate(() => [window.isSecureContext, "clipboard" in navigator]),
		).toEqual([false, false]);
		const block = insecure.locator('[data-slot="code-block"]');
		const command = (await block.locator("pre").textContent()) ?? "";
		expect(command).not.toBe("");
		await block.getByRole("button", { name: "复制" }).click();
		await expect(insecure.getByText("已复制到剪贴板")).toBeVisible();

		const reader = await browser.newContext({ permissions: ["clipboard-read"] });
		const page = await reader.newPage();
		await page.goto(controlPlane.httpUrl);
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);
	} finally {
		await browser.close();
	}
});
