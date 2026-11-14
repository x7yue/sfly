import type { Locator, Page } from "@playwright/test";
import {
	annotationBand,
	annotationFrame,
	annotationTitleBox,
	frames,
	memberList,
	savedAnnotations,
} from "./annotation-support";
import {
	addMenu,
	createEditorScenario,
	dock,
	editorDocument,
	inspector,
	nodeCard,
	nodeMenu,
	openEditor,
} from "./editor-support";
import { expect, test } from "./fixtures";
import { box, createScenario } from "./support";

// 从多选新建注释框（#315）：检查器「已选 N 个节点」和多选里节点的右键菜单都有「添加注释框」；
// 子流程的节点全被选中就记为子流程成员，只选中一部分就按节点成员记；新建后选中注释框并聚焦标题，一步撤销。

/** 画布上选中的节点 ID，排好序。 */
const selectedIn = (scope: Page | Locator) =>
	scope
		.locator('[data-node-id][aria-pressed="true"]')
		.evaluateAll((els) => els.map((el) => el.getAttribute("data-node-id") ?? "").sort());

/** 按住 Shift 从 `from` 拖到 `to`（屏幕坐标）。 */
async function marquee(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
	await page.keyboard.down("Shift");
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
	await page.mouse.move(to.x, to.y, { steps: 4 });
	await page.mouse.up();
	await page.keyboard.up("Shift");
}

/** 框选主链上 `first` 到 `last` 之间的节点：从 `first` 左上方的空白处拖到 `last` 右下方。 */
async function marqueeMainChain(page: Page, first: string, last: string) {
	const [a, b] = [await box(nodeCard(page, first)), await box(nodeCard(page, last))];
	await marquee(
		page,
		{ x: a.x - 12, y: a.y - 30 },
		{ x: b.x + b.width + 12, y: b.y + b.height + 12 },
	);
}

/**
 * 注释框的宽高是 `cardId` 节点卡片的几倍（同一时刻量两者）：视图缩放、平移、像素取整都不改变它，
 * 只有框真的变大变小才变（屏幕像素的尺寸会随视图动画差零点几个像素）。
 */
const sizeInCards = (page: Page, annotationId: string, cardId: string) =>
	page.evaluate(
		([annotation, card]) => {
			const rect = (selector: string) => {
				const el = document.querySelector(selector);
				if (!el) throw new Error(`页面上没有 ${selector}`);
				return el.getBoundingClientRect();
			};
			const frame = rect(`[data-annotation="${annotation}"]`);
			const unit = rect(`[data-node-id="${card}"]`);
			return { width: frame.width / unit.width, height: frame.height / unit.height };
		},
		[annotationId, cardId] as const,
	);

const ctrlClick = (page: Page, id: string) =>
	nodeCard(page, id).click({ modifiers: ["ControlOrMeta"] });

const multiHeading = (page: Page, n: number) =>
	inspector(page).getByRole("heading", { name: `已选 ${n} 个节点` });
const addAnnotationButton = (page: Page) =>
	inspector(page).getByRole("button", { name: "添加注释框" });
const undoButton = (page: Page) => dock(page).getByRole("button", { name: "撤销" });

async function save(page: Page, version: number) {
	await page.getByRole("button", { name: /保存/ }).click();
	await expect(page.getByText(`已保存为版本 ${version}`)).toBeVisible();
}

test("框选主链上的几个节点，再加选一个完整的子流程，从检查器新建：子流程记为子流程成员，其余记为节点成员；选中注释框并聚焦标题；往子流程里加节点，框随之变大", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	await marqueeMainChain(page, "fetch", "dispatch");
	await expect.poll(() => selectedIn(page)).toEqual(["dispatch", "fetch"]);
	await ctrlClick(page, "sub_entry");
	await ctrlClick(page, "sub_ping");
	await expect.poll(() => selectedIn(page)).toEqual(["dispatch", "fetch", "sub_entry", "sub_ping"]);
	await expect(multiHeading(page, 4)).toBeVisible();

	await addAnnotationButton(page).click();
	// 新建后选中这个注释框，标题输入框拿到焦点，默认标题整段选中。
	await expect(annotationTitleBox(page)).toBeFocused();
	await expect(annotationTitleBox(page)).toHaveValue("注释框 1");
	await expect(annotationBand(page, "注释框 1")).toHaveAttribute("aria-pressed", "true");
	await expect.poll(() => selectedIn(page)).toEqual([]);
	await expect(memberList(page).getByRole("listitem")).toHaveText([
		/fetch/,
		/dispatch/,
		/子流程 sub_entry/,
	]);
	const frame = annotationFrame(page, "annotation_1");
	for (const node of ["fetch", "dispatch", "sub_entry", "sub_ping"]) {
		expect(frames(await box(frame), await box(nodeCard(page, node)))).toBe(true);
	}
	expect(frames(await box(frame), await box(nodeCard(page, "entry")))).toBe(false);

	// 往子流程里加节点：它是子流程成员，新节点也在框里，框变大。
	const first = await box(frame);
	await nodeCard(page, "sub_ping").click({ button: "right" });
	await nodeMenu(page).getByRole("menuitem", { name: "在后面添加节点" }).click();
	await addMenu(page).getByRole("option", { name: /Sleep/ }).click();
	await expect(nodeCard(page, "sleep_1")).toBeVisible();
	// 新节点接在 sub_ping 右边，视图随后平移过去：在同一时刻量框和新节点。
	await expect
		.poll(async () => {
			const grown = await box(frame);
			return grown.width > first.width && frames(grown, await box(nodeCard(page, "sleep_1")));
		})
		.toBe(true);

	await save(page, 2);
	expect(await savedAnnotations(controlPlane, id)).toEqual([
		{
			id: "annotation_1",
			title: "注释框 1",
			nodes: ["fetch", "dispatch"],
			subflows: ["sub_entry"],
		},
	]);
});

test("新建注释框是一步撤销：撤销后注释框没了，重做后回来；选中的节点没有被动过", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await expect(undoButton(page)).toBeDisabled();

	await ctrlClick(page, "fetch");
	await ctrlClick(page, "dispatch");
	await expect(multiHeading(page, 2)).toBeVisible();
	await addAnnotationButton(page).click();
	await expect(annotationFrame(page, "annotation_1")).toBeVisible();

	await undoButton(page).click();
	await expect(annotationFrame(page, "annotation_1")).toHaveCount(0);
	await expect(inspector(page).getByRole("heading", { name: "场景设置" })).toBeVisible();
	await expect(undoButton(page)).toBeDisabled();

	await dock(page).getByRole("button", { name: "重做" }).click();
	await expect(annotationFrame(page, "annotation_1")).toBeVisible();
});

test("只选中子流程的一部分节点：只记节点成员；往这个子流程里加节点，框不变", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	await nodeCard(page, "fetch").click();
	await ctrlClick(page, "sub_ping");
	await expect(multiHeading(page, 2)).toBeVisible();
	await addAnnotationButton(page).click();
	await expect(annotationBand(page, "注释框 1")).toHaveAttribute("aria-pressed", "true");
	await expect(memberList(page).getByRole("listitem")).toHaveText([/fetch/, /sub_ping/]);

	const frame = annotationFrame(page, "annotation_1");
	await expect
		.poll(async () => frames(await box(frame), await box(nodeCard(page, "sub_ping"))))
		.toBe(true);
	const first = await sizeInCards(page, "annotation_1", "sub_ping");

	await nodeCard(page, "sub_ping").click({ button: "right" });
	await nodeMenu(page).getByRole("menuitem", { name: "在后面添加节点" }).click();
	await addMenu(page).getByRole("option", { name: /Sleep/ }).click();
	await expect(nodeCard(page, "sleep_1")).toBeVisible();
	// 框只按成员算，sub_ping 是节点成员：框的大小（以卡片为单位）不变，新节点不在框里。
	const sizeOf = async (dimension: "width" | "height") =>
		(await sizeInCards(page, "annotation_1", "sub_ping"))[dimension];
	await expect.poll(() => sizeOf("width")).toBeCloseTo(first.width, 1);
	await expect.poll(() => sizeOf("height")).toBeCloseTo(first.height, 1);
	await expect
		.poll(async () => frames(await box(frame), await box(nodeCard(page, "sleep_1"))))
		.toBe(false);

	await save(page, 2);
	expect(await savedAnnotations(controlPlane, id)).toEqual([
		{ id: "annotation_1", title: "注释框 1", nodes: ["fetch", "sub_ping"], subflows: [] },
	]);
});

test("在多选里的节点上点右键：保持多选，菜单里有「添加注释框」；在多选以外的节点上点右键，收成单选", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	await nodeCard(page, "fetch").click();
	await ctrlClick(page, "dispatch");
	await ctrlClick(page, "ping");
	await expect(multiHeading(page, 3)).toBeVisible();

	await nodeCard(page, "dispatch").click({ button: "right" });
	await expect(nodeMenu(page)).toBeVisible();
	expect(await selectedIn(page)).toEqual(["dispatch", "fetch", "ping"]);
	await expect(multiHeading(page, 3)).toBeVisible();
	await nodeMenu(page).getByRole("menuitem", { name: "添加注释框" }).click();

	await expect(annotationTitleBox(page)).toBeFocused();
	await expect(memberList(page).getByRole("listitem")).toHaveText([/fetch/, /dispatch/, /ping/]);
	for (const node of ["fetch", "dispatch", "ping"]) {
		expect(
			frames(await box(annotationFrame(page, "annotation_1")), await box(nodeCard(page, node))),
		).toBe(true);
	}

	// 在多选以外的节点上点右键：照旧收成单选，菜单是这个节点自己的。
	await nodeCard(page, "fetch").click();
	await ctrlClick(page, "ping");
	await expect(multiHeading(page, 2)).toBeVisible();
	await nodeCard(page, "entry").click({ button: "right" });
	await expect(nodeMenu(page)).toBeVisible();
	expect(await selectedIn(page)).toEqual(["entry"]);
	await expect(nodeMenu(page).getByRole("menuitem", { name: "复制节点 ID" })).toBeVisible();
	await page.keyboard.press("Escape");
});

test("只用键盘：多选里的节点按 Shift+F10 打开菜单，保持多选，选「添加注释框」", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	await nodeCard(page, "fetch").click();
	await ctrlClick(page, "dispatch");
	await expect(multiHeading(page, 2)).toBeVisible();
	await page.keyboard.press("Shift+F10");
	await expect(nodeMenu(page)).toBeFocused();
	expect(await selectedIn(page)).toEqual(["dispatch", "fetch"]);
	await page.keyboard.press("ArrowDown");
	await expect(nodeMenu(page).getByRole("menuitem", { name: "添加注释框" })).toBeFocused();
	await page.keyboard.press("Enter");

	await expect(annotationTitleBox(page)).toBeFocused();
	await expect(memberList(page).getByRole("listitem")).toHaveText([/fetch/, /dispatch/]);
});

/** editorDocument 去掉子流程里的 sub_ping：子流程 sub_entry 只剩入口节点。 */
const entryOnlySubflow = {
	...editorDocument,
	nodes: editorDocument.nodes.filter((n) => n.id !== "sub_ping"),
	edges: editorDocument.edges.filter((e) => e.to !== "sub_ping"),
};

test("子流程只有入口节点时，单个节点右键「添加注释框」记为子流程成员，和多选新建一致", async ({
	page,
	controlPlane,
}) => {
	await createEditorScenario(controlPlane);
	const id = await createScenario(controlPlane, "只有入口的子流程", entryOnlySubflow);
	await openEditor(page, id, "sub_entry");

	await nodeCard(page, "sub_entry").click({ button: "right" });
	await nodeMenu(page).getByRole("menuitem", { name: "添加注释框" }).click();
	await expect(annotationBand(page, "注释框 1")).toHaveAttribute("aria-pressed", "true");
	await expect(memberList(page).getByRole("listitem")).toHaveText([/子流程 sub_entry/]);
	await save(page, 2);
	expect(await savedAnnotations(controlPlane, id)).toEqual([
		{ id: "annotation_1", title: "注释框 1", nodes: [], subflows: ["sub_entry"] },
	]);
});

test("子流程里还有别的节点时，右键子流程入口新建的注释框仍记入口为节点成员", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	await nodeCard(page, "sub_entry").click({ button: "right" });
	await nodeMenu(page).getByRole("menuitem", { name: "添加注释框" }).click();
	await expect(annotationBand(page, "注释框 1")).toHaveAttribute("aria-pressed", "true");
	await save(page, 2);
	expect(await savedAnnotations(controlPlane, id)).toEqual([
		{ id: "annotation_1", title: "注释框 1", nodes: ["sub_entry"], subflows: [] },
	]);
});
