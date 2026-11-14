// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import type { Locator, Page } from "@playwright/test";
import {
	createEditorScenario,
	dock,
	editorDocument,
	headOf,
	inspector,
	nodeCard,
	openEditor,
} from "./editor-support";
import { expect, test } from "./fixtures";
import { box, createScenario, publishPackage } from "./support";

// 节点的显示名称（#307）：搭场景的人在检查器顶部给节点起名，卡片标题变成显示名称，
// 原来的标题挪到头部；版本对比、引用补全和校验面板也写出它。

const NAME = "创建测试用户";
const LONG = "一二三四五六七八九十".repeat(4);

const nameBox = (page: Page) => inspector(page).getByRole("textbox", { name: "显示名称" });
const titleOf = (card: Locator) => card.locator('[data-slot="base-node-title"]');
const headerOf = (card: Locator) => card.locator('[data-slot="base-node-header"]');

async function save(page: Page, version: number) {
	await page.getByRole("button", { name: /保存/ }).click();
	await expect(page.getByText(`已保存为版本 ${version}`)).toBeVisible();
}

test.beforeEach(async ({ context }) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
});

test("在检查器顶部填显示名称：卡片标题是显示名称，原标题挪到头部；撤销、重做；保存刷新后仍然在，不带首尾空白", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const fetch = nodeCard(page, "fetch");
	await expect(titleOf(fetch)).toHaveText("HTTP 检查");
	await expect(fetch).toHaveAttribute("aria-label", "节点 fetch，HTTP 检查");

	await fetch.click();
	// 占位文字是当前的默认标题；输入框在检查器顶部、页签的上面。
	await expect(nameBox(page)).toHaveValue("");
	await expect(nameBox(page)).toHaveAttribute("placeholder", "HTTP 检查");
	const [field, tabs] = [await box(nameBox(page)), await box(page.getByRole("tablist"))];
	expect(field.y).toBeLessThan(tabs.y);

	await nameBox(page).fill(`  ${NAME}  `);
	await expect(titleOf(fetch)).toHaveText(NAME);
	await expect(headerOf(fetch)).toContainText("fetch");
	await expect(headerOf(fetch)).toContainText("HTTP 检查");
	await expect(fetch).toHaveAttribute("aria-label", `节点 fetch，HTTP 检查，${NAME}`);
	await expect(inspector(page).getByRole("heading", { level: 2 })).toHaveText(NAME);
	await expect(page.getByText("有未保存的修改")).toBeVisible();

	// 改动可以撤销、重做，和其他编辑一样。
	await dock(page).getByRole("button", { name: "撤销" }).click();
	await expect(nameBox(page)).toHaveValue("");
	await expect(titleOf(fetch)).toHaveText("HTTP 检查");
	await dock(page).getByRole("button", { name: "重做" }).click();
	// 输入框里是原样输入的文字，首尾空白在保存时去掉。
	await expect(nameBox(page)).toHaveValue(`  ${NAME}  `);
	await expect(titleOf(fetch)).toHaveText(NAME);

	// 其他种类的节点：原来的标题（入口、异步任务）也挪到头部。
	await nodeCard(page, "dispatch").click();
	await nameBox(page).fill("派发子流程");
	await expect(titleOf(nodeCard(page, "dispatch"))).toHaveText("派发子流程");
	await expect(headerOf(nodeCard(page, "dispatch"))).toContainText("异步任务");
	await nodeCard(page, "fetch").click();

	await save(page, 2);
	const nodes = (await headOf(controlPlane, id)).document.nodes as Record<string, unknown>[];
	expect(nodes.find((n) => n.id === "fetch")?.display_name).toBe(NAME);
	expect(nodes.find((n) => n.id === "dispatch")?.display_name).toBe("派发子流程");
	expect(nodes.find((n) => n.id === "ping")).not.toHaveProperty("display_name");

	await page.reload();
	await expect(titleOf(nodeCard(page, "fetch"))).toHaveText(NAME);
	await expect(headerOf(nodeCard(page, "fetch"))).toContainText("HTTP 检查");
	await expect(titleOf(nodeCard(page, "ping"))).toHaveText("ping");
	await expect(page.getByText("有未保存的修改")).toHaveCount(0);
});

test("没有显示名称的节点照旧；子流程入口节点没有这个输入框，它的名称就是子流程名称", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await expect(titleOf(nodeCard(page, "ping"))).toHaveText("ping");
	await expect(titleOf(nodeCard(page, "entry"))).toHaveText("入口");
	await nodeCard(page, "sub_entry").click();
	await expect(inspector(page).getByRole("textbox", { name: "子流程名称" })).toBeVisible();
	await expect(nameBox(page)).toHaveCount(0);
	await nodeCard(page, "entry").click();
	await expect(nameBox(page)).toHaveAttribute("placeholder", "入口");
});

test("显示名称放不下时在卡片上截断，卡片尺寸不变，悬停和 aria-label 给出全文", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	const fetch = nodeCard(page, "fetch");
	const before = await box(fetch);

	await fetch.click();
	await nameBox(page).fill(LONG);
	const title = titleOf(fetch);
	await expect(title).toHaveText(LONG);
	const after = await box(fetch);
	expect([after.width, after.height]).toEqual([before.width, before.height]);
	expect(
		await title.evaluate((el) => ({
			clipped: el.scrollWidth > el.clientWidth,
			overflow: getComputedStyle(el).textOverflow,
		})),
	).toEqual({ clipped: true, overflow: "ellipsis" });
	await expect(title).toHaveAttribute("title", LONG);
	await expect(fetch).toHaveAttribute("aria-label", `节点 fetch，HTTP 检查，${LONG}`);

	// 短的显示名称没有被截断。
	await nameBox(page).fill(NAME);
	expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test("画布缩小到语义缩放时，显示名称仍然显示、字号不小于最小字号", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "fetch").click();
	await nameBox(page).fill(NAME);
	for (let i = 0; i < 3; i++) {
		await page.getByRole("button", { name: "缩小" }).click();
		await page.waitForTimeout(300);
	}
	await expect(page.locator("[data-lod]")).toHaveAttribute("data-lod", "true");
	const title = titleOf(nodeCard(page, "fetch"));
	await expect(title).toHaveText(NAME);
	const [rect, size] = [
		await box(title),
		await title.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize)),
	];
	expect(rect.width).toBeGreaterThan(0);
	// 世界坐标里的字号放大了：屏幕上的字号约 12px，不小于 11px。
	const zoom = await page.locator("[data-lod]").evaluate((el) => {
		const value = getComputedStyle(el).getPropertyValue("--canvas-zoom");
		return Number.parseFloat(value);
	});
	expect(size * zoom).toBeGreaterThanOrEqual(11);
});

test("显示名称超过 40 个字符是字段错误：显示在输入框下面，阻止保存，改短后消失；emoji 按一个字符计", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "fetch").click();

	await nameBox(page).fill("😀".repeat(40));
	await expect(nameBox(page)).not.toHaveAttribute("aria-invalid");
	await expect(page.getByText("处字段错误")).toHaveCount(0);

	await nameBox(page).fill("😀".repeat(41));
	await expect(nameBox(page)).toHaveAttribute("aria-invalid", "true");
	await expect(inspector(page)).toContainText("最多 40 个字符");
	await expect(page.getByRole("button", { name: "1 处字段错误" })).toBeVisible();
	await page.getByRole("button", { name: /保存/ }).click();
	await expect(page.getByText(/已保存为版本/)).toHaveCount(0);

	await nameBox(page).fill("😀".repeat(40));
	await expect(nameBox(page)).not.toHaveAttribute("aria-invalid");
	await expect(page.getByText("处字段错误")).toHaveCount(0);
});

test("只有空白的显示名称等于没写：不算修改，写了内容再改回空白也一样", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "fetch").click();

	await nameBox(page).fill("   ");
	await expect(page.getByText("有未保存的修改")).toHaveCount(0);
	await expect(titleOf(nodeCard(page, "fetch"))).toHaveText("HTTP 检查");

	await nameBox(page).fill(NAME);
	await expect(page.getByText("有未保存的修改")).toBeVisible();
	await nameBox(page).fill("  ");
	await expect(page.getByText("有未保存的修改")).toHaveCount(0);
	await expect(titleOf(nodeCard(page, "fetch"))).toHaveText("HTTP 检查");
});

test("复制、粘贴、创建副本时带上显示名称，不加后缀", async ({ page, controlPlane }) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "fetch").click();
	await nameBox(page).fill(NAME);
	await expect(titleOf(nodeCard(page, "fetch"))).toHaveText(NAME);

	await nodeCard(page, "fetch").focus();
	await page.keyboard.press("Control+d");
	const copy = nodeCard(page, "fetch_1");
	await expect(copy).toBeFocused();
	await expect(titleOf(copy)).toHaveText(NAME);
	await expect(headerOf(copy)).toContainText("HTTP 检查");

	await nodeCard(page, "fetch").click();
	await page.keyboard.press("Control+c");
	await nodeCard(page, "ping").click();
	await page.keyboard.press("Control+v");
	const pasted = nodeCard(page, "fetch_2");
	await expect(pasted).toBeVisible();
	await expect(titleOf(pasted)).toHaveText(NAME);

	await save(page, 2);
	const nodes = (await headOf(controlPlane, id)).document.nodes as Record<string, unknown>[];
	for (const nodeId of ["fetch", "fetch_1", "fetch_2"]) {
		expect(nodes.find((n) => n.id === nodeId)?.display_name, nodeId).toBe(NAME);
	}
});

test("版本对比：列出显示名称的变化，字段标签是「显示名称」；只改显示名称也保存出新版本；只读画布的卡片显示名称", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "fetch").click();
	await nameBox(page).fill(NAME);
	await save(page, 2);
	await nameBox(page).fill("查询测试用户");
	await save(page, 3);

	await page.goto(`/orchestrations/${id}/versions`);
	const changes = page.getByRole("region", { name: "差异" });
	await expect(changes).toContainText("显示名称");
	await expect(changes).toContainText(NAME);
	await expect(changes).toContainText("查询测试用户");
	const newer = page.getByRole("region", { name: "版本 3（只读）" });
	await expect(titleOf(newer.locator('[data-node-id="fetch"]'))).toHaveText("查询测试用户");
	await expect(headerOf(newer.locator('[data-node-id="fetch"]'))).toContainText("HTTP 检查");
	const older = page.getByRole("region", { name: "版本 2（只读）" });
	await expect(titleOf(older.locator('[data-node-id="fetch"]'))).toHaveText(NAME);

	// 和第 1 版（没有显示名称）比：新增了这个字段。
	await page.getByRole("button", { name: "把版本 1 放在左侧（A）" }).click();
	await expect(changes).toContainText("显示名称");
	await expect(changes).toContainText("（新增）");
});

test("引用补全和引用选择器里的上游节点写成「显示名称（节点 ID）」，没有显示名称的只写节点 ID", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "fetch").click();
	await nameBox(page).fill(NAME);

	await nodeCard(page, "ping").click();
	const host = inspector(page).getByRole("combobox", { name: "输入 host" });
	await host.click();
	await page.keyboard.press("End");
	await page.keyboard.type("$");
	const list = page.getByRole("listbox", { name: "可引用的值" });
	const option = list.getByRole("option").filter({ hasText: "nodes.fetch.outputs.status" });
	await expect(option).toContainText(`integer · ${NAME}（fetch）`);
	// 引用本身仍然以节点 ID 为键。
	await expect(option).toContainText("nodes.fetch.outputs.status");
	await page.keyboard.press("Escape");

	// 去掉显示名称后只写节点 ID。
	await nodeCard(page, "fetch").click();
	await nameBox(page).fill("");
	await nodeCard(page, "ping").click();
	await host.click();
	await page.keyboard.press("End");
	await page.keyboard.type("$");
	await expect(
		list.getByRole("option").filter({ hasText: "nodes.fetch.outputs.status" }),
	).toContainText("integer · fetch");
	await expect(list).not.toContainText("（fetch）");
});

test("引用选择器（非字符串输入旁的「插入引用」）也写出显示名称", async ({ page, controlPlane }) => {
	await publishPackage(controlPlane, {
		nodes: [
			{
				name: "probe",
				title: "探测",
				entry: "demo_checks.http:probe",
				inputs: { type: "object", properties: {} },
				outputs: { type: "object", properties: { status: { type: "integer" } } },
			},
			{
				name: "typed",
				title: "各种类型",
				entry: "demo_checks.http:typed",
				inputs: { type: "object", properties: { count: { type: "integer" } } },
				outputs: { type: "object", properties: {} },
			},
		],
	});
	const document = {
		default_agent: "agent-linux",
		nodes: [
			{ id: "entry", kind: "entry", position: { x: 0, y: 0 }, params: [] },
			{
				id: "probe",
				kind: "package",
				package: "demo-checks",
				node: "probe",
				display_name: NAME,
				position: { x: 252, y: 0 },
				inputs: {},
			},
			{
				id: "typed",
				kind: "package",
				package: "demo-checks",
				node: "typed",
				position: { x: 504, y: 0 },
				inputs: {},
			},
		],
		edges: [
			{ from: "entry", to: "probe", kind: "chain" },
			{ from: "probe", to: "typed", kind: "chain" },
		],
		packages: { "demo-checks": "1.2.0" },
	};
	const id = await createScenario(controlPlane, "引用选择器", document);
	await openEditor(page, id, "typed");
	await nodeCard(page, "typed").click();
	await inspector(page).getByRole("button", { name: "在 count 中插入引用" }).click();
	await expect(
		page
			.getByRole("listbox", { name: "可引用的值" })
			.getByRole("option", { name: /nodes\.probe\.outputs\.status/ }),
	).toContainText(`integer · ${NAME}（probe）`);
});

test("校验面板的警告写成「显示名称（节点 ID）」，前往仍然定位到节点", async ({
	page,
	controlPlane,
}) => {
	await publishPackage(controlPlane);
	const warned = {
		...editorDocument,
		nodes: editorDocument.nodes.map((n) =>
			n.id === "fetch" ? { ...n, display_name: NAME, inputs: {} } : n,
		),
	};
	const id = await createScenario(controlPlane, "有警告的场景", warned);
	await openEditor(page, id);
	await expect(titleOf(nodeCard(page, "fetch"))).toHaveText(NAME);

	await page.getByRole("button", { name: /条警告/ }).click();
	const warnings = inspector(page).getByRole("listitem").filter({ hasText: "必填输入 url" });
	await expect(warnings).toContainText(`节点 ${NAME}（fetch） 的必填输入 url 没有填写`);
	await warnings.getByRole("button", { name: "前往" }).click();
	await expect(nodeCard(page, "fetch")).toHaveAttribute("aria-pressed", "true");
});
