import { expect, test } from "./fixtures";
import {
	createScenario,
	expectFocusVisible,
	publishPackage,
	scenarioUsing,
	triggerRun,
} from "./support";

// 场景列表页（原型 #/scenarios）：卡片、表格、搜索筛选、更多菜单、归档与恢复、新建场景。

/** 通过 API 修改场景的说明（列表页的数据准备）。 */
async function describeScenario(
	cp: { fetch: (path: string, init?: RequestInit) => Promise<Response> },
	id: string,
	description: string,
) {
	const res = await cp.fetch(`/orchestrations/${id}`, {
		method: "PATCH",
		headers: { "content-type": "application/json", "x-sfly-nickname": "tester" },
		body: JSON.stringify({ description }),
	});
	if (!res.ok) throw new Error(`修改说明失败：${res.status}`);
}

test("卡片显示缩略图、名称、说明、版本与节点数、Agent 在线状态和最近运行；运行中可以进入监控页", async ({
	page,
	controlPlane,
	connectAgent,
	clock,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await (await connectAgent({ name: "agent-b" })).disconnect();
	await publishPackage(controlPlane);
	const busy = await createScenario(controlPlane, "日终数据处理", scenarioUsing("agent-a"));
	await describeScenario(controlPlane, busy, "每日 18:00 跑批并核对结果");
	await createScenario(controlPlane, "撮合压测", scenarioUsing("agent-b"));
	await createScenario(controlPlane, "空场景");
	clock.advance(60_000);
	const runId = await triggerRun(controlPlane, busy);
	await agent.nextAssign();

	await page.goto("/orchestrations");
	await expect(page.getByRole("heading", { name: "场景编排" })).toBeVisible();

	const card = page.getByRole("article", { name: "日终数据处理" });
	await expect(card).toContainText("v1");
	await expect(card).toContainText("2 节点");
	await expect(card).toContainText("每日 18:00 跑批并核对结果");
	await expect(card.getByTitle("agent-a（默认 Agent） · 在线")).toBeVisible();
	await expect(card).toContainText("最近运行");
	await expect(card).toContainText("tester");
	// 缩略图按最近一次运行着色：入口节点已完成，ping 执行中。
	await expect(card.locator('rect[data-node="entry"]')).toHaveAttribute("data-state", "ok");
	await expect(card.locator('rect[data-node="ping"]')).toHaveAttribute("data-state", "running");

	const offline = page.getByRole("article", { name: "撮合压测" });
	await expect(offline.getByTitle("agent-b（默认 Agent） · 离线")).toBeVisible();
	await expect(offline).toContainText("1 个不在线，任务会排队");
	await expect(offline).toContainText("从未运行");

	const empty = page.getByRole("article", { name: "空场景" });
	await expect(empty).toContainText("未保存");
	await expect(empty).toContainText("1 节点");
	await expect(empty).not.toContainText("没有说明");

	await card.getByRole("link", { name: "运行中，进入运行监控" }).click();
	await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
});

test("最近一次运行已请求取消、还在等待任务结束时，卡片与表格显示「取消中」而不是「运行中」", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "日终数据处理", scenarioUsing("agent-a"));
	const runId = await triggerRun(controlPlane, id);
	await agent.nextAssign();
	const res = await controlPlane.fetch(`/runs/${runId}/cancel`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "tester" },
		body: "{}",
	});
	expect(res.ok).toBe(true);

	await page.goto("/orchestrations");
	const card = page.getByRole("article", { name: "日终数据处理" });
	await expect(card.getByRole("link", { name: "取消中，进入运行监控" })).toBeVisible();
	await expect(card).not.toContainText("运行中");

	await page.getByRole("button", { name: "表格视图" }).click();
	const row = page.getByRole("row", { name: /日终数据处理/ });
	await expect(row).toContainText("取消中");
	await expect(row).not.toContainText("运行中");
});

test("场景名称进入编排画布，「运行」打开运行抽屉", async ({ page, controlPlane, connectAgent }) => {
	await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));

	await page.goto("/orchestrations");
	const card = page.getByRole("article", { name: "巡检" });
	await card.getByRole("button", { name: "运行" }).click();
	await expect(page.getByRole("dialog", { name: "运行 · 巡检" })).toBeVisible();
	await page.keyboard.press("Escape");

	await card.getByRole("link", { name: "巡检" }).click();
	await expect(page).toHaveURL(new RegExp(`/orchestrations/${id}$`));
});

test("卡片的 Tab 停靠点：名称链接是第一个，缩略图和右上角的运行状态不重复停靠", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const busy = await createScenario(controlPlane, "日终数据处理", scenarioUsing("agent-a"));
	await createScenario(controlPlane, "撮合压测", scenarioUsing("agent-a"));
	await triggerRun(controlPlane, busy);
	await agent.nextAssign();
	await page.goto("/orchestrations");
	await expect(page.getByRole("article")).toHaveCount(2);

	const stopsIn = async (name: string) => {
		const card = page.getByRole("article", { name });
		await page.getByRole("heading", { name: "场景编排" }).click();
		const stops: string[] = [];
		for (let i = 0; i < 60; i++) {
			await page.keyboard.press("Tab");
			const inside = await card.evaluate((el) => el.contains(document.activeElement));
			if (!inside && stops.length > 0) break;
			if (inside) {
				stops.push(
					await page.evaluate(() => {
						const a = document.activeElement as HTMLElement;
						return a.getAttribute("aria-label") ?? a.textContent?.trim() ?? "";
					}),
				);
			}
		}
		return stops;
	};
	expect(await stopsIn("日终数据处理")).toEqual([
		"日终数据处理",
		"运行中，进入运行监控",
		"运行",
		"更多操作",
	]);
	expect(await stopsIn("撮合压测")).toEqual(["撮合压测", "运行", "更多操作"]);
});

test("切换到表格视图，视图保存在地址里", async ({ page, controlPlane }) => {
	const id = await createScenario(controlPlane, "巡检");
	await describeScenario(controlPlane, id, "检查各环境的服务");
	await page.goto("/orchestrations");
	await page.getByRole("button", { name: "表格视图" }).click();
	await expect(page).toHaveURL(/view=table/);
	const row = page.getByRole("row", { name: /巡检/ });
	await expect(row).toContainText("检查各环境的服务");
	await expect(row).toContainText("从未运行");
	await expect(row).toContainText("未保存");

	await page.reload();
	await expect(page.getByRole("table", { name: "场景列表" })).toBeVisible();
	await page.getByRole("button", { name: "卡片视图" }).click();
	await expect(page.getByRole("article", { name: "巡检" })).toBeVisible();
});

test("按名称、说明或 Agent 搜索，按最近运行状态和 Agent 筛选", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await connectAgent({ name: "agent-b" });
	await publishPackage(controlPlane);
	const daily = await createScenario(controlPlane, "日终数据处理", scenarioUsing("agent-a"));
	await describeScenario(controlPlane, daily, "每日跑批");
	await createScenario(controlPlane, "撮合压测", scenarioUsing("agent-b"));
	await createScenario(controlPlane, "巡检");
	await triggerRun(controlPlane, daily);
	await agent.succeed(await agent.nextAssign());

	await page.goto("/orchestrations");
	const cards = page.getByRole("article");
	await expect(cards).toHaveCount(3);

	const search = page.getByRole("searchbox", { name: "搜索场景" });
	await search.fill("跑批");
	await expect(cards).toHaveText([/日终数据处理/]);
	await search.fill("agent-b");
	await expect(cards).toHaveText([/撮合压测/]);
	await search.fill("没有这个");
	await expect(page.getByRole("region", { name: "没有匹配的场景" })).toBeVisible();
	await expect(page).toHaveURL(/q=/);
	await page.getByRole("button", { name: "清除筛选" }).click();
	await expect(cards).toHaveCount(3);
	// 搜索框随地址清空（与运行记录页同一种防抖 + 写地址方式），不会把旧关键字写回。
	await expect(search).toHaveValue("");
	await page.waitForTimeout(600);
	await expect(cards).toHaveCount(3);

	const status = page.getByRole("group", { name: "最近运行" });
	await status.getByRole("button", { name: "最近成功" }).click();
	await expect(cards).toHaveText([/日终数据处理/]);
	await status.getByRole("button", { name: "最近失败" }).click();
	await expect(page.getByRole("region", { name: "没有匹配的场景" })).toBeVisible();
	await status.getByRole("button", { name: "全部" }).click();

	await page.getByRole("combobox", { name: "Agent" }).selectOption("agent-b");
	await expect(cards).toHaveText([/撮合压测/]);
	await expect(page).toHaveURL(/agent=agent-b/);
});

test("更多菜单：编辑名称和说明、复制、版本历史", async ({ page, controlPlane }) => {
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "巡检", scenarioUsing("agent-a"));
	await page.goto("/orchestrations");

	const card = page.getByRole("article", { name: "巡检" });
	const more = card.getByRole("button", { name: "更多操作" });
	await more.click();
	await page.getByRole("menuitem", { name: "编辑名称和说明…" }).click();
	const edit = page.getByRole("dialog", { name: "编辑名称和说明" });
	await edit.getByLabel("名称").fill("生产巡检");
	await edit.getByLabel("说明").fill("每小时检查一次");
	await edit.getByRole("button", { name: "保存" }).click();
	await expect(edit).toBeHidden();
	await expect(more).toBeFocused();
	const renamed = page.getByRole("article", { name: "生产巡检" });
	await expect(renamed).toContainText("每小时检查一次");
	// 改名不产生新版本。
	await expect(renamed).toContainText("v1");

	await renamed.getByRole("button", { name: "更多操作" }).click();
	await page.getByRole("menuitem", { name: "复制场景…" }).click();
	const copy = page.getByRole("dialog", { name: "复制场景" });
	await expect(copy.getByLabel("名称")).toHaveValue("生产巡检 副本");
	await copy.getByLabel("名称").fill("测试环境巡检");
	await copy.getByRole("button", { name: "复制" }).click();
	const copied = page.getByRole("article", { name: "测试环境巡检" });
	await expect(copied).toContainText("每小时检查一次");
	await expect(copied).toContainText("v1");

	await copied.getByRole("button", { name: "更多操作" }).click();
	await page.getByRole("menuitem", { name: "版本历史" }).click();
	await expect(page).toHaveURL(/\/orchestrations\/[^/]+\/versions$/);
});

test("归档后从列表消失，在「已归档」里恢复；有运行中的运行时不能归档", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "旧场景", scenarioUsing("agent-a"));
	const busy = await createScenario(controlPlane, "运行中的场景", scenarioUsing("agent-a"));
	await triggerRun(controlPlane, busy);
	await agent.nextAssign();

	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "运行中的场景" }).getByLabel("更多操作").click();
	await expect(page.getByRole("menuitem", { name: /归档/ })).toBeDisabled();
	await expect(page.getByRole("menuitem", { name: /归档/ })).toContainText("运行中不可归档");
	await page.keyboard.press("Escape");
	// 关闭的菜单播完退场动画才卸载，期间仍在无障碍树里；等它消失再打开下一张卡片的菜单。
	await expect(page.getByRole("menu")).toHaveCount(0);

	await page.getByRole("article", { name: "旧场景" }).getByLabel("更多操作").click();
	await page.getByRole("menuitem", { name: /归档/ }).click();
	const confirm = page.getByRole("dialog", { name: "归档「旧场景」？" });
	await confirm.getByRole("button", { name: "归档" }).click();
	await expect(page.getByRole("article", { name: "旧场景" })).toBeHidden();

	const archived = page.getByRole("button", { name: /已归档/ });
	await expect(archived).toContainText("1");
	await archived.click();
	await expect(page.getByRole("heading", { name: "已归档的场景" })).toBeVisible();
	const card = page.getByRole("article", { name: "旧场景" });
	await expect(card).toContainText("归档于");
	await expect(page.getByRole("article")).toHaveCount(1);
	await card.getByRole("button", { name: "恢复" }).click();
	await expect(page.getByRole("region", { name: "没有已归档的场景" })).toBeVisible();

	await archived.click();
	await expect(page.getByRole("article", { name: "旧场景" })).toBeVisible();
});

test("归档确认框的放弃按钮叫「保留场景」；归档成功的通知里可以「撤销」，场景回到列表", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	await createScenario(controlPlane, "旧场景", scenarioUsing("agent-a"));

	await page.goto("/orchestrations");
	const card = page.getByRole("article", { name: "旧场景" });
	await card.getByLabel("更多操作").click();
	await page.getByRole("menuitem", { name: /归档/ }).click();
	const confirm = page.getByRole("dialog", { name: "归档「旧场景」？" });
	await expect(confirm.getByRole("button", { name: "取消", exact: true })).toHaveCount(0);
	await confirm.getByRole("button", { name: "保留场景" }).click();
	await expect(confirm).toBeHidden();
	await expect(card).toBeVisible();

	await card.getByLabel("更多操作").click();
	await page.getByRole("menuitem", { name: /归档/ }).click();
	await confirm.getByRole("button", { name: "归档" }).click();
	await expect(card).toBeHidden();
	await page.getByRole("button", { name: "撤销" }).click();
	await expect(page.getByText("已恢复「旧场景」")).toBeVisible();
	await expect(card).toBeVisible();
});

test("已归档场景的历史运行仍可回看：卡片与表格行的「查看运行记录」，运行记录的场景筛选里标注「已归档」", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "旧场景", scenarioUsing("agent-a"));
	await createScenario(controlPlane, "新场景", scenarioUsing("agent-a"));
	const runId = await triggerRun(controlPlane, id);
	await agent.succeed(await agent.nextAssign());
	const res = await controlPlane.fetch(`/orchestrations/${id}/archive`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "tester" },
		body: "{}",
	});
	expect(res.ok).toBe(true);

	await page.goto("/orchestrations?archived=true");
	const card = page.getByRole("article", { name: "旧场景" });
	await card.getByRole("link", { name: "查看运行记录" }).click();
	await expect(page).toHaveURL(new RegExp(`/runs\\?scenario=${id}`));
	const select = page.getByRole("combobox", { name: "场景" });
	await expect(select).toHaveValue(id);
	await expect(select.locator("option:checked")).toHaveText("旧场景（已归档）");
	await expect(page.getByRole("table", { name: "历史运行" })).toContainText(runId.slice(0, 8));

	// 表格视图里同样有入口；筛选下拉里也能直接选到已归档的场景。
	await page.goto("/orchestrations?archived=true&view=table");
	await page
		.getByRole("row", { name: /旧场景/ })
		.getByRole("link", { name: "查看运行记录" })
		.click();
	await expect(page).toHaveURL(new RegExp(`scenario=${id}`));
	await select.selectOption({ label: "新场景" });
	await select.selectOption({ label: "旧场景（已归档）" });
	await expect(page.getByRole("table", { name: "历史运行" })).toContainText(runId.slice(0, 8));
});

test("新建场景：自带入口节点，建好后进入编排画布；命令面板里也能新建", async ({ page }) => {
	await page.goto("/orchestrations");
	await expect(page.getByRole("region", { name: "还没有场景" })).toBeVisible();
	await page.getByRole("button", { name: "新建场景" }).first().click();
	const dialog = page.getByRole("dialog", { name: "新建场景" });
	await dialog.getByLabel("名称").fill("登录冒烟");
	await dialog.getByLabel("说明").fill("每次发布后跑");
	await dialog.getByRole("button", { name: "新建" }).click();
	await expect(page).toHaveURL(/\/orchestrations\/[0-9a-f-]{36}$/);
	await expect(page.locator(".react-flow__node")).toHaveCount(1);

	await page.keyboard.press("Control+k");
	await page.getByRole("option", { name: "新建场景" }).click();
	const again = page.getByRole("dialog", { name: "新建场景" });
	await again.getByLabel("名称").fill("支付冒烟");
	await again.getByRole("button", { name: "新建" }).click();
	await expect(page).toHaveURL(/\/orchestrations\/[0-9a-f-]{36}$/);

	await page.goto("/orchestrations");
	await expect(page.getByRole("article", { name: "登录冒烟" })).toContainText("每次发布后跑");
	await expect(page.getByRole("article", { name: "支付冒烟" })).toContainText("1 节点");
});

test("列表页的键盘：/ 聚焦并选中搜索框，↓ 进入第一张卡片，J / K 在卡片之间移动，Enter 进入编排画布", async ({
	page,
	controlPlane,
}) => {
	await createScenario(controlPlane, "日终数据处理");
	await createScenario(controlPlane, "日终对账");
	await createScenario(controlPlane, "撮合压测");
	await page.goto("/orchestrations");
	const cards = page.locator("article[data-list-item]");
	await expect(cards).toHaveCount(3);
	const box = page.getByRole("searchbox", { name: "搜索场景" });

	await page.keyboard.press("/");
	await expect(box).toBeFocused();
	await box.fill("日终");
	await expect(cards).toHaveCount(2);
	await page.getByRole("heading", { name: "场景编排" }).click();
	await page.keyboard.press("/");
	await expect(box).toBeFocused();
	expect(
		await box.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]),
	).toEqual([0, 2]);

	await page.keyboard.press("ArrowDown");
	const shown = await cards.locator("h2").allTextContents();
	const link = (index: number) => page.getByRole("link", { name: shown[index], exact: true });
	await expectFocusVisible(link(0));
	await page.keyboard.press("j");
	await expectFocusVisible(link(1));
	await page.keyboard.press("j");
	await expectFocusVisible(link(1));
	await page.keyboard.press("k");
	await expectFocusVisible(link(0));
	await expect(cards.nth(0)).toHaveCSS("border-color", "rgb(68, 68, 68)");
	await expect(cards.nth(1)).not.toHaveCSS("border-color", "rgb(68, 68, 68)");

	const href = await link(1).getAttribute("href");
	await page.keyboard.press("j");
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(new RegExp(`${href}$`));
});

test("列表页的键盘：焦点不在列表里时 J 去第一项、K 去最后一项；表格视图里在行之间移动；菜单打开时不抢焦点", async ({
	page,
	controlPlane,
}) => {
	await createScenario(controlPlane, "日终数据处理");
	await createScenario(controlPlane, "撮合压测");
	await createScenario(controlPlane, "登录巡检");
	await page.goto("/orchestrations?view=table");
	const table = page.getByRole("table", { name: "场景列表" });
	const rows = table.locator("tr[data-list-item]");
	await expect(rows).toHaveCount(3);
	const names = await rows.locator("td:first-child a").allTextContents();
	const link = (index: number) => table.getByRole("link", { name: names[index] });

	await page.keyboard.press("k");
	await expectFocusVisible(link(2));
	await page.keyboard.press("k");
	await expectFocusVisible(link(1));
	const hovered = await rows.nth(1).evaluate((el) => getComputedStyle(el).backgroundColor);
	const plain = await rows.nth(0).evaluate((el) => getComputedStyle(el).backgroundColor);
	expect(hovered).not.toBe(plain);

	await rows.nth(1).getByRole("button", { name: "更多操作" }).click();
	const menu = page.getByRole("menu");
	await expect(menu).toBeVisible();
	await page.keyboard.press("j");
	await expect(menu).toBeVisible();
	expect(await menu.evaluate((el) => el.contains(document.activeElement))).toBe(true);
	await page.keyboard.press("Escape");
	await expect(menu).toBeHidden();
});

test("卡片的最小宽度 340px，屏幕越大卡片不会更窄；「最近运行」始终一行，卡片窄到 360px 以下先去掉触发人", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	for (const name of ["甲", "乙", "丙", "丁", "戊"]) {
		const id = await createScenario(controlPlane, name, scenarioUsing("agent-a"));
		await triggerRun(controlPlane, id);
		await agent.succeed(await agent.nextAssign());
	}
	const cards = page.locator("article[data-list-item]");
	const lastRun = (card: ReturnType<typeof cards.nth>) =>
		card.locator("div", { hasText: /^最近运行/ }).last();

	const widths: number[] = [];
	for (const width of [1280, 1440, 1920]) {
		await page.setViewportSize({ width, height: 900 });
		await page.goto("/orchestrations");
		await expect(cards).toHaveCount(5);
		const [card] = await cards.evaluateAll((all) =>
			all.map((a) => a.getBoundingClientRect().width),
		);
		widths.push(card ?? 0);
		for (let i = 0; i < 5; i++) {
			const height = await lastRun(cards.nth(i)).evaluate(
				(el) => el.getBoundingClientRect().height,
			);
			expect(height).toBeLessThanOrEqual(20);
		}
	}
	expect(Math.min(...widths)).toBeGreaterThanOrEqual(340);

	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/orchestrations");
	const grid = page.locator("#main .grid").first();
	const first = cards.first();
	await grid.evaluate((el) => {
		el.style.width = "1090px";
	});
	expect((await first.boundingBox())?.width ?? 0).toBeLessThan(360);
	await expect(first.getByText("tester")).toBeHidden();
	await expect(first.getByText("成功")).toBeVisible();
	await grid.evaluate((el) => {
		el.style.width = "1300px";
	});
	expect((await first.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(360);
	await expect(first.getByText("tester")).toBeVisible();
});

test("表格：场景列吃掉多出来的宽度，其余列按内容收紧；场景名被截断时悬停显示全文", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const longName = `撮合压测 · 高并发下单 · A 环境 · ${"很长的名称".repeat(14)}`;
	await createScenario(controlPlane, longName, scenarioUsing("agent-a"));
	await createScenario(controlPlane, "短名称", scenarioUsing("agent-a"));

	const columns = async (width: number) => {
		await page.setViewportSize({ width, height: 900 });
		await page.goto("/orchestrations?view=table");
		const table = page.getByRole("table", { name: "场景列表" });
		await expect(table.getByRole("row")).toHaveCount(3);
		return table
			.getByRole("columnheader")
			.evaluateAll((all) => all.map((th) => Math.round(th.getBoundingClientRect().width)));
	};
	const narrow = await columns(1280);
	const wide = await columns(1920);
	expect(wide[0]).toBeGreaterThan((narrow[0] ?? 0) + 500);
	expect(wide.slice(1)).toEqual(narrow.slice(1));

	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto("/orchestrations?view=table");
	const link = page.getByRole("link", { name: longName });
	await expect(link).toHaveAttribute("data-truncated", "true");
	const tip = page.locator('[data-slot="tooltip-content"]');
	await link.hover();
	await expect(tip).toContainText(longName);
	await page.mouse.move(0, 0);
	await expect(tip).toHaveCount(0);
	await link.focus();
	await expect(tip).toContainText(longName);
	await expect(page.getByRole("row", { name: /短名称/ }).locator("[data-truncated]")).toHaveCount(
		0,
	);
});

test("新建场景：名称为空也能提交，错误写在名称下并把焦点放回输入框；服务端拒绝的原因写在弹窗里，不发通知", async ({
	page,
}) => {
	await page.route("**/api/orchestrations", async (route) => {
		if (route.request().method() !== "POST") return route.continue();
		await route.fulfill({
			status: 409,
			contentType: "application/json",
			body: JSON.stringify({ error: { code: "name_taken", message: "场景名称已存在" } }),
		});
	});
	await page.goto("/orchestrations");
	await expect(page.getByRole("heading", { name: "场景编排", level: 1 })).toBeVisible();
	await page.keyboard.press("n");
	const dialog = page.getByRole("dialog", { name: "新建场景" });
	const name = dialog.getByLabel("名称");
	const submit = dialog.getByRole("button", { name: "新建", exact: true });
	await expect(name).toHaveAttribute("aria-required", "true");
	await expect(submit).toBeEnabled();
	await expect(dialog.getByText("填写场景名称")).toHaveCount(0);

	await page.keyboard.press("Tab");
	await expect(dialog.getByText("填写场景名称")).toHaveCount(0);
	await submit.click();
	const problem = dialog.getByText("填写场景名称");
	await expect(problem).toBeVisible();
	await expect(name).toBeFocused();
	await expect(name).toHaveAttribute("aria-invalid", "true");
	await expect(name).toHaveAttribute("aria-describedby", (await problem.getAttribute("id")) ?? "");

	await name.fill("重名的场景");
	await expect(problem).toBeHidden();
	await submit.click();
	await expect(dialog.getByRole("alert")).toHaveText("场景名称已存在");
	await expect(dialog).toBeVisible();
	await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

test("在「已归档」里恢复之后焦点落到下一张卡片，最后一张恢复后回到页面标题", async ({
	page,
	controlPlane,
}) => {
	const ids = [] as string[];
	for (const name of ["甲", "乙"]) ids.push(await createScenario(controlPlane, name));
	for (const id of ids) {
		const res = await controlPlane.fetch(`/orchestrations/${id}/archive`, {
			method: "POST",
			headers: { "x-sfly-nickname": "tester" },
		});
		expect(res.ok).toBe(true);
	}
	await page.goto("/orchestrations?archived=true");
	const cards = page.locator("article[data-list-item]");
	await expect(cards).toHaveCount(2);
	const [first, second] = await cards.evaluateAll((all) => all.map((a) => a.ariaLabel ?? ""));

	await page.getByRole("article", { name: first }).getByRole("button", { name: "恢复" }).focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("article", { name: first })).toBeHidden();
	await expect(
		page.getByRole("article", { name: second }).locator("[data-list-primary]"),
	).toBeFocused();

	await page.getByRole("article", { name: second }).getByRole("button", { name: "恢复" }).focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("region", { name: "没有已归档的场景" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "已归档的场景", level: 1 })).toBeFocused();
});

test("归档服务端拒绝时，原因写在确认框里，不发通知", async ({ page, controlPlane }) => {
	const id = await createScenario(controlPlane, "旧场景");
	await page.route(`**/api/orchestrations/${id}/archive`, (route) =>
		route.fulfill({
			status: 409,
			contentType: "application/json",
			body: JSON.stringify({ error: { code: "running", message: "场景有运行中的运行" } }),
		}),
	);
	await page.goto("/orchestrations");
	await page.getByRole("article", { name: "旧场景" }).getByLabel("更多操作").click();
	await page.getByRole("menuitem", { name: /归档/ }).click();
	const confirm = page.getByRole("dialog", { name: "归档「旧场景」？" });
	await confirm.getByRole("button", { name: "归档", exact: true }).click();
	await expect(confirm.getByRole("alert")).toHaveText("不能归档：场景有运行中的运行");
	await expect(confirm).toBeVisible();
	await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

test("最近运行里执行中的状态标签脉冲一处（卡片与表格各一个），缩略图角标和其余状态点静止", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	const agent = await connectAgent({ name: "agent-a" });
	await publishPackage(controlPlane);
	const busy = await createScenario(controlPlane, "跑着的场景", scenarioUsing("agent-a"));
	await createScenario(controlPlane, "空闲的场景", scenarioUsing("agent-a"));
	await triggerRun(controlPlane, busy);
	await agent.nextAssign();
	const pulses = () =>
		page.evaluate(
			() =>
				document
					.getAnimations()
					.filter((a) => a instanceof CSSAnimation && a.animationName === "status-pulse").length,
		);

	await page.goto("/orchestrations");
	await expect(page.getByRole("article", { name: "跑着的场景" })).toContainText("运行中");
	expect(await pulses()).toBe(1);
	await page.goto("/orchestrations?view=table");
	await expect(page.getByRole("row", { name: /跑着的场景/ })).toContainText("运行中");
	expect(await pulses()).toBe(1);
});
