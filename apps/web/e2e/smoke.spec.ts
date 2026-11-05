import { expect, test } from "./fixtures";

test("打开应用，看到已连接的 Agent", async ({ page, connectAgent }) => {
	await connectAgent({
		name: "agent-a",
		agentVersion: "1.2.3",
		os: "linux",
		arch: "x86_64",
		slots: 2,
	});

	await page.goto("/");
	await page.getByRole("navigation").getByRole("link", { name: "Agent" }).click();

	await expect(page).toHaveURL(/\/agents$/);
	const row = page.getByRole("row", { name: /agent-a/ });
	await expect(row).toContainText("在线");
	await expect(row).toContainText("1.2.3");
	await expect(row).toContainText("linux/x86_64");
});

test("直接打开前端路由（刷新页面）时由控制面回退到入口页", async ({ page, connectAgent }) => {
	await connectAgent({ name: "agent-b", slots: 1 });

	await page.goto("/agents");

	await expect(page.getByRole("heading", { name: "Agent" })).toBeVisible();
	await expect(page.getByRole("row", { name: /agent-b/ })).toContainText("在线");
});
