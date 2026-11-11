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

const overlap = (
	a: { x: number; y: number; width: number; height: number },
	b: { x: number; y: number; width: number; height: number },
) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const existing = ["entry", "fetch", "dispatch", "ping", "sub_entry", "sub_ping"];

test("工具条「＋」：可搜索的菜单，新节点落在视口中心、不连线；与已有节点重叠时错开；游离节点只警告，可以保存", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	// 选中了某个节点也不影响：「＋」添加的节点没有来源。
	await nodeCard(page, "sub_entry").click();
	await dock(page).getByRole("button", { name: "添加节点" }).click();
	const menu = addMenu(page);
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("group", { name: "内置" })).toBeVisible();
	await expect(menu.getByRole("group", { name: "demo-checks @1.2.0" })).toBeVisible();
	await expect(menu.getByText(/^新节点不连线/)).toBeVisible();
	await expect(menu.getByRole("combobox", { name: "搜索节点类型" })).toBeFocused();

	await menu.getByRole("combobox", { name: "搜索节点类型" }).fill("HTTP");
	await expect(menu.getByRole("option")).toHaveCount(1);
	await menu.getByRole("option", { name: /HTTP 检查/ }).click();
	await expect(menu).toHaveCount(0);

	await expect(nodeCard(page, "http_check_1")).toBeVisible();
	await expect(nodeCard(page, "http_check_1")).toHaveAttribute("aria-pressed", "true");
	await expect(nodeCard(page, "http_check_1")).toBeFocused();
	await expect(page.locator('[data-edge*="http_check_1"]')).toHaveCount(0);
	await expect(page.locator("[data-edge]")).toHaveCount(5);

	// 落在视口中心附近（检查器、顶栏之外的区域），不压住已有节点。
	const added = await box(nodeCard(page, "http_check_1"));
	const inspectorBox = await box(page.getByRole("complementary", { name: "检查器" }));
	expect(Math.abs(added.x + added.width / 2 - inspectorBox.x / 2)).toBeLessThan(300);
	expect(Math.abs(added.y + added.height / 2 - 450)).toBeLessThan(300);
	for (const other of existing) {
		expect(overlap(added, await box(nodeCard(page, other))), other).toBe(false);
	}

	// 再加一个：落点被上一个占了，往右下错开。
	const first = await nodePosition(page, "http_check_1");
	await page.keyboard.press("/");
	await addMenu(page).getByRole("option", { name: /Sleep/ }).click();
	await expect(nodeCard(page, "sleep_1")).toBeVisible();
	const second = await nodePosition(page, "sleep_1");
	if (!first || !second) throw new Error("没有节点位置");
	expect(second.x).toBeGreaterThan(first.x);
	expect(second.y).toBeGreaterThan(first.y);
	const [a, b] = [await box(nodeCard(page, "http_check_1")), await box(nodeCard(page, "sleep_1"))];
	expect(overlap(a, b)).toBe(false);
	await expect(page.locator("[data-edge]")).toHaveCount(5);

	// 游离节点只产生警告，不阻止保存。
	await expect(nodeCard(page, "sleep_1")).toContainText("1 警告");
	await page.getByRole("button", { name: /保存/ }).click();
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const saved = (await headOf(controlPlane, id)) as unknown as {
		document: { nodes: { id: string }[]; edges: { from: string; to: string }[] };
	};
	expect(saved.document.nodes.map((n) => n.id)).toEqual([...existing, "http_check_1", "sleep_1"]);
	expect(saved.document.edges).toHaveLength(5);
});

const paneMenu = (page: Page) => page.getByRole("menu", { name: "画布菜单" });
/** 画布空白处（主链下方、子流程区域左侧）。 */
const BLANK = { x: 200, y: 640 };

test("空白处右键菜单：各项带注册表里的快捷键；「添加节点」的节点落在右键位置、不连线", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	await page.mouse.click(BLANK.x, BLANK.y, { button: "right" });
	const menu = paneMenu(page);
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("menuitem")).toHaveText([
		"添加节点/",
		"粘贴没有可粘贴的节点",
		"整理布局AltShiftF",
		"适配视图0",
		"撤销没有可撤销的修改CtrlZ",
		"重做没有可重做的修改CtrlShiftZ",
	]);
	await expect(menu.getByRole("menuitem", { name: /粘贴/ })).toBeDisabled();
	await expect(menu.getByRole("menuitem", { name: /撤销/ })).toBeDisabled();
	const menuBox = await box(menu);
	expect(Math.abs(menuBox.x - BLANK.x)).toBeLessThan(12);
	expect(Math.abs(menuBox.y - BLANK.y)).toBeLessThan(12);

	await menu.getByRole("menuitem", { name: /添加节点/ }).click();
	await expect(menu).toHaveCount(0);
	const add = addMenu(page);
	await expect(add.getByRole("combobox", { name: "搜索节点类型" })).toBeFocused();
	await expect(add.getByText(/^新节点不连线/)).toBeVisible();
	const addBox = await box(add);
	expect(Math.abs(addBox.x - BLANK.x)).toBeLessThan(12);
	await add.getByRole("option", { name: /定时/ }).click();

	await expect(nodeCard(page, "timer_1")).toBeFocused();
	await expect(page.locator("[data-edge]")).toHaveCount(5);
	// 卡片中心就在右键的位置。
	const card = await box(nodeCard(page, "timer_1"));
	expect(Math.abs(card.x + card.width / 2 - BLANK.x)).toBeLessThan(3);
	expect(Math.abs(card.y + card.height / 2 - BLANK.y)).toBeLessThan(3);

	// 菜单里撤销、重做。
	await page.mouse.click(BLANK.x + 300, BLANK.y + 100, { button: "right" });
	await paneMenu(page).getByRole("menuitem", { name: /撤销/ }).click();
	await expect(nodeCard(page, "timer_1")).toHaveCount(0);
	await page.mouse.click(BLANK.x + 300, BLANK.y + 100, { button: "right" });
	await expect(paneMenu(page).getByRole("menuitem", { name: /撤销/ })).toBeDisabled();
	await paneMenu(page).getByRole("menuitem", { name: /重做/ }).click();
	await expect(nodeCard(page, "timer_1")).toBeVisible();

	// 整理布局。
	const original = await nodePosition(page, "sub_entry");
	await page.mouse.click(BLANK.x + 300, BLANK.y + 100, { button: "right" });
	await paneMenu(page)
		.getByRole("menuitem", { name: /整理布局/ })
		.click();
	await expect.poll(() => nodePosition(page, "sub_entry")).not.toEqual(original);
});

test("空白处右键菜单可用键盘操作：方向键移动、Enter 执行、Esc 关闭后焦点回到画布", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const canvas = page.getByRole("region", { name: /^编排画布/ });
	const menu = paneMenu(page);
	const highlighted = menu.locator('[role="menuitem"][data-highlighted]');

	await page.mouse.click(BLANK.x, BLANK.y, { button: "right" });
	await expect(menu).toBeVisible();
	await page.keyboard.press("ArrowDown");
	await expect(highlighted).toContainText("添加节点");
	// 禁用的项（粘贴）也能走到（读得到原因），但 Enter 不执行。
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("ArrowDown");
	await expect(highlighted).toContainText("整理布局");
	await page.keyboard.press("ArrowUp");
	await page.keyboard.press("ArrowUp");
	await expect(highlighted).toContainText("添加节点");
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
	await expect(canvas).toBeFocused();

	// Enter 执行「添加节点」；添加节点菜单 Esc 关闭后焦点也回到画布。
	await page.mouse.click(BLANK.x, BLANK.y, { button: "right" });
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	await expect(menu).toHaveCount(0);
	await expect(addMenu(page).getByRole("combobox", { name: "搜索节点类型" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(addMenu(page)).toHaveCount(0);
	await expect(canvas).toBeFocused();

	// 「适配视图」：先把画布拖走，再从菜单适配回来。
	const before = await box(nodeCard(page, "entry"));
	await page.mouse.move(BLANK.x, BLANK.y);
	await page.mouse.down();
	await page.mouse.move(BLANK.x + 150, BLANK.y + 60, { steps: 4 });
	await page.mouse.up();
	await expect.poll(async () => (await box(nodeCard(page, "entry"))).x).not.toBe(before.x);
	await page.mouse.click(BLANK.x, BLANK.y, { button: "right" });
	await menu.getByRole("menuitem", { name: /适配视图/ }).click();
	await expect
		.poll(async () => Math.round((await box(nodeCard(page, "entry"))).x))
		.toBe(Math.round(before.x));
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

	// 在节点卡片上用 Tab 或 / 打开：Esc 后焦点回到这张卡片。Tab 接在这个节点后面，/ 不连线。
	await nodeCard(page, "ping").click();
	await page.keyboard.press("Tab");
	await expect(addMenu(page).getByText("新节点接在 ping 之后")).toBeVisible();
	// 子流程入口不能接在链上。
	await expect(addMenu(page).getByRole("option", { name: /子流程入口/ })).toHaveCount(0);
	await closeWithEscape();
	await expect(nodeCard(page, "ping")).toBeFocused();
	await page.keyboard.press("/");
	await expect(addMenu(page).getByText(/^新节点不连线/)).toBeVisible();
	await expect(addMenu(page).getByRole("option", { name: /子流程入口/ })).toHaveCount(1);
	await closeWithEscape();
	await expect(nodeCard(page, "ping")).toBeFocused();

	// 已有出线的节点后面不能再接（链不能分叉）：Tab 提示原因，不打开菜单。
	await nodeCard(page, "fetch").click();
	await page.keyboard.press("Tab");
	await expect(page.getByText("节点 fetch 已有出线，链不能分叉")).toBeVisible();
	await expect(addMenu(page)).toHaveCount(0);

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

	// 焦点在链尾节点上按 Tab：新节点接在它后面，放在它右侧同一行。
	await nodeCard(page, "ping").click();
	await expect(nodeCard(page, "ping")).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(addMenu(page)).toBeVisible();
	await page.keyboard.type("定时");
	await page.keyboard.press("Enter");
	await expect(addMenu(page)).toHaveCount(0);
	await expect(edge(page, "chain:ping->timer_1")).toHaveCount(1);
	await expect(nodeCard(page, "timer_1")).toBeFocused();
	expect(await nodePosition(page, "timer_1")).toEqual({ x: 1008, y: 0 });

	// 子流程的链尾同理。
	await nodeCard(page, "sub_ping").click();
	await page.keyboard.press("Tab");
	await expect(addMenu(page).getByText("新节点接在 sub_ping 之后")).toBeVisible();
	await addMenu(page).getByRole("option", { name: /Sleep/ }).click();
	await expect(edge(page, "chain:sub_ping->sleep_1")).toHaveCount(1);
	await expect(page.getByText("有未保存的修改", { exact: true })).toBeVisible();
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
	await expect(nodeCard(page, "timer_1")).toBeVisible();
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

	// 异步任务节点先换成可以勾选「同时新建子流程」的表单（#187，见 async-subflow.spec.ts），不勾选直接添加。
	await menu.getByRole("option", { name: /异步任务/ }).click();
	await menu
		.getByRole("form", { name: "添加异步任务" })
		.getByRole("button", { name: "添加" })
		.click();
	await expect(edge(page, "chain:ping->async_1")).toHaveCount(1);
	// 新节点的链入口就在松开鼠标的位置。
	const inPort = await box(
		nodeCard(page, "async_1").locator('.react-flow__handle[data-handleid="chain"].target'),
	);
	expect(Math.abs(inPort.x + inPort.width / 2 - drop.x)).toBeLessThan(3);
	expect(Math.abs(inPort.y + inPort.height / 2 - drop.y)).toBeLessThan(3);

	// 已有出线的节点不能往后追加。
	await dragToBlank("fetch");
	await expect(addMenu(page)).toHaveCount(0);
	await expect(page.getByText("节点 fetch 已有出线，链不能分叉")).toBeVisible();
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

test("运行状态下画布只读：工具条不显示添加、撤销 / 重做、整理布局，对应的快捷键不生效；空白处右键菜单只有适配视图", async ({
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

	// 空白处右键菜单只有适配视图。
	await page.mouse.click(BLANK.x, BLANK.y, { button: "right" });
	await expect(paneMenu(page).getByRole("menuitem")).toHaveText(["适配视图0"]);
	await page.keyboard.press("Escape");
	await expect(paneMenu(page)).toHaveCount(0);

	await page.locator("body").press("e");
	await expect(dock(page).getByRole("button", { name: "添加节点" })).toBeVisible();
	await expect(dock(page).getByRole("button", { name: "整理布局" })).toBeVisible();
});
