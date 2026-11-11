import type { Locator, Page } from "@playwright/test";
import { createEditorScenario, headOf, nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";
import { createScenario, expectFocusVisible, publishPackage } from "./support";

// 编排画布的编辑操作（#39）：添加节点、撤销 / 重做、整理布局。

const dock = (page: Page) => page.getByRole("toolbar", { name: "画布工具" });
const addMenu = (page: Page) => page.getByRole("dialog", { name: "添加节点" });
const edge = (page: Page, id: string) => page.locator(`[data-edge="${id}"]`);

async function box(locator: Locator) {
	const b = await locator.boundingBox();
	if (!b) throw new Error("元素不可见");
	return b;
}

/** 节点在画布坐标里的位置（React Flow 写在节点外层的 transform 上）。 */
const nodePosition = (page: Page, id: string) =>
	page.locator(`.react-flow__node[data-id="${id}"]`).evaluate((el) => {
		const m = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(
			(el as HTMLElement).style.transform,
		);
		return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
	});

async function openEditor(page: Page, id: string, lastNode = "sub_ping") {
	await page.goto(`/orchestrations/${id}`);
	await expect(nodeCard(page, lastNode)).toBeVisible();
	await expect
		.poll(async () => JSON.stringify(await nodeCard(page, "entry").boundingBox()))
		.toBe(JSON.stringify(await nodeCard(page, "entry").boundingBox()));
}

test("工具条「＋」：可搜索的菜单，新节点接在主链链尾；选中子流程里的节点时接在子流程的链尾", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	await dock(page).getByRole("button", { name: "添加节点" }).click();
	const menu = addMenu(page);
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("group", { name: "内置" })).toBeVisible();
	await expect(menu.getByRole("group", { name: "demo-checks @1.2.0" })).toBeVisible();
	await expect(menu.getByText("新节点接在 ping 之后")).toBeVisible();
	await expect(menu.getByRole("combobox", { name: "搜索节点类型" })).toBeFocused();

	await menu.getByRole("combobox", { name: "搜索节点类型" }).fill("HTTP");
	await expect(menu.getByRole("option")).toHaveCount(1);
	await menu.getByRole("option", { name: /HTTP 检查/ }).click();
	await expect(menu).toHaveCount(0);

	await expect(nodeCard(page, "http_check_1")).toBeVisible();
	await expect(nodeCard(page, "http_check_1")).toHaveAttribute("aria-pressed", "true");
	await expect(nodeCard(page, "http_check_1")).toBeFocused();
	await expect(edge(page, "chain:ping->http_check_1")).toHaveCount(1);
	// 接在链尾的右侧，同一行。
	expect(await nodePosition(page, "http_check_1")).toEqual({ x: 1008, y: 0 });

	// 选中子流程里的节点：接在子流程的链尾。
	await nodeCard(page, "sub_entry").click();
	await dock(page).getByRole("button", { name: "添加节点" }).click();
	await expect(addMenu(page).getByText("新节点接在 sub_ping 之后")).toBeVisible();
	await addMenu(page).getByRole("option", { name: /Sleep/ }).click();
	await expect(edge(page, "chain:sub_ping->sleep_1")).toHaveCount(1);
	await expect(page.getByText("有未保存的修改", { exact: true })).toBeVisible();
});

test("Tab 或 / 打开节点搜索；Esc 关闭后焦点回到原处", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	const addButton = dock(page).getByRole("button", { name: "添加节点" });
	const closeWithEscape = async () => {
		await expect(addMenu(page)).toBeVisible();
		await expect(addMenu(page).getByRole("combobox", { name: "搜索节点类型" })).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(addMenu(page)).toHaveCount(0);
	};

	// 页面上没有焦点时 Tab 照常进入页面，不打开菜单；用 Tab 走到画布区域上也不打开（键盘用户能进出画布）。
	const canvas = page.getByRole("region", { name: /^编排画布/ });
	await page.keyboard.press("Tab");
	await expect(addMenu(page)).toHaveCount(0);
	await canvas.focus();
	await expectFocusVisible(canvas);
	await page.keyboard.press("Tab");
	await expect(addMenu(page)).toHaveCount(0);
	await expect(canvas).not.toBeFocused();

	// 用鼠标点过画布空白处后 Tab 打开：Esc 后焦点回到画布。
	await page.locator(".react-flow__pane").click({ position: { x: 40, y: 400 } });
	await page.keyboard.press("Tab");
	await closeWithEscape();
	await expect(canvas).toBeFocused();

	// 在节点卡片上用 Tab 或 / 打开：Esc 后焦点回到这张卡片。
	await nodeCard(page, "fetch").click();
	await page.keyboard.press("Tab");
	await closeWithEscape();
	await expect(nodeCard(page, "fetch")).toBeFocused();
	await page.keyboard.press("/");
	await closeWithEscape();
	await expect(nodeCard(page, "fetch")).toBeFocused();

	// 点工具条按钮打开：Esc 后回到按钮。
	await nodeCard(page, "fetch").click();
	await addButton.click();
	await closeWithEscape();
	await expect(addButton).toBeFocused();

	// 焦点在工具条按钮上时 Tab 照常切换焦点。
	await dock(page).getByRole("button", { name: "指针" }).focus();
	await page.keyboard.press("Tab");
	await expect(addMenu(page)).toHaveCount(0);
	await expect(dock(page).getByRole("button", { name: "抓手" })).toBeFocused();

	await nodeCard(page, "fetch").click();
	await expect(nodeCard(page, "fetch")).toBeFocused();
	await page.keyboard.press("/");
	await expect(addMenu(page)).toBeVisible();
	await page.keyboard.type("定时");
	await page.keyboard.press("Enter");
	await expect(addMenu(page)).toHaveCount(0);
	await expect(edge(page, "chain:ping->timer_1")).toHaveCount(1);
	await expect(nodeCard(page, "timer_1")).toBeFocused();
});

test("按 / 后立即输入并回车：渲染帧来得晚时输入也不丢，选中过滤后的节点（#123）", async ({
	page,
	controlPlane,
}) => {
	// 模拟机器繁忙时渲染帧来得晚：requestAnimationFrame 的回调推迟 300ms 执行。
	// 搜索框若等下一帧才拿到焦点，这段时间里输入的字会落在节点卡片上丢掉，回车选中的是过滤前的第一项。
	await page.addInitScript(() => {
		const raf = window.requestAnimationFrame.bind(window);
		window.requestAnimationFrame = (callback) =>
			raf((time) => setTimeout(() => callback(time), 300)) as number;
	});
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	await nodeCard(page, "fetch").click();
	await expect(nodeCard(page, "fetch")).toBeFocused();
	await page.keyboard.press("/");
	await page.keyboard.type("定时");
	await page.keyboard.press("Enter");
	await expect(addMenu(page)).toHaveCount(0);
	await expect(edge(page, "chain:ping->timer_1")).toHaveCount(1);
	await expect(nodeCard(page, "async_1")).toHaveCount(0);
});

test("从链尾端口拖线到空白处：弹出可以接上的节点菜单，新节点放在松开鼠标的位置", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	const port = (nodeId: string) =>
		nodeCard(page, nodeId).locator('.react-flow__handle[data-handleid="chain"].source');
	const dragToBlank = async (nodeId: string) => {
		const from = await box(port(nodeId));
		const x = from.x + from.width / 2;
		const y = from.y + from.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x + 40, y + 60, { steps: 4 });
		await page.mouse.move(x + 80, y + 110, { steps: 4 });
		await page.mouse.up();
		return { x: x + 80, y: y + 110 };
	};

	const drop = await dragToBlank("ping");
	const menu = addMenu(page);
	await expect(menu).toBeVisible();
	await expect(menu.getByText("新节点接在 ping 之后")).toBeVisible();
	// 子流程入口不能接在链上。
	await expect(menu.getByRole("option", { name: /子流程入口/ })).toHaveCount(0);
	const menuBox = await box(menu);
	expect(Math.abs(menuBox.x - drop.x)).toBeLessThan(12);
	expect(Math.abs(menuBox.y - drop.y)).toBeLessThan(12);

	// Esc 关闭：焦点回到拖出连线的节点。再拖一次接着选。
	await expect(menu.getByRole("combobox", { name: "搜索节点类型" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
	await expect(nodeCard(page, "ping")).toBeFocused();
	await dragToBlank("ping");
	await expect(menu).toBeVisible();

	await menu.getByRole("option", { name: /异步任务/ }).click();
	await expect(edge(page, "chain:ping->async_1")).toHaveCount(1);
	// 新节点的链入口就在松开鼠标的位置。
	const inPort = await box(
		nodeCard(page, "async_1").locator('.react-flow__handle[data-handleid="chain"].target'),
	);
	expect(Math.abs(inPort.x + inPort.width / 2 - drop.x)).toBeLessThan(3);
	expect(Math.abs(inPort.y + inPort.height / 2 - drop.y)).toBeLessThan(3);

	// 不是链尾的节点不能往后追加。
	await dragToBlank("fetch");
	await expect(addMenu(page)).toHaveCount(0);
	await expect(page.getByText("只能在主链或子流程的链尾追加节点")).toBeVisible();
});

test("撤销 / 重做：删除节点（连带连线）、移动、参数修改都可以撤销", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const undo = dock(page).getByRole("button", { name: "撤销" });
	const redo = dock(page).getByRole("button", { name: "重做" });
	await expect(undo).toBeDisabled();
	await expect(redo).toBeDisabled();

	// Delete 删除节点，Ctrl Z 恢复节点和连线，Ctrl Shift Z 再删掉。
	await nodeCard(page, "fetch").click();
	await page.keyboard.press("Delete");
	await expect(nodeCard(page, "fetch")).toHaveCount(0);
	await expect(edge(page, "chain:entry->fetch")).toHaveCount(0);
	await expect(edge(page, "chain:fetch->dispatch")).toHaveCount(0);
	await page.keyboard.press("Control+z");
	await expect(nodeCard(page, "fetch")).toBeVisible();
	await expect(edge(page, "chain:entry->fetch")).toHaveCount(1);
	await expect(edge(page, "chain:fetch->dispatch")).toHaveCount(1);
	await expect(redo).toBeEnabled();
	await page.keyboard.press("Control+Shift+z");
	await expect(nodeCard(page, "fetch")).toHaveCount(0);
	await page.keyboard.press("Control+z");
	await expect(nodeCard(page, "fetch")).toBeVisible();

	// 移动节点。
	const before = await nodePosition(page, "ping");
	const card = await box(nodeCard(page, "ping"));
	await page.mouse.move(card.x + 60, card.y + 50);
	await page.mouse.down();
	await page.mouse.move(card.x + 100, card.y + 90, { steps: 5 });
	await page.mouse.up();
	await expect.poll(() => nodePosition(page, "ping")).not.toEqual(before);
	await undo.click();
	await expect.poll(() => nodePosition(page, "ping")).toEqual(before);

	// 参数修改：连续输入算一步。
	await nodeCard(page, "fetch").click();
	const url = page
		.getByRole("complementary", { name: "检查器" })
		.getByRole("combobox", { name: "输入 url" });
	await url.fill("https://example.test/a");
	await url.pressSequentially("bc");
	await expect(url).toHaveText("https://example.test/abc");
	// 焦点在输入框里时 Ctrl Z 是输入框自己的撤销，用工具条按钮撤销画布上的修改。
	await undo.click();
	await expect(url).toHaveText("https://example.test/snap");
	await redo.click();
	await expect(url).toHaveText("https://example.test/abc");

	// 撤销到底就和已保存的版本一样。
	await undo.click();
	await expect(page.getByText("已保存", { exact: true })).toBeVisible();
	await expect(undo).toBeDisabled();
	expect((await headOf(controlPlane, id)).number).toBe(1);
});

test("整理布局（Alt Shift F）：主链在上、子流程放在下方区域；可以撤销", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const original = await nodePosition(page, "sub_entry");

	await page.keyboard.press("Alt+Shift+F");
	await expect(page.getByText("已整理布局")).toBeVisible();
	// dispatch 在主链第 3 位（x 504），子流程从它右下方开始。
	await expect.poll(() => nodePosition(page, "dispatch")).toEqual({ x: 504, y: 0 });
	expect(await nodePosition(page, "sub_entry")).toEqual({ x: 714, y: 256 });
	expect(await nodePosition(page, "sub_ping")).toEqual({ x: 966, y: 256 });

	await page.keyboard.press("Control+z");
	await expect.poll(() => nodePosition(page, "sub_entry")).toEqual(original);

	await dock(page).getByRole("button", { name: "整理布局" }).click();
	await expect.poll(() => nodePosition(page, "sub_entry")).toEqual({ x: 714, y: 256 });
	await dock(page).getByRole("button", { name: "撤销" }).click();
	await expect.poll(() => nodePosition(page, "sub_entry")).toEqual(original);
});

test("通过 API 创建、缺少布局的场景打开时用整理布局得到初始布局", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane);
	const main = ["a", "b", "c", "d", "e"];
	const id = await createScenario(controlPlane, "没有布局", {
		default_agent: "agent-linux",
		nodes: [
			{ id: "entry", kind: "entry", params: [] },
			...main.map((n) => ({ id: n, kind: "package", package: "demo-checks", node: "ping" })),
		],
		edges: ["entry", ...main].slice(1).map((to, i) => ({
			from: i === 0 ? "entry" : main[i - 1],
			to,
			kind: "chain",
		})),
		packages: { "demo-checks": "1.2.0" },
	});
	await openEditor(page, id, "e");

	// 6 个节点的主链按两行折返：每行 3 个。
	expect(await nodePosition(page, "entry")).toEqual({ x: 0, y: 0 });
	expect(await nodePosition(page, "b")).toEqual({ x: 504, y: 0 });
	expect(await nodePosition(page, "c")).toEqual({ x: 0, y: 214 });
	expect(await nodePosition(page, "e")).toEqual({ x: 504, y: 214 });
	// 补齐布局不算修改。
	await expect(page.getByText("已保存", { exact: true })).toBeVisible();
});

test("运行状态下画布只读：工具条不显示添加、撤销 / 重做、整理布局，对应的快捷键不生效", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const original = await nodePosition(page, "sub_entry");

	await page.locator("body").press("r");
	await expect(page.getByRole("button", { name: /保存/ })).toHaveCount(0);
	for (const tool of ["添加节点", "撤销", "重做", "整理布局"]) {
		await expect(dock(page).getByRole("button", { name: tool })).toHaveCount(0);
	}
	await page.keyboard.press("Tab");
	await page.keyboard.press("/");
	await expect(addMenu(page)).toHaveCount(0);
	await page.keyboard.press("Alt+Shift+F");
	await expect(page.getByText("已整理布局")).toHaveCount(0);
	expect(await nodePosition(page, "sub_entry")).toEqual(original);

	await page.locator("body").press("e");
	await expect(dock(page).getByRole("button", { name: "添加节点" })).toBeVisible();
	await expect(dock(page).getByRole("button", { name: "整理布局" })).toBeVisible();
});
