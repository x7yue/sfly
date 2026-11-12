// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import { addMenu, headOf, inspector, nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";
import { openMonitor } from "./monitor-scenario";
import { createFeishuBot, createScenario, triggerRun } from "./support";

// 飞书通知节点（#229，ADR 0020）：画布上添加、选择已登记的机器人（下拉框，也可以引用入口参数）、写文本、
// 打开「@所有人」；机器人没有登记时字段下有警告；运行时由控制面发给飞书，节点立即成功。

const entry = {
	id: "entry",
	kind: "entry",
	position: { x: 0, y: 0 },
	params: [{ name: "env", type: "string", default: "A 环境" }],
};

const scenario = (nodes: Record<string, unknown>[] = []) => ({
	nodes: [entry, ...nodes],
	edges: nodes.map((n, i) => ({
		from: i === 0 ? "entry" : nodes[i - 1]?.id,
		to: n.id,
		kind: "chain",
	})),
	packages: {},
});

test("添加飞书通知节点：选择机器人、写带引用的文本、打开「@所有人」，保存后运行，飞书收到消息，节点成功", async ({
	page,
	controlPlane,
	feishu,
	clock,
}) => {
	await createFeishuBot(controlPlane, "ops", feishu.webhookUrl("ops-token"));
	await createFeishuBot(controlPlane, "dev", feishu.webhookUrl("dev-token"));
	const id = await createScenario(controlPlane, "压测通知", scenario());
	await page.goto(`/orchestrations/${id}`);

	// 焦点在链尾的入口节点上按 Tab：添加节点接在它后面。
	await nodeCard(page, "entry").click();
	await page.keyboard.press("Tab");
	await addMenu(page)
		.getByRole("option", { name: /飞书通知/ })
		.click();
	const card = nodeCard(page, "feishu_notify_1");
	await expect(card).toHaveAttribute("aria-pressed", "true");
	await expect(card).toContainText("飞书通知");
	await expect(card).toContainText("未选择飞书机器人");

	const panel = inspector(page);
	const bot = panel.getByRole("combobox", { name: "飞书机器人" });
	await expect(bot.getByRole("option")).toHaveText(["（选择机器人）", "dev", "ops"]);
	await expect(panel.getByText("节点 feishu_notify_1 没有选择飞书机器人")).toBeVisible();

	await bot.selectOption("ops");
	await expect(panel.getByText("节点 feishu_notify_1 没有选择飞书机器人")).toHaveCount(0);
	await expect(card).toContainText("机器人 = ops");
	await panel.getByRole("combobox", { name: "文本" }).fill("压测开始：${{ params.env }}");
	await panel.getByRole("switch", { name: "@所有人" }).click();

	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const head = await headOf(controlPlane, id);
	expect(head.document.nodes.find((n) => n.id === "feishu_notify_1")).toMatchObject({
		kind: "feishu_notify",
		bot: "ops",
		text: "压测开始：${{ params.env }}",
		at_all: true,
		always: false,
	});

	const runId = await triggerRun(controlPlane, id);
	await expect.poll(() => feishu.requests.length).toBe(1);
	expect(feishu.requests[0]).toMatchObject({
		path: "/open-apis/bot/v2/hook/ops-token",
		json: {
			msg_type: "text",
			content: { text: '压测开始：A 环境<at user_id="all">所有人</at>' },
		},
	});

	// 运行监控页：飞书通知节点成功，运行成功。
	await openMonitor(page, clock, runId);
	await expect(
		page
			.getByRole("region", { name: "链路时间线" })
			.getByRole("button", { name: /^feishu_notify_1 .* 成功$/ }),
	).toBeVisible();
	await expect(page.getByRole("banner").getByTestId("run-status")).toHaveText("成功");
});

test("机器人没有登记时字段下有警告；改选已登记的机器人，或改为引用入口参数", async ({
	page,
	controlPlane,
	feishu,
}) => {
	await createFeishuBot(controlPlane, "ops", feishu.webhookUrl("ops-token"));
	const id = await createScenario(
		controlPlane,
		"压测通知",
		scenario([
			{ id: "notify", kind: "feishu_notify", position: { x: 252, y: 0 }, bot: "ghost", text: "hi" },
		]),
	);
	await page.goto(`/orchestrations/${id}`);
	await nodeCard(page, "notify").click();
	const panel = inspector(page);
	const warning = "节点 notify 选择的飞书机器人「ghost」还没有登记";
	const bot = panel.getByRole("combobox", { name: "飞书机器人" });
	await expect(bot).toHaveValue("ghost");
	await expect(bot.getByRole("option")).toHaveText(["（选择机器人）", "ops", "ghost（未登记）"]);
	await expect(panel.getByText(warning)).toBeVisible();

	await bot.selectOption("ops");
	await expect(panel.getByText(warning)).toHaveCount(0);

	// 改为引用：只能选入口参数，选中后显示引用标签；触发时按实际传入的值检查。
	const list = panel.getByRole("listbox", { name: "可引用的值" });
	await panel.getByRole("button", { name: "在 飞书机器人 中插入引用" }).click();
	await expect(list.getByRole("group")).toHaveText([/^入口参数/]);
	await list.getByRole("option", { name: /params\.env/ }).click();
	const chip = panel.getByRole("group", { name: "飞书机器人" });
	await expect(chip).toHaveText("${{ params.env }}");
	await expect(panel.getByText(/还没有登记/)).toHaveCount(0);

	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const head = await headOf(controlPlane, id);
	expect(head.document.nodes.find((n) => n.id === "notify")).toMatchObject({
		bot: "${{ params.env }}",
	});

	await chip.getByRole("button", { name: "移除 机器人 的引用" }).click();
	await expect(bot).toHaveValue("");
	await expect(panel.getByText("节点 notify 没有选择飞书机器人")).toBeVisible();
});

test("飞书通知节点可以设为 always；节点卡片上有 always 标签", async ({ page, controlPlane }) => {
	const id = await createScenario(
		controlPlane,
		"压测通知",
		scenario([{ id: "notify", kind: "feishu_notify", position: { x: 252, y: 0 }, text: "收尾" }]),
	);
	await page.goto(`/orchestrations/${id}`);
	await nodeCard(page, "notify").click();
	await inspector(page).getByRole("tab", { name: "执行" }).click();
	await inspector(page).getByRole("switch", { name: "always" }).click();
	await expect(nodeCard(page, "notify")).toContainText("always");
	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	expect(
		(await headOf(controlPlane, id)).document.nodes.find((n) => n.id === "notify"),
	).toMatchObject({ always: true });
});
