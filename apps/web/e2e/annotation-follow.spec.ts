import type { Locator, Page } from "@playwright/test";
import {
	annotated,
	annotationBand,
	annotationFrame,
	savedAnnotations,
	type TestAnnotation,
} from "./annotation-support";
import {
	dock,
	editorDocument,
	headOf,
	inspector,
	nodeCard,
	nodeMenu,
	nodePosition,
	openEditor,
	switchMode,
} from "./editor-support";
import { expect, test } from "./fixtures";
import { box, createScenario, publishPackage, triggerRun } from "./support";

// 注释框跟着成员走（#314）：拖动标题带时成员（子流程成员的全部节点）一起移动，一步撤销；
// 选中或悬停注释框时成员高亮、框里的非成员节点变淡；只读的画布上悬停照样高亮，不能拖动。

/** 画布上的六个节点：主链 entry → fetch → dispatch → ping，dispatch 调度子流程 sub_entry → sub_ping。 */
const IDS = ["entry", "fetch", "dispatch", "ping", "sub_entry", "sub_ping"] as const;
type Id = (typeof IDS)[number];

/** fetch 和 ping 是成员，中间的 dispatch 不是成员但落在框里；entry 和子流程在框外。 */
const ENDS: TestAnnotation = { id: "annotation_1", title: "首尾", nodes: ["fetch", "ping"] };
/** 子流程成员：fetch 加上 sub_entry 的整条链（sub_entry、sub_ping）。 */
const WITH_SUBFLOW: TestAnnotation = {
	id: "annotation_1",
	title: "拉取和对账",
	nodes: ["fetch"],
	subflows: ["sub_entry"],
};

/** 空白处：不在任何节点、注释框标题带和悬浮控件上。 */
const BLANK = { x: 700, y: 760 };

async function scenarioWith(
	cp: Parameters<typeof createScenario>[0],
	annotations: TestAnnotation[],
) {
	await publishPackage(cp);
	return createScenario(cp, "日终数据处理", annotated(annotations));
}

/** 画布实际的缩放比例（--canvas-zoom）。 */
const canvasZoom = (page: Page) =>
	page
		.locator("[data-canvas-region]")
		.evaluate((el) => Number(getComputedStyle(el).getPropertyValue("--canvas-zoom")));

type Positions = Record<Id, { x: number; y: number }>;

async function canvasPositions(page: Page): Promise<Positions> {
	const entries = await Promise.all(
		IDS.map(async (id) => {
			const at = await nodePosition(page, id);
			if (!at) throw new Error(`画布上没有 ${id}`);
			return [id, at] as const;
		}),
	);
	return Object.fromEntries(entries) as Positions;
}

/** 相对 `before`，每个节点是跟着移动了 `delta`（moved）、没动（still），还是别的位移（原样写出）。 */
async function shiftsSince(page: Page, before: Positions, delta: { x: number; y: number }) {
	const after = await canvasPositions(page);
	return Object.fromEntries(
		IDS.map((id) => {
			const dx = after[id].x - before[id].x;
			const dy = after[id].y - before[id].y;
			const verdict =
				Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01
					? "still"
					: Math.abs(dx - delta.x) < 0.5 && Math.abs(dy - delta.y) < 0.5
						? "moved"
						: `${dx.toFixed(2)},${dy.toFixed(2)}`;
			return [id, verdict];
		}),
	);
}

/** 按住标题带的中心拖动 `by`（屏幕像素）。 */
async function dragBand(page: Page, band: Locator, by: { x: number; y: number }) {
	const b = await box(band);
	const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x + by.x / 2, from.y + by.y / 2, { steps: 4 });
	await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 4 });
	await page.mouse.up();
}

const undo = (page: Page) => dock(page).getByRole("button", { name: "撤销" });
const redo = (page: Page) => dock(page).getByRole("button", { name: "重做" });

const DRAG = { x: 96, y: 64 } as const;

test("拖动标题带：成员一起移动，框里夹着的非成员不动，算一步撤销", async ({
	page,
	controlPlane,
}) => {
	const id = await scenarioWith(controlPlane, [ENDS]);
	await openEditor(page, id);
	const zoom = await canvasZoom(page);
	const delta = { x: DRAG.x / zoom, y: DRAG.y / zoom };
	const before = await canvasPositions(page);
	const frameBefore = await box(annotationFrame(page, "annotation_1"));
	const entryBefore = await box(nodeCard(page, "entry"));

	await dragBand(page, annotationBand(page, "首尾"), DRAG);
	await expect
		.poll(() => shiftsSince(page, before, delta))
		.toEqual({
			entry: "still",
			fetch: "moved",
			dispatch: "still",
			ping: "moved",
			sub_entry: "still",
			sub_ping: "still",
		});
	// 视图没有被拖着平移：框外的节点在屏幕上也没有动。框跟着成员走，标题带按住的位置没有离开鼠标。
	expect(await box(nodeCard(page, "entry"))).toEqual(entryBefore);
	const frameAfter = await box(annotationFrame(page, "annotation_1"));
	expect(frameAfter.x - frameBefore.x).toBeCloseTo(DRAG.x, 0);
	expect(frameAfter.y - frameBefore.y).toBeCloseTo(DRAG.y, 0);
	await expect(page.getByText("有未保存的修改")).toBeVisible();

	// 一步撤销：全部回到原处；重做：全部回到拖动后的位置。
	await undo(page).click();
	await expect.poll(() => canvasPositions(page)).toEqual(before);
	await redo(page).click();
	await expect
		.poll(() => shiftsSince(page, before, delta))
		.toEqual({
			entry: "still",
			fetch: "moved",
			dispatch: "still",
			ping: "moved",
			sub_entry: "still",
			sub_ping: "still",
		});
	await expect(redo(page)).toBeDisabled();

	// 位置写进保存的版本：成员移动了同样的距离，其余不变。
	await page.getByRole("button", { name: /保存/ }).click();
	await expect(page.getByText("已保存为版本 2")).toBeVisible();
	const saved = Object.fromEntries(
		(await headOf(controlPlane, id)).document.nodes.map((n) => [
			n.id,
			(n as unknown as { position: { x: number; y: number } }).position,
		]),
	) as Positions;
	for (const node of IDS) {
		const moved = node === "fetch" || node === "ping";
		const was = editorDocument.nodes.find((n) => n.id === node)?.position;
		expect(saved[node].x, `${node}.x`).toBeCloseTo((was?.x ?? 0) + (moved ? delta.x : 0), 0);
		expect(saved[node].y, `${node}.y`).toBeCloseTo((was?.y ?? 0) + (moved ? delta.y : 0), 0);
	}
	// 注释框只记成员，不存坐标。
	expect(await savedAnnotations(controlPlane, id)).toEqual([
		{ id: "annotation_1", title: "首尾", nodes: ["fetch", "ping"], subflows: [] },
	]);
});

test("子流程成员：整个子流程的节点一起移动，子流程区域和注释框跟着；非成员不动", async ({
	page,
	controlPlane,
}) => {
	const id = await scenarioWith(controlPlane, [WITH_SUBFLOW]);
	await openEditor(page, id);
	const zoom = await canvasZoom(page);
	const delta = { x: DRAG.x / zoom, y: DRAG.y / zoom };
	const before = await canvasPositions(page);
	const region = page.getByRole("region", { name: "子流程 sub_entry" });
	const regionBefore = await box(region);

	await dragBand(page, annotationBand(page, "拉取和对账"), DRAG);
	await expect
		.poll(() => shiftsSince(page, before, delta))
		.toEqual({
			entry: "still",
			fetch: "moved",
			dispatch: "still",
			ping: "still",
			sub_entry: "moved",
			sub_ping: "moved",
		});
	const regionAfter = await box(region);
	expect(regionAfter.x - regionBefore.x).toBeCloseTo(DRAG.x, 0);
	expect(regionAfter.y - regionBefore.y).toBeCloseTo(DRAG.y, 0);

	await undo(page).click();
	await expect.poll(() => canvasPositions(page)).toEqual(before);
	await expect(undo(page)).toBeDisabled();
});

test("点一下标题带只是选中，不挪动成员也不进撤销栈；拖动之后选中的状态不变", async ({
	page,
	controlPlane,
}) => {
	const id = await scenarioWith(controlPlane, [ENDS]);
	await openEditor(page, id);
	const before = await canvasPositions(page);

	await annotationBand(page, "首尾").click();
	await expect(annotationBand(page, "首尾")).toHaveAttribute("aria-pressed", "true");
	expect(await canvasPositions(page)).toEqual(before);
	await expect(undo(page)).toBeDisabled();

	// 选中之后拖动：照样移动成员，仍然选中。
	await dragBand(page, annotationBand(page, "首尾"), DRAG);
	await expect(annotationBand(page, "首尾")).toHaveAttribute("aria-pressed", "true");
	await expect(inspector(page).getByRole("heading", { name: "首尾" })).toBeVisible();
	expect((await canvasPositions(page)).fetch).not.toEqual(before.fetch);

	// 没有选中时拖动：不会顺带选中（和拖动节点一样）。
	await annotationBand(page, "首尾").click();
	await page.mouse.click(BLANK.x, BLANK.y);
	await expect(annotationBand(page, "首尾")).toHaveAttribute("aria-pressed", "false");
	await dragBand(page, annotationBand(page, "首尾"), { x: 40, y: 0 });
	await expect(annotationBand(page, "首尾")).toHaveAttribute("aria-pressed", "false");
	await expect(inspector(page).getByRole("heading", { name: "场景设置" })).toBeVisible();
});

test("抓手工具下拖动标题带是平移画布，成员不动", async ({ page, controlPlane }) => {
	const id = await scenarioWith(controlPlane, [ENDS]);
	await openEditor(page, id);
	const before = await canvasPositions(page);
	const entry = await box(nodeCard(page, "entry"));

	await dock(page).getByRole("button", { name: "抓手" }).click();
	await dragBand(page, annotationBand(page, "首尾"), DRAG);
	await expect
		.poll(async () => (await box(nodeCard(page, "entry"))).x)
		.toBeGreaterThan(entry.x + 50);
	expect(await canvasPositions(page)).toEqual(before);
	await expect(undo(page)).toBeDisabled();
});

/** 卡片现在的样子：底色、描边、光晕和标题文字的实际颜色（都是浏览器算出来的值）。 */
async function look(card: Locator) {
	return card.evaluate((el) => {
		const style = getComputedStyle(el);
		const title = el.querySelector('[data-slot="base-node-title"]');
		return {
			background: style.backgroundColor,
			border: style.borderTopColor,
			shadow: style.boxShadow,
			title: title ? getComputedStyle(title).color : "",
		};
	});
}
type Look = Awaited<ReturnType<typeof look>>;

/** 画布区域（编辑器里只有一块；版本对比里是左右两块，各自有名字）。 */
const canvasOf = (page: Page) => page.locator("[data-canvas-region]");

async function looks(canvas: Locator): Promise<Record<Id, Look>> {
	const entries = await Promise.all(
		IDS.map(async (id) => [id, await look(canvas.locator(`[data-node-id="${id}"]`))] as const),
	);
	return Object.fromEntries(entries) as Record<Id, Look>;
}

/** 等卡片的样子停下来（描边有颜色过渡，节点状态也可能还在加载）再取，作为没有强调任何注释框时的样子。 */
async function settledLooks(canvas: Locator): Promise<Record<Id, Look>> {
	let previous = "";
	await expect
		.poll(async () => {
			const now = JSON.stringify(await looks(canvas));
			const same = now === previous;
			previous = now;
			return same;
		})
		.toBe(true);
	return JSON.parse(previous);
}

/**
 * 每个节点相对 `base`（还没有强调任何注释框时的样子）是什么状态：
 * plain 没变；highlighted 描边或光晕变了、底色没变；dimmed 底色沉到所在底色（画布、注释框底板）的方向、和原来的底色不同（不用不透明度，文字对比度不降）；
 * 其余原样写出。
 */
async function emphasis(canvas: Locator, base: Record<Id, Look>) {
	const now = await looks(canvas);
	return Object.fromEntries(
		IDS.map((id) => {
			const [was, is] = [base[id], now[id]];
			const verdict =
				JSON.stringify(was) === JSON.stringify(is)
					? "plain"
					: is.background === was.background &&
							is.title === was.title &&
							(is.border !== was.border || is.shadow !== was.shadow)
						? "highlighted"
						: is.background !== was.background
							? "dimmed"
							: JSON.stringify({ was, is });
			return [id, verdict];
		}),
	);
}

const PLAIN = {
	entry: "plain",
	fetch: "plain",
	dispatch: "plain",
	ping: "plain",
	sub_entry: "plain",
	sub_ping: "plain",
};

test("悬停标题带：成员高亮，夹在框里的非成员变淡，框外的节点不变；移开后恢复", async ({
	page,
	controlPlane,
}) => {
	const id = await scenarioWith(controlPlane, [ENDS]);
	await openEditor(page, id);
	const base = await settledLooks(canvasOf(page));

	await annotationBand(page, "首尾").hover();
	await expect
		.poll(() => emphasis(canvasOf(page), base))
		.toEqual({ ...PLAIN, fetch: "highlighted", dispatch: "dimmed", ping: "highlighted" });

	await page.mouse.move(BLANK.x, BLANK.y);
	await expect.poll(() => emphasis(canvasOf(page), base)).toEqual(PLAIN);
});

test("选中注释框：成员高亮、夹在框里的非成员变淡，鼠标移开后仍然；点空白处取消", async ({
	page,
	controlPlane,
}) => {
	const id = await scenarioWith(controlPlane, [WITH_SUBFLOW]);
	await openEditor(page, id);
	const base = await settledLooks(canvasOf(page));

	await annotationBand(page, "拉取和对账").click();
	await page.mouse.move(BLANK.x, BLANK.y);
	// fetch 和子流程的整条链是成员；dispatch 和 ping 夹在中间的框里，不是成员。
	await expect
		.poll(() => emphasis(canvasOf(page), base))
		.toEqual({
			...PLAIN,
			fetch: "highlighted",
			dispatch: "dimmed",
			ping: "dimmed",
			sub_entry: "highlighted",
			sub_ping: "highlighted",
		});

	await page.mouse.click(BLANK.x, BLANK.y);
	await expect.poll(() => emphasis(canvasOf(page), base)).toEqual(PLAIN);
});

test("选中一个注释框时悬停另一个：悬停的那个先显示，移开后回到选中的", async ({
	page,
	controlPlane,
}) => {
	const id = await scenarioWith(controlPlane, [
		ENDS,
		{ id: "annotation_2", title: "对账子流程", subflows: ["sub_entry"] },
	]);
	await openEditor(page, id);
	const base = await settledLooks(canvasOf(page));

	await annotationBand(page, "首尾").click();
	await page.mouse.move(BLANK.x, BLANK.y);
	await expect
		.poll(() => emphasis(canvasOf(page), base))
		.toEqual({ ...PLAIN, fetch: "highlighted", dispatch: "dimmed", ping: "highlighted" });

	await annotationBand(page, "对账子流程").hover();
	await expect
		.poll(() => emphasis(canvasOf(page), base))
		.toEqual({ ...PLAIN, sub_entry: "highlighted", sub_ping: "highlighted" });

	await page.mouse.move(BLANK.x, BLANK.y);
	await expect
		.poll(() => emphasis(canvasOf(page), base))
		.toEqual({ ...PLAIN, fetch: "highlighted", dispatch: "dimmed", ping: "highlighted" });
});

test("鼠标停在标题带上时注释框被撤销掉，再重做回来：不会凭空高亮", async ({
	page,
	controlPlane,
}) => {
	const id = await scenarioWith(controlPlane, []);
	await openEditor(page, id);
	const base = await settledLooks(canvasOf(page));

	await nodeCard(page, "fetch").click({ button: "right" });
	await nodeMenu(page).getByRole("menuitem", { name: "添加注释框" }).click();
	await expect(annotationFrame(page, "annotation_1")).toBeVisible();
	await page.mouse.click(BLANK.x, BLANK.y);
	await annotationBand(page, "注释框 1").hover();
	await expect.poll(() => emphasis(canvasOf(page), base)).toMatchObject({ fetch: "highlighted" });

	// 标题带在鼠标下面消失：浏览器不会再发 pointerleave。
	await page.keyboard.press("ControlOrMeta+z");
	await expect(annotationFrame(page, "annotation_1")).toHaveCount(0);
	await page.mouse.move(BLANK.x, BLANK.y);
	await page.keyboard.press("ControlOrMeta+Shift+z");
	await expect(annotationBand(page, "注释框 1")).toBeVisible();
	await expect(annotationBand(page, "注释框 1")).toHaveAttribute("aria-pressed", "false");
	await expect.poll(() => emphasis(canvasOf(page), base)).toEqual(PLAIN);
});

test("运行状态模式（只读）：悬停照样高亮，拖动标题带不会移动成员", async ({
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
	const id = await createScenario(
		controlPlane,
		"日终数据处理",
		annotated([ENDS], {
			...editorDocument,
			nodes: editorDocument.nodes.map((n) =>
				n.id === "entry"
					? { ...n, params: [{ name: "biz_date", type: "string", default: "2026-01-01" }] }
					: n,
			),
		}),
	);
	await triggerRun(controlPlane, id);
	await openEditor(page, id);
	await switchMode(page, "run");
	const band = annotationFrame(page, "annotation_1").locator("[data-annotation-band]");
	await expect(band).toBeVisible();
	for (const node of IDS) await expect(nodeCard(page, node)).toHaveAttribute("data-run");
	await expect(page.getByRole("button", { name: /^选中注释框/ })).toHaveCount(0);
	const base = await settledLooks(canvasOf(page));
	const before = await canvasPositions(page);

	await band.hover();
	await expect
		.poll(() => emphasis(canvasOf(page), base))
		.toEqual({ ...PLAIN, fetch: "highlighted", dispatch: "dimmed", ping: "highlighted" });

	// 拖动：成员在画布上的位置不变（按住标题带拖动在只读画布上是平移视图）。
	await dragBand(page, band, DRAG);
	expect(await canvasPositions(page)).toEqual(before);
	await page.mouse.move(BLANK.x, BLANK.y);
	await expect.poll(() => emphasis(canvasOf(page), base)).toEqual(PLAIN);

	await switchMode(page, "edit");
	expect(await canvasPositions(page)).toEqual(before);
	await expect(page.getByText("有未保存的修改")).toHaveCount(0);
});

test("版本查看画布（只读）：悬停照样高亮，只高亮悬停的那一侧", async ({ page, controlPlane }) => {
	await publishPackage(controlPlane);
	const id = await createScenario(controlPlane, "日终数据处理", annotated([ENDS], editorDocument));
	const res = await controlPlane.fetch(`/orchestrations/${id}/versions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sfly-nickname": "bob" },
		body: JSON.stringify({
			base_version: 1,
			document: annotated([{ ...ENDS, nodes: ["fetch", "dispatch", "ping"] }], editorDocument),
		}),
	});
	expect(res.status, await res.text()).toBe(201);

	await page.goto(`/orchestrations/${id}/versions?a=1&b=2`);
	const a = page.getByRole("region", { name: "版本 1（只读）" });
	const b = page.getByRole("region", { name: "版本 2（只读）" });
	await expect(a.locator('[data-annotation="annotation_1"]')).toBeVisible();
	await expect(b.locator('[data-annotation="annotation_1"]')).toBeVisible();
	const baseA = await settledLooks(a);
	const baseB = await settledLooks(b);

	await a.locator('[data-annotation="annotation_1"]').locator("[data-annotation-band]").hover();
	await expect
		.poll(() => emphasis(a, baseA))
		.toEqual({ ...PLAIN, fetch: "highlighted", dispatch: "dimmed", ping: "highlighted" });
	expect(await emphasis(b, baseB)).toEqual(PLAIN);

	// 第 2 版里 dispatch 也是成员：没有被夹在中间的非成员。
	await b.locator('[data-annotation="annotation_1"]').locator("[data-annotation-band]").hover();
	await expect
		.poll(() => emphasis(b, baseB))
		.toEqual({ ...PLAIN, fetch: "highlighted", dispatch: "highlighted", ping: "highlighted" });
	await expect.poll(() => emphasis(a, baseA)).toEqual(PLAIN);
});
