import type { FocusItemView } from "@sfly/schema";

/**
 * 场景检查器「关注项」页上对列表的修改（排序、改名）：都是纯函数，结果交给 `useFocusItems().replace` 整份写回。
 */

/** 把第 `from` 项挪到第 `to` 位（挪完以后的下标，从 0 数）。 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
	const next = [...list];
	const [item] = next.splice(from, 1);
	if (item !== undefined) next.splice(to, 0, item);
	return next;
}

/**
 * 拖动时的落点是两项之间的空位（`slot`：第 `slot` 项的前面，`slot` 等于项数时是末尾）；
 * 返回把第 `from` 项放到那里以后它的下标。
 */
export const indexAfterDrop = (from: number, slot: number): number =>
	slot > from ? slot - 1 : slot;

/**
 * 给关注项起名：去掉首尾空白，清空或者写成图表标题就是没起名（显示时用图表标题）。
 * 这是控制面也认的规则（空白当作没起名），这里先做掉，列表上看到的就是写入的。其余（状态、图表类型）不变。
 */
export function renamedItem(item: FocusItemView, typed: string): FocusItemView {
	const { title: _was, ...untitled } = item;
	const name = typed.trim();
	return name === "" || name === item.chart ? untitled : { ...untitled, title: name };
}
