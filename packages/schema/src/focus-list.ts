import type { FocusItemInput } from "./http/orchestrations.js";

/**
 * 关注项列表上的纯规则（GLOSSARY「关注项」）：控制面写入时比较新旧列表，
 * web 的「关注项」页显示名字、比较列表，用的是这里的同一份。请求里的项和场景视图里的项（带状态）都能用。
 */

type FocusRef = Pick<FocusItemInput, "node_id" | "chart">;
type NamedFocusRef = FocusRef & Pick<FocusItemInput, "title">;

/** 一个关注项的身份：来源节点和图表标题。名字（`title`）不是身份，改名还是同一项。 */
export const focusKey = (item: FocusRef): string => JSON.stringify([item.node_id, item.chart]);

/** 显示用的名字：场景作者起的名字，没起名时是图表标题。 */
export const focusName = (item: NamedFocusRef): string => item.title ?? item.chart;

/** 两份列表是否完全一样：同样的项、同样的名字、同样的顺序。 */
export const sameFocusList = (a: readonly NamedFocusRef[], b: readonly NamedFocusRef[]): boolean =>
	a.length === b.length &&
	a.every((item, i) => {
		const other = b[i] as NamedFocusRef;
		return focusKey(item) === focusKey(other) && item.title === other.title;
	});
