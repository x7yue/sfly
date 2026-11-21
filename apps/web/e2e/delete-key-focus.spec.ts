import type { Locator, Page } from "@playwright/test";
import {
	createEditorScenario,
	dock,
	inspector,
	nodeCard,
	openEditor,
	typedDocument,
	typedNodes,
} from "./editor-support";
import { expect, test } from "./fixtures";
import { box, createScenario, publishPackage } from "./support";

// 画布上的删除键（#461）：焦点在检查器（输入框、下拉、按钮、页签、面板本身）里时，Backspace 和 Delete 不传给画布；
// 焦点在画布上选中节点时照常删除，并给一条带「撤销」的通知。

const KEYS = ["Backspace", "Delete"] as const;

const notice = (page: Page) =>
	page.locator("[data-sonner-toast]").filter({ hasText: "已删除节点" });

/** 选中 ping（整值引用 `${{ nodes.fetch.outputs.status }}`），检查器停在「参数」页。 */
async function selectPing(page: Page, controlPlane: Parameters<typeof createEditorScenario>[0]) {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "ping").click();
	await expect(inspector(page).getByRole("tab", { name: "参数" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
}

/** 检查器里焦点会落的几种地方（不是画布）：都不该把删除键传给画布。 */
const TARGETS: Array<{ name: string; locate: (page: Page) => Locator | Promise<Locator> }> = [
	{
		name: "面板本身（点一下不是输入框的空白处，#404 第 2 条的复现步骤）",
		locate: async (page) => {
			const panel = inspector(page).getByRole("tabpanel");
			// 点面板底部的空白处（左边缘有调整宽度的把手，盖住了左上角）。
			const { width, height } = await box(panel);
			await panel.click({ position: { x: width - 8, y: height - 8 } });
			return panel;
		},
	},
	{
		name: "输入框（整值引用，contenteditable）",
		locate: (page) => inspector(page).getByRole("combobox", { name: "输入 host" }),
	},
	{ name: "页签", locate: (page) => inspector(page).getByRole("tab", { name: "说明与指标" }) },
	{
		name: "按钮（删除节点）",
		locate: (page) => inspector(page).getByRole("button", { name: "删除节点" }),
	},
	{ name: "检查器容器（Esc 回到的地方）", locate: (page) => inspector(page) },
];

for (const key of KEYS) {
	for (const target of TARGETS) {
		test(`焦点在检查器的${target.name}：${key} 不删除节点`, async ({ page, controlPlane }) => {
			await selectPing(page, controlPlane);
			const focus = await target.locate(page);
			await focus.focus();
			await expect(focus).toBeFocused();
			await page.keyboard.press(key);
			await expect(nodeCard(page, "ping")).toBeVisible();
			await expect(notice(page)).toHaveCount(0);
			// 输入框里的删除键是编辑文字（整块引用被删掉也是一步撤销）；其他地方什么都不该发生。
			if (!target.name.startsWith("输入框")) {
				await expect(dock(page).getByRole("button", { name: "撤销" })).toBeDisabled();
			}
		});
	}

	test(`焦点在检查器的开关（执行页的 always）：${key} 不删除节点`, async ({
		page,
		controlPlane,
	}) => {
		await selectPing(page, controlPlane);
		await inspector(page).getByRole("tab", { name: "执行" }).click();
		const toggle = inspector(page).getByRole("switch", { name: "always" });
		await toggle.focus();
		await expect(toggle).toBeFocused();
		await page.keyboard.press(key);
		await expect(nodeCard(page, "ping")).toBeVisible();
		await expect(notice(page)).toHaveCount(0);
		await expect(dock(page).getByRole("button", { name: "撤销" })).toBeDisabled();
	});

	test(`焦点在检查器的下拉（枚举参数 level）、输入框、移除引用的按钮上：${key} 不删除节点`, async ({
		page,
		controlPlane,
	}) => {
		await publishPackage(controlPlane, { nodes: typedNodes });
		const id = await createScenario(controlPlane, "各种类型的参数", typedDocument);
		await page.goto(`/orchestrations/${id}`);
		await nodeCard(page, "typed").click();
		const panel = inspector(page);
		const focusables = [
			panel.getByRole("combobox", { name: "输入 level" }),
			panel.getByRole("textbox", { name: "输入 ratio" }),
			panel.getByRole("button", { name: "移除 count 的引用" }),
		];
		for (const focus of focusables) {
			await focus.focus();
			await expect(focus).toBeFocused();
			await page.keyboard.press(key);
			await expect(nodeCard(page, "typed")).toBeVisible();
			await expect(notice(page)).toHaveCount(0);
		}
	});

	test(`焦点在画布的工具条、大纲上（也不是画布）：${key} 不删除选中的节点`, async ({
		page,
		controlPlane,
	}) => {
		const id = await createEditorScenario(controlPlane);
		await openEditor(page, id);
		await nodeCard(page, "ping").click();
		await dock(page).getByRole("button", { name: "大纲" }).click();
		const outline = page.getByRole("complementary", { name: "大纲" });
		await expect(outline).toBeVisible();
		for (const focus of [
			dock(page).getByRole("button", { name: "适配视图" }),
			outline.getByRole("button").first(),
		]) {
			await focus.focus();
			await expect(focus).toBeFocused();
			await page.keyboard.press(key);
			await expect(nodeCard(page, "ping")).toBeVisible();
			await expect(notice(page)).toHaveCount(0);
		}
	});

	test(`页面上没有焦点（点在顶栏标题文字上，焦点落到 body）：${key} 和方向键等画布键一样照常作用于选中的节点`, async ({
		page,
		controlPlane,
	}) => {
		const id = await createEditorScenario(controlPlane);
		await openEditor(page, id);
		await nodeCard(page, "ping").click();
		await page.getByRole("heading", { level: 1 }).click();
		expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
		await page.keyboard.press(key);
		await expect(nodeCard(page, "ping")).toHaveCount(0);
		await expect(notice(page)).toBeVisible();
	});

	test(`焦点在画布上：选中节点按 ${key} 照常删除，带「撤销」的通知把它恢复`, async ({
		page,
		controlPlane,
	}) => {
		const id = await createEditorScenario(controlPlane);
		await openEditor(page, id);
		await nodeCard(page, "ping").click();
		await page.keyboard.press(key);
		await expect(nodeCard(page, "ping")).toHaveCount(0);
		const toast = notice(page);
		await expect(toast).toBeVisible();
		await expect(toast).toContainText("ping");
		// 带「撤销」的通知不自动消失；点它节点回来。
		await toast.getByRole("button", { name: "撤销" }).click();
		await expect(nodeCard(page, "ping")).toBeVisible();
		await expect(toast).toHaveCount(0);
		// 通知的「撤销」就是撤销栈里的这一步：撤销之后工具条的「撤销」回到起点。
		await expect(dock(page).getByRole("button", { name: "撤销" })).toBeDisabled();
	});
}
