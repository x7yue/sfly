import type { Page } from "@playwright/test";
import type { TestControlPlane } from "../../server/test/support/test-control-plane.js";
import { editorDocument, headOf, inspector } from "./editor-support";
import type { box } from "./support";

// 注释框的端到端测试（annotations.spec.ts、视觉回归，以及之后的注释框工单）共用的定位与数据。

export interface TestAnnotation {
	id: string;
	title: string;
	note?: string;
	color?: string;
	nodes?: string[];
	subflows?: string[];
}

/** 画布上的注释框（按 ID）。 */
export const annotationFrame = (page: Page, id: string) =>
	page.locator(`[data-annotation="${id}"]`);

/** 可编辑画布上注释框的标题带：点它选中注释框。 */
export const annotationBand = (page: Page, title: string) =>
	page.getByRole("button", { name: `选中注释框 ${title}` });

/** 检查器里注释框的字段。 */
export const annotationTitleBox = (page: Page) =>
	inspector(page).getByRole("textbox", { name: "标题" });
export const annotationNoteBox = (page: Page) =>
	inspector(page).getByRole("textbox", { name: "备注" });
/** 检查器里注释框的颜色选择（一组按钮，按颜色名找）。 */
export const annotationColors = (page: Page) =>
	inspector(page).getByRole("group", { name: "颜色" });
/** 检查器里注释框的成员列表。 */
export const memberList = (page: Page) => inspector(page).getByRole("list", { name: "成员" });

/** editorDocument 加上注释框。 */
export const annotated = (annotations: TestAnnotation[], base: object = editorDocument) => ({
	...base,
	annotations,
});

/** 控制面上最新版本里的注释框。 */
export async function savedAnnotations(cp: TestControlPlane, scenario: string) {
	const head = (await headOf(cp, scenario)) as unknown as {
		document: { annotations?: TestAnnotation[] };
	};
	return head.document.annotations;
}

type Rect = Awaited<ReturnType<typeof box>>;

/** `inner` 整个落在 `outer` 里（屏幕坐标，容差 1px）。 */
export function frames(outer: Rect, inner: Rect): boolean {
	return (
		inner.x >= outer.x - 1 &&
		inner.y >= outer.y - 1 &&
		inner.x + inner.width <= outer.x + outer.width + 1 &&
		inner.y + inner.height <= outer.y + outer.height + 1
	);
}
