// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import type { Locator, Page } from "@playwright/test";
import {
	clipboard,
	createEditorScenario,
	dock,
	edges,
	editorDocument,
	headOf,
	inspector,
	nodeCard,
	nodeMenu,
	nodePosition,
	openEditor,
	paneMenu,
} from "./editor-support";
import { expect, test } from "./fixtures";
import { box, createScenario, publishPackage } from "./support";

// 单个节点的复制、粘贴、创建副本（#186）：Ctrl+C / Ctrl+V / Ctrl+D 与节点菜单、空白处菜单；
// 内容放在系统剪贴板里，可以粘贴到另一个场景。

const setClipboard = (page: Page, text: string) =>
	page.evaluate((t) => navigator.clipboard.writeText(t), text);
const nodeIds = (page: Page) =>
	page
		.locator("[data-node-id]")
		.evaluateAll((els) => els.map((el) => el.getAttribute("data-node-id") ?? "").sort());

/** 卡片中心离屏幕上的某一点不到 3px。 */
async function expectCenteredAt(card: Locator, at: { x: number; y: number }) {
	const b = await box(card);
	expect(Math.abs(b.x + b.width / 2 - at.x)).toBeLessThan(3);
	expect(Math.abs(b.y + b.height / 2 - at.y)).toBeLessThan(3);
}

const ORIGINAL_IDS = ["dispatch", "entry", "fetch", "ping", "sub_entry", "sub_ping"];
const ORIGINAL_EDGES = [
	"chain:dispatch->ping",
	"chain:entry->fetch",
	"chain:fetch->dispatch",
	"chain:sub_entry->sub_ping",
	"dispatch:dispatch->sub_entry",
];

type SavedNode = { id: string; kind: string; position?: unknown } & Record<string, unknown>;
type Saved = {
	document: {
		nodes: SavedNode[];
		edges: { from: string; to: string }[];
		packages: Record<string, string>;
	};
};
const saved = async (cp: Parameters<typeof headOf>[0], id: string) =>
	(await headOf(cp, id)) as unknown as Saved;
const withoutPlace = ({ id: _, position: __, ...rest }: SavedNode) => rest;

async function save(page: Page, version: number) {
	await page.getByRole("button", { name: /保存/ }).click();
	await expect(page.getByText(`已保存为版本 ${version}`)).toBeVisible();
}

test.beforeEach(async ({ context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

test("Ctrl+D 与「创建副本」：参数相同、ID 不同、不带连线，落在原节点旁边，各是一步撤销", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id, "sub_ping");
	const undo = dock(page).getByRole("button", { name: "撤销" });

	// Ctrl+D：副本从原节点的位置往右下错开到不压住任何节点的地方，选中并聚焦。
	await nodeCard(page, "fetch").click();
	await page.keyboard.press("Control+d");
	await expect(nodeCard(page, "http_check_1")).toHaveCount(0);
	await expect(nodeCard(page, "fetch_1")).toBeFocused();
	await expect(nodeCard(page, "fetch_1")).toHaveAttribute("aria-pressed", "true");
	expect(await nodePosition(page, "fetch_1")).toEqual({ x: 380, y: 128 });
	await expect.poll(() => edges(page)).toEqual(ORIGINAL_EDGES);
	await expect(inspector(page).getByRole("combobox", { name: "输入 url" })).toHaveText(
		"https://example.test/snap",
	);

	// 一步撤销。
	await undo.click();
	await expect(nodeCard(page, "fetch_1")).toHaveCount(0);
	await expect(undo).toBeDisabled();

	// 节点菜单里的「创建副本」「复制」排在「在后面添加节点」之后。
	await nodeCard(page, "dispatch").click({ button: "right" });
	await expect(nodeMenu(page).getByRole("menuitem")).toHaveText([
		"在后面添加节点Tab",
		"创建副本CtrlD",
		"复制CtrlC",
		"重命名F2",
		"复制节点 ID",
		"复制输出引用",
		"断开入线",
		"断开出线",
		"删除节点Delete",
	]);
	await nodeMenu(page)
		.getByRole("menuitem", { name: /创建副本/ })
		.click();
	await expect(nodeCard(page, "dispatch_1")).toBeFocused();
	await nodeCard(page, "fetch").click();
	await page.keyboard.press("Control+d");
	await expect(nodeCard(page, "fetch_1")).toBeVisible();
	await expect.poll(() => edges(page)).toEqual(ORIGINAL_EDGES);

	// 保存下来的副本：除 ID 和位置外与原节点相同，没有连线。
	await save(page, 2);
	const doc = (await saved(controlPlane, id)).document;
	const byId = (nid: string) => doc.nodes.find((n) => n.id === nid) as SavedNode;
	expect(withoutPlace(byId("fetch_1"))).toEqual(withoutPlace(byId("fetch")));
	expect(withoutPlace(byId("dispatch_1"))).toEqual(withoutPlace(byId("dispatch")));
	expect(doc.edges).toHaveLength(5);
	expect(doc.edges.some((e) => [e.from, e.to].some((n) => n.endsWith("_1")))).toBe(false);

	// 撤销逐步回去。
	await undo.click();
	await expect(nodeCard(page, "fetch_1")).toHaveCount(0);
	await undo.click();
	await expect(nodeCard(page, "dispatch_1")).toHaveCount(0);
	await expect(undo).toBeDisabled();
});

test("入口节点和子流程入口节点不能复制、不能创建副本", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id, "sub_ping");

	for (const entry of ["entry", "sub_entry"]) {
		await nodeCard(page, entry).click({ button: "right" });
		await expect(nodeMenu(page)).toBeVisible();
		await expect(nodeMenu(page).getByRole("menuitem", { name: /创建副本/ })).toHaveCount(0);
		await expect(nodeMenu(page).getByRole("menuitem", { name: /^复制\s*Ctrl\s*C$/ })).toHaveCount(
			0,
		);
		await page.keyboard.press("Escape");
		await expect(nodeCard(page, entry)).toBeFocused();
	}

	await setClipboard(page, "原来的内容");
	await nodeCard(page, "sub_entry").click();
	await page.keyboard.press("Control+d");
	await expect(page.getByText("子流程入口节点不能复制或创建副本")).toBeVisible();
	await nodeCard(page, "entry").click();
	await page.keyboard.press("Control+c");
	await expect(page.getByText("入口节点不能复制或创建副本", { exact: true })).toBeVisible();
	expect(await clipboard(page)).toBe("原来的内容");
	await expect.poll(() => nodeIds(page)).toEqual(ORIGINAL_IDS);
	await expect(dock(page).getByRole("button", { name: "撤销" })).toBeDisabled();
});

test("Ctrl+C 后在另一个标签页的另一个场景 Ctrl+V：落在鼠标位置；鼠标不在画布上时落在视口中心；没锁定的节点包带上原版本", async ({
	page: sourceTab,
	context,
	controlPlane,
}) => {
	const source = await createEditorScenario(controlPlane);
	// 另一个场景：没有用 demo-checks；两个节点分在两边，视口中心空着。
	const target = await createScenario(controlPlane, "另一个场景", {
		default_agent: "agent-linux",
		nodes: [
			{ id: "entry", kind: "entry", position: { x: 0, y: 0 }, params: [] },
			{ id: "wait", kind: "sleep", position: { x: 1000, y: 0 }, duration: "5s" },
		],
		edges: [{ from: "entry", to: "wait", kind: "chain" }],
		packages: {},
	});

	await openEditor(sourceTab, source, "sub_ping");
	await nodeCard(sourceTab, "fetch").click();
	await sourceTab.keyboard.press("Control+c");
	await expect(sourceTab.getByText("已复制节点 fetch")).toBeVisible();
	expect(JSON.parse(await clipboard(sourceTab))).toEqual({
		type: "sfly/node",
		node: {
			id: "fetch",
			kind: "package",
			package: "demo-checks",
			node: "http_check",
			always: false,
			inputs: { url: "https://example.test/snap" },
		},
		package: { name: "demo-checks", version: "1.2.0" },
	});

	// 另一个标签页。
	const page = await context.newPage();
	await openEditor(page, target, "wait");
	const at = { x: 500, y: 600 };
	await page.mouse.move(at.x, at.y);
	await page.keyboard.press("Control+v");
	await expect(nodeCard(page, "fetch_1")).toBeFocused();
	await expectCenteredAt(nodeCard(page, "fetch_1"), at);
	await expect(page.locator("[data-edge]")).toHaveCount(1);

	// 鼠标在检查器上：落在视口（扣掉顶栏和检查器）中心。
	const panel = await box(inspector(page));
	await page.mouse.move(panel.x + panel.width / 2, panel.y + 200);
	await page.keyboard.press("Control+v");
	await expect(nodeCard(page, "fetch_2")).toBeFocused();
	await expectCenteredAt(nodeCard(page, "fetch_2"), {
		x: panel.x / 2,
		// 视口高 900（playwright.config.ts），顶部控件组占 54。
		y: (900 + 54) / 2,
	});

	// 粘贴是一步撤销。
	await page.keyboard.press("Control+z");
	await expect(nodeCard(page, "fetch_2")).toHaveCount(0);
	await expect(nodeCard(page, "fetch_1")).toBeVisible();

	// 目标场景没锁定 demo-checks：带上原来的版本，没有包版本的警告。
	await nodeCard(page, "fetch_1").click();
	await expect(inspector(page).getByRole("combobox", { name: "输入 url" })).toBeVisible();
	await expect(inspector(page).getByText(/节点包 demo-checks/)).toHaveCount(0);
	await save(page, 2);
	const doc = (await saved(controlPlane, target)).document;
	expect(doc.packages).toEqual({ "demo-checks": "1.2.0" });
	expect(withoutPlace(doc.nodes.find((n) => n.id === "fetch_1") as SavedNode)).toEqual({
		kind: "package",
		package: "demo-checks",
		node: "http_check",
		always: false,
		inputs: { url: "https://example.test/snap" },
	});
	expect(doc.edges).toEqual([{ from: "entry", to: "wait", kind: "chain" }]);
});

test("右键粘贴落在右键位置；目标场景已锁定别的版本时用它的版本，静态检查给出警告", async ({
	page,
	controlPlane,
}) => {
	const source = await createEditorScenario(controlPlane);
	// demo-checks@1.3.0 去掉了 http_check。
	await publishPackage(controlPlane, {
		version: "1.3.0",
		nodes: [
			{
				name: "ping",
				title: "ping",
				entry: "demo_checks.http:ping_host",
				inputs: { type: "object", properties: { host: { type: "string" } } },
				outputs: { type: "object", properties: {} },
			},
		],
	});
	const target = await createScenario(controlPlane, "锁定新版本的场景", {
		default_agent: "agent-linux",
		nodes: [
			{ id: "entry", kind: "entry", position: { x: 0, y: 0 }, params: [] },
			{
				id: "probe",
				kind: "package",
				package: "demo-checks",
				node: "ping",
				position: { x: 252, y: 0 },
				inputs: { host: "localhost" },
			},
		],
		edges: [{ from: "entry", to: "probe", kind: "chain" }],
		packages: { "demo-checks": "1.3.0" },
	});

	// 节点菜单里的「复制」。
	await openEditor(page, source, "sub_ping");
	await nodeCard(page, "fetch").click({ button: "right" });
	await nodeMenu(page)
		.getByRole("menuitem", { name: /^复制\s*Ctrl\s*C$/ })
		.click();
	await expect(page.getByText("已复制节点 fetch")).toBeVisible();
	expect(JSON.parse(await clipboard(page)).node.id).toBe("fetch");

	await openEditor(page, target, "probe");
	const at = { x: 400, y: 600 };
	await page.mouse.click(at.x, at.y, { button: "right" });
	const paste = paneMenu(page).getByRole("menuitem", { name: /粘贴/ });
	await expect(paste).toHaveText("粘贴CtrlV");
	await paste.click();
	await expect(nodeCard(page, "fetch_1")).toBeFocused();
	await expectCenteredAt(nodeCard(page, "fetch_1"), at);
	await expect(
		inspector(page).getByText("节点包 demo-checks@1.3.0 中没有节点类型 http_check"),
	).toBeVisible();

	await save(page, 2);
	expect((await saved(controlPlane, target)).document.packages).toEqual({ "demo-checks": "1.3.0" });

	// 撤销一步就回去。
	await dock(page).getByRole("button", { name: "撤销" }).click();
	await expect(nodeCard(page, "fetch_1")).toHaveCount(0);
});

test("打开空白处菜单不读剪贴板，点「粘贴」才读：不是节点时提示、Ctrl+V 无动作；不允许读取时提示按 Ctrl V", async ({
	page,
	controlPlane,
}) => {
	// 数页面调用了几次 readText（calls）、其中几次已经读完（settled）。
	await page.addInitScript(() => {
		const clipboard = navigator.clipboard;
		const read = clipboard.readText.bind(clipboard);
		const count = { calls: 0, settled: 0 };
		Object.assign(window, { clipboardReads: count });
		clipboard.readText = () => {
			count.calls += 1;
			return read().finally(() => {
				count.settled += 1;
			});
		};
	});
	const reads = () =>
		page.evaluate(
			() =>
				(window as unknown as { clipboardReads: { calls: number; settled: number } })
					.clipboardReads,
		);
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id, "sub_ping");
	const blank = { x: 200, y: 640 };
	const notNode = page.getByText("剪贴板里没有可粘贴的节点");

	for (const [i, text] of [
		"hello",
		JSON.stringify({ type: "sfly/node", node: { id: "x", kind: "sleep", duration: "" } }),
		JSON.stringify({
			type: "sfly/node",
			node: editorDocument.nodes.find((n) => n.id === "entry"),
		}),
	].entries()) {
		await setClipboard(page, text);
		await page.mouse.click(blank.x, blank.y, { button: "right" });
		const paste = paneMenu(page).getByRole("menuitem", { name: /粘贴/ });
		await expect(paste).toHaveText("粘贴CtrlV");
		await expect(paste).toBeEnabled();
		expect((await reads()).calls).toBe(i);
		await paste.click();
		await expect(paneMenu(page)).toHaveCount(0);
		await expect.poll(async () => (await reads()).settled).toBe(i + 1);
		await expect(notNode.first()).toBeVisible();

		await page.mouse.move(blank.x, blank.y);
		await page.keyboard.press("Control+v");
	}
	await expect(page.getByText("已保存", { exact: true })).toBeVisible();
	await expect.poll(() => nodeIds(page)).toEqual(ORIGINAL_IDS);

	// 浏览器不允许读取剪贴板：提示改按 Ctrl V。
	await page.evaluate(() => {
		navigator.clipboard.readText = () =>
			Promise.reject(new DOMException("拒绝", "NotAllowedError"));
	});
	await page.mouse.click(blank.x, blank.y, { button: "right" });
	await paneMenu(page).getByRole("menuitem", { name: /粘贴/ }).click();
	await expect(page.getByText("浏览器不允许读取剪贴板")).toBeVisible();
	await expect(page.getByText("请按 Ctrl V 粘贴")).toBeVisible();
	await expect.poll(() => nodeIds(page)).toEqual(ORIGINAL_IDS);
});

test("没有 Clipboard API 时（http 访问）菜单里的「复制」照样能用，「粘贴」禁用并说明，Ctrl+C / Ctrl+V 照常可用", async ({
	page,
	controlPlane,
}) => {
	await page.addInitScript(() =>
		Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }),
	);
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id, "sub_ping");
	const blank = { x: 200, y: 640 };

	// 菜单里的「复制」改用浏览器的复制命令，照样写进剪贴板。
	await nodeCard(page, "ping").click({ button: "right" });
	await nodeMenu(page)
		.getByRole("menuitem", { name: /^复制\s*Ctrl\s*C$/ })
		.click();
	await expect(page.getByText("已复制节点 ping")).toBeVisible();
	await expect(page.getByText("复制失败")).toHaveCount(0);
	const reader = await page.context().newPage();
	await reader.goto("/agents");
	expect(await reader.evaluate(() => navigator.clipboard.readText())).toContain('"ping"');
	await reader.close();
	await page.bringToFront();

	await page.mouse.click(blank.x, blank.y, { button: "right" });
	const paste = paneMenu(page).getByRole("menuitem", { name: /粘贴/ });
	await expect(paste).toHaveText("粘贴浏览器不允许读取剪贴板，请按 Ctrl V 粘贴CtrlV");
	await expect(paste).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(paneMenu(page)).toHaveCount(0);

	// 按键复制、粘贴走浏览器的 copy / paste 事件，不需要 Clipboard API。
	await nodeCard(page, "ping").click();
	await page.keyboard.press("Control+c");
	await expect(page.getByText("已复制节点 ping").last()).toBeVisible();
	await page.mouse.move(blank.x, blank.y);
	await page.keyboard.press("Control+v");
	await expect(nodeCard(page, "ping_1")).toBeFocused();
	await expect.poll(() => nodeIds(page)).toEqual([...ORIGINAL_IDS, "ping_1"].sort());
});

test("焦点在输入框里时 Ctrl+C / Ctrl+V / Ctrl+D 仍是文本操作", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id, "sub_ping");

	// 先复制一个节点：之后在输入框里粘贴也不会粘出节点。
	await nodeCard(page, "ping").click();
	await page.keyboard.press("Control+c");
	await expect(page.getByText("已复制节点 ping")).toBeVisible();

	await nodeCard(page, "fetch").click();
	const url = inspector(page).getByRole("combobox", { name: "输入 url" });
	await url.click();
	await page.keyboard.press("Control+a");
	await page.keyboard.press("Control+c");
	await expect.poll(() => clipboard(page)).toBe("https://example.test/snap");
	await page.keyboard.press("End");
	await page.keyboard.press("Control+v");
	await expect(url).toHaveText("https://example.test/snaphttps://example.test/snap");
	await page.keyboard.press("Control+d");
	await expect(url).toBeFocused();

	// 剪贴板里是节点也一样：输入框里粘贴的是文字。
	await setClipboard(
		page,
		JSON.stringify({ type: "sfly/node", node: { id: "x", kind: "sleep", duration: "1s" } }),
	);
	await page.keyboard.press("Control+v");
	await expect(url).toContainText('"type":"sfly/node"');
	await expect.poll(() => nodeIds(page)).toEqual(ORIGINAL_IDS);
});

test("快捷键面板列出复制节点、粘贴节点、创建副本", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id, "sub_ping");
	await page.locator("body").press("?");
	const panel = page.getByRole("dialog", { name: "快捷键" });
	const canvas = panel.getByRole("region", { name: "编排画布" });
	for (const [label, keys] of [
		["复制节点", "CtrlC"],
		["粘贴节点", "CtrlV"],
		["创建副本", "CtrlD"],
	]) {
		await expect(
			canvas.locator("dl > div").filter({ hasText: new RegExp(`^${label}`) }),
		).toHaveText(`${label}${keys}`);
	}
});
