import type { Page } from "@playwright/test";
import { ARRANGE_STEP } from "@sfly/orchestration";
import {
	annotated,
	annotationBand,
	annotationFrame,
	memberList,
	type TestAnnotation,
} from "./annotation-support";
import {
	dock,
	editorDocument,
	nodeCard,
	nodeMenu,
	nodePosition,
	openEditor,
} from "./editor-support";
import { expect, test } from "./fixtures";
import { box, createScenario, publishPackage } from "./support";

// 注释框的画布操作（第二批）：双击标题原地改标题、F2；选中注释框时标题后面的工具条（颜色、排列、删除）；
// 多选节点时上方的工具条（新建注释框、排列），Ctrl+G / Ctrl+Shift+G；把节点拖进注释框、按住 Alt 拖出。

/** 「取数」框着 fetch、dispatch；「汇报」框着子流程 sub_entry；entry、ping 不在框里。 */
const ANNOTATIONS: TestAnnotation[] = [
	{ id: "annotation_1", title: "取数", nodes: ["fetch", "dispatch"] },
	{ id: "annotation_2", title: "汇报", subflows: ["sub_entry"] },
];

async function openAnnotated(page: Page, cp: Parameters<typeof publishPackage>[0]) {
	await publishPackage(cp);
	const id = await createScenario(cp, "日终数据处理", annotated(ANNOTATIONS, editorDocument));
	await openEditor(page, id);
	return id;
}

const undo = (page: Page) => dock(page).getByRole("button", { name: "撤销" }).click();
const titleEditor = (page: Page) => page.getByRole("textbox", { name: "注释框的标题" });
const annotationToolbar = (page: Page, title: string) =>
	page.getByRole("toolbar", { name: `注释框 ${title} 的工具条` });
const selectionToolbar = (page: Page) => page.getByRole("toolbar", { name: "选中节点的工具条" });
const dropHint = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });

/** 选中注释框，看检查器里的成员。 */
async function membersOf(page: Page, title: string) {
	await annotationBand(page, title).click();
	return memberList(page).getByRole("listitem").allTextContents();
}

/** 按下节点卡片中间，分几步拖到 `to`（屏幕坐标），停在那里不松手。 */
async function dragCard(page: Page, id: string, to: { x: number; y: number }) {
	const card = await box(nodeCard(page, id));
	await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
	await page.mouse.down();
	await page.mouse.move(card.x + card.width / 2 + 20, card.y + card.height / 2 + 20, { steps: 3 });
	await page.mouse.move(to.x, to.y, { steps: 8 });
}

test("双击框外的标题原地改标题：Enter 确认，一步撤销；Esc 取消，清空等于不改；选中注释框后 F2 也能改", async ({
	page,
	controlPlane,
}) => {
	await openAnnotated(page, controlPlane);

	await annotationBand(page, "取数").dblclick();
	await expect(titleEditor(page)).toBeFocused();
	await expect(titleEditor(page)).toHaveValue("取数");
	await titleEditor(page).fill("准备数据");
	await titleEditor(page).press("Enter");
	await expect(annotationBand(page, "准备数据")).toBeVisible();
	await expect(titleEditor(page)).toHaveCount(0);
	await expect(page.locator("[data-canvas-region]")).toBeFocused();
	await undo(page);
	await expect(annotationBand(page, "取数")).toBeVisible();

	await annotationBand(page, "取数").dblclick();
	await titleEditor(page).fill("不要了");
	await titleEditor(page).press("Escape");
	await expect(annotationBand(page, "取数")).toBeVisible();
	await annotationBand(page, "取数").dblclick();
	await titleEditor(page).fill("   ");
	await titleEditor(page).press("Enter");
	await expect(annotationBand(page, "取数")).toBeVisible();

	await annotationBand(page, "汇报").click();
	await page.keyboard.press("F2");
	await expect(titleEditor(page)).toBeFocused();
	await titleEditor(page).fill("对账汇报");
	await titleEditor(page).press("Enter");
	await expect(annotationBand(page, "对账汇报")).toBeVisible();
});

test("选中注释框：标题后面出现工具条，换颜色、纵向排列成员、删除注释框（节点不动），各是一步撤销；有子流程成员时没有排列", async ({
	page,
	controlPlane,
}) => {
	await openAnnotated(page, controlPlane);
	await expect(annotationToolbar(page, "取数")).toHaveCount(0);
	await annotationBand(page, "取数").click();
	const bar = annotationToolbar(page, "取数");
	await expect(bar).toBeVisible();
	// 工具条接在标题胶囊后面，同一行。
	const [chip, tools] = [await box(annotationBand(page, "取数")), await box(bar)];
	expect(tools.x).toBeGreaterThan(chip.x + chip.width);
	expect(Math.abs(tools.y + tools.height - (chip.y + chip.height))).toBeLessThan(2);

	await bar.getByRole("button", { name: "颜色：灰" }).click();
	const picker = page.locator('[data-slot="popover-content"]').getByRole("group", { name: "颜色" });
	await picker.getByRole("button", { name: "橙" }).click();
	await expect(picker).toHaveCount(0);
	await expect(annotationFrame(page, "annotation_1")).toHaveAttribute(
		"data-annotation-color",
		"orange",
	);
	await expect(bar.getByRole("button", { name: "颜色：橙" })).toBeVisible();

	await bar.getByRole("button", { name: "纵向排列" }).click();
	await expect.poll(() => nodePosition(page, "dispatch")).toEqual({ x: 300, y: ARRANGE_STEP.y });
	expect(await nodePosition(page, "fetch")).toEqual({ x: 300, y: 0 });
	await undo(page);
	await expect.poll(() => nodePosition(page, "dispatch")).toEqual({ x: 600, y: 0 });
	await expect(annotationFrame(page, "annotation_1")).toHaveAttribute(
		"data-annotation-color",
		"orange",
	);

	await annotationBand(page, "汇报").click();
	const report = annotationToolbar(page, "汇报");
	await expect(report).toBeVisible();
	await expect(report.getByRole("button", { name: "纵向排列" })).toHaveCount(0);
	const subEntry = await nodePosition(page, "sub_entry");
	await report.getByRole("button", { name: "删除注释框（节点不动）" }).click();
	await expect(annotationFrame(page, "annotation_2")).toHaveCount(0);
	expect(await nodePosition(page, "sub_entry")).toEqual(subEntry);
	await undo(page);
	await expect(annotationFrame(page, "annotation_2")).toBeVisible();
});

test("多选节点：上方出现工具条，可以排列、新建注释框；Ctrl+G 新建，Ctrl+Shift+G 删除选中的注释框；多选的节点菜单也能排列", async ({
	page,
	controlPlane,
}) => {
	await openAnnotated(page, controlPlane);
	await nodeCard(page, "entry").click();
	await expect(selectionToolbar(page)).toHaveCount(0);
	await nodeCard(page, "ping").click({ modifiers: ["ControlOrMeta"] });
	const bar = selectionToolbar(page);
	await expect(bar).toBeVisible();
	const [tools, entry] = [await box(bar), await box(nodeCard(page, "entry"))];
	expect(tools.y + tools.height).toBeLessThan(entry.y);

	await bar.getByRole("button", { name: "横向排列" }).click();
	await expect.poll(() => nodePosition(page, "ping")).toEqual({ x: 300, y: 0 });
	expect(await nodePosition(page, "entry")).toEqual({ x: 0, y: 0 });
	await undo(page);
	await expect.poll(() => nodePosition(page, "ping")).toEqual({ x: 900, y: 0 });

	// 撤销后选中不变，Ctrl+G 用这两个节点新建注释框。
	await page.keyboard.press("ControlOrMeta+g");
	await expect(annotationFrame(page, "annotation_3")).toBeVisible();
	expect(await membersOf(page, "注释框 3")).toEqual([
		expect.stringContaining("entry"),
		expect.stringContaining("ping"),
	]);
	await page.keyboard.press("ControlOrMeta+Shift+g");
	await expect(annotationFrame(page, "annotation_3")).toHaveCount(0);
	expect(await nodePosition(page, "ping")).toEqual({ x: 900, y: 0 });

	await nodeCard(page, "entry").click();
	await nodeCard(page, "sub_ping").click({ modifiers: ["ControlOrMeta"] });
	await nodeCard(page, "sub_ping").click({ button: "right" });
	await expect(nodeMenu(page).getByRole("menuitem", { name: /添加注释框/ })).toContainText("Ctrl");
	await nodeMenu(page).getByRole("menuitem", { name: "纵向排列" }).click();
	await expect.poll(() => nodePosition(page, "sub_ping")).toEqual({ x: 0, y: ARRANGE_STEP.y });
});

test("把节点拖进注释框：卡片中心进了框时框高亮，卡片下面写着「松手加入」；松手加入，和这次拖动一起是一步撤销", async ({
	page,
	controlPlane,
}) => {
	await openAnnotated(page, controlPlane);
	const before = await nodePosition(page, "ping");
	const frame = annotationFrame(page, "annotation_1");
	const target = await box(frame);
	await dragCard(page, "ping", { x: target.x + target.width / 2, y: target.y + target.height - 8 });
	await expect(frame).toHaveAttribute("data-drop-target", "true");
	await expect(dropHint(page, "松手加入「取数」")).toBeVisible();
	await page.mouse.up();
	await expect(frame).not.toHaveAttribute("data-drop-target");
	await expect(dropHint(page, "松手")).toHaveCount(0);
	expect(await membersOf(page, "取数")).toEqual([
		expect.stringContaining("fetch"),
		expect.stringContaining("dispatch"),
		expect.stringContaining("ping"),
	]);

	await undo(page);
	await expect.poll(() => nodePosition(page, "ping")).toEqual(before);
	expect(await membersOf(page, "取数")).toHaveLength(2);
});

test("按住 Alt 拖出：框不跟着走，提示「松手移出」，松手移出；拖出最后一个成员时提示注释框会一起删除", async ({
	page,
	controlPlane,
}) => {
	await openAnnotated(page, controlPlane);
	const frame = annotationFrame(page, "annotation_1");
	const width = (await box(frame)).width;
	const card = await box(nodeCard(page, "dispatch"));

	await page.keyboard.down("Alt");
	await dragCard(page, "dispatch", { x: card.x + card.width / 2, y: card.y + 420 });
	await expect(dropHint(page, "松手移出「取数」")).toBeVisible();
	// 框不再跟着 dispatch：只框着 fetch。
	await expect.poll(async () => (await box(frame)).width).toBeLessThan(width * 0.7);
	await page.mouse.up();
	await page.keyboard.up("Alt");
	expect(await membersOf(page, "取数")).toEqual([expect.stringContaining("fetch")]);

	const fetch = await box(nodeCard(page, "fetch"));
	await page.keyboard.down("Alt");
	await dragCard(page, "fetch", { x: fetch.x + fetch.width / 2, y: fetch.y + 420 });
	await expect(dropHint(page, "「取数」没有别的成员，会一起删除")).toBeVisible();
	await page.mouse.up();
	await page.keyboard.up("Alt");
	await expect(frame).toHaveCount(0);
	await undo(page);
	await expect(frame).toBeVisible();
});
