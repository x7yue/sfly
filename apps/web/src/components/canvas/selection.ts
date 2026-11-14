/**
 * 画布上选中了什么（单测见 selection.test.ts）：什么都没选、一组节点，或者一个注释框（#278）。
 * 节点和注释框不会同时选中；一组节点至少有一个，ID 不重复，按选中的先后排列。
 *
 * 画布现在只能单选，一组里只有一个节点，注释框也还没有；框选、加选（#309）和注释框（#310）用的是同一个形状。
 */
export type CanvasSelection =
	| { readonly kind: "none" }
	| { readonly kind: "nodes"; readonly ids: readonly [string, ...string[]] }
	| { readonly kind: "annotation"; readonly id: string };

export const NO_SELECTION: CanvasSelection = { kind: "none" };

export const selectNode = (id: string): CanvasSelection => ({ kind: "nodes", ids: [id] });

export const isNodeSelected = (selection: CanvasSelection, id: string): boolean =>
	selection.kind === "nodes" && selection.ids.includes(id);

/** 恰好选中一个节点时是它，否则是 null：检查器显示的、复制和创建副本作用的、方向键从它出发的节点。 */
export const soleNode = (selection: CanvasSelection): string | null =>
	selection.kind === "nodes" && selection.ids.length === 1 ? selection.ids[0] : null;

/**
 * 只留下 `keep` 认可的节点（删掉的节点、画布上没有的节点不再算选中），一个都不剩时什么都没选。
 * 节点都留下时返回原来的对象：画布按选中状态给节点标记选中，对象不变就不用重画节点。
 */
export function keepNodes(
	selection: CanvasSelection,
	keep: (id: string) => boolean,
): CanvasSelection {
	if (selection.kind !== "nodes" || selection.ids.every(keep)) return selection;
	const [first, ...rest] = selection.ids.filter(keep);
	return first === undefined ? NO_SELECTION : { kind: "nodes", ids: [first, ...rest] };
}
