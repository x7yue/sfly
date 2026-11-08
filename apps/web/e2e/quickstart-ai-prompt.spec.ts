import { expect, test } from "./fixtures";

// 快速开始页「用 AI 编程助手开始」（#61）：读真实的 docs/guide。这一节的代码块是给人复制的提示词，
// 它让 AI 编程助手自己从 llms.txt 读取文档、按「自己手动开始」的步骤做；控制面地址已经填好，
// 复制得到完整的提示词，用户只需在「需求：」后面补上需求。没有单独给 AI 看的页面。

test("快速开始里的 AI 提示词填好了 llms.txt 地址，复制得到完整提示词；目录里没有单独的 AI 页面", async ({
	page,
	context,
	controlPlane,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.goto("/docs");
	const doc = page.getByRole("article", { name: "快速开始" });
	await expect(doc.getByRole("heading", { level: 2, name: "用 AI 编程助手开始" })).toBeVisible();
	await expect(doc.getByRole("heading", { level: 2, name: "自己手动开始" })).toBeVisible();
	await expect(
		page.getByRole("navigation", { name: "文档目录" }).getByRole("link", { name: /AI/ }),
	).toHaveCount(0);

	const url = controlPlane.httpUrl;
	const prompt =
		`请帮我开发一个 sfly 节点包。sfly 的文档索引在 ${url}/llms.txt：先用 curl 读取它，再读其中的「快速开始」页，` +
		"按「自己手动开始」的步骤逐页读取原文并照着做，每一步达到「完成」再做下一步。" +
		"项目创建后，以项目里的 .agents/skills/sfly-node-dev/SKILL.md 为准。\n\n" +
		"需要注册令牌，或者需要我在控制面页面上操作（例如联调时在场景里运行）时，停下来告诉我；令牌不要写进项目文件。" +
		"发布前把包名、版本和改动摘要给我，等我同意再发布。\n\n需求：";
	const block = doc.locator("[data-slot=code-block]").first();
	await expect(block).toContainText(`${url}/llms.txt`);
	await block.getByRole("button", { name: "复制" }).click();
	await expect(page.getByText("已复制到剪贴板")).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(prompt);
});
