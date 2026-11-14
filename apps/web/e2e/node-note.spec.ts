// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import type { Page } from "@playwright/test";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import {
	clipboard,
	createEditorScenario,
	dock,
	editorDocument,
	headOf,
	inspector,
	nodeCard,
	openEditor,
} from "./editor-support";
import { expect, test } from "./fixtures";
import { box, createScenario, overlap, publishPackage } from "./support";

// 节点的备注（#308）：搭场景的人在检查器里写多行备注，卡片头部出现备注图标，悬停或聚焦时显示全文；
// 备注属于场景版本，复制、粘贴、版本对比都带着它。

const NOTE = "每天 8 点拉取快照\n超时设为 600 秒：镜像很大，冷启动要 5 分钟";
/** 60 行、共 1 500 多个字符：一屏放不下，但没有超过 2000 个字符的上限。 */
const LONG_NOTE = Array.from(
	{ length: 60 },
	(_, i) => `第 ${i + 1} 行：${"这一行的内容".repeat(3)}`,
).join("\n");

const noteIcon = (page: Page, id: string) => nodeCard(page, id).locator('[data-slot="note-icon"]');
const noteBox = (page: Page) => inspector(page).getByRole("textbox", { name: "备注" });
const tooltip = (page: Page) => page.getByRole("tooltip");

async function save(page: Page, version: number) {
	await page.getByRole("button", { name: /保存/ }).click();
	await expect(page.getByText(`已保存为版本 ${version}`)).toBeVisible();
}

type Noted = { id: string; note?: string };
const savedNote = async (cp: TestControlPlane, scenario: string, node: string) =>
	((await headOf(cp, scenario)).document.nodes as Noted[]).find((n) => n.id === node)?.note;

async function writeNote(page: Page, node: string, note: string) {
	await nodeCard(page, node).click();
	await noteBox(page).fill(note);
}

test("写备注：卡片头部出现备注图标，没有备注的节点没有，卡片尺寸不变；保存刷新后图标还在", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await expect(page.locator('[data-slot="note-icon"]')).toHaveCount(0);
	const before = await box(nodeCard(page, "fetch"));

	await nodeCard(page, "fetch").click();
	await expect(noteBox(page)).toHaveValue("");
	await noteBox(page).fill(`  ${NOTE}  `);

	await expect(noteIcon(page, "fetch")).toHaveCount(1);
	await expect(page.locator('[data-slot="note-icon"]')).toHaveCount(1);
	// 图标在卡片头部，卡片的大小和位置都没变。
	await expect(nodeCard(page, "fetch").locator("header")).toContainText("fetch");
	await expect(nodeCard(page, "fetch").locator("header [data-slot='note-icon']")).toBeVisible();
	expect(await box(nodeCard(page, "fetch"))).toEqual(before);

	// 只有空白等于没写。
	await noteBox(page).fill(" \n  ");
	await expect(noteIcon(page, "fetch")).toHaveCount(0);
	await expect(page.getByText("有未保存的修改")).toHaveCount(0);
	await noteBox(page).fill(`  ${NOTE}  `);
	await expect(page.getByText("有未保存的修改")).toBeVisible();

	await save(page, 2);
	expect(await savedNote(controlPlane, id, "fetch")).toBe(NOTE);
	expect(await savedNote(controlPlane, id, "ping")).toBeUndefined();

	await page.reload();
	await expect(nodeCard(page, "sub_ping")).toBeVisible();
	await expect(noteIcon(page, "fetch")).toHaveCount(1);
	await expect(page.locator('[data-slot="note-icon"]')).toHaveCount(1);
	await nodeCard(page, "fetch").click();
	await expect(noteBox(page)).toHaveValue(NOTE);
});

test("每种节点都能写备注：入口、异步任务、子流程入口也有图标", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	for (const node of ["entry", "dispatch", "sub_entry"]) {
		await writeNote(page, node, `${node} 的备注`);
		await expect(noteIcon(page, node)).toHaveCount(1);
	}
	await expect(page.locator('[data-slot="note-icon"]')).toHaveCount(3);
});

test("悬停图标显示备注全文，换行照样是两行，移开后消失；卡片的描述里也有备注", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await writeNote(page, "fetch", NOTE);

	await noteIcon(page, "fetch").hover();
	await expect(tooltip(page)).toBeVisible();
	await expect(tooltip(page)).toHaveText(NOTE);
	const lines = await tooltip(page).evaluate((el) => (el as HTMLElement).innerText.split("\n"));
	expect(lines).toEqual(NOTE.split("\n"));
	// 卡片上的图标只负责悬停；读屏用户在卡片的描述里读到备注。
	await expect(nodeCard(page, "fetch")).toHaveAccessibleDescription(NOTE);

	await page.mouse.move(5, 300);
	await expect(tooltip(page)).toHaveCount(0);
});

test("键盘：用方向键把焦点移到节点上时显示备注，移开后消失；鼠标点选节点时不弹出", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await writeNote(page, "fetch", NOTE);
	await page.mouse.move(5, 300);

	await nodeCard(page, "entry").click();
	await expect(nodeCard(page, "entry")).toBeFocused();
	await expect(tooltip(page)).toHaveCount(0);

	await page.keyboard.press("ArrowRight");
	await expect(nodeCard(page, "fetch")).toBeFocused();
	await expect(tooltip(page)).toHaveText(NOTE);

	await page.keyboard.press("ArrowRight");
	await expect(nodeCard(page, "dispatch")).toBeFocused();
	await expect(tooltip(page)).toHaveCount(0);

	// 点选带备注的节点：焦点在它上面，但不是键盘焦点，不弹出。
	await page.mouse.move(5, 300);
	await nodeCard(page, "fetch").click({ position: { x: 20, y: 60 } });
	await expect(nodeCard(page, "fetch")).toBeFocused();
	await expect(tooltip(page)).toHaveCount(0);
});

test("长备注：提示放得进视口，超出的部分滚动着看全，不被截断", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await writeNote(page, "fetch", LONG_NOTE);
	await expect(page.getByText("最多 2000 个字符")).toHaveCount(0);

	await noteIcon(page, "fetch").hover();
	const tip = tooltip(page);
	await expect(tip).toHaveText(LONG_NOTE);
	const viewport = page.viewportSize();
	const shown = await box(tip);
	expect(shown.y).toBeGreaterThanOrEqual(0);
	expect(shown.y + shown.height).toBeLessThanOrEqual(viewport?.height ?? 0);
	expect(shown.x + shown.width).toBeLessThanOrEqual(viewport?.width ?? 0);

	// 鼠标移进提示里滚动：提示一直开着，滚到底能看到最后一行。
	const text = tip.locator('[data-slot="note-text"]');
	expect(await text.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
	await page.mouse.move(shown.x + shown.width / 2, shown.y + shown.height / 2, { steps: 8 });
	await page.mouse.wheel(0, 20_000);
	await expect
		.poll(() => text.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
		.toBeLessThanOrEqual(1);
	await expect(tip).toBeVisible();
});

test("长备注：焦点在节点上时用 PageDown、PageUp、Home、End 滚动提示，节点不会跳走", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await writeNote(page, "fetch", LONG_NOTE);
	await nodeCard(page, "entry").click();
	await page.mouse.move(5, 300);
	await page.keyboard.press("ArrowRight");
	await expect(nodeCard(page, "fetch")).toBeFocused();
	const text = tooltip(page).locator('[data-slot="note-text"]');
	await expect(text).toBeVisible();
	const scrolled = () => text.evaluate((el) => Math.round(el.scrollTop));
	const rest = () => text.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
	expect(await scrolled()).toBe(0);

	await page.keyboard.press("PageDown");
	await expect.poll(scrolled).toBeGreaterThan(100);
	await page.keyboard.press("End");
	await expect.poll(rest).toBeLessThanOrEqual(1);
	await page.keyboard.press("PageUp");
	await expect.poll(rest).toBeGreaterThan(100);
	await page.keyboard.press("Home");
	await expect.poll(scrolled).toBe(0);
	await expect(nodeCard(page, "fetch")).toBeFocused();
	await expect(tooltip(page)).toBeVisible();
});

test("同时有警告和备注的节点：键盘聚焦到它时两个提示都显示，不叠在一起", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "警告加备注", {
		...editorDocument,
		nodes: editorDocument.nodes.map((n) =>
			n.id === "ping" ? { ...n, inputs: { host: "${{ nodes.nope.outputs.x }}" }, note: NOTE } : n,
		),
	});
	await openEditor(page, id);
	await nodeCard(page, "dispatch").click();
	await page.mouse.move(5, 300);

	await page.keyboard.press("ArrowRight");
	await expect(nodeCard(page, "ping")).toBeFocused();
	await expect(tooltip(page)).toHaveCount(2);
	await expect(tooltip(page).filter({ hasText: "引用了不存在的节点 nope" })).toBeVisible();
	await expect(tooltip(page).filter({ hasText: "超时设为 600 秒" })).toBeVisible();
	const [warnings, note] = [
		await box(tooltip(page).filter({ hasText: "引用了不存在的节点 nope" })),
		await box(tooltip(page).filter({ hasText: "超时设为 600 秒" })),
	];
	expect(overlap(warnings, note)).toBe(false);
});

test("缩放：缩小到只留关键信息后图标还在，悬停显示的全文不随画布缩小", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await writeNote(page, "fetch", NOTE);
	const normal = await box(noteIcon(page, "fetch"));

	for (let i = 0; i < 12; i++) await dock(page).getByRole("button", { name: "缩小" }).click();
	await expect(page.getByRole("status", { name: "缩放比例" })).toHaveText("30%");
	await expect(page.locator("[data-lod]")).toHaveAttribute("data-lod", "true");
	await expect(noteIcon(page, "fetch")).toBeVisible();
	// 缩小后图标在屏幕上的大小和 100% 时相近：它和卡片头部的文字一起语义缩放。
	const small = await box(noteIcon(page, "fetch"));
	expect(small.width).toBeGreaterThan(normal.width * 0.6);
	expect(small.width).toBeLessThan(normal.width * 1.5);

	await noteIcon(page, "fetch").hover();
	await expect(tooltip(page)).toHaveText(NOTE);
	expect(await tooltip(page).evaluate((el) => getComputedStyle(el).fontSize)).toBe("12px");
});

test("撤销、重做：写备注、清空备注各是一步", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await writeNote(page, "fetch", NOTE);
	await expect(noteIcon(page, "fetch")).toHaveCount(1);

	await dock(page).getByRole("button", { name: "撤销" }).click();
	await expect(noteBox(page)).toHaveValue("");
	await expect(noteIcon(page, "fetch")).toHaveCount(0);
	await expect(page.getByText("有未保存的修改")).toHaveCount(0);

	await dock(page).getByRole("button", { name: "重做" }).click();
	await expect(noteBox(page)).toHaveValue(NOTE);
	await expect(noteIcon(page, "fetch")).toHaveCount(1);

	await save(page, 2);
	await noteBox(page).fill("");
	await expect(noteIcon(page, "fetch")).toHaveCount(0);
	await dock(page).getByRole("button", { name: "撤销" }).click();
	await expect(noteBox(page)).toHaveValue(NOTE);
	await expect(noteIcon(page, "fetch")).toHaveCount(1);
});

test("备注超过 2000 个字符：检查器指出出错的字段，不能保存；改短之后恢复", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await writeNote(page, "fetch", "😀".repeat(2000));
	await expect(inspector(page).getByText("最多 2000 个字符")).toHaveCount(0);

	await noteBox(page).fill("😀".repeat(2001));
	await expect(noteBox(page)).toHaveAttribute("aria-invalid", "true");
	await expect(inspector(page).getByText("最多 2000 个字符")).toBeVisible();
	await expect(page.getByText("1 处字段错误")).toBeVisible();

	await noteBox(page).fill("😀".repeat(2000));
	await expect(inspector(page).getByText("最多 2000 个字符")).toHaveCount(0);
	await save(page, 2);
	expect(await savedNote(controlPlane, id, "fetch")).toBe("😀".repeat(2000));
});

test.describe("复制、粘贴、创建副本", () => {
	test.beforeEach(async ({ context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	});

	test("Ctrl+D 创建副本、Ctrl+C 再 Ctrl+V 粘贴：备注一起带过去，保存下来的副本和原节点除 ID 和位置外相同", async ({
		page,
		controlPlane,
	}) => {
		const id = await createEditorScenario(controlPlane);
		await openEditor(page, id);
		await writeNote(page, "fetch", NOTE);

		await nodeCard(page, "fetch").click();
		await page.keyboard.press("Control+d");
		await expect(nodeCard(page, "fetch_1")).toBeFocused();
		await expect(noteIcon(page, "fetch_1")).toHaveCount(1);
		await expect(noteBox(page)).toHaveValue(NOTE);

		await nodeCard(page, "fetch").click();
		await page.keyboard.press("Control+c");
		await expect(page.getByText("已复制节点 fetch")).toBeVisible();
		expect(JSON.parse(await clipboard(page))).toMatchObject({ node: { id: "fetch", note: NOTE } });
		await page.keyboard.press("Control+v");
		await expect(nodeCard(page, "fetch_2")).toBeFocused();
		await expect(noteIcon(page, "fetch_2")).toHaveCount(1);
		await expect(noteBox(page)).toHaveValue(NOTE);

		await save(page, 2);
		for (const copy of ["fetch_1", "fetch_2"]) {
			expect(await savedNote(controlPlane, id, copy)).toBe(NOTE);
		}
		await expect(page.locator('[data-slot="note-icon"]')).toHaveCount(3);
	});
});

const noted = (note: string) => ({
	...editorDocument,
	nodes: editorDocument.nodes.map((n) => (n.id === "fetch" ? { ...n, note } : n)),
});

async function saveVersion(cp: TestControlPlane, scenario: string, base: number, document: object) {
	const res = await cp.fetch(`/orchestrations/${scenario}/versions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "bob" },
		body: JSON.stringify({ base_version: base, document }),
	});
	expect(res.status, await res.text()).toBe(201);
}

test("版本对比：列出备注的新增和修改，字段标签是「备注」，多行照样是多行；版本画布上的图标悬停显示全文", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await saveVersion(controlPlane, id, 1, noted(NOTE));
	const edited = "超时改成 300 秒\n不再等镜像预热";
	await saveVersion(controlPlane, id, 2, noted(edited));
	const diff = page.getByRole("region", { name: "差异" });
	const noteRow = diff
		.locator("div")
		.filter({ has: page.getByText("备注", { exact: true }) })
		.last();

	// 版本 1 → 2：节点 fetch 新增了备注。
	await page.goto(`/orchestrations/${id}/versions?a=1&b=2`);
	await expect(diff).toContainText("− 版本 1 → + 版本 2");
	await expect(diff.getByText("备注", { exact: true })).toBeVisible();
	await expect(diff.locator("ins")).toHaveText(NOTE);
	await expect(noteRow).toContainText("（新增）");
	const lines = await diff.locator("ins").evaluate((el) => (el as HTMLElement).innerText);
	expect(lines.split("\n")).toEqual(NOTE.split("\n"));
	await expect(diff.getByText("note", { exact: true })).toHaveCount(0);

	// 版本 2 → 3：备注改了，旧值和新值都列出来。
	await page.goto(`/orchestrations/${id}/versions?a=2&b=3`);
	await expect(diff).toContainText("− 版本 2 → + 版本 3");
	await expect(diff.locator("del")).toHaveText(NOTE);
	await expect(diff.locator("ins")).toHaveText(edited);

	// 只读的版本画布上，卡片同样有备注图标，悬停看全文。
	const pane = page.getByRole("region", { name: "版本 3（只读）" });
	await expect(pane.locator('[data-node-id="ping"]')).toBeVisible();
	await expect(pane.locator('[data-slot="note-icon"]')).toHaveCount(1);
	await pane.locator('[data-node-id="fetch"] [data-slot="note-icon"]').hover();
	await expect(tooltip(page)).toHaveText(edited);
});
