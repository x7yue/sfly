import { expect, test } from "./fixtures";

// AI 编程助手快速开始（#61）：读真实的 docs/guide。页面顶部的代码块是给 AI 编程助手的提示词，
// 控制面地址已经填好，复制得到完整的提示词，用户只需在「需求：」后面补上需求。

test("AI 快速开始页顶部的提示词填好了控制面地址，复制得到完整提示词", async ({
	page,
	context,
	controlPlane,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.goto("/docs");
	await page
		.getByRole("navigation", { name: "文档目录" })
		.getByRole("link", { name: "AI 编程助手快速开始" })
		.click();
	await expect(page).toHaveURL(/\/docs\/ai-quickstart$/);

	const doc = page.getByRole("article", { name: "AI 编程助手快速开始" });
	const prompt =
		`先运行 \`curl -s ${controlPlane.httpUrl}/docs/ai-quickstart.md\` 读取 sfly 节点开发指引，` +
		"按指引开发一个 sfly 节点包。\n\n需求：";
	const block = doc.locator("[data-slot=code-block]").first();
	await expect(block).toContainText(`${controlPlane.httpUrl}/docs/ai-quickstart.md`);
	await block.getByRole("button", { name: "复制" }).click();
	await expect(page.getByText("已复制到剪贴板")).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(prompt);
});
