import { expect, test } from "./fixtures";
import {
	createFocusScenario,
	focusDocument,
	focusKeysOf,
	focusList,
	focusNames,
	openFocusList,
	saveVersion,
	sceneView,
	setFocusItems,
} from "./focus-support";

// 场景设置的「关注项」页（#344 / #349）：排序、改名、移除后撤销、最后修改、失效的项。

const ORDERS = { node_id: "fetch", chart: "延迟", title: "下单延迟" };
const THROUGHPUT = { node_id: "fetch", chart: "吞吐", title: "母单量" };
const CHILD = { node_id: "fetch2", chart: "请求数", title: "子单量" };
const LEVEL = { node_id: "ping", chart: "level" };

/** 显示名字是 `name` 的那一行（按行里「移除」按钮的名称找）。 */
const row = (list: ReturnType<typeof focusList>, name: string) =>
	list
		.getByRole("listitem")
		.filter({ has: list.page().getByRole("button", { name: `移除关注项 ${name}` }) });

test("只用键盘上移和下移：读屏的实时区域播报新位置，焦点跟着那一项走，到头的按钮仍然可以聚焦", async ({
	page,
	controlPlane,
}) => {
	const id = await createFocusScenario(controlPlane);
	await setFocusItems(controlPlane, id, [ORDERS, THROUGHPUT, CHILD, LEVEL]);
	const panel = await openFocusList(page, id);
	const status = panel.getByRole("status");

	const down = panel.getByRole("button", { name: "下移 下单延迟" });
	const up = panel.getByRole("button", { name: "上移 下单延迟" });
	await expect(up).toHaveAttribute("aria-disabled", "true");
	await down.focus();
	await page.keyboard.press("Enter");
	await expect(status).toHaveText("下单延迟 移到第 2 位，共 4 项");
	await expect(down).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(status).toHaveText("下单延迟 移到第 3 位，共 4 项");
	await page.keyboard.press("Enter");
	await expect(status).toHaveText("下单延迟 移到第 4 位，共 4 项");
	await expect(down).toBeFocused();
	await expect(down).toHaveAttribute("aria-disabled", "true");
	await expect.poll(() => focusNames(panel)).toEqual(["母单量", "子单量", "level", "下单延迟"]);

	// 已经到末尾：再按什么都不发生，焦点也还在。
	await page.keyboard.press("Enter");
	await expect(down).toBeFocused();
	await expect.poll(() => focusNames(panel)).toEqual(["母单量", "子单量", "level", "下单延迟"]);

	await page.keyboard.press("Shift+Tab");
	await expect(up).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(status).toHaveText("下单延迟 移到第 3 位，共 4 项");
	await expect(up).toBeFocused();

	await expect
		.poll(() => focusKeysOf(controlPlane, id))
		.toEqual(["fetch:吞吐", "fetch2:请求数", "fetch:延迟", "ping:level"]);
	await expect(panel.getByText("最后修改：")).toContainText("tester");
	// 把刚才的移动挪回去，正好是上一次修改之前的列表：记为撤销。
	await expect(panel.getByText("最后修改：")).toContainText("撤销了「下单延迟」的移动");
	expect((await sceneView(controlPlane, id)).head_version).toBe(1);
});

test("拖动手柄排序：落在两行之间，放手后写入，最后修改写明移到第几位", async ({
	page,
	controlPlane,
}) => {
	const id = await createFocusScenario(controlPlane);
	await setFocusItems(controlPlane, id, [ORDERS, THROUGHPUT, CHILD, LEVEL]);
	const panel = await openFocusList(page, id);

	const handle = (name: string) => row(focusList(panel), name).locator("[data-focus-handle]");
	await handle("level").dragTo(row(focusList(panel), "母单量"), {
		targetPosition: { x: 40, y: 4 },
	});
	await expect.poll(() => focusNames(panel)).toEqual(["下单延迟", "level", "母单量", "子单量"]);
	await expect
		.poll(() => focusKeysOf(controlPlane, id))
		.toEqual(["fetch:延迟", "ping:level", "fetch:吞吐", "fetch2:请求数"]);
	await expect(panel.getByText("最后修改：")).toContainText("把「level」移到第 2 位");

	// 拖到最后一行的下半部分：放到末尾。
	await handle("下单延迟").dragTo(row(focusList(panel), "子单量"), {
		targetPosition: { x: 40, y: 40 },
	});
	await expect.poll(() => focusNames(panel)).toEqual(["level", "母单量", "子单量", "下单延迟"]);
});

test("移除后马上出现撤销，撤销把列表恢复成移除之前的样子，最后修改随之更新", async ({
	page,
	controlPlane,
}) => {
	const id = await createFocusScenario(controlPlane);
	await setFocusItems(controlPlane, id, [ORDERS, THROUGHPUT, CHILD, LEVEL]);
	const panel = await openFocusList(page, id);
	await expect(panel.getByText("本场景的关注项已用 4 / 8")).toBeVisible();

	await panel.getByRole("button", { name: "移除关注项 母单量" }).click();
	await expect.poll(() => focusNames(panel)).toEqual(["下单延迟", "子单量", "level"]);
	const undo = panel.getByRole("button", { name: "撤销" });
	await expect(panel.getByText("已移除「母单量」，正在跑的运行也去掉了这一项。")).toBeVisible();
	await expect(undo).toBeFocused();
	await expect(panel.getByRole("status")).toHaveText("已移除「母单量」，可以撤销");
	await expect(panel.getByText("本场景的关注项已用 3 / 8")).toBeVisible();
	await expect(panel.getByText("最后修改：")).toContainText("移除了「母单量」");
	await expect
		.poll(() => focusKeysOf(controlPlane, id))
		.toEqual(["fetch:延迟", "fetch2:请求数", "ping:level"]);

	await undo.click();
	await expect.poll(() => focusNames(panel)).toEqual(["下单延迟", "母单量", "子单量", "level"]);
	await expect(undo).toHaveCount(0);
	await expect(panel.getByText("最后修改：")).toContainText("撤销了移除「母单量」");
	await expect(panel.getByText("本场景的关注项已用 4 / 8")).toBeVisible();
	await expect(panel.getByRole("textbox", { name: /^名称（fetch · 吞吐）/ })).toBeFocused();
	await expect
		.poll(() => focusKeysOf(controlPlane, id))
		.toEqual(["fetch:延迟", "fetch:吞吐", "fetch2:请求数", "ping:level"]);
	expect((await sceneView(controlPlane, id)).focus_items[1]).toMatchObject({ title: "母单量" });
});

test("移除之后又改了别的，撤销就消失了：它只管刚做的那一次移除", async ({ page, controlPlane }) => {
	const id = await createFocusScenario(controlPlane);
	await setFocusItems(controlPlane, id, [ORDERS, THROUGHPUT, CHILD]);
	const panel = await openFocusList(page, id);

	await panel.getByRole("button", { name: "移除关注项 下单延迟" }).click();
	await expect(panel.getByRole("button", { name: "撤销" })).toBeVisible();
	await panel.getByRole("button", { name: "下移 母单量" }).click();
	await expect(panel.getByRole("button", { name: "撤销" })).toHaveCount(0);
	await expect.poll(() => focusNames(panel)).toEqual(["子单量", "母单量"]);

	// 别人在这期间改了列表：页面读到以后撤销就消失，它不能把别人的修改盖掉。
	await panel.getByRole("button", { name: "移除关注项 子单量" }).click();
	await expect(panel.getByRole("button", { name: "撤销" })).toBeVisible();
	await setFocusItems(controlPlane, id, [THROUGHPUT, LEVEL], "bob");
	await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
	await expect.poll(() => focusNames(panel)).toEqual(["母单量", "level"]);
	await expect(panel.getByRole("button", { name: "撤销" })).toHaveCount(0);
});

test("移除一个已经失效的项以后也能撤销", async ({ page, controlPlane }) => {
	const id = await createFocusScenario(controlPlane);
	await setFocusItems(controlPlane, id, [THROUGHPUT, LEVEL]);
	await saveVersion(controlPlane, id, 1, {
		...focusDocument,
		nodes: focusDocument.nodes.filter((n) => n.id !== "ping"),
		edges: focusDocument.edges.filter((e) => e.to !== "ping"),
	});
	const panel = await openFocusList(page, id, "fetch2");

	await panel.getByRole("button", { name: "移除关注项 level" }).click();
	await expect.poll(() => focusNames(panel)).toEqual(["母单量"]);
	await panel.getByRole("button", { name: "撤销" }).click();
	await expect.poll(() => focusNames(panel)).toEqual(["母单量", "level"]);
	await expect(page.getByText("无法修改关注项")).toHaveCount(0);
	await expect(panel.getByText("最后修改：")).toContainText("撤销了移除「level」");
	await expect.poll(() => focusKeysOf(controlPlane, id)).toEqual(["fetch:吞吐", "ping:level"]);
});

test("改名后显示新名字，写空或写成图表标题回到图表标题，Esc 放弃这次输入", async ({
	page,
	controlPlane,
}) => {
	const id = await createFocusScenario(controlPlane);
	await setFocusItems(controlPlane, id, [{ node_id: "fetch", chart: "延迟" }, LEVEL]);
	const panel = await openFocusList(page, id);
	const name = panel.getByRole("textbox", { name: /^名称（fetch · 延迟）/ });
	await expect(name).toHaveValue("延迟");

	await name.fill("  撮合延迟 ");
	await page.keyboard.press("Enter");
	await expect(name).toHaveValue("撮合延迟");
	await expect
		.poll(async () => (await sceneView(controlPlane, id)).focus_items[0])
		.toMatchObject({ chart: "延迟", title: "撮合延迟" });
	await expect(panel.getByText("最后修改：")).toContainText("把「延迟」改名为「撮合延迟」");
	// 来源和图表标题还在这一行里，名字改了也认得出是哪一张。
	await expect(row(focusList(panel), "撮合延迟")).toContainText("fetch · 图表 延迟");

	await page.reload();
	await panel.getByRole("tab", { name: "关注项" }).click();
	await expect(name).toHaveValue("撮合延迟");

	await name.fill("放弃的名字");
	await page.keyboard.press("Escape");
	await expect(name).toHaveValue("撮合延迟");

	await name.fill("");
	await name.blur();
	await expect(name).toHaveValue("延迟");
	await expect
		.poll(async () => (await sceneView(controlPlane, id)).focus_items[0])
		.toEqual({ node_id: "fetch", chart: "延迟", status: "ok", chart_type: "line" });
	// 改回原来的名字，正好是上一次修改之前的列表：记为撤销。
	await expect(panel.getByText("最后修改：")).toContainText("撤销了「延迟」的改名");
});

test("每行写来源节点、图表和类型；失效项的两种说明都显示，名额计数里包含它们", async ({
	page,
	controlPlane,
}) => {
	const id = await createFocusScenario(controlPlane);
	await setFocusItems(controlPlane, id, [
		{ node_id: "fetch", chart: "延迟" },
		{ node_id: "fetch2", chart: "errors" },
		{ node_id: "fetch2", chart: "吞吐", title: "子流程吞吐" },
		LEVEL,
	]);
	// 第 2 版：fetch 换成了 ping 节点类型（没有图表「延迟」），ping 节点删掉了。
	await saveVersion(controlPlane, id, 1, {
		...focusDocument,
		nodes: [
			...focusDocument.nodes
				.filter((n) => n.id !== "ping")
				.map((n) => (n.id === "fetch" ? { ...n, node: "ping", inputs: { host: "h" } } : n)),
		],
		edges: focusDocument.edges.filter((e) => e.to !== "ping"),
	});
	const panel = await openFocusList(page, id, "fetch2");

	await expect(panel.getByText("本场景的关注项已用 4 / 8（含 2 项已失效的）")).toBeVisible();
	const rows = focusList(panel).getByRole("listitem");
	await expect(rows).toHaveCount(4);

	await expect(rows.nth(0)).toContainText("fetch · 图表 延迟");
	await expect(rows.nth(0)).toContainText("这个版本的节点没有图表 延迟");
	await expect(rows.nth(1)).toContainText("fetch2 · 图表 errors");
	await expect(rows.nth(1).getByText(/^数值$/)).toHaveCount(1);
	await expect(rows.nth(2)).toContainText("fetch2 · 图表 吞吐");
	await expect(rows.nth(2).getByText(/^图表$/)).toHaveCount(1);
	await expect(rows.nth(3)).toContainText("ping · 图表 level");
	await expect(rows.nth(3)).toContainText(
		"节点 ping 不在最新版本 v2 里，只在运行 v1 及更早版本时显示",
	);
	// 失效的项没有类型可写。
	await expect(rows.nth(0).getByText(/^(数值|图表)$/)).toHaveCount(0);
	await expect(rows.nth(3).getByText(/^(数值|图表)$/)).toHaveCount(0);
});

test("没有关注项时写明怎么添加；节点检查器里设的关注项回到场景设置时已经在列表里", async ({
	page,
	controlPlane,
}) => {
	const id = await createFocusScenario(controlPlane);
	const panel = await openFocusList(page, id);
	await expect(panel.getByText("还没有关注项。")).toBeVisible();
	await expect(panel.getByText("本场景的关注项已用 0 / 8")).toBeVisible();

	await page.locator('[data-node-id="fetch"]').click();
	await panel.getByRole("tab", { name: "说明与指标" }).click();
	await panel.getByRole("button", { name: "把 延迟 设为关注项" }).click();
	await expect(panel.getByRole("button", { name: "把 延迟 设为关注项" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	// Esc 回到画布上的节点，再按一次取消选中：回到场景设置，停在「关注项」页。
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
	await expect(panel.getByRole("heading", { name: "场景设置" })).toBeVisible();
	await expect(panel.getByRole("tab", { name: "关注项" })).toHaveAttribute("aria-selected", "true");
	await expect.poll(() => focusNames(panel)).toEqual(["延迟"]);
});
