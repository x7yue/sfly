import { expect, START_TIME, test } from "./fixtures";
import { advance, runDocument as document } from "./run-records";
import { createScenario, holdApi, publishPackage, triggerRun } from "./support";

// 运行记录页（原型 #/runs）：进行中的运行是卡片，历史运行是表格。

const MINUTE = 60_000;

test("进行中的运行显示为卡片：场景、版本、时长、各链进度、失败的子流程、当前节点与进度", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent", slots: 4 });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "日终数据处理", document({ subflow: true }));
	const runId = await triggerRun(controlPlane, scenario);
	await agent.succeed(await agent.nextAssign());
	const tasks = [await agent.nextAssign(), await agent.nextAssign()];
	const verify = tasks.find((t) => t.nodeId === "verify");
	const probe = tasks.find((t) => t.nodeId === "probe");
	if (!verify || !probe) throw new Error("没有派发 verify 与 probe");
	agent.progress(verify, 3, 10);
	await agent.fail(probe);
	// 只把浏览器时间往后拨（控制面时钟不动，任务租约不会过期）。
	await page.clock.setFixedTime(new Date(Date.parse(START_TIME) + 5 * MINUTE + 3_000));

	await page.goto("/runs");
	const card = page.getByRole("article", { name: `运行 ${runId.slice(0, 8)}` });
	await expect(card).toContainText("日终数据处理");
	await expect(card).toContainText("v1");
	await expect(card).toContainText("5m 03s");
	await expect(card).toContainText("tester 触发");
	await expect(card).toContainText("子流程 sub 失败");
	await expect(card.getByRole("img", { name: "主链 3/4" })).toBeVisible();
	await expect(card.getByRole("img", { name: "子流程 sub 1/2" })).toBeVisible();
	await expect(card.getByRole("listitem")).toHaveText([/verify.*执行中.*3 \/ 10/]);

	await card.getByRole("link", { name: "打开运行详情" }).click();
	await expect(page).toHaveURL(`/runs/${runId}`);
});

test("历史运行显示为表格：编号、场景、状态与失败节点、进度、版本、触发人、开始时间、耗时", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent", slots: 4 });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "撮合压测", document());
	const ok = await triggerRun(controlPlane, scenario);
	await agent.succeed(await agent.nextAssign());
	const verify = await agent.nextAssign();
	await advance(clock, agent, 90_000);
	await agent.succeed(verify);
	clock.advance(MINUTE);
	const failed = await triggerRun(controlPlane, scenario);
	await agent.fail(await agent.nextAssign());

	await page.goto("/runs");
	const table = page.getByRole("table", { name: "历史运行" });
	await expect(
		table.getByRole("row", { name: new RegExp(ok.slice(0, 8)) }).getByRole("cell"),
	).toHaveText([ok.slice(0, 8), "撮合压测", "成功", "", "v1", "tester", "01-01 08:00", "1m 30s"]);
	const failedRow = table.getByRole("row", { name: new RegExp(failed.slice(0, 8)) });
	await expect(failedRow.getByRole("cell").nth(2)).toHaveText("失败 · check");
	await expect(failedRow.getByRole("img", { name: "主链 2/3" })).toBeVisible();
	// 从新到旧。
	await expect(table.getByRole("row").nth(1)).toContainText(failed.slice(0, 8));

	await failedRow.click();
	await expect(page).toHaveURL(`/runs/${failed}`);
});

test("按状态、场景、编号或触发人筛选，筛选条件放在地址里", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent", slots: 4 });
	await publishPackage(controlPlane);
	const checkout = await createScenario(controlPlane, "结账回归", document());
	const login = await createScenario(controlPlane, "登录巡检", document());
	const failed = await triggerRun(controlPlane, checkout);
	await agent.fail(await agent.nextAssign());
	const running = await triggerRun(controlPlane, login);
	await agent.nextAssign();
	const other = await triggerRun(controlPlane, login);
	await agent.nextAssign();

	await page.goto("/runs");
	const history = page.getByRole("table", { name: "历史运行" });
	const cards = page.getByRole("article");
	await expect(cards).toHaveCount(2);
	await expect(history.getByRole("row")).toHaveCount(2);

	const status = page.getByRole("group", { name: "状态" });
	await expect(status.getByRole("button", { name: "运行中 2" })).toBeVisible();
	await status.getByRole("button", { name: /失败/ }).click();
	await expect(page).toHaveURL(/status=failed/);
	await expect(cards).toHaveCount(0);
	await expect(history.getByRole("row")).toHaveCount(2);
	await expect(history).toContainText(failed.slice(0, 8));

	await status.getByRole("button", { name: "全部" }).click();
	await page.getByRole("combobox", { name: "场景" }).selectOption({ label: "登录巡检" });
	await expect(page).toHaveURL(new RegExp(`scenario=${login}`));
	await expect(cards).toHaveCount(2);
	await expect(history).toHaveCount(0);

	await page.getByRole("searchbox", { name: "搜索运行编号或触发人" }).fill(running.slice(0, 6));
	await expect(cards).toHaveCount(1);
	await expect(cards.first()).toContainText(running.slice(0, 8));
	// 全是数字的关键字在地址里按 JSON 字符串编码（带引号），所以只检查包含。
	await expect.poll(() => new URL(page.url()).searchParams.get("q")).toContain(running.slice(0, 6));

	await page.reload();
	await expect(cards).toHaveCount(1);
	await expect(page.getByRole("searchbox", { name: "搜索运行编号或触发人" })).toHaveValue(
		running.slice(0, 6),
	);

	await page.getByRole("searchbox", { name: "搜索运行编号或触发人" }).fill("nobody");
	await expect(page.getByRole("region", { name: "没有符合条件的运行" })).toBeVisible();
	expect(other).not.toBe(running);
});

test("地址里的关键字被清掉时搜索框跟着清空，不会把旧关键字写回地址", async ({ page }) => {
	await page.goto("/runs");
	const box = page.getByRole("searchbox", { name: "搜索运行编号或触发人" });
	await box.fill("nobody");
	await expect(page).toHaveURL(/q=nobody/);

	await page
		.getByRole("navigation", { name: "主导航" })
		.getByRole("link", { name: /运行记录/ })
		.click();
	await expect(box).toHaveValue("");
	// 等过防抖时间：地址里不会再出现旧关键字。
	await page.waitForTimeout(600);
	expect(new URL(page.url()).searchParams.get("q")).toBeNull();
	await expect(box).toHaveValue("");
});

test("实时更新：运行结束后从卡片移到历史表格", async ({ page, controlPlane, connectAgent }) => {
	const agent = await connectAgent({ name: "agent", slots: 4 });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "巡检", document());
	const runId = await triggerRun(controlPlane, scenario);
	const check = await agent.nextAssign();

	await page.goto("/runs");
	const card = page.getByRole("article", { name: `运行 ${runId.slice(0, 8)}` });
	await expect(card.getByRole("listitem")).toHaveText([/check/]);

	await agent.succeed(check);
	await expect(card.getByRole("listitem")).toHaveText([/verify/]);
	await agent.succeed(await agent.nextAssign());
	await expect(card).toHaveCount(0);
	await expect(
		page
			.getByRole("table", { name: "历史运行" })
			.getByRole("row", { name: new RegExp(runId.slice(0, 8)) }),
	).toContainText("成功");
});

test("取消运行：确认后运行进入取消中；Esc 关闭确认框时焦点回到按钮", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent", slots: 4 });
	await publishPackage(controlPlane);
	const scenario = await createScenario(controlPlane, "巡检", document());
	const runId = await triggerRun(controlPlane, scenario);
	await agent.nextAssign();

	await page.goto("/runs");
	const card = page.getByRole("article", { name: `运行 ${runId.slice(0, 8)}` });
	const cancel = card.getByRole("button", { name: "取消运行" });
	await cancel.click();
	const dialog = page.getByRole("dialog", { name: `取消运行 ${runId.slice(0, 8)}？` });
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await expect(cancel).toBeFocused();

	await cancel.click();
	await dialog.getByRole("button", { name: "取消运行" }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByText("已请求取消运行")).toBeVisible();
	await expect(card).toContainText("取消中");
	await expect(card.getByRole("button", { name: "强制终止" })).toBeVisible();
	expect((await agent.nextCancel()).force).toBe(false);
});

test("没有运行时显示空状态，加载时显示骨架", async ({ page }) => {
	const { release } = await holdApi(page, "/runs**");
	await page.goto("/runs");
	await expect(page.getByRole("status", { name: "加载中" })).toBeVisible();
	release();
	const empty = page.getByRole("region", { name: "没有运行记录" });
	await expect(empty).toBeVisible();
	await empty.getByRole("link", { name: "去场景编排" }).click();
	await expect(page).toHaveURL("/orchestrations");
});
