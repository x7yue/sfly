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

test("归档之后焦点落到下一张卡片；最后一张也归档后焦点回到页面标题", async ({
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

	await archive(second ?? "");
	await expect(page.getByRole("heading", { name: "场景编排", level: 1 })).toBeFocused();
});

test("带「撤销」的通知在右下角、不自动消失，Alt+T 跳过去用键盘撤销；撤销之后通知消失时焦点不会被抢回进去之前的元素", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "甲", scenarioUsing("agent-a"));
	await createScenario(controlPlane, "乙", scenarioUsing("agent-a"));
	await page.goto("/orchestrations");
	await expect(page.locator("article[data-list-item]")).toHaveCount(2);
	await page.getByRole("article", { name: "乙" }).getByLabel("更多操作").click();
	await page.getByRole("menuitem", { name: /归档/ }).click();
	await page
		.getByRole("dialog", { name: "归档「乙」？" })
		.getByRole("button", { name: "归档", exact: true })
		.click();

	const toasts = page.getByRole("region", { name: /通知/ }).locator("[data-sonner-toast]");
	const archived = toasts.filter({ hasText: "已归档「乙」" });
	await expect(archived).toBeVisible();
	const at = await box(archived);
	const viewport = page.viewportSize() ?? { width: 0, height: 0 };
	expect(at.x).toBeGreaterThan(viewport.width / 2);
	expect(at.y).toBeGreaterThan(viewport.height / 2);
	await expect(archived.getByRole("button", { name: "关闭通知" })).toBeVisible();
	// biome-ignore lint/plugin/e2e-fixed-wait: 带「撤销」的通知不自动消失：断言的是等过普通通知（2.6 秒）与警告（5.2 秒）的时长它仍在，没有发生的事无从等起
	await page.waitForTimeout(7_000);
	await expect(archived).toBeVisible();

	// 归档之后焦点落到「甲」的链接；从它出发按 Alt+T 进入通知区域，通知容器（sonner）记下「甲」。
	await expect(
		page.getByRole("article", { name: "甲" }).locator("[data-list-primary]"),
	).toBeFocused();
	await page.keyboard.press("Alt+t");
	const undo = archived.getByRole("button", { name: "撤销" });
	for (let i = 0; i < 4 && !(await undo.evaluate((el) => el === document.activeElement)); i++) {
		await page.keyboard.press("Tab");
	}
	await expect(undo).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("article", { name: "乙" })).toBeVisible();

	// 焦点所在的「撤销」通知被移走了，之后用户去了别处。
	await expect(archived).toHaveCount(0);
	const more = page.getByRole("article", { name: "乙" }).getByLabel("更多操作");
	await more.focus();
	// 「已恢复」也消失、通知区域卸载：焦点留在用户去的地方，不被拉回「甲」。
	await expect(toasts).toHaveCount(0);
	await expect(more).toBeFocused();
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

test("列表表格的表头吸在页面主区域顶端；表头不加粗", async ({ page, controlPlane }) => {
	for (const name of ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]) {
		await createScenario(controlPlane, `场景-${name}`);
	}
	await page.setViewportSize({ width: 1280, height: 400 });
	await page.goto("/orchestrations?view=table");
	const table = page.getByRole("table", { name: "场景列表" });
	await expect(table.getByRole("row")).toHaveCount(9);
	const head = table.getByRole("columnheader", { name: "场景" });
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
		// direct://：不走系统代理。macOS 上 Chromium 跟随系统代理，sfly.test 不是回环地址，请求会发给代理，
		// 代理解析不了它（502），host-resolver-rules 的映射也不再起作用。
		args: ["--host-resolver-rules=MAP sfly.test 127.0.0.1", "--proxy-server=direct://"],
	});
	try {
		const context = await browser.newContext();
		await context.addCookies([
			{
				name: "sfly_login",
				value: await controlPlane.users.loginCookie(),
				url: `http://sfly.test:${port}`,
				httpOnly: true,
				sameSite: "Lax",
			},
		]);
		const insecure = await context.newPage();
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
