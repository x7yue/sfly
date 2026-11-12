import type { Page } from "@playwright/test";
import { type E2eFixtures, expect, test } from "./fixtures";
import {
	createFeishuBot,
	createScenario,
	publishPackage,
	scenarioUsing,
	setRunNotification,
} from "./support";

// 运行通知（#232，ADR 0020）：场景的「更多」菜单里配置（四项设置，不属于场景版本）、复制场景时一并复制、
// 机器人被删除时给出提示；运行结束时由控制面发卡片，运行抽屉里显示一行状态。

const settingsOf = async (
	cp: { fetch(path: string): Promise<Response> },
	id: string,
): Promise<unknown> =>
	((await (await cp.fetch(`/orchestrations/${id}`)).json()) as { run_notification: unknown })
		.run_notification;

test("在场景的更多菜单里配置运行通知：不产生新版本，复制场景时一并复制，机器人被删除后有提示", async ({
	page,
	controlPlane,
	feishu,
}) => {
	await publishPackage(controlPlane);
	await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("a"));
	await createFeishuBot(controlPlane, "告警群", feishu.webhookUrl("b"));
	const id = await createScenario(controlPlane, "订单压测", scenarioUsing("agent-a"));
	await page.goto("/orchestrations");

	const card = page.getByRole("article", { name: "订单压测" });
	const more = card.getByRole("button", { name: "更多操作" });
	await more.click();
	await page.getByRole("menuitem", { name: "运行通知…" }).click();
	const dialog = page.getByRole("dialog", { name: "运行通知" });
	// 默认关闭：没有选机器人，仅失败时触发。
	const bot = dialog.getByRole("combobox", { name: "飞书机器人" });
	await expect(bot).toHaveValue("");
	await expect(bot.getByRole("option")).toHaveText(["（不发送运行通知）", "压测群", "告警群"]);
	await expect(dialog.getByRole("combobox", { name: "触发条件" })).toHaveValue("failed");
	await expect(dialog.getByLabel("卡片标题")).toHaveAttribute("placeholder", "订单压测");

	await bot.selectOption("压测群");
	await dialog.getByRole("combobox", { name: "触发条件" }).selectOption("失败和取消");
	await dialog.getByLabel("卡片标题").fill("【订单压测-A 环境】");
	await dialog.getByLabel("附加说明").fill("负责人 <at id=ou_1></at>");
	await dialog.getByRole("button", { name: "保存" }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText("已保存运行通知")).toBeVisible();
	await expect(more).toBeFocused();

	// 立即生效，不产生新版本。
	const saved = {
		bot: "压测群",
		trigger: "failed_or_cancelled",
		title: "【订单压测-A 环境】",
		note: "负责人 <at id=ou_1></at>",
	};
	expect(await settingsOf(controlPlane, id)).toEqual(saved);
	await expect(card).toContainText("v1");

	// 再打开：显示保存的设置。
	await more.click();
	await page.getByRole("menuitem", { name: "运行通知…" }).click();
	await expect(dialog.getByRole("combobox", { name: "飞书机器人" })).toHaveValue("压测群");
	await expect(dialog.getByRole("combobox", { name: "触发条件" })).toHaveValue(
		"failed_or_cancelled",
	);
	await expect(dialog.getByLabel("卡片标题")).toHaveValue("【订单压测-A 环境】");
	await expect(dialog.getByLabel("附加说明")).toHaveValue("负责人 <at id=ou_1></at>");
	await dialog.getByRole("button", { name: "取消" }).click();
	await expect(dialog).toBeHidden();

	// 复制场景：运行通知的设置一起复制。
	await more.click();
	await page.getByRole("menuitem", { name: "复制场景…" }).click();
	const copy = page.getByRole("dialog", { name: "复制场景" });
	await copy.getByLabel("名称").fill("B 环境压测");
	await copy.getByRole("button", { name: "复制" }).click();
	const copied = page.getByRole("article", { name: "B 环境压测" });
	await expect(copied).toBeVisible();
	await copied.getByRole("button", { name: "更多操作" }).click();
	await page.getByRole("menuitem", { name: "运行通知…" }).click();
	await expect(dialog.getByRole("combobox", { name: "飞书机器人" })).toHaveValue("压测群");
	await expect(dialog.getByLabel("卡片标题")).toHaveValue("【订单压测-A 环境】");
	await dialog.getByRole("button", { name: "取消" }).click();

	// 机器人被删除：设置原样保留，选择框标出未登记，并提示运行结束时不会发送。
	const removed = await controlPlane.fetch("/feishu-bots/%E5%8E%8B%E6%B5%8B%E7%BE%A4", {
		method: "DELETE",
		headers: { "x-sfly-nickname": "tester" },
	});
	expect(removed.status).toBe(204);
	await more.click();
	await page.getByRole("menuitem", { name: "运行通知…" }).click();
	await expect(dialog.getByRole("combobox", { name: "飞书机器人" })).toHaveValue("压测群");
	await expect(dialog.getByRole("combobox", { name: "飞书机器人" })).toContainText(
		"压测群（未登记）",
	);
	await expect(dialog.getByRole("alert")).toContainText("「压测群」已被删除");
	await expect(dialog.getByRole("alert")).toContainText("未发送");

	// 换成别的机器人：提示消失；机器人选「不发送」即关闭。
	await dialog.getByRole("combobox", { name: "飞书机器人" }).selectOption("告警群");
	await expect(dialog.getByRole("alert")).toHaveCount(0);
	await dialog.getByRole("combobox", { name: "飞书机器人" }).selectOption("");
	await dialog.getByRole("button", { name: "保存" }).click();
	await expect(dialog).toBeHidden();
	expect(await settingsOf(controlPlane, id)).toEqual({ ...saved, bot: null });
});

test("删除机器人前的引用列表里有运行通知的设置", async ({ page, controlPlane, feishu }) => {
	await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("a"));
	const scenario = await createScenario(controlPlane, "订单压测");
	await setRunNotification(controlPlane, scenario, { bot: "压测群" });
	await page.goto("/feishu-bots");

	await page
		.getByRole("row", { name: /压测群/ })
		.getByRole("button", { name: "删除" })
		.click();
	const dialog = page.getByRole("dialog", { name: "删除飞书机器人「压测群」？" });
	const used = dialog.getByRole("list", { name: "引用这个机器人的场景" });
	await expect(used.getByRole("link", { name: "订单压测" })).toHaveAttribute(
		"href",
		`/orchestrations/${scenario}`,
	);
	await expect(used).toContainText("运行通知（场景设置）");
	await expect(dialog).toContainText("记为「未发送：机器人已删除」");
});

test.describe("运行抽屉里的运行通知状态", () => {
	/** 触发一次运行（从场景列表的运行抽屉），让节点按 `end` 结束，返回抽屉里的运行摘要。 */
	async function runFromDrawer(
		{ page, connectAgent }: { page: Page; connectAgent: E2eFixtures["connectAgent"] },
		end: "success" | "fail",
	) {
		const agent = await connectAgent({ name: "agent-a" });
		await page.goto("/orchestrations");
		await page
			.getByRole("article", { name: "订单压测" })
			.getByRole("button", { name: "运行" })
			.click();
		const drawer = page.getByRole("dialog", { name: "运行 · 订单压测" });
		await drawer.getByRole("button", { name: "触发运行" }).click();
		const task = await agent.nextAssign();
		await (end === "success" ? agent.succeed(task) : agent.fail(task, "boom"));
		return drawer.getByRole("region", { name: "运行摘要" });
	}

	test("运行结束后：排队中，投递完成后变成已送达；运行没有发通知的场景没有这一行", async ({
		page,
		controlPlane,
		connectAgent,
		feishu,
	}) => {
		await publishPackage(controlPlane);
		await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("a"));
		const scenario = await createScenario(controlPlane, "订单压测", scenarioUsing("agent-a"));
		await setRunNotification(controlPlane, scenario, { bot: "压测群", trigger: "always" });
		// 飞书慢一点响应：先能看到「排队中」。
		feishu.reply({ delayMs: 1500 });

		const summary = await runFromDrawer({ page, connectAgent }, "success");
		await expect(summary.getByTestId("summary-status")).toHaveText("成功");
		const line = summary.getByRole("group", { name: "运行通知" });
		await expect(line).toContainText("排队中");
		await expect(line).toContainText("发给「压测群」");
		// 运行结束后事件流已关闭：抽屉定时重新获取，等到结果。
		await expect(line).toContainText("已送达", { timeout: 15_000 });
		expect(feishu.requests).toHaveLength(1);
	});

	test("投递失败：显示失败和中文原因，运行的结果不变", async ({
		page,
		controlPlane,
		connectAgent,
		feishu,
	}) => {
		await publishPackage(controlPlane);
		await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("a"));
		const scenario = await createScenario(controlPlane, "订单压测", scenarioUsing("agent-a"));
		await setRunNotification(controlPlane, scenario, { bot: "压测群" });
		feishu.reply({ code: 19024 });

		const summary = await runFromDrawer({ page, connectAgent }, "fail");
		await expect(summary.getByTestId("summary-status")).toHaveText("失败");
		const line = summary.getByRole("group", { name: "运行通知" });
		await expect(line).toContainText("投递失败", { timeout: 15_000 });
		await expect(line).toContainText("关键词");
		await expect(summary.getByTestId("summary-status")).toHaveText("失败");
	});

	test("机器人已被删除：未发送，触发不被拦截", async ({
		page,
		controlPlane,
		connectAgent,
		feishu,
	}) => {
		await publishPackage(controlPlane);
		await createFeishuBot(controlPlane, "压测群", feishu.webhookUrl("a"));
		const scenario = await createScenario(controlPlane, "订单压测", scenarioUsing("agent-a"));
		await setRunNotification(controlPlane, scenario, { bot: "压测群", trigger: "always" });
		await controlPlane.fetch("/feishu-bots/%E5%8E%8B%E6%B5%8B%E7%BE%A4", {
			method: "DELETE",
			headers: { "x-sfly-nickname": "tester" },
		});

		const summary = await runFromDrawer({ page, connectAgent }, "success");
		await expect(summary.getByTestId("summary-status")).toHaveText("成功");
		const line = summary.getByRole("group", { name: "运行通知" });
		await expect(line).toContainText("未发送");
		await expect(line).toContainText("「压测群」机器人已删除");
		expect(feishu.requests).toHaveLength(0);
	});

	test("场景没有开运行通知：运行抽屉里没有这一行", async ({ page, controlPlane, connectAgent }) => {
		await publishPackage(controlPlane);
		await createScenario(controlPlane, "订单压测", scenarioUsing("agent-a"));

		const summary = await runFromDrawer({ page, connectAgent }, "success");
		await expect(summary.getByTestId("summary-status")).toHaveText("成功");
		await expect(summary.getByRole("group", { name: "运行通知" })).toHaveCount(0);
	});
});
