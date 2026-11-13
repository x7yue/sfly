import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

// 开发文档页（ADR 0013，#60）：侧边栏与命令面板都能进入，渲染控制面返回的 Markdown（占位符已替换），
// 代码块带复制按钮，页面之间可以互相链接。用 e2e/docs-fixture 里的固定文档，不随 docs/guide 的内容变化。

const DOCS_FIXTURE = fileURLToPath(new URL("./docs-fixture", import.meta.url));
test.use({ controlPlaneOptions: { docsDir: DOCS_FIXTURE, version: "1.2.3" } });

const article = (page: import("@playwright/test").Page) =>
	page.getByRole("article", { name: "快速开始" });

test("从侧边栏进入开发文档，Markdown 渲染成标题、列表、表格、链接和代码块", async ({
	page,
	controlPlane,
}) => {
	await page.goto("/agents");
	await page
		.getByRole("navigation", { name: "主导航" })
		.getByRole("link", { name: "开发文档" })
		.click();
	await expect(page).toHaveURL(/\/docs$/);

	const doc = article(page);
	await expect(doc.getByRole("heading", { level: 1, name: "快速开始" })).toBeVisible();
	await expect(doc.getByRole("heading", { level: 2, name: "步骤" })).toBeVisible();
	await expect(doc.getByRole("heading", { level: 3, name: "更多" })).toBeVisible();
	await expect(doc.getByText("当前控制面是")).toHaveText(
		`sfly 节点包里的 @node 函数由测试机上的 sfly Agent 执行。当前控制面是 ${controlPlane.httpUrl}，版本 1.2.3。`,
	);
	await expect(doc.locator("ol > li")).toHaveCount(3);
	await expect(doc.locator("ol ul > li")).toHaveText(["写节点", "写单元测试"]);
	const table = doc.getByRole("table");
	await expect(table.getByRole("columnheader")).toHaveText(["命令", "作用"]);
	await expect(table.getByRole("row", { name: /sfly dev/ })).toContainText("在本机 Agent 上联调");
	await expect(doc.locator("code", { hasText: "@node" })).toBeVisible();
	await expect(doc.getByRole("link", { name: "Python 文档" })).toHaveAttribute(
		"href",
		"https://docs.python.org/3/",
	);

	// 文档目录：当前页高亮，可以切到别的页面。
	const toc = page.getByRole("navigation", { name: "文档目录" });
	await expect(toc.getByRole("link")).toHaveText(["快速开始", "安装 Agent"]);
	await expect(toc.getByRole("link", { name: "快速开始" })).toHaveAttribute("aria-current", "page");

	// 文档之间的链接（`install-agent.md`）在页面里跳到对应的文档页，再链回来。
	await doc.getByRole("link", { name: "安装 Agent" }).click();
	await expect(page).toHaveURL(/\/docs\/install-agent$/);
	const install = page.getByRole("article", { name: "安装 Agent" });
	await expect(install.getByRole("heading", { level: 1 })).toHaveText("安装 Agent");
	await install.getByRole("link", { name: "快速开始" }).click();
	await expect(page).toHaveURL(/\/docs\/quickstart$/);

	// 指向前端页面的链接照常跳转。
	await article(page).getByRole("link", { name: "节点包管理" }).click();
	await expect(page).toHaveURL(/\/packages$/);
});

test("从命令面板进入开发文档", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "控制台", exact: true })).toBeVisible();
	await page.keyboard.press("Control+k");
	const palette = page.getByRole("dialog", { name: "命令面板" });
	await expect(palette.getByRole("combobox", { name: "命令" })).toBeFocused();
	await page.keyboard.type("开发文档");
	await expect(palette.getByRole("option")).toHaveText([/开发文档/]);
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/docs$/);
	await expect(article(page).getByRole("heading", { level: 1 })).toHaveText("快速开始");
});

test("代码块的复制按钮把替换后的命令写入剪贴板", async ({ page, context, controlPlane }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.goto("/docs/quickstart");
	const block = article(page).locator("[data-slot=code-block]").first();
	await block.getByRole("button", { name: "复制" }).click();
	await expect(page.getByText("已复制到剪贴板")).toBeVisible();
	const url = controlPlane.httpUrl;
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		`curl -fsSL ${url}/install.sh | sh -s -- --name agent-1\n` +
			`sfly init demo-checks --server ${url} --version 1.2.3 --with-a-rather-long-flag-to-scroll-horizontally`,
	);
});

test("未知的文档页显示错误，可以回到目录里的页面", async ({ page }) => {
	await page.goto("/docs/no-such-page");
	await expect(page.getByRole("alert")).toContainText("无法加载文档");
	await page
		.getByRole("navigation", { name: "文档目录" })
		.getByRole("link", { name: "安装 Agent" })
		.click();
	await expect(page.getByRole("article", { name: "安装 Agent" })).toBeVisible();
});

test.describe("排版", () => {
	test.use({
		controlPlaneOptions: {
			docsDir: fileURLToPath(new URL("./docs-typography-fixture", import.meta.url)),
		},
	});

	test("标题 22 / 16 / 14 / 13 拉开层级，标题里的代码按标题缩一档、没有底色块；正文最宽 42em、行高 22px，代码块和表格用满宽", async ({
		page,
	}) => {
		await page.goto("/docs/typography");
		const doc = page.getByRole("article", { name: "排版" });
		await expect(doc.getByRole("heading", { level: 1 })).toBeVisible();

		const style = (selector: string, property: string) =>
			doc
				.locator(selector)
				.first()
				.evaluate((el, name) => getComputedStyle(el).getPropertyValue(name), property);
		expect(await style("h1", "font-size")).toBe("22px");
		expect(await style("h2", "font-size")).toBe("16px");
		expect(await style("h3", "font-size")).toBe("14px");
		expect(await style("h4", "font-size")).toBe("13px");
		for (const heading of ["h1", "h2", "h3", "h4"]) {
			expect(await style(heading, "font-weight")).toBe("600");
		}

		expect(await style("h2 code", "font-size")).toBe("14px");
		expect(await style("h2 code", "background-color")).toBe("rgba(0, 0, 0, 0)");
		expect(await style("p code", "font-size")).toBe("12px");
		expect(await style("p code", "background-color")).not.toBe("rgba(0, 0, 0, 0)");

		const paragraph = doc.locator("p").first();
		expect(await style("p", "line-height")).toBe("22px");
		expect(await style("p", "text-wrap-style")).toBe("pretty");
		expect(await style("li", "line-height")).toBe("22px");
		const text = Math.round((await paragraph.boundingBox())?.width ?? 0);
		expect(text).toBeLessThanOrEqual(546);
		expect(
			Math.round((await doc.locator("blockquote").boundingBox())?.width ?? 0),
		).toBeLessThanOrEqual(546);
		const code = Math.round(
			(await doc.locator('[data-slot="code-block"]').boundingBox())?.width ?? 0,
		);
		expect(code).toBeGreaterThan(text + 100);
		await expect(doc.locator('[data-slot="table-container"]')).toHaveCSS("overflow-x", "auto");
	});
});
