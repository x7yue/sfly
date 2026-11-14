import type { Locator, Page } from "@playwright/test";
import {
	clipboard,
	createEditorScenario,
	dock,
	edges,
	inspector,
	nodeCard,
	nodePosition,
	openEditor,
	switchMode,
} from "./editor-support";
import { expect, test } from "./fixtures";
import { box } from "./support";
import { twoVersions } from "./versions-support";

// 画布多选（#309）：Shift 框选、Ctrl/⌘ 加选减选、点子流程区域标题选中整个子流程；整组拖动、整组删除各是一步撤销；
// 检查器显示「已选 N 个节点」；只读的画布不能多选。

const ORIGINAL_EDGES = [
	"chain:dispatch->ping",
	"chain:entry->fetch",
	"chain:fetch->dispatch",
	"chain:sub_entry->sub_ping",
	"dispatch:dispatch->sub_entry",
];

/** 画布上选中的节点 ID，排好序。 */
const selectedIn = (scope: Page | Locator) =>
	scope
		.locator('[data-node-id][aria-pressed="true"]')
		.evaluateAll((els) => els.map((el) => el.getAttribute("data-node-id") ?? "").sort());

/** 按住 `key`（可以不按）从 `from` 拖到 `to`（屏幕坐标）。 */
async function drag(
	page: Page,
	from: { x: number; y: number },
	to: { x: number; y: number },
	key?: "Shift",
) {
	if (key) await page.keyboard.down(key);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
	await page.mouse.move(to.x, to.y, { steps: 4 });
	await page.mouse.up();
	if (key) await page.keyboard.up(key);
}

/** 从 `first` 左上方的空白处拖到 `last` 右下方：框住主链上 first 到 last 之间的节点。 */
async function aroundCards(page: Page, first: string, last: string) {
	const [a, b] = [await box(nodeCard(page, first)), await box(nodeCard(page, last))];
	return {
		from: { x: a.x - 12, y: a.y - 30 },
		to: { x: b.x + b.width + 12, y: b.y + b.height + 12 },
	};
}

const multiHeading = (page: Page, n: number) =>
	inspector(page).getByRole("heading", { name: `已选 ${n} 个节点` });

test("指针工具下 Shift 拖动空白处是框选；不按键拖动空白处、抓手工具下 Shift 拖动都是平移", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const entry = () => box(nodeCard(page, "entry"));
	const start = await entry();

	// 框住 fetch 和 dispatch：只选中框里完整的节点，视图不动。
	const around = await aroundCards(page, "fetch", "dispatch");
	await drag(page, around.from, around.to, "Shift");
	await expect.poll(() => selectedIn(page)).toEqual(["dispatch", "fetch"]);
	await expect(multiHeading(page, 2)).toBeVisible();
	expect(await entry()).toEqual(start);

	// 框选之后，框里的节点照样能点（没有盖在上面的选区矩形）。
	await nodeCard(page, "dispatch").click();
	await expect.poll(() => selectedIn(page)).toEqual(["dispatch"]);

	// 不按键拖动空白处（拖过 fetch）：平移视图，不框选，选中不变。
	await drag(page, around.from, { x: around.from.x + 160, y: around.from.y + 70 });
	await expect.poll(async () => (await entry()).x).toBeGreaterThan(start.x + 100);
	expect(await selectedIn(page)).toEqual(["dispatch"]);

	// 抓手工具下按住 Shift 拖动也是平移。
	await page.keyboard.press("Escape");
	await expect.poll(() => selectedIn(page)).toEqual([]);
	await dock(page).getByRole("button", { name: "抓手" }).click();
	const panned = await entry();
	const again = await aroundCards(page, "fetch", "dispatch");
	await drag(page, again.from, { x: again.to.x, y: again.to.y + 60 }, "Shift");
	await expect.poll(async () => (await entry()).y).toBeGreaterThan(panned.y + 60);
	expect(await selectedIn(page)).toEqual([]);
});

test("Ctrl/⌘ + 点击节点加选、减选；不按键点击只选中这一个", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	await nodeCard(page, "fetch").click();
	await nodeCard(page, "ping").click({ modifiers: ["ControlOrMeta"] });
	await nodeCard(page, "sub_ping").click({ modifiers: ["ControlOrMeta"] });
	await expect.poll(() => selectedIn(page)).toEqual(["fetch", "ping", "sub_ping"]);
	await expect(multiHeading(page, 3)).toBeVisible();

	await nodeCard(page, "fetch").click({ modifiers: ["ControlOrMeta"] });
	await expect.poll(() => selectedIn(page)).toEqual(["ping", "sub_ping"]);
	await expect(multiHeading(page, 2)).toBeVisible();

	// 减到只剩一个：检查器回到这个节点。
	await nodeCard(page, "ping").click({ modifiers: ["ControlOrMeta"] });
	await expect.poll(() => selectedIn(page)).toEqual(["sub_ping"]);
	await expect(inspector(page).getByText("sub_ping", { exact: true })).toBeVisible();
	await nodeCard(page, "sub_ping").click({ modifiers: ["ControlOrMeta"] });
	await expect.poll(() => selectedIn(page)).toEqual([]);
	await expect(inspector(page).getByRole("heading", { name: "场景设置" })).toBeVisible();

	await nodeCard(page, "fetch").click({ modifiers: ["ControlOrMeta"] });
	await nodeCard(page, "ping").click({ modifiers: ["ControlOrMeta"] });
	await expect.poll(() => selectedIn(page)).toEqual(["fetch", "ping"]);
	await nodeCard(page, "ping").click();
	await expect.poll(() => selectedIn(page)).toEqual(["ping"]);
});

test("点子流程区域的标题，选中这个子流程链上的全部节点", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	await nodeCard(page, "fetch").click();
	await page.getByRole("button", { name: "选中子流程 sub_entry 的全部节点" }).click();
	await expect.poll(() => selectedIn(page)).toEqual(["sub_entry", "sub_ping"]);
	await expect(multiHeading(page, 2)).toBeVisible();
});

test("拖动多选中的任意一个节点，整组一起移动，一步撤销", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const undo = dock(page).getByRole("button", { name: "撤销" });
	const position = async (node: string) => {
		const p = await nodePosition(page, node);
		if (!p) throw new Error(`没有节点 ${node} 的位置`);
		return p;
	};
	const before = {
		fetch: await position("fetch"),
		dispatch: await position("dispatch"),
		ping: await position("ping"),
	};

	await nodeCard(page, "fetch").click();
	await nodeCard(page, "dispatch").click({ modifiers: ["ControlOrMeta"] });
	const card = await box(nodeCard(page, "dispatch"));
	await drag(page, { x: card.x + 60, y: card.y + 50 }, { x: card.x + 140, y: card.y + 170 });
	await expect.poll(() => position("dispatch")).not.toEqual(before.dispatch);
	const moved = { fetch: await position("fetch"), dispatch: await position("dispatch") };
	const shift = (from: { x: number; y: number }, to: { x: number; y: number }) => ({
		x: Math.round(to.x - from.x),
		y: Math.round(to.y - from.y),
	});
	expect(shift(before.fetch, moved.fetch)).toEqual(shift(before.dispatch, moved.dispatch));
	expect(shift(before.fetch, moved.fetch).y).toBeGreaterThan(50);
	expect(await position("ping")).toEqual(before.ping);
	expect(await selectedIn(page)).toEqual(["dispatch", "fetch"]);

	await undo.click();
	await expect.poll(() => position("fetch")).toEqual(before.fetch);
	expect(await position("dispatch")).toEqual(before.dispatch);
	await expect(undo).toBeDisabled();
});

test("多选时按 Delete 依次删除选中的节点，入口节点跳过，一步撤销全部恢复", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const undo = dock(page).getByRole("button", { name: "撤销" });

	await nodeCard(page, "entry").click();
	await nodeCard(page, "fetch").click({ modifiers: ["ControlOrMeta"] });
	await nodeCard(page, "dispatch").click({ modifiers: ["ControlOrMeta"] });
	await expect(multiHeading(page, 3)).toBeVisible();
	await page.keyboard.press("Delete");

	// 每个节点都按单个删除的规则：链上连续的 fetch、dispatch 删掉后，前后接上；dispatch 的调度连线一起删除。
	await expect(nodeCard(page, "fetch")).toHaveCount(0);
	await expect(nodeCard(page, "dispatch")).toHaveCount(0);
	await expect(nodeCard(page, "entry")).toBeVisible();
	await expect(page.getByText("入口节点不能删除，已跳过")).toBeVisible();
	await expect.poll(() => edges(page)).toEqual(["chain:entry->ping", "chain:sub_entry->sub_ping"]);
	expect(await selectedIn(page)).toEqual(["entry"]);

	await undo.click();
	await expect(nodeCard(page, "fetch")).toBeVisible();
	await expect(nodeCard(page, "dispatch")).toBeVisible();
	await expect.poll(() => edges(page)).toEqual(ORIGINAL_EDGES);
	await expect(undo).toBeDisabled();
});

test("多选时检查器显示「已选 N 个节点」和删除按钮，删除算一步撤销", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const undo = dock(page).getByRole("button", { name: "撤销" });

	await nodeCard(page, "ping").click();
	await nodeCard(page, "sub_ping").click({ modifiers: ["ControlOrMeta"] });
	await expect(multiHeading(page, 2)).toBeVisible();
	await inspector(page).getByRole("button", { name: "删除选中的节点" }).click();
	await expect(nodeCard(page, "ping")).toHaveCount(0);
	await expect(nodeCard(page, "sub_ping")).toHaveCount(0);
	await expect(inspector(page).getByRole("heading", { name: "场景设置" })).toBeVisible();

	await undo.click();
	await expect(nodeCard(page, "ping")).toBeVisible();
	await expect(nodeCard(page, "sub_ping")).toBeVisible();
	await expect.poll(() => edges(page)).toEqual(ORIGINAL_EDGES);
	await expect(undo).toBeDisabled();
});

test("Esc 或点空白处取消多选；方向键从最近选中的节点出发，多选收成单选", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const pickTwo = async (first: string, second: string) => {
		await nodeCard(page, first).click();
		await nodeCard(page, second).click({ modifiers: ["ControlOrMeta"] });
		await expect.poll(() => selectedIn(page)).toEqual([first, second].sort());
	};

	await pickTwo("fetch", "dispatch");
	await page.keyboard.press("Escape");
	await expect.poll(() => selectedIn(page)).toEqual([]);
	await expect(inspector(page).getByRole("heading", { name: "场景设置" })).toBeVisible();

	await pickTwo("fetch", "dispatch");
	const fetch = await box(nodeCard(page, "fetch"));
	await page.mouse.click(fetch.x + fetch.width / 2, fetch.y + fetch.height + 120);
	await expect.poll(() => selectedIn(page)).toEqual([]);

	await pickTwo("fetch", "dispatch");
	await page.keyboard.press("ArrowRight");
	await expect.poll(() => selectedIn(page)).toEqual(["ping"]);
	await expect(nodeCard(page, "ping")).toBeFocused();

	await pickTwo("dispatch", "fetch");
	await page.keyboard.press("ArrowLeft");
	await expect.poll(() => selectedIn(page)).toEqual(["entry"]);
});

test.describe("多选时复制、创建副本", () => {
	test.beforeEach(async ({ context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	});

	test("Ctrl+C、Ctrl+D 只提示不支持，不复制任何节点", async ({ page, controlPlane }) => {
		const id = await createEditorScenario(controlPlane);
		await openEditor(page, id);
		await page.evaluate(() => navigator.clipboard.writeText("原来的内容"));

		await nodeCard(page, "fetch").click();
		await nodeCard(page, "ping").click({ modifiers: ["ControlOrMeta"] });
		await page.keyboard.press("ControlOrMeta+c");
		await expect(page.getByText("不能一次复制多个节点")).toBeVisible();
		expect(await clipboard(page)).toBe("原来的内容");

		await page.keyboard.press("Control+d");
		await expect(page.getByText("不能一次给多个节点创建副本")).toBeVisible();
		await expect(page.locator("[data-node-id]")).toHaveCount(6);
		expect(await selectedIn(page)).toEqual(["fetch", "ping"]);
	});
});

test("运行状态模式不能多选：编辑时的多选只留最近选中的节点，Ctrl/⌘ 点击只选中一个，Shift 拖动是平移，子流程标题不能点", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);

	await nodeCard(page, "fetch").click();
	await nodeCard(page, "ping").click({ modifiers: ["ControlOrMeta"] });
	await switchMode(page, "run");
	await expect.poll(() => selectedIn(page)).toEqual(["ping"]);

	await nodeCard(page, "fetch").click();
	await nodeCard(page, "dispatch").click({ modifiers: ["ControlOrMeta"] });
	await expect.poll(() => selectedIn(page)).toEqual(["dispatch"]);

	const entry = await box(nodeCard(page, "entry"));
	const around = await aroundCards(page, "fetch", "dispatch");
	await drag(page, around.from, { x: around.to.x, y: around.to.y + 60 }, "Shift");
	await expect
		.poll(async () => (await box(nodeCard(page, "entry"))).y)
		.toBeGreaterThan(entry.y + 60);
	expect(await selectedIn(page)).toEqual(["dispatch"]);
	await expect(page.getByRole("button", { name: /^选中子流程/ })).toHaveCount(0);
});

test("版本查看的画布不能多选：Ctrl/⌘ 点击只选中一个，子流程标题不能点", async ({
	page,
	controlPlane,
	clock,
}) => {
	const id = await twoVersions(controlPlane, clock);
	await page.goto(`/orchestrations/${id}/versions`);
	const pane = page.getByRole("region", { name: "版本 2（只读）" });
	await expect(pane.locator('[data-node-id="fetch"]')).toBeVisible();

	await pane.locator('[data-node-id="fetch"]').click();
	await pane.locator('[data-node-id="ping"]').click({ modifiers: ["ControlOrMeta"] });
	await expect.poll(() => selectedIn(pane)).toEqual(["ping"]);
	await expect(pane.getByRole("button", { name: /^选中子流程/ })).toHaveCount(0);
});
