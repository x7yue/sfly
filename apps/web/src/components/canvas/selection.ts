/**
 * 画布上选中了什么（单测见 selection.test.ts）：什么都没选、一组节点，或者一个注释框（#278）。
 * 它们不会同时选中；一组节点至少有一个，ID 不重复，按选中的先后排列。
 *
 * 一组节点来自框选、Ctrl/⌘ 加选和点子流程区域的标题（#309）；注释框来自点它的标题带、新建（#310）。
 */
export type CanvasSelection =
	| { readonly kind: "none" }
	| { readonly kind: "nodes"; readonly ids: readonly [string, ...string[]] }
	| { readonly kind: "annotation"; readonly id: string };

export const NO_SELECTION: CanvasSelection = { kind: "none" };

export const selectNode = (id: string): CanvasSelection => ({ kind: "nodes", ids: [id] });

export const selectAnnotation = (id: string): CanvasSelection => ({ kind: "annotation", id });

/** 选中的注释框（没有选中注释框时是 null）。 */
export const selectedAnnotation = (selection: CanvasSelection): string | null =>
	selection.kind === "annotation" ? selection.id : null;

/** 选中一组节点：重复的 ID 只留第一次出现的那个，一个都没有时什么都没选。 */
export function selectNodes(ids: Iterable<string>): CanvasSelection {
	const [first, ...rest] = new Set(ids);
	return first === undefined ? NO_SELECTION : { kind: "nodes", ids: [first, ...rest] };
}

export const isNodeSelected = (selection: CanvasSelection, id: string): boolean =>
	selection.kind === "nodes" && selection.ids.includes(id);

/** 恰好选中一个节点时是它，否则是 null：检查器显示的、复制和创建副本作用的节点。 */
export const soleNode = (selection: CanvasSelection): string | null =>
	selection.kind === "nodes" && selection.ids.length === 1 ? selection.ids[0] : null;

/** 选中了不止一个节点时是这组节点，否则是 null：检查器显示「已选 N 个节点」。 */
export const multipleNodes = (selection: CanvasSelection): readonly string[] | null =>
	selection.kind === "nodes" && selection.ids.length > 1 ? selection.ids : null;

/**
 * 多选收成单选：只留最近选中的那个节点（方向键从它出发；只读的画布不能多选，只显示它）。
 * 其余情况原样返回同一个对象。
 */
export function latestNode(selection: CanvasSelection): CanvasSelection {
	if (selection.kind !== "nodes" || selection.ids.length === 1) return selection;
	return selectNode(selection.ids[selection.ids.length - 1] as string);
}

/** Ctrl/⌘ + 点击：没选中的节点加到这组的最后，选中了的去掉；选中的是注释框时换成只选这个节点。 */
export function toggleNode(selection: CanvasSelection, id: string): CanvasSelection {
	if (selection.kind !== "nodes") return selectNode(id);
	return selection.ids.includes(id)
		? selectNodes(selection.ids.filter((n) => n !== id))
		: selectNodes([...selection.ids, id]);
}

/**
 * 框选过程中画布逐步报告的变化（节点 `id` 变成选中或不选中）：新选中的排到最后，取消的去掉。
 * 框选一开始 React Flow 就把原来选中的节点都报告为取消选中，所以框选的结果是替换原来的选中，不是加进去。
 * 选中的是注释框时从空的一组开始。
 */
export function withSelectChanges(
	selection: CanvasSelection,
	changes: readonly { id: string; selected: boolean }[],
): CanvasSelection {
	const ids = new Set(selection.kind === "nodes" ? selection.ids : []);
	for (const change of changes) {
		if (change.selected) ids.add(change.id);
		else ids.delete(change.id);
	}
	return selectNodes(ids);
}

/**
 * 只留下 `keep` 认可的节点（删掉的节点、画布上没有的节点不再算选中），一个都不剩时什么都没选。
 * 节点都留下时返回原来的对象：画布按选中状态给节点标记选中，对象不变就不用重画节点。
 */
export function keepNodes(
	selection: CanvasSelection,
	keep: (id: string) => boolean,
): CanvasSelection {
	if (selection.kind !== "nodes" || selection.ids.every(keep)) return selection;
	return selectNodes(selection.ids.filter(keep));
}

/** 选中的注释框不在了（撤销了新建、删掉了）时什么都没选；其余情况返回原来的对象。 */
export function keepAnnotation(
	selection: CanvasSelection,
	exists: (id: string) => boolean,
): CanvasSelection {
	return selection.kind === "annotation" && !exists(selection.id) ? NO_SELECTION : selection;
}
