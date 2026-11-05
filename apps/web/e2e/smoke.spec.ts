import { expect, test } from "./fixtures";

test("直接打开前端路由（刷新页面）时由控制面回退到入口页", async ({ page, connectAgent }) => {
	await connectAgent({ name: "agent-b", slots: 1 });

	await page.goto("/agents");

	await expect(page.getByRole("heading", { name: "Agent 管理" })).toBeVisible();
	await expect(page.getByRole("row", { name: /agent-b/ })).toContainText("在线");
});
