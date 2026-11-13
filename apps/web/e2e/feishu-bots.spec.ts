import { expect, test } from "./fixtures";
import { createFeishuBot, createScenario, triggerRun } from "./support";

// 飞书机器人管理页（ADR 0020）：登记、Webhook 地址打码、替换、删除、发送测试消息。
// 机器人的 Webhook 地址指向假的飞书服务（fixtures 的 feishu），它记录收到的请求、按测试指定的状态码和 code 应答。
// 最近一次投递和积压条数（#230）：页面每 5 秒重新查询一次，等它们出现用较长的等待上限。

const SECRET = "tok-4f9a8c71-e2b0-43d6-9a55-0a1b2c3d4e5f";

// 表格各列的位置：名称、Webhook 地址、最近投递、积压、登记时间、测试结果、操作。
const CELL = { webhook: 1, lastDelivery: 2, backlog: 3, testResult: 5 } as const;

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
	const masked = await bot.getByRole("cell").nth(CELL.webhook).textContent();
	expect(masked).toMatch(/^http:\/\/127\.0.*4e5f$/);
	expect(masked).not.toContain(SECRET);
	await expect(page.locator("body")).not.toContainText(SECRET);
	await expect(bot.getByRole("cell").nth(CELL.testResult)).toHaveText("未测试");
	// 登记后页面上的操作：header 里有「登记机器人」，列表在表格里。
	await expect(page.getByRole("heading", { name: "飞书机器人", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "登记机器人" })).toBeVisible();
});

test("登记：输入过程中不报错，离开输入框才提示；提交按钮一直可点，空着提交时错误写在字段下并把焦点放回去；名称重复的原因写在弹窗里、不发通知", async ({
	page,
	controlPlane,
	feishu,
}) => {
	await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("a"));
	await page.goto("/feishu-bots");
	await page.getByRole("button", { name: "登记机器人" }).click();
	const dialog = page.getByRole("dialog", { name: "登记飞书机器人" });
	const submit = dialog.getByRole("button", { name: "登记", exact: true });
	const name = dialog.getByLabel("名称");
	const webhook = dialog.getByLabel("Webhook 地址");
	await expect(submit).toBeEnabled();
	await expect(webhook).toHaveAttribute("type", "url");

	await name.fill("压测群");
	await webhook.pressSequentially("h");
	await expect(webhook).not.toHaveAttribute("aria-invalid", "true");
	await expect(dialog).not.toContainText("必须是 http 或 https 地址");
	await webhook.pressSequentially("ttp://x");
	await expect(dialog).not.toContainText("必须是 http 或 https 地址");

	await webhook.fill("ftp://feishu.example/hook/1");
	await name.focus();
	const problem = dialog.getByText("Webhook 地址必须是 http 或 https 地址");
	await expect(problem).toBeVisible();
	await expect(webhook).toHaveAttribute("aria-invalid", "true");
	await expect(webhook).toHaveAttribute(
		"aria-describedby",
		(await problem.getAttribute("id")) ?? "",
	);
	await expect(submit).toBeEnabled();

	await webhook.fill(feishu.webhookUrl("b"));
	await expect(problem).toBeHidden();
	await expect(webhook).not.toHaveAttribute("aria-invalid", "true");
	await webhook.fill("http://feishu.example/hook 1");
	await expect(dialog).toContainText("Webhook 地址不能含空白字符");

	await name.fill("");
	await webhook.fill("");
	await submit.click();
	await expect(dialog.getByText("填写机器人名称")).toBeVisible();
	await expect(name).toBeFocused();
	await name.fill("压测群");
	await submit.click();
	await expect(dialog.getByText("填写 Webhook 地址")).toBeVisible();
	await expect(webhook).toBeFocused();

	await webhook.fill(feishu.webhookUrl("b"));
	await submit.click();
	await expect(dialog.getByRole("alert")).toHaveText("飞书机器人「压测群」已存在，名称不能重复");
	await expect(dialog).toBeVisible();
	await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);

	await name.fill("告警群");
	await submit.click();
	await expect(dialog).toBeHidden();
	await expect(page.getByRole("table", { name: "飞书机器人列表" }).getByRole("row")).toHaveCount(3);
});

test("登记之后焦点落到新的那一行；删除之后焦点落到相邻的一行，最后一行删掉后回到页面标题", async ({
	page,
	feishu,
}) => {
	await page.goto("/feishu-bots");
	const register = async (button: string, bot: string, hook: string) => {
		await page.getByRole("button", { name: button }).click();
		const dialog = page.getByRole("dialog", { name: "登记飞书机器人" });
		await dialog.getByLabel("名称").fill(bot);
		await dialog.getByLabel("Webhook 地址").fill(feishu.webhookUrl(hook));
		await dialog.getByRole("button", { name: "登记", exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect(row(page, bot).getByRole("button", { name: "发送测试消息" })).toBeFocused();
	};
	await register("登记机器人", "压测群", "a");
	await register("登记机器人", "告警群", "b");

	await row(page, "压测群").getByRole("button", { name: "删除" }).click();
	await page
		.getByRole("dialog", { name: "删除飞书机器人「压测群」？" })
		.getByRole("button", { name: "删除", exact: true })
		.click();
	await expect(row(page, "压测群")).toHaveCount(0);
	await expect(row(page, "告警群").getByRole("button", { name: "发送测试消息" })).toBeFocused();

	await row(page, "告警群").getByRole("button", { name: "删除" }).click();
	await page
		.getByRole("dialog", { name: "删除飞书机器人「告警群」？" })
		.getByRole("button", { name: "删除", exact: true })
		.click();
	await expect(page.getByRole("heading", { name: "飞书机器人", level: 1 })).toBeFocused();
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
	await expect(bot.getByRole("cell").nth(CELL.testResult)).toHaveText("测试消息已送达");
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
	const result = row(page, "压测群").getByRole("cell").nth(CELL.testResult);
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
	const result = row(page, "压测群").getByRole("cell").nth(CELL.testResult);
	await expect(result).toContainText("无法连接 127.0.0.1");
	await expect(result).toContainText("防火墙");
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
	await expect(bot.getByRole("cell").nth(CELL.testResult)).toHaveText("测试消息已送达");

	await bot.getByRole("button", { name: "替换地址" }).click();
	const dialog = page.getByRole("dialog", { name: "替换「压测群」的 Webhook 地址" });
	await expect(dialog.getByLabel("新的 Webhook 地址")).toHaveValue("");
	await expect(dialog).not.toContainText("old-token");
	await dialog.getByLabel("新的 Webhook 地址").fill(feishu.webhookUrl("new-token-5678"));
	await dialog.getByRole("button", { name: "替换" }).click();
	await expect(dialog).toBeHidden();

	// 旧的测试结果不再适用。
	await expect(bot.getByRole("cell").nth(CELL.testResult)).toHaveText("未测试");
	await bot.getByRole("button", { name: "发送测试消息" }).click();
	await expect(bot.getByRole("cell").nth(CELL.testResult)).toHaveText("测试消息已送达");
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

/** 一个入口 + 一个飞书通知节点的场景：运行时向这个机器人发一条消息。 */
const notifyScenario = (bot: string) => ({
	nodes: [
		{ id: "entry", kind: "entry", params: [] },
		{ id: "notify", kind: "feishu_notify", bot, text: "压测开始" },
	],
	edges: [{ from: "entry", to: "notify", kind: "chain" }],
	packages: {},
});
const POLL_WAIT = { timeout: 15_000 };

test("最近投递和积压：登记之后尚无投递；消息送达后显示已送达和时间，积压为 0", async ({
	page,
	controlPlane,
	feishu,
}) => {
	await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("a"));
	await page.goto("/feishu-bots");
	const bot = row(page, "压测群");
	await expect(bot.getByRole("cell").nth(CELL.lastDelivery)).toHaveText("尚无投递");
	await expect(bot.getByRole("cell").nth(CELL.backlog)).toHaveText("0");

	const scenario = await createScenario(controlPlane, "通知", notifyScenario("压测群"));
	await triggerRun(controlPlane, scenario);

	const last = bot.getByRole("cell").nth(CELL.lastDelivery);
	await expect(last).toContainText("已送达", POLL_WAIT);
	await expect(last).toContainText("01-01 08:00");
	await expect(bot.getByRole("cell").nth(CELL.backlog)).toHaveText("0");
	expect(feishu.requests).toHaveLength(1);
});

test("可重试的失败：最近投递是失败的原因，积压是还在排队的条数；飞书恢复后重试送达", async ({
	page,
	controlPlane,
	feishu,
	clock,
}) => {
	feishu.reply({ status: 503 });
	await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("a"));
	const scenario = await createScenario(controlPlane, "通知", notifyScenario("压测群"));
	await triggerRun(controlPlane, scenario);
	await page.goto("/feishu-bots");
	const bot = row(page, "压测群");
	const last = bot.getByRole("cell").nth(CELL.lastDelivery);
	const backlog = bot.getByRole("cell").nth(CELL.backlog);

	await expect(last).toContainText("投递失败", POLL_WAIT);
	await expect(last).toContainText("飞书服务暂时不可用（HTTP 503）");
	await expect(last).toContainText("下一步：");
	await expect(backlog).toHaveText("1 条");

	// 控制面时间过了退避的 1 秒：重试，这次送达。
	clock.advance(1000);
	await expect(last).toContainText("已送达", POLL_WAIT);
	await expect(backlog).toHaveText("0");
	expect(feishu.requests).toHaveLength(2);
});

test("不可重试的失败：最近投递写着中文原因和下一步，不再排队，页面上没有 Webhook 地址的令牌", async ({
	page,
	controlPlane,
	feishu,
}) => {
	feishu.reply({ code: 19024, msg: `Key Words Not Found ${feishu.webhookUrl(SECRET)}` });
	await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl(SECRET));
	const scenario = await createScenario(controlPlane, "通知", notifyScenario("压测群"));
	await triggerRun(controlPlane, scenario);
	await page.goto("/feishu-bots");
	const bot = row(page, "压测群");
	const last = bot.getByRole("cell").nth(CELL.lastDelivery);

	await expect(last).toContainText("投递失败", POLL_WAIT);
	await expect(last).toContainText("没有飞书群里这个机器人设置的关键词");
	await expect(last).toContainText("下一步：");
	await expect(bot.getByRole("cell").nth(CELL.backlog)).toHaveText("0");
	await expect(page.locator("body")).not.toContainText(SECRET);
});

test("删除机器人：它还在排队的消息被丢弃，积压清零；同名重新登记后没有旧的记录", async ({
	page,
	controlPlane,
	feishu,
}) => {
	feishu.replyAlways({ status: 503 });
	await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("a"));
	const scenario = await createScenario(controlPlane, "通知", notifyScenario("压测群"));
	await triggerRun(controlPlane, scenario);
	await page.goto("/feishu-bots");
	await expect(row(page, "压测群").getByRole("cell").nth(CELL.backlog)).toHaveText(
		"1 条",
		POLL_WAIT,
	);

	await row(page, "压测群").getByRole("button", { name: "删除" }).click();
	await page
		.getByRole("dialog", { name: "删除飞书机器人「压测群」？" })
		.getByRole("button", { name: "删除", exact: true })
		.click();
	await expect(row(page, "压测群")).toHaveCount(0);

	await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("a"));
	await page.reload();
	const bot = row(page, "压测群");
	await expect(bot.getByRole("cell").nth(CELL.lastDelivery)).toHaveText("尚无投递");
	await expect(bot.getByRole("cell").nth(CELL.backlog)).toHaveText("0");
});
