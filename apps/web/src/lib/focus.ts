/**
 * 按键交给谁：焦点在可以输入文字的元素里、或有弹窗打开时，快捷键（components/shortcuts）、画布按键
 * （FlowCanvas、编辑器的 Tab）和画布的复制粘贴（editor/node-clipboard）都不处理，照常交给它们。
 */

/** 可以输入文字的元素：输入框、文本域、下拉选择、contenteditable（ReferenceEditor）。 */
export const isEditable = (target: EventTarget | null): boolean =>
	target instanceof HTMLElement &&
	(target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** 打开着的弹窗与弹出层。正在关闭（退场动画中）的不算：Base UI 只给打开着的加 data-open。 */
export const OPEN_DIALOG = '[role="dialog"][data-open], [role="alertdialog"][data-open]';

/** 有弹窗或弹出层打开着。 */
export const dialogOpen = (): boolean => document.querySelector(OPEN_DIALOG) !== null;

/**
 * 焦点在画布本身：画布区域、节点卡片、画布空白处，或者页面上没有焦点（`body`）。画布自己的方向键、Enter、Esc（FlowCanvas）
 * 按它判断：画布工具条、检查器、大纲等盖在画布上的东西里，这些键归它们自己用（工具条里 ← → 在按钮之间移动）。
 */
export const onCanvasFocus = (target: EventTarget | null): boolean => {
	if (!(target instanceof Element)) return true;
	return (
		target === document.body ||
		target.hasAttribute("data-canvas-region") ||
		target.closest("[data-node-id]") !== null ||
		target.classList.contains("react-flow__pane")
	);
};

/**
 * 焦点在画布区域里、不在检查器和大纲这类面板（`aside`）里：画布本身、节点卡片、画布工具条、浮在画布上的工具条，
 * 或者页面上没有焦点。登记了 `canvasOnly` 的快捷键（删除节点、连线、注释框）按它判断：点完画布工具条的按钮接着按
 * Delete 照常删除选中的节点，但在检查器里点一下不是输入框的地方再按 Backspace 不能删掉画布上的节点（#461）；
 * 页头、侧边栏、弹出的菜单（在画布区域之外）里同样不触发。
 */
export const inCanvasArea = (target: EventTarget | null): boolean => {
	if (!(target instanceof Element)) return true;
	if (target === document.body) return true;
	return target.closest("[data-canvas-region]") !== null && target.closest("aside") === null;
};
