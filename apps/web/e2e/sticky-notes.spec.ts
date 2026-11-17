import type { Page } from "@playwright/test";
import { annotated } from "./annotation-support";
import {
	dock,
	editorDocument,
	headOf,
	inspector,
	openEditor,
	paneMenu,
	switchMode,
	zoomOut,
} from "./editor-support";
import { expect, test } from "./fixtures";
import { box, createScenario, publishPackage, triggerRun } from "./support";

// 便签（ADR 0026，第四批）：空白处菜单新建；拖动移动、拖右下角改大小；检查器里改标题、正文、颜色；
// 工具条换颜色、删除，Delete 删除；整理布局排在最上面一行；运行状态、版本查看只读显示，版本对比列出改动；
// 缩小视图只留一行；大纲和小地图里也有。

interface TestSticky {
	id: string;
	title?: string;
	text: string;
	color?: string;
	position?: { x: number; y: number };
	size?: { width: number; height: number };
}

const STICKIES: TestSticky[] = [
	{
		id: "sticky_1",
		title: "跑之前确认",
		text: "- Agent 都在线\n- 升级包已放好",
		position: { x: 0, y: -260 },
	},
];

/** editorDocument 去掉必填的入口参数（给了默认值），不填参数也能触发运行。 */
const triggerable = {
	...editorDocument,
	nodes: editorDocument.nodes.map((n) =>
		n.id === "entry"
			? { ...n, params: [{ name: "biz_date", type: "string", default: "2026-01-01" }] }
			: n,
	),
};

async function openWithStickies(
	page: Page,
	cp: Parameters<typeof publishPackage>[0],
	stickies: TestSticky[] = STICKIES,
) {
	await publishPackage(cp);
	const id = await createScenario(cp, "日终数据处理", {
		...annotated([], triggerable),
		sticky_notes: stickies,
	});
	await openEditor(page, id);
	return id;
}

const sticky = (page: Page, id: string) => page.locator(`[data-sticky-note="${id}"]`);
/** 便签的纸面（按住它拖动、点它选中、双击它打开检查器）。 */
const paper = (page: Page, id: string) => sticky(page, id).locator("> div").last();
const textBox = (page: Page) => inspector(page).getByRole("textbox", { name: "正文" });
const titleBox = (page: Page) => inspector(page).getByRole("textbox", { name: "标题" });
const undo = (page: Page) => dock(page).getByRole("button", { name: "撤销" }).click();
const toolbar = (page: Page) => page.getByRole("toolbar", { name: "便签的工具条" });
const saved = async (cp: Parameters<typeof headOf>[0], id: string) =>
	((await headOf(cp, id)) as unknown as { document: { sticky_notes: TestSticky[] } }).document
		.sticky_notes;

async function save(page: Page, version: number) {
	await page.getByRole("button", { name: /保存/ }).click();
	await expect(page.getByText(`已保存为版本 ${version}`)).toBeVisible();
}

/** 从 `from` 分几步拖到 `to`（屏幕坐标）。 */
async function dragFrom(page: Page, from: { x: number; y: number }, by: { x: number; y: number }) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x + by.x / 2, from.y + by.y / 2, { steps: 4 });
	await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 4 });
	await page.mouse.up();
}

test("空白处菜单添加便签：落在右键的位置，选中，正文输入框拿到焦点；改标题、正文、颜色；保存刷新后还在；新建能撤销", async ({
	page,
	controlPlane,
}) => {
	const id = await openWithStickies(page, controlPlane, []);
	await page.mouse.click(360, 700, { button: "right" });
	await paneMenu(page).getByRole("menuitem", { name: "添加便签" }).click();
	const created = sticky(page, "sticky_1");
	await expect(created).toBeVisible();
	const at = await box(created);
	expect(Math.abs(at.x - 360)).toBeLessThan(2);
	expect(Math.abs(at.y - 700)).toBeLessThan(2);
	await expect(textBox(page)).toBeFocused();
	await expect(textBox(page)).toHaveValue("便签 1");

	await textBox(page).fill("- 一\n- 二\n收尾");
	await titleBox(page).fill("清单");
	await inspector(page)
		.getByRole("group", { name: "颜色" })
		.getByRole("button", { name: "绿" })
		.click();
	await expect(created).toHaveAttribute("data-annotation-color", "green");
	await expect(created.getByRole("listitem")).toHaveText(["一", "二"]);
	await expect(created).toContainText("清单");
	await expect(created).toContainText("收尾");

	await save(page, 2);
	expect(await saved(controlPlane, id)).toEqual([
		expect.objectContaining({
			id: "sticky_1",
			title: "清单",
			text: "- 一\n- 二\n收尾",
			color: "green",
		}),
	]);
	await page.reload();
	await expect(sticky(page, "sticky_1")).toContainText("清单");

	// 新建一张再撤销：便签消失，检查器回到场景设置。
	await page.mouse.click(1000, 700, { button: "right" });
	await paneMenu(page).getByRole("menuitem", { name: "添加便签" }).click();
	await expect(sticky(page, "sticky_2")).toBeVisible();
	await undo(page);
	await expect(sticky(page, "sticky_2")).toHaveCount(0);
	await expect(inspector(page).getByRole("heading", { name: "场景设置" })).toBeVisible();
});

test("拖动便签移动、拖右下角改大小，各是一步撤销；工具条换颜色、删除；选中后按 Delete 删除", async ({
	page,
	controlPlane,
}) => {
	await openWithStickies(page, controlPlane);
	const note = sticky(page, "sticky_1");
	const before = await box(note);

	await dragFrom(page, { x: before.x + 60, y: before.y + 60 }, { x: 120, y: 40 });
	const moved = await box(note);
	expect(moved.x - before.x).toBeGreaterThan(100);
	expect(moved.width).toBeCloseTo(before.width, 0);
	await undo(page);
	await expect.poll(async () => (await box(note)).x).toBeCloseTo(before.x, 0);

	// 选中以后才有改大小的手柄。
	await paper(page, "sticky_1").click();
	await expect(toolbar(page)).toBeVisible();
	const handle = note.locator("[data-sticky-resize]");
	const corner = await box(handle);
	await dragFrom(
		page,
		{ x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 },
		{ x: 80, y: 60 },
	);
	const resized = await box(note);
	expect(resized.width - before.width).toBeGreaterThan(60);
	expect(resized.height - before.height).toBeGreaterThan(40);
	expect(resized.x).toBeCloseTo(before.x, 0);
	await undo(page);
	await expect.poll(async () => (await box(note)).width).toBeCloseTo(before.width, 0);

	// 工具条：换颜色（选黄色时去掉 color）。
	await paper(page, "sticky_1").click();
	await toolbar(page).getByRole("button", { name: "颜色：黄" }).click();
	await page
		.locator('[data-slot="popover-content"]')
		.getByRole("group", { name: "颜色" })
		.getByRole("button", { name: "蓝" })
		.click();
	await expect(note).toHaveAttribute("data-annotation-color", "blue");

	// 选中后按 Delete 删除，撤销回来；工具条上的删除也行。
	await paper(page, "sticky_1").click();
	await page.keyboard.press("Delete");
	await expect(note).toHaveCount(0);
	await undo(page);
	await expect(note).toBeVisible();
	await paper(page, "sticky_1").click();
	await toolbar(page).getByRole("button", { name: "删除便签" }).click();
	await expect(note).toHaveCount(0);
});

test("正文清空是字段错误，不能保存；保存被拦下时选中这张便签并聚焦正文；双击便签也打开检查器", async ({
	page,
	controlPlane,
}) => {
	await openWithStickies(page, controlPlane);
	await paper(page, "sticky_1").dblclick();
	await expect(textBox(page)).toBeFocused();
	await textBox(page).fill("");
	await page.getByRole("button", { name: "收起检查器" }).click();
	await page.getByRole("button", { name: /保存/ }).click();
	await expect(textBox(page)).toBeFocused();
	await expect(inspector(page)).toContainText("不能为空");
	await expect(page.getByText(/已保存为版本/)).toHaveCount(0);
});

test("整理布局把便签排在最上面一行；运行状态和版本查看里显示便签（只读），版本对比列出便签的改动", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({
		name: "agent-linux",
		slots: 2,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	const id = await openWithStickies(page, controlPlane, [
		{ id: "sticky_1", title: "跑之前确认", text: "- 一", position: { x: 900, y: 600 } },
		{ id: "sticky_2", text: "已知问题", position: { x: 0, y: 900 } },
	]);
	await page.keyboard.press("Alt+Shift+F");
	await expect
		.poll(async () => {
			const [a, b, entry] = [
				await box(sticky(page, "sticky_1")),
				await box(sticky(page, "sticky_2")),
				await box(page.locator('[data-node-id="entry"]')),
			];
			return a.y === b.y && a.x < b.x && a.y + a.height < entry.y && Math.abs(a.x - entry.x) < 2;
		})
		.toBe(true);
	await paper(page, "sticky_1").click();
	await titleBox(page).fill("跑之前先确认");
	await save(page, 2);
	await triggerRun(controlPlane, id);

	await switchMode(page, "run");
	await expect(sticky(page, "sticky_1")).toContainText("跑之前先确认");
	await paper(page, "sticky_1").click();
	await expect(sticky(page, "sticky_1")).not.toHaveAttribute("data-selected");
	await expect(toolbar(page)).toHaveCount(0);

	await page.goto(`/orchestrations/${id}/versions?a=1&b=2`);
	const group = page.getByRole("region", { name: "差异" }).getByRole("region", { name: "便签" });
	await expect(group).toContainText("跑之前先确认（sticky_1）");
	await expect(group).toContainText("标题 跑之前确认 → 跑之前先确认");
	await expect(
		page.getByRole("region", { name: "版本 2（只读）" }).locator('[data-sticky-note="sticky_1"]'),
	).toBeVisible();
});

test("缩小视图时便签只留一行（标题，没有标题时是正文第一行）；大纲列出便签，点一下定位并选中；小地图画出便签", async ({
	page,
	controlPlane,
}) => {
	await openWithStickies(page, controlPlane, [
		...STICKIES,
		{
			id: "sticky_2",
			text: "- 已知问题：重启慢\n第二行",
			color: "pink",
			position: { x: 400, y: -260 },
		},
	]);
	await zoomOut(page, 3);
	await expect(page.locator("[data-lod]")).toHaveAttribute("data-lod", "true");
	await expect(sticky(page, "sticky_1").getByRole("listitem")).toHaveCount(0);
	await expect(sticky(page, "sticky_2")).toContainText("已知问题：重启慢");
	await expect(sticky(page, "sticky_2")).not.toContainText("第二行", { useInnerText: true });

	await dock(page).getByRole("button", { name: "大纲" }).click();
	const outline = page.getByRole("complementary", { name: "大纲" });
	const list = outline.getByRole("region", { name: "便签" });
	await expect(list.getByRole("button")).toHaveText(["跑之前确认", "已知问题：重启慢"]);
	await list.getByRole("button", { name: "已知问题：重启慢" }).click();
	await expect(sticky(page, "sticky_2")).toHaveAttribute("data-selected", "true");
	await expect(inspector(page).getByRole("textbox", { name: "正文" })).toHaveValue(
		"- 已知问题：重启慢\n第二行",
	);

	const blocks = page.locator(
		".react-flow__minimap [data-minimap-annotations] rect[data-minimap-sticky]",
	);
	await expect(blocks).toHaveCount(2);
	await expect(blocks.nth(1)).toHaveAttribute("data-annotation-color", "pink");
});
