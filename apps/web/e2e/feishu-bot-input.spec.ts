// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import { headOf, inspector, nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";
import { createFeishuBot, createScenario, publishPackage } from "./support";

// 「飞书机器人」类型的输入（#233）：节点开发者用 sfly.FeishuBot 标注的参数在检查器里是飞书机器人下拉框，
// 列出已登记的机器人；也可以用「插入引用」改为引用入口参数。选的不是已登记的机器人时字段下有警告。
// 删除机器人之前的引用列表包含这种参数的常量值。

/** alerts 的节点类型：alert 的 bot 是「飞书机器人」类型（sfly build 的标记）。 */
const alertNodes = [
	{
		name: "alert",
		title: "告警",
		entry: "alerts:alert",
		inputs: {
			type: "object",
			properties: { bot: { type: "string", "x-sfly-type": "feishu_bot" } },
			required: ["bot"],
		},
		outputs: { type: "object", properties: {} },
	},
];

const alertDocument = (bot: string) => ({
	default_agent: "runner",
	nodes: [
		{
			id: "entry",
			kind: "entry",
			position: { x: 0, y: 0 },
			params: [{ name: "channel", type: "string" }],
		},
		{
			id: "alert",
			kind: "package",
			package: "alerts",
			node: "alert",
			position: { x: 252, y: 0 },
			inputs: { bot },
		},
	],
	edges: [{ from: "entry", to: "alert", kind: "chain" }],
	packages: { alerts: "1.0.0" },
});

test("检查器：飞书机器人类型的参数是已登记机器人的下拉框，未登记时警告，可以改为引用入口参数", async ({
	page,
	controlPlane,
	feishu,
	connectAgent,
}) => {
	await connectAgent({ name: "runner" });
	await createFeishuBot(controlPlane, "ops", feishu.webhookUrl("ops-token"));
	await createFeishuBot(controlPlane, "dev", feishu.webhookUrl("dev-token"));
	await publishPackage(controlPlane, { name: "alerts", version: "1.0.0", nodes: alertNodes });
	const id = await createScenario(controlPlane, "告警", alertDocument("ghost"));

	await page.goto(`/orchestrations/${id}`);
	await nodeCard(page, "alert").click();
	const panel = inspector(page);
	const select = panel.getByRole("combobox", { name: "输入 bot" });
	const warning = "节点 alert 的输入 bot 选择的飞书机器人「ghost」还没有登记";

	// 已登记的机器人；当前值不是已登记的机器人时标出「未登记」，字段下有警告，类型显示为「飞书机器人」。
	await expect(select).toHaveValue("ghost");
	await expect(select.getByRole("option")).toHaveText([
		"（必填）",
		"dev",
		"ops",
		"ghost（未登记）",
	]);
	await expect(panel.getByText(warning)).toBeVisible();
	await expect(panel.getByText("飞书机器人", { exact: true })).toBeVisible();

	// 选一个已登记的机器人：警告消失。
	await select.selectOption("ops");
	await expect(panel.getByText(warning)).toHaveCount(0);

	// 改为引用：只能选入口参数，选中后显示引用标签；点 × 回到下拉框。
	const list = panel.getByRole("listbox", { name: "可引用的值" });
	await panel.getByRole("button", { name: "在 bot 中插入引用" }).click();
	await expect(list.getByRole("group")).toHaveText([/^入口参数/]);
	await list.getByRole("option", { name: /params\.channel/ }).click();
	const chip = panel.getByRole("group", { name: "输入 bot" });
	await expect(chip).toHaveText("${{ params.channel }}");

	await page.keyboard.press("Control+s");
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const head = await headOf(controlPlane, id);
	expect(head.document.nodes.find((n) => n.id === "alert")?.inputs).toEqual({
		bot: "${{ params.channel }}",
	});

	await chip.getByRole("button", { name: "移除 bot 的引用" }).click();
	await expect(select).toBeFocused();
	await expect(select).toHaveValue("");
});

test("删除飞书机器人之前列出的引用包含飞书机器人类型的参数的常量值，指出节点和参数", async ({
	page,
	controlPlane,
	feishu,
}) => {
	await createFeishuBot(controlPlane, "ops", feishu.webhookUrl("ops-token"));
	await publishPackage(controlPlane, { name: "alerts", version: "1.0.0", nodes: alertNodes });
	const id = await createScenario(controlPlane, "订单压测", alertDocument("ops"));

	await page.goto("/feishu-bots");
	await page
		.getByRole("table", { name: "飞书机器人列表" })
		.getByRole("row", { name: /^ops/ })
		.getByRole("button", { name: "删除" })
		.click();
	const dialog = page.getByRole("dialog", { name: "删除飞书机器人「ops」？" });
	const used = dialog.getByRole("list", { name: "引用这个机器人的场景" });
	await expect(used.getByRole("link", { name: "订单压测" })).toHaveAttribute(
		"href",
		`/orchestrations/${id}`,
	);
	await expect(used).toContainText("节点 alert 的输入 bot");
});
