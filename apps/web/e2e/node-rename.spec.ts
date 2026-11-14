import type { Locator, Page } from "@playwright/test";
import {
	createEditorScenario,
	dock,
	editorDocument,
	headOf,
	inspector,
	nodeCard,
	nodeMenu,
	openEditor,
	switchMode,
} from "./editor-support";
import { expect, test } from "./fixtures";
import { box, createScenario, publishPackage } from "./support";

// 原地改显示名称（#312）：双击卡片标题、选中节点后按 F2、节点右键菜单（Shift+F10）的「重命名」三种方式，
// Enter 确认、Esc 取消；确认空白就是清除显示名称；一次改名是一步撤销；只读的画布不能改名。

const NAME = "创建测试用户";
const OTHER = "查询测试用户";

const titleOf = (card: Locator) => card.locator('[data-slot="base-node-title"]');
const headerOf = (card: Locator) => card.locator('[data-slot="base-node-header"]');
const renameBox = (card: Locator) => card.getByRole("textbox", { name: "显示名称" });
const undo = (page: Page) => dock(page).getByRole("button", { name: "撤销" });
const redo = (page: Page) => dock(page).getByRole("button", { name: "重做" });
const unsaved = (page: Page) => page.getByText("有未保存的修改");
/** 画布当前的视口变换（平移与缩放）。 */
const viewport = (page: Page) =>
	page.locator(".react-flow__viewport").evaluate((el) => (el as HTMLElement).style.transform);

/** 给 fetch 节点起好显示名称的场景（保存为版本 1）。 */
async function namedScenario(cp: Parameters<typeof createScenario>[0], name = NAME) {
	await publishPackage(cp);
	const named = {
		...editorDocument,
		nodes: editorDocument.nodes.map((n) => (n.id === "fetch" ? { ...n, display_name: name } : n)),
	};
	return createScenario(cp, "有显示名称的场景", named);
}

async function save(page: Page, version: number) {
	await page.getByRole("button", { name: /保存/ }).click();
	await expect(page.getByText(`已保存为版本 ${version}`)).toBeVisible();
}

test.beforeEach(async ({ context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

test("双击卡片标题原地改名：输入框有无障碍名称，卡片尺寸不变，Enter 确认；保存、刷新后仍在", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const fetch = nodeCard(page, "fetch");
	const before = await box(fetch);

	await titleOf(fetch).dblclick();
	// 输入框有名称、拿到焦点；没有显示名称时是空的，占位文字是当前的默认标题。
	const input = renameBox(fetch);
	await expect(input).toBeFocused();
	await expect(input).toHaveValue("");
	await expect(input).toHaveAttribute("placeholder", "HTTP 检查");
	await expect(titleOf(fetch)).toHaveCount(0);
	expect(await box(fetch)).toEqual(before);

	await input.fill(`  ${NAME}  `);
	expect(await box(fetch)).toEqual(before);
	// 输入的过程中还没有改场景。
	await expect(unsaved(page)).toHaveCount(0);
	await input.press("Enter");

	await expect(input).toHaveCount(0);
	await expect(titleOf(fetch)).toHaveText(NAME);
	await expect(headerOf(fetch)).toContainText("HTTP 检查");
	await expect(fetch).toHaveAttribute("aria-label", `节点 fetch，HTTP 检查，${NAME}`);
	expect(await box(fetch)).toEqual(before);
	// 确认之后焦点回到卡片，键盘接着操作；检查器里是同一个名称。
	await expect(fetch).toBeFocused();
	await expect(unsaved(page)).toBeVisible();
	await expect(inspector(page).getByRole("textbox", { name: "显示名称" })).toHaveValue(NAME);

	await save(page, 2);
	const nodes = (await headOf(controlPlane, id)).document.nodes as Record<string, unknown>[];
	expect(nodes.find((n) => n.id === "fetch")?.display_name).toBe(NAME);
	await page.reload();
	await expect(titleOf(nodeCard(page, "fetch"))).toHaveText(NAME);
});

test("双击标题不触发画布的双击缩放；双击空白处仍然缩放", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const start = await viewport(page);

	// 对照：双击空白处缩放（节点下面的一片空白）。
	const pane = page.locator(".react-flow__pane");
	const fetch = await box(nodeCard(page, "fetch"));
	await pane.dblclick({
		position: { x: fetch.x + fetch.width / 2, y: fetch.y + fetch.height + 160 },
	});
	await expect.poll(() => viewport(page)).not.toBe(start);

	await page.reload();
	await openEditor(page, id);
	const settled = await viewport(page);
	await titleOf(nodeCard(page, "fetch")).dblclick();
	await expect(renameBox(nodeCard(page, "fetch"))).toBeFocused();
	// 缩放的动画不到半秒：等它本该结束的时候，视口没有动。
	await page.waitForTimeout(600);
	expect(await viewport(page)).toBe(settled);

	// 抓手工具下节点不能拖动、不挡画布的双击缩放，双击标题同样只改名。
	await page.keyboard.press("Escape");
	await page.locator("body").press("h");
	await expect(page.locator("[data-tool]")).toHaveAttribute("data-tool", "hand");
	await titleOf(nodeCard(page, "ping")).dblclick();
	await expect(renameBox(nodeCard(page, "ping"))).toBeFocused();
	await page.waitForTimeout(600);
	expect(await viewport(page)).toBe(settled);
});

test("选中节点后按 F2 原地改名；焦点在输入框里时 F2 不重复触发", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const fetch = nodeCard(page, "fetch");

	// 没有选中节点时 F2 什么也不做。
	await page.locator("body").press("F2");
	await expect(page.getByRole("textbox", { name: "显示名称" })).toHaveCount(0);

	await fetch.click();
	await page.keyboard.press("F2");
	const input = renameBox(fetch);
	await expect(input).toBeFocused();
	await input.fill(NAME);
	await input.press("F2");
	await expect(input).toHaveValue(NAME);
	await input.press("Enter");
	await expect(titleOf(fetch)).toHaveText(NAME);

	// 用方向键沿链选中、聚焦节点后同样可以：入口节点的占位文字是「入口」。
	await page.keyboard.press("ArrowLeft");
	await expect(nodeCard(page, "entry")).toBeFocused();
	await page.keyboard.press("F2");
	await expect(renameBox(nodeCard(page, "entry"))).toHaveAttribute("placeholder", "入口");
	await renameBox(nodeCard(page, "entry")).fill("每日入口");
	await page.keyboard.press("Enter");
	await expect(titleOf(nodeCard(page, "entry"))).toHaveText("每日入口");
	await expect(headerOf(nodeCard(page, "entry"))).toContainText("入口");

	await save(page, 2);
	const nodes = (await headOf(controlPlane, id)).document.nodes as Record<string, unknown>[];
	expect(nodes.find((n) => n.id === "fetch")?.display_name).toBe(NAME);
	expect(nodes.find((n) => n.id === "entry")?.display_name).toBe("每日入口");
});

test("右键菜单和 Shift+F10 的菜单里都有「重命名」（带 F2），选了就进入原地编辑，焦点留在输入框", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const fetch = nodeCard(page, "fetch");

	// 鼠标。
	await fetch.click({ button: "right" });
	const menu = nodeMenu(page);
	await expect(menu.getByRole("menuitem", { name: /重命名/ })).toHaveText("重命名F2");
	await menu.getByRole("menuitem", { name: /重命名/ }).click();
	await expect(menu).toHaveCount(0);
	// 菜单关闭时焦点会回到卡片：输入框要在那之后仍然拿着焦点。
	await expect(renameBox(fetch)).toBeFocused();
	await renameBox(fetch).fill(NAME);
	await renameBox(fetch).press("Enter");
	await expect(titleOf(fetch)).toHaveText(NAME);
	await expect(fetch).toBeFocused();

	// 键盘：Shift+F10 打开菜单，方向键移到「重命名」（排在「创建副本」「复制」后面），Enter。
	await page.keyboard.press("Shift+F10");
	await expect(menu).toBeFocused();
	for (const item of ["在后面添加节点", "创建副本", "复制", "重命名"]) {
		await page.keyboard.press("ArrowDown");
		await expect(menu.locator('[role="menuitem"][data-highlighted]')).toContainText(item);
	}
	await page.keyboard.press("Enter");
	await expect(menu).toHaveCount(0);
	await expect(renameBox(fetch)).toBeFocused();
	// 已有显示名称时输入框里是它，并且全选，直接输入就是替换。
	await expect(renameBox(fetch)).toHaveValue(NAME);
	await page.keyboard.type(OTHER);
	await page.keyboard.press("Enter");
	await expect(titleOf(fetch)).toHaveText(OTHER);
});

test("Esc 取消：不改场景、不进撤销历史，焦点回到卡片；输入框里已有的名称原样保留", async ({
	page,
	controlPlane,
}) => {
	const id = await namedScenario(controlPlane);
	await openEditor(page, id);
	const fetch = nodeCard(page, "fetch");
	await expect(titleOf(fetch)).toHaveText(NAME);

	await titleOf(fetch).dblclick();
	await expect(renameBox(fetch)).toHaveValue(NAME);
	await renameBox(fetch).fill(OTHER);
	await renameBox(fetch).press("Escape");
	await expect(renameBox(fetch)).toHaveCount(0);
	await expect(titleOf(fetch)).toHaveText(NAME);
	await expect(fetch).toBeFocused();
	await expect(unsaved(page)).toHaveCount(0);
	await expect(undo(page)).toBeDisabled();

	// 再进入编辑，输入框里是原来的名称，不是上次放弃的文字。
	await page.keyboard.press("F2");
	await expect(renameBox(fetch)).toHaveValue(NAME);
	await renameBox(fetch).press("Escape");
	// 取消时没有取消选中节点。
	await expect(fetch).toHaveAttribute("aria-pressed", "true");
});

test("确认空白等于清除显示名称，卡片恢复默认标题；没有显示名称时确认空白不算修改", async ({
	page,
	controlPlane,
}) => {
	const id = await namedScenario(controlPlane);
	await openEditor(page, id);
	const fetch = nodeCard(page, "fetch");

	await titleOf(fetch).dblclick();
	await renameBox(fetch).fill("   ");
	await renameBox(fetch).press("Enter");
	await expect(titleOf(fetch)).toHaveText("HTTP 检查");
	await expect(fetch).toHaveAttribute("aria-label", "节点 fetch，HTTP 检查");
	await expect(unsaved(page)).toBeVisible();
	await save(page, 2);
	const nodes = (await headOf(controlPlane, id)).document.nodes as Record<string, unknown>[];
	expect(nodes.find((n) => n.id === "fetch")).not.toHaveProperty("display_name");

	// 原来没有名称时，确认空白什么也没改（刷新后撤销历史是空的）。
	await page.reload();
	await expect(titleOf(fetch)).toHaveText("HTTP 检查");
	await titleOf(fetch).dblclick();
	await expect(renameBox(fetch)).toHaveValue("");
	await renameBox(fetch).press("Enter");
	await expect(titleOf(fetch)).toHaveText("HTTP 检查");
	await expect(unsaved(page)).toHaveCount(0);
	await expect(undo(page)).toBeDisabled();
});

test("一次改名是一步撤销：连续改两次要撤销两次，重做回来；改名后焦点在卡片上，Ctrl+Z 直接可用", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const fetch = nodeCard(page, "fetch");

	await titleOf(fetch).dblclick();
	await renameBox(fetch).fill(NAME);
	await renameBox(fetch).press("Enter");
	await fetch.press("F2");
	await renameBox(fetch).fill(OTHER);
	await renameBox(fetch).press("Enter");
	await expect(titleOf(fetch)).toHaveText(OTHER);

	await page.keyboard.press("Control+z");
	await expect(titleOf(fetch)).toHaveText(NAME);
	await dock(page).getByRole("button", { name: "撤销" }).click();
	await expect(titleOf(fetch)).toHaveText("HTTP 检查");
	await expect(undo(page)).toBeDisabled();
	await expect(unsaved(page)).toHaveCount(0);

	await redo(page).click();
	await expect(titleOf(fetch)).toHaveText(NAME);
	await redo(page).click();
	await expect(titleOf(fetch)).toHaveText(OTHER);

	// 清除显示名称也是一步。
	await fetch.focus();
	await page.keyboard.press("F2");
	await renameBox(fetch).fill("");
	await renameBox(fetch).press("Enter");
	await expect(titleOf(fetch)).toHaveText("HTTP 检查");
	await undo(page).click();
	await expect(titleOf(fetch)).toHaveText(OTHER);
});

test("名称最长 40 个字符（按字符计，emoji 算一个）：多出来的输入不进输入框，保存不报字段错误", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const fetch = nodeCard(page, "fetch");

	await titleOf(fetch).dblclick();
	await renameBox(fetch).fill("😀".repeat(45));
	await expect(renameBox(fetch)).toHaveValue("😀".repeat(40));
	await renameBox(fetch).press("Enter");
	await expect(titleOf(fetch)).toHaveText("😀".repeat(40));
	await expect(page.getByText("处字段错误")).toHaveCount(0);
	await save(page, 2);
	const nodes = (await headOf(controlPlane, id)).document.nodes as Record<string, unknown>[];
	expect(nodes.find((n) => n.id === "fetch")?.display_name).toBe("😀".repeat(40));
});

test("输入法组字时 Enter、Esc 只是选字，不确认也不取消；点别处（失焦）确认；Tab 确认且不打开添加节点菜单", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const fetch = nodeCard(page, "fetch");

	await titleOf(fetch).dblclick();
	await renameBox(fetch).fill(NAME);
	for (const key of ["Enter", "Escape"]) {
		await renameBox(fetch).evaluate((el, k) => {
			el.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: k,
					isComposing: true,
					bubbles: true,
					cancelable: true,
				}),
			);
		}, key);
	}
	await expect(renameBox(fetch)).toHaveValue(NAME);
	await expect(unsaved(page)).toHaveCount(0);

	// 点画布空白处：输入框失焦，已输入的名称生效。
	await page.locator(".react-flow__pane").click({ position: { x: 40, y: 400 } });
	await expect(renameBox(fetch)).toHaveCount(0);
	await expect(titleOf(fetch)).toHaveText(NAME);

	await fetch.click();
	await page.keyboard.press("F2");
	await renameBox(fetch).fill(OTHER);
	await renameBox(fetch).press("Tab");
	await expect(titleOf(fetch)).toHaveText(OTHER);
	await expect(page.getByRole("dialog", { name: "添加节点" })).toHaveCount(0);
});

test("子流程入口节点不能原地改名：它的名称是子流程名称，在检查器里改；菜单里的「重命名」禁用并说明原因", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const sub = nodeCard(page, "sub_entry");

	await titleOf(sub).dblclick();
	await expect(page.getByRole("textbox", { name: "显示名称" })).toHaveCount(0);
	await sub.click();
	await page.keyboard.press("F2");
	await expect(page.getByRole("textbox", { name: "显示名称" })).toHaveCount(0);

	await sub.click({ button: "right" });
	const item = nodeMenu(page).getByRole("menuitem", { name: /重命名/ });
	await expect(item).toBeDisabled();
	await expect(item).toContainText("子流程入口节点的名称是子流程名称，在检查器里修改");
});

test("运行状态模式和版本查看的画布只读：双击标题、F2 都不能改名，右键菜单里没有「重命名」", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	await switchMode(page, "run");
	const fetch = nodeCard(page, "fetch");
	await titleOf(fetch).dblclick();
	await expect(page.getByRole("textbox", { name: "显示名称" })).toHaveCount(0);
	await fetch.click();
	await page.keyboard.press("F2");
	await expect(page.getByRole("textbox", { name: "显示名称" })).toHaveCount(0);
	await fetch.click({ button: "right" });
	await expect(nodeMenu(page).getByRole("menuitem")).toHaveText(["复制节点 ID", "复制输出引用"]);
	await page.keyboard.press("Escape");

	// 回到编辑模式后一切照旧。
	await switchMode(page, "edit");
	await titleOf(fetch).dblclick();
	await expect(renameBox(fetch)).toBeFocused();
	await renameBox(fetch).fill(NAME);
	await renameBox(fetch).press("Enter");
	await save(page, 2);

	await page.goto(`/orchestrations/${id}/versions`);
	const newer = page.getByRole("region", { name: "版本 2（只读）" });
	const card = newer.locator('[data-node-id="fetch"]');
	await expect(titleOf(card)).toHaveText(NAME);
	await titleOf(card).dblclick();
	await card.click();
	await page.keyboard.press("F2");
	await expect(page.getByRole("textbox", { name: "显示名称" })).toHaveCount(0);
	await expect(titleOf(card)).toHaveText(NAME);
});

test("快捷键面板列出 F2「重命名节点」", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await page.keyboard.press("?");
	const group = page
		.getByRole("dialog", { name: "快捷键" })
		.getByRole("region", { name: "编排画布" });
	await expect(group.locator("div").filter({ hasText: /^重命名节点F2$/ })).toBeVisible();
});
