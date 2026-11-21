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
 * 焦点在画布上：画布区域本身、节点卡片、画布空白处，或者页面上没有焦点（`body`）。检查器、大纲、工具条、菜单等
 * 盖在画布上的面板不算。画布自己的方向键、Enter、Esc（FlowCanvas）和登记了 `canvasOnly` 的快捷键（删除）都按它判断：
 * 焦点在别的面板里时，这些键不传给画布。
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
