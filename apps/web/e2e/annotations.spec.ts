import type { Page } from "@playwright/test";
import { dropDocumentFields } from "../../server/test/support/legacy-document.js";
import {
	annotated,
	annotationBand,
	annotationFrame,
	annotationNoteBox,
	annotationTitleBox,
	frames,
	memberList,
	savedAnnotations,
	type TestAnnotation,
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
	switchMode,
} from "./editor-support";
import { expect, test } from "./fixtures";
import { box, createScenario, publishPackage, triggerRun } from "./support";

// 注释框（#310）：从节点右键菜单新建、加入、移出（只用键盘也行）；画在画布上，范围由成员算出；
// 点标题带选中，在检查器里改标题、备注、成员，删除注释框；删节点时同步更新；运行状态和版本查看里也显示。

const NOTE = "先建用户再查订单\n订单号由 fetch 生成";

/** editorDocument 去掉必填的入口参数（给了默认值），不填参数也能触发运行。 */
const triggerable = {
	...editorDocument,
	nodes: editorDocument.nodes.map((n) =>
		n.id === "entry"
			? { ...n, params: [{ name: "biz_date", type: "string", default: "2026-01-01" }] }
			: n,
	),
};

const openMenu = async (page: Page, id: string) => {
	await nodeCard(page, id).click({ button: "right" });
	await expect(nodeMenu(page)).toBeVisible();
	return nodeMenu(page);
};
/** 卡片整个落在注释框里：成员变化之后框要到下一次渲染才更新，断言时用 `expect.poll` 等它。 */
const framesCard = (page: Page, annotation: string, card: string) => async () =>
	frames(await box(annotationFrame(page, annotation)), await box(nodeCard(page, card)));
const joinMenu = (page: Page) => page.getByRole("menu", { name: "加入注释框" });
const leaveMenu = (page: Page) => page.getByRole("menu", { name: "移出注释框" });

/** 在打开的节点菜单里按 ↓，直到高亮的项以 `text` 开头。 */
async function arrowTo(page: Page, text: string) {
	const highlighted = nodeMenu(page).locator('[role="menuitem"][data-highlighted]');
	for (let i = 0; i < 12; i++) {
		await page.keyboard.press("ArrowDown");
		await expect(highlighted).toHaveCount(1);
		if ((await highlighted.textContent())?.startsWith(text)) return;
	}
	throw new Error(`节点菜单里没有「${text}」`);
}

async function save(page: Page, version: number) {
	await page.getByRole("button", { name: /保存/ }).click();
	await expect(page.getByText(`已保存为版本 ${version}`)).toBeVisible();
}

async function scenarioWith(
	cp: Parameters<typeof createEditorScenario>[0],
	annotations: TestAnnotation[],
) {
	await publishPackage(cp);
	return createScenario(cp, "日终数据处理", annotated(annotations));
}

test("从节点菜单新建注释框，标题输入框拿到焦点；加入、移出其他节点，框跟着成员变；写标题和备注，保存刷新后还在", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	let menu = await openMenu(page, "fetch");
	await expect(menu.getByRole("menuitem", { name: /注释框/ })).toHaveText([
		"添加注释框",
		"加入注释框没有可以加入的注释框",
		"移出注释框这个节点不在注释框里",
	]);

	await menu.getByRole("menuitem", { name: "添加注释框" }).click();
	// 新建后选中这个注释框，标题输入框拿到焦点，默认标题整段选中，直接输入就替换掉。
	await expect(annotationTitleBox(page)).toBeFocused();
	await expect(annotationTitleBox(page)).toHaveValue("注释框 1");
	await expect(annotationBand(page, "注释框 1")).toHaveAttribute("aria-pressed", "true");
	await page.keyboard.type("造测试数据");
	await expect(annotationTitleBox(page)).toHaveValue("造测试数据");
	await expect(inspector(page).getByRole("heading", { name: "造测试数据" })).toBeVisible();
	await expect(annotationBand(page, "造测试数据")).toBeVisible();
	const frame = annotationFrame(page, "annotation_1");
	await expect.poll(framesCard(page, "annotation_1", "fetch")).toBe(true);
	await expect.poll(framesCard(page, "annotation_1", "ping")).toBe(false);
	await expect(memberList(page).getByRole("listitem")).toHaveText([/fetch/]);

	// 加入：ping 进来，框从 fetch 一直包到 ping（中间的 dispatch 不是成员，但落在框里）。
	menu = await openMenu(page, "ping");
	await menu.getByRole("menuitem", { name: "加入注释框" }).click();
	await expect(joinMenu(page).getByRole("menuitem")).toHaveText(["造测试数据annotation_1"]);
	await joinMenu(page)
		.getByRole("menuitem", { name: /造测试数据/ })
		.click();
	await expect(nodeMenu(page)).toHaveCount(0);
	for (const node of ["fetch", "dispatch", "ping"]) {
		await expect.poll(framesCard(page, "annotation_1", node)).toBe(true);
	}
	// ping 已经在里面了：没有别的注释框可以加入；能从这个注释框移出。
	menu = await openMenu(page, "ping");
	await expect(menu.getByRole("menuitem", { name: /^加入注释框/ })).toBeDisabled();
	await menu.getByRole("menuitem", { name: /^移出注释框/ }).click();
	await expect(leaveMenu(page).getByRole("menuitem")).toHaveText(["造测试数据annotation_1"]);
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");

	// 移出 fetch：框只剩 ping。
	menu = await openMenu(page, "fetch");
	await menu.getByRole("menuitem", { name: /^移出注释框/ }).click();
	await leaveMenu(page)
		.getByRole("menuitem", { name: /造测试数据/ })
		.click();
	await expect.poll(framesCard(page, "annotation_1", "fetch")).toBe(false);
	await expect.poll(framesCard(page, "annotation_1", "ping")).toBe(true);
	// 移出最后一个成员：和删节点一样，注释框一起删除，节点不动；一步撤销恢复。
	const ping = await box(nodeCard(page, "ping"));
	menu = await openMenu(page, "ping");
	await menu.getByRole("menuitem", { name: /^移出注释框/ }).click();
	await expect(leaveMenu(page).getByRole("menuitem")).toHaveText(["造测试数据annotation_1"]);
	await expect(leaveMenu(page).getByRole("menuitem")).toBeEnabled();
	await leaveMenu(page)
		.getByRole("menuitem", { name: /造测试数据/ })
		.click();
	await expect(frame).toHaveCount(0);
	expect(await box(nodeCard(page, "ping"))).toEqual(ping);
	await dock(page).getByRole("button", { name: "撤销" }).click();
	await expect(frame).toBeVisible();
	await expect.poll(framesCard(page, "annotation_1", "ping")).toBe(true);

	// 点标题带选中注释框，写备注：标题带上出现备注图标，悬停显示全文。
	await nodeCard(page, "entry").click();
	await annotationBand(page, "造测试数据").click();
	await expect(annotationBand(page, "造测试数据")).toHaveAttribute("aria-pressed", "true");
	await annotationNoteBox(page).fill(`  ${NOTE}  `);
	const noteIcon = frame.locator('[data-slot="note-icon"]');
	await expect(noteIcon).toHaveCount(1);
	await noteIcon.hover();
	await expect(page.getByRole("tooltip")).toHaveText(NOTE);
	await expect(annotationBand(page, "造测试数据")).toHaveAccessibleDescription(NOTE);

	await save(page, 2);
	expect(await savedAnnotations(controlPlane, id)).toEqual([
		{ id: "annotation_1", title: "造测试数据", note: NOTE, nodes: ["ping"], subflows: [] },
	]);
	await page.reload();
	await expect(annotationBand(page, "造测试数据")).toBeVisible();
	await expect.poll(framesCard(page, "annotation_1", "ping")).toBe(true);
	await expect(frame.locator('[data-slot="note-icon"]')).toHaveCount(1);
	await annotationBand(page, "造测试数据").click();
	await expect(annotationNoteBox(page)).toHaveValue(NOTE);
	await expect(annotationTitleBox(page)).toHaveValue("造测试数据");
});

test("只用键盘：Shift+F10 新建注释框、输入标题，Esc 回到画布，方向键换到另一个节点，再用菜单把它加入", async ({
	page,
	controlPlane,
}) => {
	const id = await createEditorScenario(controlPlane);
	await openEditor(page, id);
	await nodeCard(page, "fetch").click();
	await page.keyboard.press("Shift+F10");
	await expect(nodeMenu(page)).toBeFocused();
	await arrowTo(page, "添加注释框");
	await page.keyboard.press("Enter");
	await expect(annotationTitleBox(page)).toBeFocused();
	await page.keyboard.type("拉取快照");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("region", { name: /^编排画布/ })).toBeFocused();

	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("ArrowRight");
	await expect(nodeCard(page, "fetch")).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(nodeCard(page, "dispatch")).toBeFocused();
	await page.keyboard.press("Shift+F10");
	await expect(nodeMenu(page)).toBeFocused();
	await arrowTo(page, "加入注释框");
	await page.keyboard.press("ArrowRight");
	await expect(joinMenu(page).getByRole("menuitem", { name: /拉取快照/ })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(nodeMenu(page)).toHaveCount(0);
	await expect(nodeCard(page, "dispatch")).toBeFocused();

	await annotationBand(page, "拉取快照").click();
	await expect(memberList(page).getByRole("listitem")).toHaveText([/fetch/, /dispatch/]);
});

test("选中注释框后按 Enter，焦点移到检查器里的标题输入框；Esc 回到画布", async ({
	page,
	controlPlane,
}) => {
	const id = await scenarioWith(controlPlane, [
		{ id: "annotation_1", title: "主链后半段", nodes: ["dispatch", "ping"] },
	]);
	await openEditor(page, id);
	await annotationBand(page, "主链后半段").click();
	await expect(annotationBand(page, "主链后半段")).toHaveAttribute("aria-pressed", "true");

	// 用键盘：焦点在画布区域上，注释框是选中的。
	const canvas = page.getByRole("region", { name: /^编排画布/ });
	await canvas.focus();
	await page.keyboard.press("Enter");
	await expect(annotationTitleBox(page)).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(canvas).toBeFocused();
});

test("检查器：逐个移出成员、跳到成员，删除注释框时成员节点不动；添加、修改、删除都能撤销和重做", async ({
	page,
	controlPlane,
}) => {
	const id = await scenarioWith(controlPlane, [
		{
			id: "annotation_1",
			title: "主链后半段",
			nodes: ["dispatch", "ping"],
			subflows: ["sub_entry"],
		},
	]);
	await openEditor(page, id);
	await annotationBand(page, "主链后半段").click();
	await expect(inspector(page).getByRole("heading", { name: "主链后半段" })).toBeVisible();
	await expect(inspector(page)).toContainText("annotation_1");
	await expect(memberList(page).getByRole("listitem")).toHaveText([
		/dispatch/,
		/ping/,
		/子流程 sub_entry/,
	]);

	// 跳到成员：选中并定位到那个节点。
	await memberList(page).getByRole("button", { name: "前往 ping" }).click();
	await expect(nodeCard(page, "ping")).toHaveAttribute("aria-pressed", "true");

	await annotationBand(page, "主链后半段").click();
	await memberList(page).getByRole("button", { name: "移出 dispatch" }).click();
	await expect(memberList(page).getByRole("listitem")).toHaveText([/ping/, /子流程 sub_entry/]);
	await memberList(page).getByRole("button", { name: "移出 子流程 sub_entry" }).click();
	await expect(memberList(page).getByRole("listitem")).toHaveText([/ping/]);
	// 移出最后一个成员：注释框一起删除，检查器回到场景设置，节点不动；一步撤销恢复。
	const lastPing = await box(nodeCard(page, "ping"));
	await expect(memberList(page).getByRole("button", { name: "移出 ping" })).toBeEnabled();
	await memberList(page).getByRole("button", { name: "移出 ping" }).click();
	await expect(annotationFrame(page, "annotation_1")).toHaveCount(0);
	await expect(inspector(page).getByRole("heading", { name: "场景设置" })).toBeVisible();
	expect(await box(nodeCard(page, "ping"))).toEqual(lastPing);
	await dock(page).getByRole("button", { name: "撤销" }).click();
	await annotationBand(page, "主链后半段").click();
	await expect(memberList(page).getByRole("listitem")).toHaveText([/ping/]);

	// 撤销、重做成员的修改。
	await dock(page).getByRole("button", { name: "撤销" }).click();
	await expect(memberList(page).getByRole("listitem")).toHaveText([/ping/, /子流程 sub_entry/]);
	await dock(page).getByRole("button", { name: "重做" }).click();
	await expect(memberList(page).getByRole("listitem")).toHaveText([/ping/]);

	// 改标题：连续输入合成一步撤销。
	await annotationTitleBox(page).fill("收尾");
	await expect(annotationBand(page, "收尾")).toBeVisible();
	await dock(page).getByRole("button", { name: "撤销" }).click();
	await expect(annotationBand(page, "主链后半段")).toBeVisible();
	await dock(page).getByRole("button", { name: "重做" }).click();
	await expect(annotationBand(page, "收尾")).toBeVisible();

	// 删除注释框：成员节点不动，检查器回到场景设置。
	const ping = await box(nodeCard(page, "ping"));
	await inspector(page).getByRole("button", { name: "删除注释框" }).click();
	await expect(annotationFrame(page, "annotation_1")).toHaveCount(0);
	await expect(inspector(page).getByRole("heading", { name: "场景设置" })).toBeVisible();
	expect(await box(nodeCard(page, "ping"))).toEqual(ping);
	await dock(page).getByRole("button", { name: "撤销" }).click();
	await expect(annotationBand(page, "收尾")).toBeVisible();
	await dock(page).getByRole("button", { name: "重做" }).click();
	await expect(annotationFrame(page, "annotation_1")).toHaveCount(0);

	// 添加也能撤销。
	await openMenu(page, "fetch");
	await nodeMenu(page).getByRole("menuitem", { name: "添加注释框" }).click();
	await expect(annotationFrame(page, "annotation_1")).toBeVisible();
	await dock(page).getByRole("button", { name: "撤销" }).click();
	await expect(annotationFrame(page, "annotation_1")).toHaveCount(0);
	await expect(page.getByText("有未保存的修改")).toBeVisible();
});

test("标题为空时是字段错误，不能保存；保存被拦下时选中这个注释框并聚焦标题", async ({
	page,
	controlPlane,
}) => {
	const id = await scenarioWith(controlPlane, [
		{ id: "annotation_1", title: "造测试数据", nodes: ["fetch"] },
	]);
	await openEditor(page, id);
	await annotationBand(page, "造测试数据").click();
	await annotationTitleBox(page).fill("  ");
	await expect(inspector(page).getByText("不能为空")).toBeVisible();
	await expect(page.getByText("1 处字段错误")).toBeVisible();

	await nodeCard(page, "entry").click();
	await page.getByRole("button", { name: /保存/ }).click();
	await expect(annotationTitleBox(page)).toBeFocused();
	await annotationTitleBox(page).fill("造测试数据 v2");
	await save(page, 2);
	expect((await savedAnnotations(controlPlane, id))?.[0]?.title).toBe("造测试数据 v2");
});

test("删除节点时成员同步更新：删掉的节点和子流程入口从注释框里去掉，成员删光的注释框一起删除；一次撤销全部恢复", async ({
	page,
	controlPlane,
}) => {
	const id = await scenarioWith(controlPlane, [
		{ id: "annotation_1", title: "主链", nodes: ["fetch", "ping"] },
		{ id: "annotation_2", title: "派发", nodes: ["dispatch"] },
		{ id: "annotation_3", title: "子流程", subflows: ["sub_entry"] },
	]);
	await openEditor(page, id);
	const before = await Promise.all(
		["annotation_1", "annotation_2", "annotation_3"].map((a) => box(annotationFrame(page, a))),
	);

	await nodeCard(page, "fetch").click();
	await nodeCard(page, "dispatch").click({ modifiers: ["ControlOrMeta"] });
	await nodeCard(page, "sub_entry").click({ modifiers: ["ControlOrMeta"] });
	await page.keyboard.press("Delete");
	await expect(nodeCard(page, "fetch")).toHaveCount(0);
	await expect(annotationFrame(page, "annotation_2")).toHaveCount(0);
	await expect(annotationFrame(page, "annotation_3")).toHaveCount(0);
	expect(
		frames(await box(annotationFrame(page, "annotation_1")), await box(nodeCard(page, "ping"))),
	).toBe(true);
	await annotationBand(page, "主链").click();
	await expect(memberList(page).getByRole("listitem")).toHaveText([/ping/]);

	await dock(page).getByRole("button", { name: "撤销" }).click();
	await expect(nodeCard(page, "fetch")).toBeVisible();
	const after = await Promise.all(
		["annotation_1", "annotation_2", "annotation_3"].map((a) => box(annotationFrame(page, a))),
	);
	expect(after).toEqual(before);
	await expect(page.getByText("有未保存的修改")).toHaveCount(0);
});

test("子流程成员：往子流程里加节点，框跟着变大；画在子流程区域下面，后添加的画在上层", async ({
	page,
	controlPlane,
}) => {
	const id = await scenarioWith(controlPlane, [
		{ id: "annotation_1", title: "对账子流程", subflows: ["sub_entry"] },
		{ id: "annotation_2", title: "同一个子流程", subflows: ["sub_entry"] },
	]);
	await openEditor(page, id);
	const region = page.getByRole("region", { name: "子流程 sub_entry" });
	const first = await box(annotationFrame(page, "annotation_1"));
	expect(frames(first, await box(region))).toBe(true);

	// 两个注释框范围相同：标题带重在一起，点到的是后添加的那个。
	expect(await box(annotationFrame(page, "annotation_2"))).toEqual(first);
	const band = await box(annotationBand(page, "同一个子流程"));
	await page.mouse.click(band.x + 8, band.y + band.height / 2);
	await expect(annotationBand(page, "同一个子流程")).toHaveAttribute("aria-pressed", "true");

	await openMenu(page, "sub_ping");
	await nodeMenu(page).getByRole("menuitem", { name: "在后面添加节点" }).click();
	await addMenu(page).getByRole("option", { name: /Sleep/ }).click();
	await expect(nodeCard(page, "sleep_1")).toBeVisible();
	// 新节点接在 sub_ping 右边，视图随后平移过去：在同一时刻量框、新节点和子流程区域。
	const frame = annotationFrame(page, "annotation_1");
	await expect
		.poll(async () => {
			const grown = await box(frame);
			const added = await box(nodeCard(page, "sleep_1"));
			const sub = await box(region);
			return grown.width > first.width && frames(grown, added) && frames(grown, sub);
		})
		.toBe(true);
});

test("缩小画布：标题带的文字跟着语义缩放，屏幕上不小于 12px", async ({ page, controlPlane }) => {
	const id = await scenarioWith(controlPlane, [
		{ id: "annotation_1", title: "造测试数据", nodes: ["fetch", "dispatch"] },
	]);
	await openEditor(page, id);
	const title = annotationBand(page, "造测试数据").getByText("造测试数据");
	for (let i = 0; i < 12; i++) await dock(page).getByRole("button", { name: "缩小" }).click();
	await expect(page.getByRole("status", { name: "缩放比例" })).toHaveText("30%");
	// 屏幕字号 = 字号 × 画布实际的缩放比例（--canvas-zoom）；等缩放动画停在 30% 再量。
	const zoom = () =>
		title.evaluate((el) =>
			Number(
				getComputedStyle(el.closest("[data-lod]") as Element).getPropertyValue("--canvas-zoom"),
			),
		);
	await expect.poll(zoom).toBeCloseTo(0.3, 5);
	const fontPx = await title.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
	expect(fontPx * (await zoom())).toBeGreaterThanOrEqual(12 - 0.01);
	await expect(title).toBeVisible();
});

test("打开画布时适配视图把注释框的范围也算进去：外沿不被检查器、视口和工具条挡住", async ({
	page,
	controlPlane,
}) => {
	// 子流程成员的框在子流程区域外面再留一圈，右边比最右的节点宽出 48 个单位：按节点算的话，
	// 节点刚好贴着适配的边距，框的右沿就伸到检查器下面去了。
	const id = await scenarioWith(controlPlane, [
		{ id: "annotation_1", title: "对账子流程", subflows: ["sub_entry"] },
	]);
	await openEditor(page, id);

	const [frame, panel, tools] = [
		await box(annotationFrame(page, "annotation_1")),
		await box(inspector(page)),
		await box(dock(page)),
	];
	expect(frame.x, "框的左沿").toBeGreaterThanOrEqual(0);
	expect(frame.y, "框的上沿").toBeGreaterThanOrEqual(0);
	expect(frame.x + frame.width, "框的右沿").toBeLessThanOrEqual(panel.x);
	expect(frame.y + frame.height, "框的下沿").toBeLessThanOrEqual(tools.y);
});

test("运行状态模式和版本查看画布显示注释框（只读，标题带不能点）；版本对比列出注释框的新增、删除和修改", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({
		name: "agent-linux",
		slots: 2,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	const v1 = annotated(
		[
			{ id: "annotation_1", title: "造测试数据", nodes: ["fetch"] },
			{ id: "annotation_2", title: "旧的一段", nodes: ["ping"] },
		],
		triggerable,
	);
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "日终数据处理", v1);
	const v2 = annotated(
		[
			{
				id: "annotation_1",
				title: "准备数据",
				note: "两步都要成功",
				nodes: ["fetch", "dispatch"],
			},
			{ id: "annotation_3", title: "对账", subflows: ["sub_entry"] },
		],
		triggerable,
	);
	const res = await controlPlane.fetch(`/orchestrations/${id}/versions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "bob" },
		body: JSON.stringify({ base_version: 1, document: v2 }),
	});
	expect(res.status, await res.text()).toBe(201);
	await triggerRun(controlPlane, id);

	// 运行状态：显示运行绑定的版本（第 2 版）的注释框，只读。
	await openEditor(page, id);
	await switchMode(page, "run");
	await expect(annotationFrame(page, "annotation_3")).toBeVisible();
	await expect(annotationFrame(page, "annotation_1")).toContainText("准备数据");
	await expect(page.getByRole("button", { name: /^选中注释框/ })).toHaveCount(0);
	await switchMode(page, "edit");
	await expect(annotationBand(page, "准备数据")).toBeVisible();

	// 版本对比：差异列表有「注释框」一组，两侧的只读画布都画出注释框。
	await page.goto(`/orchestrations/${id}/versions?a=1&b=2`);
	const diff = page.getByRole("region", { name: "差异" });
	const group = diff.getByRole("region", { name: "注释框" });
	await expect(group).toContainText("+ 对账（annotation_3）");
	await expect(group).toContainText("− 旧的一段（annotation_2）");
	await expect(group).toContainText("准备数据（annotation_1）");
	await expect(group).toContainText("标题 造测试数据 → 准备数据");
	await expect(group).toContainText("备注 两步都要成功（新增）");
	await expect(group).toContainText("成员节点 fetch → fetch、dispatch");
	const a = page.getByRole("region", { name: "版本 1（只读）" });
	const b = page.getByRole("region", { name: "版本 2（只读）" });
	await expect(a.locator('[data-annotation="annotation_2"]')).toBeVisible();
	await expect(b.locator('[data-annotation="annotation_3"]')).toBeVisible();
	await expect(b.locator('[data-annotation="annotation_1"] [data-slot="note-icon"]')).toHaveCount(
		1,
	);
	await expect(page.getByRole("button", { name: /^选中注释框/ })).toHaveCount(0);
});

test("运行绑定的是升级前保存的版本（库里的文档没有 annotations）：选中注释框后切到运行状态，页面照常显示", async ({
	page,
	controlPlane,
	connectAgent,
}) => {
	await connectAgent({
		name: "agent-linux",
		slots: 2,
		installedPackages: [{ name: "demo-checks", version: "1.2.0" }],
	});
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "日终数据处理", triggerable);
	await triggerRun(controlPlane, id);
	const res = await controlPlane.fetch(`/orchestrations/${id}/versions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "bob" },
		body: JSON.stringify({
			base_version: 1,
			document: annotated(
				[{ id: "annotation_1", title: "造测试数据", nodes: ["fetch"] }],
				triggerable,
			),
		}),
	});
	expect(res.status, await res.text()).toBe(201);
	await dropDocumentFields(controlPlane, id, ["annotations"], 1);

	await openEditor(page, id);
	await annotationBand(page, "造测试数据").click();
	await switchMode(page, "run");
	// 运行绑定的第 1 版（没有注释框）加载出来、节点叠加上运行状态之后，页面还在。
	await expect(annotationFrame(page, "annotation_1")).toHaveCount(0);
	await expect(nodeCard(page, "fetch")).toHaveAttribute("data-run");
	await expect(page.getByText("Something went wrong")).toHaveCount(0);

	await switchMode(page, "edit");
	await expect(annotationBand(page, "造测试数据")).toHaveAttribute("aria-pressed", "true");
});
