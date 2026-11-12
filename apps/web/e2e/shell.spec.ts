import { expect, test } from "./fixtures";
import { createScenario, publishPackage, scenarioUsing, triggerRun } from "./support";

// 应用外壳：侧边栏、面包屑、命令面板、快捷键面板、昵称、焦点管理、样式分层与字体。

const sidebar = (page: import("@playwright/test").Page) =>
	page.getByRole("navigation", { name: "主导航" });
const breadcrumb = (page: import("@playwright/test").Page) =>
	page.getByRole("navigation", { name: "面包屑" });

test("侧边栏在七个一级页面之间切换，当前页高亮，面包屑跟随", async ({ page }) => {
	await page.goto("/");
	await expect(breadcrumb(page)).toHaveText(/控制台/);

	for (const [label, url] of [
		["场景编排", /\/orchestrations$/],
		["运行记录", /\/runs$/],
		["Agent 管理", /\/agents$/],
		["节点包管理", /\/packages$/],
		["飞书机器人", /\/feishu-bots$/],
		["开发文档", /\/docs$/],
		["控制台", /\/$/],
	] as const) {
		await sidebar(page).getByRole("link", { name: label }).click();
		await expect(page).toHaveURL(url);
		await expect(sidebar(page).getByRole("link", { name: label })).toHaveAttribute(
			"aria-current",
			"page",
		);
		await expect(breadcrumb(page).locator('[aria-current="page"]')).toHaveText(label);
	}
});

test("侧边栏项右侧平时是计数，悬停或键盘聚焦时换成跳转快捷键，折叠后不显示", async ({
	page,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a" });
	await page.goto("/");
	const agents = sidebar(page).getByRole("link", { name: "Agent 管理" });
	const count = agents.getByText("1/1");
	const keys = agents.locator("span[aria-hidden]:has(kbd)");
	await expect(count).toBeVisible();
	await expect(count).toHaveCSS("opacity", "1");
	await expect(keys).toHaveText("G然后A");
	await expect(keys).toHaveCSS("opacity", "0");

	await agents.hover();
	await expect(keys).toHaveCSS("opacity", "1");
	await expect(count).toHaveCSS("opacity", "0");

	await page.mouse.move(700, 500);
	const docs = sidebar(page).getByRole("link", { name: "开发文档" });
	await expect(docs.locator("span[aria-hidden]:has(kbd)")).toHaveCSS("opacity", "0");
	await docs.focus();
	await expect(docs.locator("span[aria-hidden]:has(kbd)")).toHaveText("G然后H");
	await expect(docs.locator("span[aria-hidden]:has(kbd)")).toHaveCSS("opacity", "1");

	await page.getByRole("button", { name: "折叠侧边栏" }).click();
	await expect(sidebar(page).locator("kbd")).toHaveCount(0);
});

test("侧边栏可以折叠成一列图标，刷新后保持", async ({ page }) => {
	await page.goto("/agents");
	await page.getByRole("button", { name: "折叠侧边栏" }).click();

	const agents = sidebar(page).getByRole("link", { name: "Agent 管理" });
	await expect(agents.getByText("Agent 管理")).toHaveClass(/sr-only/);
	await agents.hover();
	await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText("Agent 管理");

	await page.reload();
	await expect(page.getByRole("button", { name: "展开侧边栏" })).toBeVisible();
	await page.keyboard.press("Control+b");
	await expect(page.getByRole("button", { name: "折叠侧边栏" })).toBeVisible();
	await expect(agents.getByText("Agent 管理")).not.toHaveClass(/sr-only/);
});

test("命令面板：Ctrl K 打开，搜索并跳转到页面或场景", async ({ page, controlPlane }) => {
	const scenarioId = await createScenario(controlPlane, "日终数据处理");
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "控制台", exact: true })).toBeVisible();

	await page.keyboard.press("Control+k");
	const palette = page.getByRole("dialog", { name: "命令面板" });
	await expect(palette).toBeVisible();
	await expect(palette.getByRole("combobox", { name: "命令" })).toBeFocused();
	await page.keyboard.type("节点包");
	await expect(palette.getByRole("option")).toHaveText([/节点包管理/]);
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/packages$/);
	await expect(palette).toBeHidden();

	await page.getByRole("button", { name: /搜索页面、场景、命令/ }).click();
	await expect(palette.getByRole("combobox", { name: "命令" })).toBeFocused();
	await page.keyboard.type("日终");
	await expect(
		palette.getByRole("group", { name: "场景", exact: true }).getByRole("option"),
	).toHaveText(["日终数据处理"]);
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(new RegExp(`/orchestrations/${scenarioId}$`));
});

test("命令面板：Ctrl K 后马上输入，字落在搜索框里，回车执行匹配的那一条（#280）", async ({
	page,
}) => {
	await page.goto("/agents");
	await expect(page.getByRole("heading", { name: "Agent 管理" })).toBeVisible();
	// 机器忙的时候一帧可能很长：让每一帧都晚到 300ms，打开面板和下一帧之间按下的键也要进搜索框。
	await page.evaluate(() => {
		const raf = window.requestAnimationFrame.bind(window);
		window.requestAnimationFrame = (callback) =>
			raf(() => {
				setTimeout(() => callback(performance.now()), 300);
			});
	});
	await page.keyboard.press("Control+k");
	await page.keyboard.type("节点包");
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/packages$/);
});

test("命令面板：「运行」分组跳转到最近的运行；「运行场景」打开运行抽屉", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const scenarioId = await createScenario(controlPlane, "日终数据处理", scenarioUsing("agent-a"));
	const runId = await triggerRun(controlPlane, scenarioId);
	await agent.nextAssign();
	await page.goto("/agents");
	await expect(page.getByRole("heading", { name: "Agent 管理" })).toBeVisible();

	await page.keyboard.press("Control+k");
	await expect(page.getByRole("combobox", { name: "命令" })).toBeFocused();
	const palette = page.getByRole("dialog", { name: "命令面板" });
	await page.keyboard.type(runId.slice(0, 6));
	const runs = palette.getByRole("group", { name: "运行", exact: true });
	await expect(runs.getByRole("option")).toHaveText([
		new RegExp(`${runId.slice(0, 8)}.*日终数据处理`),
	]);
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));

	await page.goto("/agents");
	await expect(page.getByRole("heading", { name: "Agent 管理" })).toBeVisible();
	await page.keyboard.press("Control+k");
	await expect(page.getByRole("combobox", { name: "命令" })).toBeFocused();
	await page.keyboard.type("日终");
	const start = palette.getByRole("group", { name: "运行场景" }).getByRole("option");
	await expect(start).toHaveText(["运行「日终数据处理」"]);
	await start.click();
	await expect(palette).toBeHidden();
	const drawer = page.getByRole("dialog", { name: "运行 · 日终数据处理" });
	await expect(drawer.getByRole("list", { name: "触发前检查" })).toBeVisible();
	await expect(page).toHaveURL(/\/agents$/);
});

test("命令面板执行命令：打开快捷键面板", async ({ page }) => {
	await page.goto("/agents");
	await expect(page.getByRole("heading", { name: "Agent 管理" })).toBeVisible();
	await page.keyboard.press("Control+k");
	await expect(page.getByRole("combobox", { name: "命令" })).toBeFocused();
	await page.keyboard.type("快捷键");
	await page.getByRole("option", { name: /打开快捷键面板/ }).click();
	await expect(page.getByRole("dialog", { name: "命令面板" })).toBeHidden();
	await expect(page.getByRole("dialog", { name: "快捷键" })).toBeVisible();
});

test("快捷键面板（?）列出注册表里的快捷键，列出的跳转快捷键都生效", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "控制台", exact: true })).toBeVisible();
	await page.keyboard.press("?");
	const panel = page.getByRole("dialog", { name: "快捷键" });
	await expect(panel).toBeVisible();
	const global = panel.getByRole("region", { name: "全局" });
	await expect(global.getByRole("term")).toHaveText([
		"命令面板",
		"快捷键面板",
		"关闭浮层",
		"控制台",
		"场景编排",
		"运行记录",
		"Agent 管理",
		"节点包管理",
		"飞书机器人",
		"开发文档",
		"折叠 / 展开侧边栏",
		"新建场景",
	]);
	await expect(global.getByRole("definition").nth(0)).toHaveText("CtrlK");
	await page.keyboard.press("Escape");
	await expect(panel).toBeHidden();

	for (const [keys, url] of [
		["g a", /\/agents$/],
		["g p", /\/packages$/],
		["g f", /\/feishu-bots$/],
		["g h", /\/docs$/],
		["g r", /\/runs$/],
		["g s", /\/orchestrations$/],
		["g d", /\/$/],
	] as const) {
		for (const key of keys.split(" ")) await page.keyboard.press(key);
		await expect(page).toHaveURL(url);
	}
});

test("在输入框里打字不会触发单键快捷键", async ({ page }) => {
	await page.goto("/agents");
	await expect(page.getByRole("heading", { name: "Agent 管理" })).toBeVisible();
	await page.keyboard.press("Control+k");
	await expect(page.getByRole("combobox", { name: "命令" })).toBeFocused();
	await page.keyboard.type("g p ? n");
	await expect(page).toHaveURL(/\/agents$/);
	await expect(page.getByRole("dialog", { name: "快捷键" })).toBeHidden();
	await expect(page.getByRole("dialog", { name: "新建场景" })).toBeHidden();
	await expect(page.getByRole("combobox", { name: "命令" })).toHaveValue("g p ? n");
});

test("N 打开新建场景：在页面上打开、在弹窗的输入框里打字不再触发；命令面板里「新建场景」显示这个键", async ({
	page,
}) => {
	await page.goto("/agents");
	await expect(page.getByRole("heading", { name: "Agent 管理" })).toBeVisible();
	await page.keyboard.press("n");
	const dialog = page.getByRole("dialog", { name: "新建场景" });
	await expect(dialog).toBeVisible();
	const name = dialog.getByRole("textbox", { name: "名称" });
	await expect(name).toBeFocused();
	await page.keyboard.type("n g s ?");
	await expect(name).toHaveValue("n g s ?");
	await expect(page).toHaveURL(/\/agents$/);
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();

	await page.keyboard.press("Control+k");
	const palette = page.getByRole("dialog", { name: "命令面板" });
	await expect(palette.getByRole("combobox", { name: "命令" })).toBeFocused();
	await expect(palette.getByRole("group", { name: "当前页面" })).toHaveCount(0);
	await expect(palette.getByRole("option", { name: /新建场景/ })).toHaveText(/新建场景N/);
	await page.keyboard.type("新建");
	await page.keyboard.press("Enter");
	await expect(dialog).toBeVisible();
});

test("弹窗锁定焦点，Esc 关闭后焦点回到打开它的按钮", async ({ page }) => {
	await page.goto("/agents");
	const search = page.getByRole("button", { name: /搜索页面、场景、命令/ });
	await search.focus();
	await page.keyboard.press("Enter");
	const palette = page.getByRole("dialog", { name: "命令面板" });
	await expect(palette).toBeVisible();

	// Tab 在弹窗内循环，不会落到背后的页面上。
	for (let i = 0; i < 5; i++) {
		await page.keyboard.press("Tab");
		await expect
			.poll(() => palette.evaluate((el) => el.contains(document.activeElement)))
			.toBe(true);
	}

	await page.keyboard.press("Escape");
	await expect(palette).toBeHidden();
	await expect(search).toBeFocused();

	// 快捷键面板从侧边栏按钮打开，关闭按钮关闭后同样回到原处。
	const keysButton = page.getByRole("button", { name: "快捷键" });
	await keysButton.click();
	const panel = page.getByRole("dialog", { name: "快捷键" });
	await panel.getByRole("button", { name: "关闭" }).click();
	await expect(panel).toBeHidden();
	await expect(keysButton).toBeFocused();
});

test.describe("没有昵称时", () => {
	test.use({ nickname: null });

	test("第一次打开要求填写昵称，不能跳过；之后可以在顶栏修改", async ({ page }) => {
		await page.goto("/agents");
		const dialog = page.getByRole("dialog", { name: "欢迎使用 sfly" });
		await expect(dialog).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(dialog).toBeVisible();

		await dialog.getByRole("textbox", { name: "昵称" }).fill("评审员");
		await dialog.getByRole("button", { name: "开始使用" }).click();
		await expect(dialog).toBeHidden();

		const me = page.getByRole("button", { name: "评审员" });
		await me.click();
		const edit = page.getByRole("dialog", { name: "修改昵称" });
		await edit.getByRole("textbox", { name: "昵称" }).fill("小王");
		await edit.getByRole("button", { name: "保存" }).click();
		await expect(page.getByText("昵称已改为 小王")).toBeVisible();
		await expect(page.getByRole("button", { name: "小王" })).toBeVisible();
	});
});

test("样式都在设计体系声明的 CSS layer 里（没有按页面的旧样式层），字体随前端打包、不请求外部资源", async ({
	page,
	baseURL,
}) => {
	const external: string[] = [];
	page.on("request", (req) => {
		if (!req.url().startsWith(baseURL ?? "")) external.push(req.url());
	});
	await page.goto("/agents");
	await expect(page.getByRole("heading", { name: "Agent 管理" })).toBeVisible();

	const unlayered = await page.evaluate(() =>
		[...document.styleSheets].flatMap((sheet) =>
			[...sheet.cssRules]
				.filter((rule) => rule instanceof CSSStyleRule || rule instanceof CSSMediaRule)
				.map((rule) => rule.cssText.slice(0, 80)),
		),
	);
	expect(unlayered).toEqual([]);

	// 所有层都在 app.css 声明的顺序里（docs/DESIGN-SYSTEM.md「CSS layer」）：MVP 的 legacy 层已删除。
	// properties 是 Tailwind v4 自己的层（只有 @property 的回退值）。
	const layers = await page.evaluate(() => {
		const names = new Set<string>();
		const visit = (rules: CSSRuleList, prefix: string) => {
			for (const rule of rules) {
				if (rule instanceof CSSLayerStatementRule) {
					for (const n of rule.nameList) names.add(prefix + n);
				} else if (rule instanceof CSSLayerBlockRule) {
					names.add(prefix + rule.name);
					visit(rule.cssRules, `${prefix}${rule.name}.`);
				} else if (rule instanceof CSSImportRule && rule.layerName !== null) {
					names.add(prefix + rule.layerName);
				}
			}
		};
		for (const sheet of document.styleSheets) visit(sheet.cssRules, "");
		return [...names].filter((n) => !n.includes(".")).sort();
	});
	expect(layers).toEqual(["base", "components", "properties", "theme", "utilities", "vendor"]);

	// 页面上用到的两种字体都已从同源加载（字体文件来自构建产物）。
	const loaded = await page.evaluate(async () => {
		await document.fonts.ready;
		return [
			...new Set(
				[...document.fonts]
					.filter((f) => f.status === "loaded")
					.map((f) => f.family.replaceAll('"', "")),
			),
		].sort();
	});
	expect(loaded).toEqual(["IBM Plex Sans", "JetBrains Mono"]);
	expect(await page.evaluate(() => getComputedStyle(document.body).fontVariantNumeric)).toBe(
		"tabular-nums",
	);
	expect(external).toEqual([]);
});
