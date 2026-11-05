import type { Browser, Locator, Page } from "@playwright/test";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { createEditorScenario, editorDocument, headOf, nodeCard } from "./editor-support";
import { expect, test } from "./fixtures";

// 版本历史与对比、恢复、保存冲突（409）、在线编辑者（#40）。

/**
 * bob 在第 1 版之后保存的第 2 版：改了 fetch 的 url，删掉子流程里的 sub_ping，主链末尾加上 report。
 */
const secondVersion = {
	...editorDocument,
	nodes: [
		...editorDocument.nodes
			.filter((n) => n.id !== "sub_ping")
			.map((n) => (n.id === "fetch" ? { ...n, inputs: { url: "https://example.test/v2" } } : n)),
		{
			id: "report",
			kind: "package",
			package: "demo-checks",
			node: "ping",
			position: { x: 1008, y: 0 },
			inputs: { host: "report.example.test" },
		},
	],
	edges: [
		...editorDocument.edges.filter((e) => e.to !== "sub_ping"),
		{ from: "ping", to: "report", kind: "chain" },
	],
};

async function saveAs(cp: TestControlPlane, id: string, base: number, author: string) {
	const res = await cp.fetch(`/orchestrations/${id}/versions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": author },
		body: JSON.stringify({ base_version: base, document: secondVersion }),
	});
	if (res.status !== 201) throw new Error(`保存失败：${res.status} ${await res.text()}`);
}

/** 第 1 版（tester，08:00）与第 2 版（bob，08:05）。 */
async function twoVersions(cp: TestControlPlane, clock: { advance(ms: number): void }) {
	const id = await createEditorScenario(cp);
	clock.advance(5 * 60_000);
	await saveAs(cp, id, 1, "bob");
	return id;
}

const versionList = (page: Page) => page.getByRole("list", { name: "版本" });
const versionRow = (page: Page, n: number) =>
	versionList(page)
		.getByRole("listitem")
		.filter({ has: page.getByText(`v${n}`, { exact: true }) });
const pane = (page: Page, n: number) => page.getByRole("region", { name: `版本 ${n}（只读）` });

async function box(locator: Locator) {
	const b = await locator.boundingBox();
	if (!b) throw new Error("元素不可见");
	return b;
}

test("版本历史：版本号、作者、时间；默认并排只读对比最新两个版本，显示子流程区域，差异节点有标记", async ({
	page,
	controlPlane,
	clock,
}) => {
	const id = await twoVersions(controlPlane, clock);
	await page.goto(`/orchestrations/${id}/versions`);

	await expect(versionList(page).getByRole("listitem")).toHaveCount(2);
	await expect(versionRow(page, 2)).toContainText("bob");
	await expect(versionRow(page, 2)).toContainText("01-01 08:05");
	await expect(versionRow(page, 2)).toContainText("最新");
	await expect(versionRow(page, 1)).toContainText("tester");
	await expect(versionRow(page, 1)).toContainText("01-01 08:00");

	// 选中态是中性高亮，不用青色实底。
	const pickedB = versionRow(page, 2).getByRole("button", { name: "把版本 2 放在右侧（B）" });
	await expect(pickedB).toHaveAttribute("aria-pressed", "true");
	await expect(pickedB).toHaveCSS("background-color", "rgb(46, 46, 46)");
	await expect(versionRow(page, 2)).not.toHaveCSS("background-color", "rgb(44, 196, 240)");

	const a = pane(page, 1);
	const b = pane(page, 2);
	await expect(a).toBeVisible();
	await expect(b).toBeVisible();
	expect((await box(a)).x).toBeLessThan((await box(b)).x);
	await expect(a.getByRole("region", { name: "子流程 sub_entry" })).toBeVisible();
	await expect(b.getByRole("region", { name: "子流程 sub_entry" })).toBeVisible();

	// A 侧标出删除和修改的节点，B 侧标出新增和修改的节点。
	await expect(a.locator('[data-node-id="sub_ping"]')).toHaveAttribute("data-mark", "removed");
	await expect(a.locator('[data-node-id="fetch"]')).toHaveAttribute("data-mark", "changed");
	await expect(a.locator('[data-node-id="fetch"]')).toContainText("修改");
	await expect(a.locator('[data-node-id="sub_ping"]')).toContainText("删除");
	await expect(a.locator('[data-node-id="report"]')).toHaveCount(0);
	await expect(b.locator('[data-node-id="report"]')).toHaveAttribute("data-mark", "added");
	await expect(b.locator('[data-node-id="report"]')).toContainText("新增");
	await expect(b.locator('[data-node-id="fetch"]')).toHaveAttribute("data-mark", "changed");
	await expect(b.locator('[data-node-id="ping"]')).not.toHaveAttribute("data-mark", /.+/);

	// 只读：节点拖不动（拖动只平移视图，节点之间的相对位置不变）。
	const fetch = b.locator('[data-node-id="fetch"]');
	const ping = b.locator('[data-node-id="ping"]');
	const offset = async () => {
		const [f, p] = [await box(fetch), await box(ping)];
		return [Math.round(p.x - f.x), Math.round(p.y - f.y)];
	};
	const before = await offset();
	const start = await box(fetch);
	await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
	await page.mouse.down();
	await page.mouse.move(start.x + 100, start.y + 80, { steps: 5 });
	await page.mouse.up();
	expect(await offset()).toEqual(before);

	const diff = page.getByRole("region", { name: "差异" });
	await expect(diff).toContainText("− 版本 1 → + 版本 2");
	await expect(diff).toContainText("+ report");
	await expect(diff).toContainText("− sub_ping");
	await expect(diff).toContainText("https://example.test/v2");

	// 任选两个版本：把版本 1 也放到右侧后两边是同一个版本，只显示一个画布。
	await versionRow(page, 1).getByRole("button", { name: "把版本 1 放在右侧（B）" }).click();
	await expect(page).toHaveURL(/a=1&b=1/);
	await expect(pane(page, 2)).toHaveCount(0);
	await expect(pane(page, 1)).toBeVisible();
	await expect(page.getByRole("region", { name: "差异" })).toContainText("选择两个版本");
	await versionRow(page, 2).getByRole("button", { name: "把版本 2 放在左侧（A）" }).click();
	await expect(page.getByRole("region", { name: "差异" })).toContainText("− 版本 2 → + 版本 1");
	await expect(pane(page, 1).locator('[data-node-id="sub_ping"]')).toHaveAttribute(
		"data-mark",
		"added",
	);
});

test("恢复旧版本：确认后用它的内容生成一个新版本，历史版本不变", async ({
	page,
	controlPlane,
	clock,
}) => {
	const id = await twoVersions(controlPlane, clock);
	await page.goto(`/orchestrations/${id}/versions`);
	await expect(versionRow(page, 2).getByRole("button", { name: "恢复" })).toHaveCount(0);

	await versionRow(page, 1).getByRole("button", { name: "恢复" }).click();
	const dialog = page.getByRole("dialog", { name: "恢复版本 1" });
	await expect(dialog).toContainText("生成新的版本 3");
	await dialog.getByRole("button", { name: "取消" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(versionList(page).getByRole("listitem")).toHaveCount(2);

	await versionRow(page, 1).getByRole("button", { name: "恢复" }).click();
	await dialog.getByRole("button", { name: "恢复为版本 3" }).click();
	await expect(page.getByText("已用版本 1 的内容生成版本 3")).toBeVisible();
	await expect(versionList(page).getByRole("listitem")).toHaveCount(3);
	await expect(versionRow(page, 3)).toContainText("tester");
	await expect(versionRow(page, 3)).toContainText("最新");
	// 恢复后对比恢复出的版本与原版本：内容相同。
	await expect(page).toHaveURL(/a=1&b=3/);
	await expect(page.getByRole("region", { name: "差异" })).toContainText("两边内容相同");

	const v2 = (await (await controlPlane.fetch(`/orchestrations/${id}/versions/2`)).json()) as {
		author: string;
		document: { nodes: { id: string }[] };
	};
	expect(v2.author).toBe("bob");
	expect(v2.document.nodes.map((n) => n.id)).toContain("report");
	const head = await headOf(controlPlane, id);
	expect(head.number).toBe(3);
	expect(head.document.nodes.map((n) => n.id)).toContain("sub_ping");
});

const inspector = (page: Page) => page.getByRole("complementary", { name: "检查器" });

/** 打开画布、给 sub_ping 打开 always（本地修改），然后 bob 在第 1 版之后保存了第 2 版，再保存。 */
async function conflictOnSave(
	page: Page,
	cp: TestControlPlane,
	clock: { advance(ms: number): void },
) {
	const id = await createEditorScenario(cp);
	await page.goto(`/orchestrations/${id}`);
	await nodeCard(page, "sub_ping").click();
	await inspector(page).getByRole("tab", { name: "执行" }).click();
	await inspector(page).getByRole("switch", { name: "always" }).click();
	await expect(page.getByText("有未保存的修改")).toBeVisible();

	clock.advance(5 * 60_000);
	await saveAs(cp, id, 1, "bob");
	await page.keyboard.press("Control+s");
	const dialog = page.getByRole("dialog", { name: "保存被拦截：场景已有更新的版本" });
	await expect(dialog).toBeVisible();
	return { id, dialog };
}

test("保存冲突：弹窗显示对方作者和时间、与最新版本的差异，锁定焦点；放弃本地修改后载入最新版本", async ({
	page,
	controlPlane,
	clock,
}) => {
	const { id, dialog } = await conflictOnSave(page, controlPlane, clock);
	await expect(dialog).toContainText("你基于版本 1 编辑");
	await expect(dialog).toContainText("bob 于 01-01 08:05 保存了版本 2");
	await expect(dialog).toContainText("− 最新版本 2 → + 你的本地修改");
	await expect(dialog).toContainText("+ sub_ping");
	await expect(dialog).toContainText("− report");

	// 焦点锁定在弹窗里。
	for (let i = 0; i < 8; i++) {
		await page.keyboard.press("Tab");
		expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
	}
	// 继续编辑：关闭弹窗，修改还在；顶栏的「保存被拦截」可以重新打开弹窗。
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(nodeCard(page, "sub_ping").getByText("always")).toBeVisible();
	await page.getByRole("button", { name: "保存被拦截" }).click();
	await expect(dialog).toBeVisible();

	await dialog.getByRole("button", { name: "放弃本地修改并载入最新版本" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(nodeCard(page, "report")).toBeVisible();
	await expect(nodeCard(page, "sub_ping")).toHaveCount(0);
	await expect(page.getByText("v2", { exact: true })).toBeVisible();
	await expect(page.getByText("已保存", { exact: true })).toBeVisible();
	// 本地草稿已删除：刷新后仍是最新版本。
	await page.reload();
	await expect(nodeCard(page, "report")).toBeVisible();
	await expect(page.getByText("已保存", { exact: true })).toBeVisible();
	expect((await headOf(controlPlane, id)).number).toBe(2);
});

test("保存冲突：把本地修改另存为新场景，原场景不受影响", async ({ page, controlPlane, clock }) => {
	const { id, dialog } = await conflictOnSave(page, controlPlane, clock);
	const name = dialog.getByRole("textbox", { name: "新场景名称" });
	await expect(name).toHaveValue("日终数据处理（我的修改）");
	await name.fill("日终数据处理（tester）");
	await dialog.getByRole("button", { name: "另存为新场景" }).click();

	await expect(page.getByRole("heading", { name: "日终数据处理（tester）" })).toBeVisible();
	const copyId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
	expect(copyId).not.toBe(id);
	await expect(page.getByText("v1", { exact: true })).toBeVisible();
	await expect(nodeCard(page, "sub_ping").getByText("always")).toBeVisible();
	await expect(page.getByText("已保存", { exact: true })).toBeVisible();

	const copy = await headOf(controlPlane, copyId);
	expect(copy.number).toBe(1);
	expect(copy.document.nodes.find((n) => n.id === "sub_ping")).toMatchObject({ always: true });
	const original = await headOf(controlPlane, id);
	expect(original.number).toBe(2);
	expect(original.document.nodes.map((n) => n.id)).toContain("report");
});

async function openAs(browser: Browser, baseURL: string, nickname: string, path: string) {
	const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
	await context.addInitScript((name) => {
		window.localStorage.setItem("sfly.nickname", name);
	}, nickname);
	const page = await context.newPage();
	await page.goto(path);
	await expect(nodeCard(page, "entry")).toBeVisible();
	return { context, page };
}

test("在线编辑者：别人打开同一场景时显示在画布右上，离开后消失；自己的其他标签页标为「你（其他标签页）」", async ({
	page,
	browser,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({
		name: "agent-linux",
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	const id = await createEditorScenario(controlPlane);
	await page.goto(`/orchestrations/${id}`);
	await expect(nodeCard(page, "entry")).toBeVisible();
	const editors = page.getByRole("status").filter({ hasText: "正在编辑" });
	await expect(editors).toHaveCount(0);

	const other = await openAs(browser, controlPlane.httpUrl, "小李", `/orchestrations/${id}`);
	await expect(editors).toHaveText(/小李 正在编辑/);
	const at = await box(editors);
	expect(at.x).toBeGreaterThan(720);
	expect(at.y).toBeLessThan(54);
	// 对方也能看到自己。
	await expect(other.page.getByRole("status").filter({ hasText: "tester 正在编辑" })).toBeVisible();

	// 运行状态下右上控件组也显示在线编辑者，切换模式时在线状态不中断。
	const triggered = await controlPlane.fetch(`/orchestrations/${id}/runs`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "tester" },
		body: JSON.stringify({ params: { biz_date: "2026-01-01" } }),
	});
	expect(triggered.status).toBe(201);
	await page.locator("body").press("r");
	await expect(page.getByRole("link", { name: "打开运行监控" })).toBeVisible();
	await expect(editors).toHaveText(/小李 正在编辑/);
	await page.locator("body").press("e");
	await expect(page.getByRole("button", { name: /保存/ })).toBeVisible();
	await expect(other.page.getByRole("status").filter({ hasText: "tester 正在编辑" })).toBeVisible();
	await expect(editors).toHaveText(/小李 正在编辑/);

	// 离开画布页（回到场景列表）后立即消失。
	await other.page.getByRole("link", { name: "返回场景编排" }).click();
	await expect(other.page).toHaveURL(/\/orchestrations$/);
	await expect(editors).toHaveCount(0);
	await other.context.close();

	const secondTab = await page.context().newPage();
	await secondTab.goto(`/orchestrations/${id}`);
	await expect(editors).toHaveText(/你（其他标签页） 正在编辑/);
	// 关闭标签页（pagehide）后也立即消失。
	await secondTab.close({ runBeforeUnload: true });
	await expect(editors).toHaveCount(0);
});
