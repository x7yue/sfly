import type { Page } from "@playwright/test";
import { annotated, annotationFrame, type TestAnnotation } from "./annotation-support";
import {
	dock,
	editorDocument,
	inspector,
	nodeCard,
	nodePosition,
	openEditor,
	switchMode,
} from "./editor-support";
import { expect, test } from "./fixtures";
import { box, createScenario, publishPackage, triggerRun } from "./support";

// 整理和查找（第三批）：整理布局后问「保留 / 还原」；左侧的大纲按注释框分组列出节点，搜索、点一下定位；
// 小地图画出注释框。

/** 「取数」框着 fetch、dispatch；「汇报」框着子流程 sub_entry（连同 sub_ping）；entry、ping 不在框里。 */
const ANNOTATIONS: TestAnnotation[] = [
	{ id: "annotation_1", title: "取数", color: "blue", nodes: ["fetch", "dispatch"] },
	{ id: "annotation_2", title: "汇报", subflows: ["sub_entry"] },
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

async function openAnnotated(page: Page, cp: Parameters<typeof publishPackage>[0]) {
	await publishPackage(cp);
	const id = await createScenario(cp, "日终数据处理", annotated(ANNOTATIONS, triggerable));
	await openEditor(page, id);
	return id;
}

const outline = (page: Page) => page.getByRole("complementary", { name: "大纲" });
const tidyNotice = (page: Page) =>
	page.locator("[data-sonner-toast]").filter({ hasText: "已整理布局" });

test("整理布局后问保留还是还原：还原回到整理之前；保留只关掉通知；整理之后又有修改时通知自动收起", async ({
	page,
	controlPlane,
}) => {
	await openAnnotated(page, controlPlane);
	const original = await nodePosition(page, "sub_entry");

	await dock(page).getByRole("button", { name: "整理布局" }).click();
	await expect(tidyNotice(page)).toContainText("保留整理后的布局，还是还原到整理之前？");
	await expect.poll(() => nodePosition(page, "sub_entry")).not.toEqual(original);
	await tidyNotice(page).getByRole("button", { name: "还原" }).click();
	await expect.poll(() => nodePosition(page, "sub_entry")).toEqual(original);
	await expect(tidyNotice(page)).toHaveCount(0);

	await page.keyboard.press("Alt+Shift+F");
	const tidied = await nodePosition(page, "sub_entry");
	await tidyNotice(page).getByRole("button", { name: "保留" }).click();
	await expect(tidyNotice(page)).toHaveCount(0);
	expect(await nodePosition(page, "sub_entry")).toEqual(tidied);

	// 整理之后又改了别的（这里是撤销），通知收起：「还原」只还原刚才那次整理。
	await page.keyboard.press("Alt+Shift+F");
	await expect(tidyNotice(page)).toBeVisible();
	await dock(page).getByRole("button", { name: "撤销" }).click();
	await expect(tidyNotice(page)).toHaveCount(0);
});

test("大纲：O 键或工具条开关；不在框里的节点在最前，每个注释框一组；搜索；点节点选中并定位到大纲旁边，点注释框选中它", async ({
	page,
	controlPlane,
}) => {
	await openAnnotated(page, controlPlane);
	await expect(outline(page)).toHaveCount(0);
	await page.locator("[data-canvas-region]").focus();
	await page.keyboard.press("o");
	await expect(outline(page)).toBeVisible();
	await expect(dock(page).getByRole("button", { name: "大纲" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	const loose = outline(page).getByRole("region", { name: "不在注释框里的节点" });
	await expect(loose.getByRole("button")).toHaveText([/^入口entry$/, /^ping$/]);
	const fetchGroup = outline(page).getByRole("region", { name: "注释框 取数" });
	await expect(fetchGroup.getByRole("listitem")).toHaveText([/HTTP 检查fetch/, /异步任务dispatch/]);
	const report = outline(page).getByRole("region", { name: "注释框 汇报" });
	await expect(report.getByRole("listitem")).toHaveText([/sub_entry/, /sub_ping/]);

	// 收起一组。
	await report.getByRole("button", { name: "收起 汇报" }).click();
	await expect(report.getByRole("listitem")).toHaveCount(0);
	await report.getByRole("button", { name: "展开 汇报" }).click();
	await expect(report.getByRole("listitem")).toHaveCount(2);

	// 搜索：按节点 ID、标题；命中注释框标题时整组都在。
	const search = outline(page).getByRole("searchbox", { name: "搜索节点或注释框" });
	await search.fill("sub_p");
	await expect(outline(page).getByRole("listitem")).toHaveText([/sub_ping/]);
	await search.fill("取数");
	await expect(outline(page).getByRole("listitem")).toHaveCount(2);
	await search.fill("没有这个");
	await expect(outline(page)).toContainText("没有符合条件的节点或注释框");
	await search.fill("");

	// 点节点：选中，定位到没被大纲和检查器挡住的地方。
	await outline(page)
		.getByRole("button", { name: /sub_ping/ })
		.click();
	await expect(nodeCard(page, "sub_ping")).toHaveAttribute("aria-pressed", "true");
	const [panel, card] = [await box(outline(page)), await box(nodeCard(page, "sub_ping"))];
	await expect
		.poll(async () => (await box(nodeCard(page, "sub_ping"))).x)
		.toBeGreaterThan(panel.x + panel.width);
	expect(card.width).toBeGreaterThan(0);
	await expect(outline(page).getByRole("button", { name: /sub_ping/ })).toHaveAttribute(
		"aria-current",
		"true",
	);

	// 点注释框的标题：选中它。
	await fetchGroup.getByRole("button", { name: /^取数/ }).click();
	await expect(inspector(page).getByRole("heading", { name: "取数" })).toBeVisible();

	await dock(page).getByRole("button", { name: "大纲" }).click();
	await expect(outline(page)).toHaveCount(0);
});

test("运行状态下也有大纲：点注释框只定位，不选中（运行状态下不能选中注释框）", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({
		name: "agent-linux",
		slots: 2,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	const id = await openAnnotated(page, controlPlane);
	await triggerRun(controlPlane, id);
	await switchMode(page, "run");
	await dock(page).getByRole("button", { name: "大纲" }).click();
	const group = outline(page).getByRole("region", { name: "注释框 取数" });
	await group.getByRole("button", { name: /^取数/ }).click();
	await expect(annotationFrame(page, "annotation_1")).not.toHaveAttribute("data-selected");
	await outline(page).getByRole("button", { name: /ping$/ }).first().click();
	await expect(nodeCard(page, "ping")).toHaveAttribute("aria-pressed", "true");
});

test("小地图画出注释框：每个注释框一块，颜色跟着注释框；收起小地图再打开还在", async ({
	page,
	controlPlane,
}) => {
	await openAnnotated(page, controlPlane);
	const blocks = page.locator(".react-flow__minimap [data-minimap-annotations] rect");
	await expect(blocks).toHaveCount(2);
	await expect(blocks.first()).toHaveAttribute("data-annotation-color", "blue");
	await expect(blocks.nth(1)).toHaveAttribute("data-annotation-color", "gray");
	await dock(page).getByRole("button", { name: "小地图" }).click();
	await expect(blocks).toHaveCount(0);
	await dock(page).getByRole("button", { name: "小地图" }).click();
	await expect(blocks).toHaveCount(2);
});
