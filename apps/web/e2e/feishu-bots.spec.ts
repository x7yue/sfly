import { expect, test } from "./fixtures";
import { createFeishuBot, createScenario } from "./support";

// 飞书机器人管理页（ADR 0020）：登记、Webhook 地址打码、替换、删除、发送测试消息。
// 机器人的 Webhook 地址指向假的飞书服务（fixtures 的 feishu），它记录收到的请求、按测试指定的状态码和 code 应答。

const SECRET = "tok-4f9a8c71-e2b0-43d6-9a55-0a1b2c3d4e5f";

const row = (page: import("@playwright/test").Page, name: string) =>
	page
		.getByRole("table", { name: "飞书机器人列表" })
		.getByRole("row", { name: new RegExp(`^${name}`) });

test("还没有机器人时显示空状态和登记入口；侧边栏、快捷键 G F 都能到这个页面", async ({ page }) => {
	await page.goto("/");
	await page
		.getByRole("navigation", { name: "主导航" })
		.getByRole("link", { name: "飞书机器人" })
		.click();
	await expect(page).toHaveURL(/\/feishu-bots$/);
	await expect(page.getByRole("heading", { name: "飞书机器人", exact: true })).toBeVisible();
	const empty = page.getByRole("region", { name: "还没有登记飞书机器人" });
	await expect(empty).toContainText("Agent 不需要访问外网");
	await expect(empty).toContainText("不支持签名校验");

	await page.goto("/");
	await page.keyboard.press("g");
	await page.keyboard.press("f");
	await expect(page).toHaveURL(/\/feishu-bots$/);
});

test("登记：填名称和 Webhook 地址，列表里只显示打码的地址", async ({ page, feishu }) => {
	await page.goto("/feishu-bots");
	await page.getByRole("button", { name: "登记机器人" }).click();
	const dialog = page.getByRole("dialog", { name: "登记飞书机器人" });
	await expect(dialog.getByLabel("名称")).toBeFocused();
	await dialog.getByLabel("名称").fill("压测群");
	await dialog.getByLabel("Webhook 地址").fill(feishu.webhookUrl(SECRET));
	await dialog.getByRole("button", { name: "登记" }).click();

	await expect(dialog).toBeHidden();
	const bot = row(page, "压测群");
	await expect(bot).toBeVisible();
	const masked = await bot.getByRole("cell").nth(1).textContent();
	expect(masked).toMatch(/^http:\/\/127\.0.*4e5f$/);
	expect(masked).not.toContain(SECRET);
	await expect(page.locator("body")).not.toContainText(SECRET);
	await expect(bot.getByRole("cell").nth(3)).toHaveText("未测试");
	// 登记后页面上的操作：header 里有「登记机器人」，列表在表格里。
	await expect(page.getByRole("heading", { name: "飞书机器人", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "登记机器人" })).toBeVisible();
});

test("登记：名称重复时弹窗不关闭，显示中文错误；地址不是 http 或 https 时不能提交", async ({
	page,
	controlPlane,
	feishu,
}) => {
	await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("a"));
	await page.goto("/feishu-bots");
	await page.getByRole("button", { name: "登记机器人" }).click();
	const dialog = page.getByRole("dialog", { name: "登记飞书机器人" });
	const submit = dialog.getByRole("button", { name: "登记", exact: true });

	await dialog.getByLabel("名称").fill("压测群");
	await dialog.getByLabel("Webhook 地址").fill("ftp://feishu.example/hook/1");
	await expect(dialog).toContainText("Webhook 地址必须是 http 或 https 地址");
	await expect(submit).toBeDisabled();

	await dialog.getByLabel("Webhook 地址").fill(feishu.webhookUrl("b"));
	await expect(submit).toBeEnabled();
	await submit.click();
	await expect(dialog.getByRole("alert")).toHaveText("飞书机器人「压测群」已存在，名称不能重复");
	await expect(dialog).toBeVisible();

	await dialog.getByLabel("名称").fill("告警群");
	await submit.click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole("table", { name: "飞书机器人列表" }).getByRole("row")).toHaveCount(3);
});

test("发送测试消息：把一条固定文本发到 Webhook 地址里的主机，结果立即显示在这一行", async ({
	page,
	controlPlane,
	feishu,
}) => {
	await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("hook-1"));
	await page.goto("/feishu-bots");
	const bot = row(page, "压测群");

	await bot.getByRole("button", { name: "发送测试消息" }).click();
	await expect(bot.getByRole("cell").nth(3)).toHaveText("测试消息已送达");
	expect(feishu.requests).toHaveLength(1);
	expect(feishu.requests[0]?.path).toBe("/open-apis/bot/v2/hook/hook-1");
	expect(feishu.requests[0]?.json).toMatchObject({
		msg_type: "text",
		content: { text: expect.stringContaining("压测群") },
	});
});

test("发送测试消息失败：飞书的错误码翻译成中文原因和下一步，错误信息里的地址打码", async ({
	page,
	controlPlane,
	feishu,
}) => {
	await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl(SECRET));
	await page.goto("/feishu-bots");
	const result = row(page, "压测群").getByRole("cell").nth(3);
	const send = row(page, "压测群").getByRole("button", { name: "发送测试消息" });

	for (const [reply, expected] of [
		[
			{ code: 19021 },
			[
				"测试失败",
				"sfly 不支持签名校验",
				"下一步：",
				"改用「自定义关键词」或「IP 白名单」",
				"飞书错误码 19021",
			],
		],
		[{ code: 19022 }, ["控制面的出口 IP 不在", "IP 白名单", "飞书错误码 19022"]],
		[{ code: 19024 }, ["没有飞书群里这个机器人设置的关键词", "飞书错误码 19024"]],
		[{ status: 400, code: 9499 }, ["请求格式不对", "飞书错误码 9499 · HTTP 400"]],
		[
			{ code: 12345, msg: "something odd" },
			["飞书返回了错误码 12345：something odd", "自定义机器人使用指南"],
		],
		// 飞书的错误说明里带着完整地址时，页面上也是打码的。
		[{ code: 777, msg: `bad hook ${feishu.webhookUrl(SECRET)}` }, ["飞书返回了错误码 777"]],
	] as const) {
		feishu.reply(reply);
		await send.click();
		for (const text of expected) await expect(result).toContainText(text);
		await expect(result).not.toContainText(SECRET);
	}
});

test("发送测试消息失败：连不上主机时写出主机和下一步", async ({ page, controlPlane, feishu }) => {
	await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("closed"));
	await feishu.close();
	await page.goto("/feishu-bots");
	await row(page, "压测群").getByRole("button", { name: "发送测试消息" }).click();
	const result = row(page, "压测群").getByRole("cell").nth(3);
	await expect(result).toContainText("无法连接 127.0.0.1");
	await expect(result).toContainText("HTTPS_PROXY");
	await expect(result).not.toContainText("closed");
});

test("替换地址：弹窗里看不到原来的地址，只能整个替换；之后的测试消息发往新地址", async ({
	page,
	controlPlane,
	feishu,
}) => {
	await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("old-token-1234"));
	await page.goto("/feishu-bots");
	const bot = row(page, "压测群");
	await bot.getByRole("button", { name: "发送测试消息" }).click();
	await expect(bot.getByRole("cell").nth(3)).toHaveText("测试消息已送达");

	await bot.getByRole("button", { name: "替换地址" }).click();
	const dialog = page.getByRole("dialog", { name: "替换「压测群」的 Webhook 地址" });
	await expect(dialog.getByLabel("新的 Webhook 地址")).toHaveValue("");
	await expect(dialog).not.toContainText("old-token");
	await dialog.getByLabel("新的 Webhook 地址").fill(feishu.webhookUrl("new-token-5678"));
	await dialog.getByRole("button", { name: "替换" }).click();
	await expect(dialog).toBeHidden();

	// 旧的测试结果不再适用。
	await expect(bot.getByRole("cell").nth(3)).toHaveText("未测试");
	await bot.getByRole("button", { name: "发送测试消息" }).click();
	await expect(bot.getByRole("cell").nth(3)).toHaveText("测试消息已送达");
	expect(feishu.requests.map((r) => r.path)).toEqual([
		"/open-apis/bot/v2/hook/old-token-1234",
		"/open-apis/bot/v2/hook/new-token-5678",
	]);
	await expect(page.locator("body")).not.toContainText("new-token");
});

test("删除：确认后从列表里消失；取消则保留", async ({ page, controlPlane, feishu }) => {
	await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("a"));
	await createFeishuBot(controlPlane, "告警群", feishu.webhookUrl("b"));
	await page.goto("/feishu-bots");

	await row(page, "压测群").getByRole("button", { name: "删除" }).click();
	const dialog = page.getByRole("dialog", { name: "删除飞书机器人「压测群」？" });
	await dialog.getByRole("button", { name: "取消" }).click();
	await expect(dialog).toBeHidden();
	await expect(row(page, "压测群")).toBeVisible();

	await row(page, "压测群").getByRole("button", { name: "删除" }).click();
	await dialog.getByRole("button", { name: "删除", exact: true }).click();
	await expect(row(page, "压测群")).toHaveCount(0);
	await expect(row(page, "告警群")).toBeVisible();
});

test("删除前列出引用这个机器人的场景：每个场景可以点开，引用它的节点也列出；删除不受影响", async ({
	page,
	controlPlane,
	feishu,
}) => {
	await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("a"));
	await createFeishuBot(controlPlane, "告警群", feishu.webhookUrl("b"));
	const notify = (id: string, bot: string) => ({ id, kind: "feishu_notify", bot, text: id });
	const scenario = await createScenario(controlPlane, "订单压测", {
		nodes: [
			{ id: "entry", kind: "entry", params: [] },
			notify("start", "压测群"),
			notify("end", "压测群"),
		],
		edges: [
			{ from: "entry", to: "start", kind: "chain" },
			{ from: "start", to: "end", kind: "chain" },
		],
		packages: {},
	});
	await page.goto("/feishu-bots");

	// 没有场景引用的机器人：对话框里说明没有引用。
	await row(page, "告警群").getByRole("button", { name: "删除" }).click();
	const unused = page.getByRole("dialog", { name: "删除飞书机器人「告警群」？" });
	await expect(unused).toContainText("没有场景引用这个机器人");
	await unused.getByRole("button", { name: "取消" }).click();

	await row(page, "压测群").getByRole("button", { name: "删除" }).click();
	const dialog = page.getByRole("dialog", { name: "删除飞书机器人「压测群」？" });
	const used = dialog.getByRole("list", { name: "引用这个机器人的场景" });
	await expect(used.getByRole("listitem")).toHaveCount(1);
	await expect(used.getByRole("link", { name: "订单压测" })).toHaveAttribute(
		"href",
		`/orchestrations/${scenario}`,
	);
	await expect(used).toContainText("飞书通知节点 start、飞书通知节点 end");
	await expect(dialog).toContainText("删除后这些节点发不出消息");

	await dialog.getByRole("button", { name: "删除", exact: true }).click();
	await expect(row(page, "压测群")).toHaveCount(0);
});
