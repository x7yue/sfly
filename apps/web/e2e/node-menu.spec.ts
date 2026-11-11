// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import type { Page } from "@playwright/test";
import { createEditorScenario, headOf, nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";

// 节点右键菜单与链上的操作（#184）：在后面添加或插入、复制 ID 与输出引用、断开入线 / 出线、删除后自动接上。

const dock = (page: Page) => page.getByRole("toolbar", { name: "画布工具" });
const addMenu = (page: Page) => page.getByRole("dialog", { name: "添加节点" });
const nodeMenu = (page: Page) => page.getByRole("menu", { name: "节点菜单" });
const edges = (page: Page) =>
	page
		.locator("[data-edge]")
		.evaluateAll((els) => els.map((el) => el.getAttribute("data-edge") ?? "").sort());
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

const ORIGINAL = [
	"chain:dispatch->ping",
	"chain:entry->fetch",
	"chain:fetch->dispatch",
	"chain:sub_entry->sub_ping",
	"dispatch:dispatch->sub_entry",
];

/** 节点在画布坐标里的位置（React Flow 写在节点外层的 transform 上）。 */
const nodePosition = (page: Page, id: string) =>
	page.locator(`.react-flow__node[data-id="${id}"]`).evaluate((el) => {
		const m = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(
			(el as HTMLElement).style.transform,
		);
		return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
	});

async function openEditor(page: Page, id: string) {
	await page.goto(`/orchestrations/${id}`);
	await expect(nodeCard(page, "sub_ping")).toBeVisible();
	await expect(dock(page)).toBeVisible();
}

const openMenu = async (page: Page, id: string) => {
	await nodeCard(page, id).click({ button: "right" });
	await expect(nodeMenu(page)).toBeVisible();
	return nodeMenu(page);
};

test.beforeEach(async ({ context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

test("节点右键和 Shift+F10 打开同一个菜单，关闭后焦点回到节点；入口节点没有「创建副本」「复制」「删除」，没有连线的方向禁用并说明原因", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	const items = [
		"在后面添加节点Tab",
		"创建副本CtrlD",
		"复制CtrlC",
		"复制节点 ID",
		"复制输出引用",
		"断开入线",
		"断开出线",
		"删除节点Delete",
	];
	const menu = await openMenu(page, "fetch");
	await expect(menu.getByRole("menuitem")).toHaveText(items);
	// 右键的节点被选中，菜单出现在鼠标的位置。
	await expect(nodeCard(page, "fetch")).toHaveAttribute("aria-pressed", "true");
	const card = await nodeCard(page, "fetch").boundingBox();
	const at = await menu.boundingBox();
	if (!card || !at) throw new Error("元素不可见");
	expect(Math.abs(at.x - (card.x + card.width / 2))).toBeLessThan(12);
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
	await expect(nodeCard(page, "fetch")).toBeFocused();

	// 键盘：Shift+F10 打开同样的菜单（贴着节点卡片），方向键移动，Esc 关闭后焦点回到节点。
	await page.keyboard.press("Shift+F10");
	await expect(menu.getByRole("menuitem")).toHaveText(items);
	await page.keyboard.press("ArrowDown");
	await expect(menu.locator('[role="menuitem"][data-highlighted]')).toContainText("在后面添加节点");
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
	await expect(nodeCard(page, "fetch")).toBeFocused();
	// 菜单键同理。
	await page.keyboard.press("ContextMenu");
	await expect(menu).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(nodeCard(page, "fetch")).toBeFocused();

	// 入口节点：没有「删除」，没有入线。
	await openMenu(page, "entry");
	await expect(menu.getByRole("menuitem")).toHaveText([
		"在后面添加节点Tab",
		"复制节点 ID",
		"复制输出引用这个节点没有声明输出",
		"断开入线这个节点没有入线",
		"断开出线",
	]);
	await expect(menu.getByRole("menuitem", { name: /断开入线/ })).toBeDisabled();
	await expect(menu.getByRole("menuitem", { name: /复制输出引用/ })).toBeDisabled();
	await page.keyboard.press("Escape");

	// 链尾：没有出线。
	await openMenu(page, "ping");
	await expect(menu.getByRole("menuitem", { name: /断开出线/ })).toHaveText(
		"断开出线这个节点没有出线",
	);
	await expect(menu.getByRole("menuitem", { name: /断开出线/ })).toBeDisabled();
	await expect(menu.getByRole("menuitem", { name: /断开入线/ })).toBeEnabled();
});

test("复制节点 ID；「复制输出引用」列出节点类型声明的每个输出，选中后把引用写入剪贴板", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	let menu = await openMenu(page, "fetch");
	await menu.getByRole("menuitem", { name: "复制节点 ID" }).click();
	await expect(page.getByText("已复制节点 ID")).toBeVisible();
	expect(await clipboard(page)).toBe("fetch");

	menu = await openMenu(page, "fetch");
	await menu.getByRole("menuitem", { name: "复制输出引用" }).click();
	const outputs = page.getByRole("menu", { name: "复制输出引用" });
	await expect(outputs.getByRole("menuitem")).toHaveText(["status"]);
	await outputs.getByRole("menuitem", { name: "status" }).click();
	await expect(menu).toHaveCount(0);
	await expect(page.getByText("已复制输出引用")).toBeVisible();
	expect(await clipboard(page)).toBe("${{ nodes.fetch.outputs.status }}");

	// 内置节点的输出同样列出；键盘也能走进子菜单。
	await nodeCard(page, "dispatch").click();
	await page.keyboard.press("Shift+F10");
	await expect(nodeMenu(page)).toBeFocused();
	const highlighted = nodeMenu(page).locator('[role="menuitem"][data-highlighted]');
	for (const item of ["在后面添加节点", "创建副本", "复制", "复制节点 ID", "复制输出引用"]) {
		await page.keyboard.press("ArrowDown");
		await expect(highlighted).toContainText(item);
	}
	await page.keyboard.press("ArrowRight");
	await expect(outputs.getByRole("menuitem")).toHaveText(["chain_instance_id"]);
	await page.keyboard.press("Enter");
	await expect(nodeMenu(page)).toHaveCount(0);
	await expect.poll(() => clipboard(page)).toBe("${{ nodes.dispatch.outputs.chain_instance_id }}");
	// 没有改动场景。
	await expect(page.getByText("已保存", { exact: true })).toBeVisible();
});

test("「在后面添加节点」：非链尾节点是插入，后面的节点后移不重叠；链尾节点是追加；插入是一步撤销", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	let menu = await openMenu(page, "fetch");
	await menu.getByRole("menuitem", { name: /在后面添加节点/ }).click();
	await expect(addMenu(page).getByText("新节点插在 fetch 和 dispatch 之间")).toBeVisible();
	// 子流程入口不能接在链上。
	await expect(addMenu(page).getByRole("option", { name: /子流程入口/ })).toHaveCount(0);
	// Esc 关闭后焦点回到节点。
	await expect(addMenu(page).getByRole("combobox", { name: "搜索节点类型" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(nodeCard(page, "fetch")).toBeFocused();

	menu = await openMenu(page, "fetch");
	await menu.getByRole("menuitem", { name: /在后面添加节点/ }).click();
	await addMenu(page).getByRole("option", { name: /Sleep/ }).click();
	await expect(nodeCard(page, "sleep_1")).toBeFocused();
	await expect
		.poll(() => edges(page))
		.toEqual(
			[
				"chain:dispatch->ping",
				"chain:entry->fetch",
				"chain:fetch->sleep_1",
				"chain:sleep_1->dispatch",
				"chain:sub_entry->sub_ping",
				"dispatch:dispatch->sub_entry",
			].sort(),
		);
	// 新节点占了原来 dispatch 的位置，同一行后面的节点各后移一列；子流程那一行不动。
	expect(await nodePosition(page, "sleep_1")).toEqual({ x: 504, y: 0 });
	expect(await nodePosition(page, "dispatch")).toEqual({ x: 756, y: 0 });
	expect(await nodePosition(page, "ping")).toEqual({ x: 1008, y: 0 });
	expect(await nodePosition(page, "fetch")).toEqual({ x: 252, y: 0 });
	expect(await nodePosition(page, "sub_entry")).toEqual({ x: 660, y: 230 });

	// 一步撤销：节点、连线、位置都回去；重做再来。
	await dock(page).getByRole("button", { name: "撤销" }).click();
	await expect(nodeCard(page, "sleep_1")).toHaveCount(0);
	await expect.poll(() => edges(page)).toEqual(ORIGINAL);
	expect(await nodePosition(page, "dispatch")).toEqual({ x: 504, y: 0 });
	expect(await nodePosition(page, "ping")).toEqual({ x: 756, y: 0 });
	await expect(dock(page).getByRole("button", { name: "撤销" })).toBeDisabled();
	await dock(page).getByRole("button", { name: "重做" }).click();
	await expect(nodeCard(page, "sleep_1")).toBeVisible();
	expect(await nodePosition(page, "ping")).toEqual({ x: 1008, y: 0 });

	// 焦点在非链尾节点上按 Tab 也是插入。
	await nodeCard(page, "entry").click();
	await page.keyboard.press("Tab");
	await expect(addMenu(page).getByText("新节点插在 entry 和 fetch 之间")).toBeVisible();
	await expect(addMenu(page).getByRole("combobox", { name: "搜索节点类型" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(addMenu(page)).toHaveCount(0);

	// 链尾节点：追加。后移后的 ping 可能在检查器下面：用方向键沿链走过去（画布把它移进可见区域），键盘打开菜单。
	await expect(nodeCard(page, "entry")).toBeFocused();
	for (const next of ["fetch", "sleep_1", "dispatch", "ping"]) {
		await page.keyboard.press("ArrowRight");
		await expect(nodeCard(page, next)).toBeFocused();
	}
	await page.keyboard.press("Shift+F10");
	menu = nodeMenu(page);
	await expect(menu).toBeVisible();
	await menu.getByRole("menuitem", { name: /在后面添加节点/ }).click();
	await expect(addMenu(page).getByText("新节点接在 ping 之后")).toBeVisible();
	await addMenu(page).getByRole("option", { name: /定时/ }).click();
	await expect(page.locator('[data-edge="chain:ping->timer_1"]')).toHaveCount(1);
	expect(await nodePosition(page, "timer_1")).toEqual({ x: 1260, y: 0 });

	// 保存下来的链是 entry → fetch → sleep_1 → dispatch → ping → timer_1。
	await page.getByRole("button", { name: /保存/ }).click();
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const saved = (await headOf(controlPlane, id)) as unknown as {
		document: { edges: { from: string; to: string; kind: string }[] };
	};
	expect(
		saved.document.edges.filter((e) => e.kind === "chain").map((e) => `${e.from}>${e.to}`),
	).toEqual([
		"entry>fetch",
		"fetch>sleep_1",
		"sleep_1>dispatch",
		"dispatch>ping",
		"sub_entry>sub_ping",
		"ping>timer_1",
	]);
});

test("删除链中间的节点后前后自动接上：菜单、Delete 键、检查器的删除按钮行为相同，各是一步撤销", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const undo = dock(page).getByRole("button", { name: "撤销" });
	const bridged = [
		"chain:dispatch->ping",
		"chain:entry->dispatch",
		"chain:sub_entry->sub_ping",
		"dispatch:dispatch->sub_entry",
	];

	// 菜单里删除。
	const menu = await openMenu(page, "fetch");
	await menu.getByRole("menuitem", { name: /删除节点/ }).click();
	await expect(nodeCard(page, "fetch")).toHaveCount(0);
	await expect.poll(() => edges(page)).toEqual(bridged);
	await undo.click();
	await expect(nodeCard(page, "fetch")).toBeVisible();
	await expect.poll(() => edges(page)).toEqual(ORIGINAL);
	await expect(undo).toBeDisabled();

	// Delete 键。
	await nodeCard(page, "fetch").click();
	await page.keyboard.press("Delete");
	await expect(nodeCard(page, "fetch")).toHaveCount(0);
	await expect.poll(() => edges(page)).toEqual(bridged);
	await page.keyboard.press("Control+z");
	await expect.poll(() => edges(page)).toEqual(ORIGINAL);
	await expect(undo).toBeDisabled();

	// 检查器的删除按钮。
	await nodeCard(page, "fetch").click();
	await page
		.getByRole("complementary", { name: "检查器" })
		.getByRole("button", { name: "删除节点" })
		.click();
	await expect(nodeCard(page, "fetch")).toHaveCount(0);
	await expect.poll(() => edges(page)).toEqual(bridged);
	await undo.click();
	await expect.poll(() => edges(page)).toEqual(ORIGINAL);

	// 异步任务节点：调度连线一并删除，链照样接上；子流程留着（变成没有被触发的子流程）。
	await nodeCard(page, "dispatch").click();
	await page.keyboard.press("Delete");
	await expect(nodeCard(page, "dispatch")).toHaveCount(0);
	await expect
		.poll(() => edges(page))
		.toEqual(["chain:entry->fetch", "chain:fetch->ping", "chain:sub_entry->sub_ping"]);
	await expect(nodeCard(page, "sub_entry")).toBeVisible();
	await undo.click();
	await expect.poll(() => edges(page)).toEqual(ORIGINAL);

	// 入口节点删不掉。
	await nodeCard(page, "entry").click();
	await page.keyboard.press("Delete");
	await expect(nodeCard(page, "entry")).toBeVisible();
	await expect.poll(() => edges(page)).toEqual(ORIGINAL);
});

test("断开入线、断开出线：只删对应的连线，可以撤销", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	let menu = await openMenu(page, "dispatch");
	await menu.getByRole("menuitem", { name: "断开入线" }).click();
	await expect
		.poll(() => edges(page))
		.toEqual(ORIGINAL.filter((e) => e !== "chain:fetch->dispatch"));
	// 断开后 fetch 成了链尾，dispatch 没有入线了。
	menu = await openMenu(page, "dispatch");
	await expect(menu.getByRole("menuitem", { name: /断开入线/ })).toBeDisabled();
	// 出线只算链上的连线：调度连线留着。
	await menu.getByRole("menuitem", { name: "断开出线" }).click();
	await expect
		.poll(() => edges(page))
		.toEqual(["chain:entry->fetch", "chain:sub_entry->sub_ping", "dispatch:dispatch->sub_entry"]);

	// 子流程入口节点的入线是调度连线。
	menu = await openMenu(page, "sub_entry");
	await menu.getByRole("menuitem", { name: "断开入线" }).click();
	await expect.poll(() => edges(page)).toEqual(["chain:entry->fetch", "chain:sub_entry->sub_ping"]);

	const undo = dock(page).getByRole("button", { name: "撤销" });
	await undo.click();
	await undo.click();
	await undo.click();
	await expect.poll(() => edges(page)).toEqual(ORIGINAL);
	await expect(undo).toBeDisabled();
});

test("运行状态模式下节点菜单只有复制节点 ID、复制输出引用", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await page.locator("body").press("r");
	await expect(page.getByRole("button", { name: /保存/ })).toHaveCount(0);

	const menu = await openMenu(page, "fetch");
	await expect(menu.getByRole("menuitem")).toHaveText(["复制节点 ID", "复制输出引用"]);
	await menu.getByRole("menuitem", { name: "复制输出引用" }).click();
	await page
		.getByRole("menu", { name: "复制输出引用" })
		.getByRole("menuitem", { name: "status" })
		.click();
	await expect.poll(() => clipboard(page)).toBe("${{ nodes.fetch.outputs.status }}");

	// 键盘同样只有这两项；Delete 不删除节点。
	await page.keyboard.press("Shift+F10");
	await expect(menu.getByRole("menuitem")).toHaveText(["复制节点 ID", "复制输出引用"]);
	await page.keyboard.press("Escape");
	await expect(nodeCard(page, "fetch")).toBeFocused();
	await page.keyboard.press("Delete");
	await expect(nodeCard(page, "fetch")).toBeVisible();
});
