import type { Page } from "@playwright/test";
import {
	addMenu,
	createEditorScenario,
	dock,
	edges,
	editorDocument,
	headOf,
	nodeCard,
	nodePosition,
	openEditor,
} from "./editor-support";
import { expect, test } from "./fixtures";
import { box, createScenario, publishPackage } from "./support";

// 连线的右键菜单、悬停「＋」插入节点、拖动端点改接（#185）。

const edgeMenu = (page: Page) => page.getByRole("menu", { name: "连线菜单" });
const insertButton = (page: Page) => page.getByRole("button", { name: "在此插入节点" });

const ORIGINAL = [
	"chain:dispatch->ping",
	"chain:entry->fetch",
	"chain:fetch->dispatch",
	"chain:sub_entry->sub_ping",
	"dispatch:dispatch->sub_entry",
];

const center = (b: { x: number; y: number; width: number; height: number }) => ({
	x: b.x + b.width / 2,
	y: b.y + b.height / 2,
});

/** 连线上某一处的屏幕坐标：沿路径走过全长的比例 `t`。 */
const pointOn = (page: Page, id: string, t: number) =>
	page.locator(`[data-edge="${id}"]`).evaluate((el, t) => {
		const path = el as SVGPathElement;
		const ctm = path.getScreenCTM();
		if (!ctm) throw new Error("连线不可见");
		const p = path.getPointAtLength(path.getTotalLength() * t).matrixTransform(ctm);
		return { x: p.x, y: p.y };
	}, t);

/** 在连线上（离起点三成处，避开中点的「＋」）右键。 */
async function rightClickEdge(page: Page, id: string) {
	const at = await pointOn(page, id, 0.3);
	await page.mouse.click(at.x, at.y, { button: "right" });
}

/** 节点卡片上的链端口：`source` 出口、`target` 入口。 */
const port = (page: Page, nodeId: string, type: "source" | "target") =>
	nodeCard(page, nodeId).locator(`.react-flow__handle[data-handleid="chain"].${type}`);

/**
 * 按住连线的一端拖到 `to`，松开。`end` 是要拖动的那一端（`target` 是终点）。
 * 端点的拖动区是端口外侧半径 10 的圆（React Flow 的 edgeupdater），按在圆心上：避开端口本身和中点的「＋」。
 */
async function dragEnd(
	page: Page,
	id: string,
	end: "source" | "target",
	to: { x: number; y: number },
) {
	const anchor = await box(
		page.locator(`.react-flow__edge[data-id="${id}"] .react-flow__edgeupdater-${end}`),
	);
	const from = center(anchor);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x + 30, from.y + 30, { steps: 4 });
	await page.mouse.move(to.x, to.y, { steps: 8 });
	await page.mouse.up();
}

test("链上的连线右键有「在此插入节点」「断开连线」，调度连线只有「断开连线」；插入的节点接在两端之间，后面的节点让出位置，是一步撤销", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const menu = edgeMenu(page);

	await rightClickEdge(page, "chain:fetch->dispatch");
	await expect(menu.getByRole("menuitem")).toHaveText(["在此插入节点", "断开连线Delete"]);
	// 右键的连线高亮。
	await expect(page.locator('[data-edge="chain:fetch->dispatch"]')).toHaveAttribute(
		"data-highlighted",
		"true",
	);
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
	await expect(page.getByRole("region", { name: /^编排画布/ })).toBeFocused();

	// 调度连线中间不能插节点。
	await rightClickEdge(page, "dispatch:dispatch->sub_entry");
	await expect(menu.getByRole("menuitem")).toHaveText(["断开连线Delete"]);
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);

	await rightClickEdge(page, "chain:fetch->dispatch");
	await menu.getByRole("menuitem", { name: "在此插入节点" }).click();
	await expect(addMenu(page).getByText("新节点插在 fetch 和 dispatch 之间")).toBeVisible();
	await expect(addMenu(page).getByRole("option", { name: /子流程入口/ })).toHaveCount(0);
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
	// 新节点放在 fetch 右侧一列，同一行后面的节点各后移一列；子流程那一行不动。
	expect(await nodePosition(page, "sleep_1")).toEqual({ x: 504, y: 0 });
	expect(await nodePosition(page, "dispatch")).toEqual({ x: 756, y: 0 });
	expect(await nodePosition(page, "ping")).toEqual({ x: 1008, y: 0 });
	expect(await nodePosition(page, "sub_entry")).toEqual({ x: 660, y: 230 });

	// 一步撤销。
	const undo = dock(page).getByRole("button", { name: "撤销" });
	await undo.click();
	await expect(nodeCard(page, "sleep_1")).toHaveCount(0);
	await expect.poll(() => edges(page)).toEqual(ORIGINAL);
	expect(await nodePosition(page, "dispatch")).toEqual({ x: 504, y: 0 });
	await expect(undo).toBeDisabled();
});

test("悬停链上的连线时中点出现「＋」，点它与「在此插入节点」相同；调度连线上没有「＋」", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	const near = await pointOn(page, "chain:fetch->dispatch", 0.3);
	await page.mouse.move(near.x, near.y);
	await expect(insertButton(page)).toBeVisible();
	const mid = await pointOn(page, "chain:fetch->dispatch", 0.5);
	const plus = center(await box(insertButton(page)));
	expect(Math.abs(plus.x - mid.x)).toBeLessThan(2);
	expect(Math.abs(plus.y - mid.y)).toBeLessThan(2);
	// 鼠标离开连线后消失。
	await page.mouse.move(near.x, near.y + 120);
	await expect(insertButton(page)).toHaveCount(0);

	// 从链上的连线移到调度连线上：「＋」收起，不再出现。
	await page.mouse.move(near.x, near.y);
	await expect(insertButton(page)).toBeVisible();
	const dispatchEdge = await pointOn(page, "dispatch:dispatch->sub_entry", 0.3);
	await page.mouse.move(dispatchEdge.x, dispatchEdge.y);
	await expect(insertButton(page)).toHaveCount(0);

	// 鼠标沿连线移到「＋」上，它不消失；点它打开添加节点菜单。
	await page.mouse.move(near.x, near.y);
	await page.mouse.move(mid.x, mid.y, { steps: 5 });
	await insertButton(page).click();
	await expect(addMenu(page).getByText("新节点插在 fetch 和 dispatch 之间")).toBeVisible();
	await addMenu(page).getByRole("option", { name: /Sleep/ }).click();
	await expect(page.locator('[data-edge="chain:fetch->sleep_1"]')).toHaveCount(1);
	await expect(page.locator('[data-edge="chain:sleep_1->dispatch"]')).toHaveCount(1);
	expect(await nodePosition(page, "dispatch")).toEqual({ x: 756, y: 0 });

	await page.keyboard.press("Control+z");
	await expect.poll(() => edges(page)).toEqual(ORIGINAL);
	await expect(dock(page).getByRole("button", { name: "撤销" })).toBeDisabled();
});

test("断开连线：菜单和 Delete 键都只删这一条连线，各是一步撤销", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const undo = dock(page).getByRole("button", { name: "撤销" });
	const cut = ORIGINAL.filter((e) => e !== "chain:fetch->dispatch");

	await rightClickEdge(page, "chain:fetch->dispatch");
	await edgeMenu(page)
		.getByRole("menuitem", { name: /断开连线/ })
		.click();
	await expect.poll(() => edges(page)).toEqual(cut);
	await expect(nodeCard(page, "fetch")).toBeVisible();
	await undo.click();
	await expect.poll(() => edges(page)).toEqual(ORIGINAL);
	await expect(undo).toBeDisabled();

	// 调度连线同样可以断开。
	await rightClickEdge(page, "dispatch:dispatch->sub_entry");
	await edgeMenu(page)
		.getByRole("menuitem", { name: /断开连线/ })
		.click();
	await expect
		.poll(() => edges(page))
		.toEqual(ORIGINAL.filter((e) => e !== "dispatch:dispatch->sub_entry"));
	await undo.click();
	await expect.poll(() => edges(page)).toEqual(ORIGINAL);

	// 点选连线后按 Delete：选中的节点先取消选中，只删连线。
	await nodeCard(page, "fetch").click();
	const at = await pointOn(page, "chain:fetch->dispatch", 0.3);
	await page.mouse.click(at.x, at.y);
	await expect(nodeCard(page, "fetch")).toHaveAttribute("aria-pressed", "false");
	await page.keyboard.press("Delete");
	await expect.poll(() => edges(page)).toEqual(cut);
	await expect(nodeCard(page, "fetch")).toBeVisible();
	await undo.click();
	await expect.poll(() => edges(page)).toEqual(ORIGINAL);
	await expect(undo).toBeDisabled();

	// 快捷键面板写明 Delete 也能断开选中的连线。
	await page.locator("body").press("?");
	const shortcuts = page.getByRole("dialog", { name: "快捷键" });
	await expect(
		shortcuts
			.getByRole("region", { name: "编排画布" })
			.locator("dl > div")
			.filter({ hasText: /Delete$/ }),
	).toHaveText("删除节点 / 断开连线Delete");
});

test("拖动连线的终点或起点改接到另一个节点，是一步撤销；违反连线规则时回到原处并提示原因", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane);
	// 在示例场景上加一个游离节点 spare，作为改接的目标。
	const id = await createScenario(controlPlane, "改接", {
		...editorDocument,
		nodes: [
			...editorDocument.nodes,
			{
				id: "spare",
				kind: "package",
				package: "demo-checks",
				node: "ping",
				position: { x: 252, y: 230 },
				inputs: { host: "h" },
			},
		],
	});
	await openEditor(page, id);
	const undo = dock(page).getByRole("button", { name: "撤销" });
	const portAt = async (nodeId: string, type: "source" | "target") =>
		center(await box(port(page, nodeId, type)));

	// 终点：dispatch → ping 改成 dispatch → spare。
	await dragEnd(page, "chain:dispatch->ping", "target", await portAt("spare", "target"));
	await expect
		.poll(() => edges(page))
		.toEqual(
			[
				"chain:dispatch->spare",
				"chain:entry->fetch",
				"chain:fetch->dispatch",
				"chain:sub_entry->sub_ping",
				"dispatch:dispatch->sub_entry",
			].sort(),
		);
	await undo.click();
	await expect.poll(() => edges(page)).toEqual(ORIGINAL);
	await expect(undo).toBeDisabled();

	// 起点：dispatch → ping 改成 spare → ping。
	await dragEnd(page, "chain:dispatch->ping", "source", await portAt("spare", "source"));
	await expect.poll(() => edges(page)).toContain("chain:spare->ping");
	await expect.poll(() => edges(page)).not.toContain("chain:dispatch->ping");

	// 保存下来的连线留在原来的位置。
	await page.getByRole("button", { name: /保存/ }).click();
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const saved = (await headOf(controlPlane, id)) as unknown as {
		document: { edges: { from: string; to: string; kind: string }[] };
	};
	expect(saved.document.edges.map((e) => `${e.kind}:${e.from}>${e.to}`)).toEqual([
		"chain:entry>fetch",
		"chain:fetch>dispatch",
		"chain:spare>ping",
		"dispatch:dispatch>sub_entry",
		"chain:sub_entry>sub_ping",
	]);
	await undo.click();
	await expect.poll(() => edges(page)).toEqual(ORIGINAL);
	await expect(undo).toBeDisabled();

	// 汇合：entry → fetch 的终点拖到已有入线的 dispatch 上。
	await dragEnd(page, "chain:entry->fetch", "target", await portAt("dispatch", "target"));
	await expect(page.getByText("节点 dispatch 已有入线，链不能汇合")).toBeVisible();
	await expect.poll(() => edges(page)).toEqual(ORIGINAL);
	// 成环：entry → fetch 的起点拖到链尾 ping 上（ping → fetch → dispatch → ping）。
	await dragEnd(page, "chain:entry->fetch", "source", await portAt("ping", "source"));
	await expect(page.getByText("连线会形成环")).toBeVisible();
	await expect.poll(() => edges(page)).toEqual(ORIGINAL);
	// 分叉：dispatch → ping 的起点拖到已有出线的 fetch 上。
	await dragEnd(page, "chain:dispatch->ping", "source", await portAt("fetch", "source"));
	await expect(page.getByText("节点 fetch 已有出线，链不能分叉")).toBeVisible();
	await expect.poll(() => edges(page)).toEqual(ORIGINAL);
	// 拖到空白处松开：连线回到原处，不弹添加节点菜单。
	const blank = await portAt("spare", "target");
	await dragEnd(page, "chain:dispatch->ping", "target", { x: blank.x - 120, y: blank.y + 140 });
	await expect.poll(() => edges(page)).toEqual(ORIGINAL);
	await expect(addMenu(page)).toHaveCount(0);
	await expect(undo).toBeDisabled();
});

test("运行状态模式下连线没有菜单、没有「＋」、不能改接", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	// 编辑模式下有改接用的拖动区、悬停有「＋」。
	await expect(page.locator(".react-flow__edgeupdater").first()).toBeAttached();
	const near = await pointOn(page, "chain:fetch->dispatch", 0.3);
	await page.mouse.move(near.x, near.y);
	await expect(insertButton(page)).toBeVisible();
	await page.mouse.move(near.x, near.y + 160);
	await expect(insertButton(page)).toHaveCount(0);

	await page.locator("body").press("r");
	await expect(page.getByRole("button", { name: /保存/ })).toHaveCount(0);
	await page.mouse.move(near.x, near.y);
	await expect(insertButton(page)).toHaveCount(0);
	await expect(page.locator(".react-flow__edgeupdater")).toHaveCount(0);

	// 右键连线等同于右键空白处：只有「适配视图」。
	await page.mouse.click(near.x, near.y, { button: "right" });
	const paneMenu = page.getByRole("menu", { name: "画布菜单" });
	await expect(paneMenu.getByRole("menuitem")).toHaveText(["适配视图0"]);
	await expect(edgeMenu(page)).toHaveCount(0);
});
