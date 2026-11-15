import { FOCUS_ITEMS_MAX, type FocusItemInput } from "@sfly/schema";

/**
 * 关注项的列表（GLOSSARY「关注项」）：有序、按 `(node_id, chart)` 唯一、最多 {@link FOCUS_ITEMS_MAX} 项。
 * 这里只有不碰数据库的规则：写入前对列表自身的检查，以及「改了什么」的说明。
 */
export type FocusItem = FocusItemInput;

type FocusRef = Pick<FocusItem, "node_id" | "chart">;

/** 一个关注项的身份：来源节点和图表标题。名字（`title`）不是身份，改名还是同一项。 */
export const focusKey = (item: FocusRef): string => JSON.stringify([item.node_id, item.chart]);

/** 显示用的名字：场景作者起的名字，没起名时是图表标题。 */
export const focusName = (item: FocusItem): string => item.title ?? item.chart;

/** 写入被拒绝的原因，`code` 就是 400 响应的错误码。 */
export type FocusRejection =
	| { code: "focus_items_limit"; message: string; details: { limit: number; count: number } }
	| { code: "focus_item_duplicate"; message: string; details: FocusRef[] }
	| { code: "focus_item_unknown_chart"; message: string; details: FocusRef[] };

/** 列表自身的检查：不超过 {@link FOCUS_ITEMS_MAX} 项（失效的项也算），没有重复的 `(node_id, chart)`。 */
export function checkFocusList(items: readonly FocusItem[]): FocusRejection | undefined {
	if (items.length > FOCUS_ITEMS_MAX) {
		return {
			code: "focus_items_limit",
			message: `关注项最多 ${FOCUS_ITEMS_MAX} 个（已经失效的也算），这次提交了 ${items.length} 个：先去掉几个再提交`,
			details: { limit: FOCUS_ITEMS_MAX, count: items.length },
		};
	}
	const seen = new Set<string>();
	for (const { node_id, chart } of items) {
		const key = focusKey({ node_id, chart });
		if (seen.has(key)) {
			return {
				code: "focus_item_duplicate",
				message: `关注项里节点 ${node_id} 的图表「${chart}」出现了不止一次`,
				details: [{ node_id, chart }],
			};
		}
		seen.add(key);
	}
	return undefined;
}

/** 两份列表是否完全一样：同样的项、同样的名字、同样的顺序。 */
export const sameFocusList = (a: readonly FocusItem[], b: readonly FocusItem[]): boolean =>
	a.length === b.length &&
	a.every((item, i) => {
		const other = b[i] as FocusItem;
		return focusKey(item) === focusKey(other) && item.title === other.title;
	});

/** 两份列表之间的差别：加了哪些项、去掉哪些项、公共的项顺序变没变、哪些项改了名。 */
interface FocusDiff {
	added: FocusItem[];
	removed: FocusItem[];
	/** 公共的项顺序变了：恰好挪动一项时是那一项，否则是 `several`；没变时为 null。 */
	moved: FocusItem | "several" | null;
	renamed: Array<{ was: FocusItem; now: FocusItem }>;
}

const sameKeys = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((key, i) => key === b[i]);

function diffFocus(before: readonly FocusItem[], after: readonly FocusItem[]): FocusDiff {
	const was = new Map(before.map((item) => [focusKey(item), item]));
	const now = new Map(after.map((item) => [focusKey(item), item]));
	const keptBefore = before.map(focusKey).filter((key) => now.has(key));
	const keptAfter = after.map(focusKey).filter((key) => was.has(key));
	return {
		added: after.filter((item) => !was.has(focusKey(item))),
		removed: before.filter((item) => !now.has(focusKey(item))),
		moved: sameKeys(keptBefore, keptAfter) ? null : movedItem(keptBefore, keptAfter, now),
		renamed: after.flatMap((item) => {
			const old = was.get(focusKey(item));
			return old !== undefined && old.title !== item.title ? [{ was: old, now: item }] : [];
		}),
	};
}

/**
 * 公共的项顺序变了：只挪动一项就能从旧顺序得到新顺序时返回它，否则返回 `several`。
 * 相邻两项互换时两项都符合，取往前挪的那一项（「把 B 移到第 1 位」）。
 */
function movedItem(
	keptBefore: readonly string[],
	keptAfter: readonly string[],
	now: ReadonlyMap<string, FocusItem>,
): FocusItem | "several" {
	const without = (keys: readonly string[], key: string) => keys.filter((k) => k !== key);
	const candidates = keptAfter.filter((key) =>
		sameKeys(without(keptBefore, key), without(keptAfter, key)),
	);
	const key = candidates.find((k) => keptAfter.indexOf(k) < keptBefore.indexOf(k)) ?? candidates[0];
	return (key && now.get(key)) || "several";
}

/** 最多逐个写出名字的项数，再多就只写数量。 */
const NAMED_AT_MOST = 2;

/** 紧跟在动词后面：「「A」、「B」」，项数多时是「 3 项」（数字和汉字之间留一个空格）。 */
const namesOf = (items: readonly FocusItem[]): string =>
	items.length <= NAMED_AT_MOST
		? items.map((item) => `「${focusName(item)}」`).join("、")
		: ` ${items.length} 项`;

/**
 * 一句话说明从 `before` 改成 `after` 改了什么（用户故事 9：「把「下单延迟」移到第 6 位」）：
 * 添加、移除、移动、改名，几处一起改时用分号连起来。
 */
export function describeFocusChange(
	before: readonly FocusItem[],
	after: readonly FocusItem[],
): string {
	const { added, removed, moved, renamed } = diffFocus(before, after);
	const parts: string[] = [];
	if (added.length > 0) parts.push(`添加了${namesOf(added)}`);
	if (removed.length > 0) parts.push(`移除了${namesOf(removed)}`);
	if (moved === "several") parts.push("调整了顺序");
	else if (moved) parts.push(`把「${focusName(moved)}」移到第 ${after.indexOf(moved) + 1} 位`);
	if (renamed.length === 1) {
		const [{ was, now }] = renamed as [(typeof renamed)[number]];
		parts.push(`把「${focusName(was)}」改名为「${focusName(now)}」`);
	} else if (renamed.length > 1) {
		parts.push(`给 ${renamed.length} 项改了名称`);
	}
	return parts.join("；");
}

/**
 * 一句话说明从 `current` 改成 `after` 是撤销了上一次修改（`after` 就是上一次修改之前的列表）：
 * 撤销的是添加、移除、移动或改名时写明，说不清是哪一种就写「撤销了上一次修改」。
 */
export function describeFocusUndo(
	current: readonly FocusItem[],
	after: readonly FocusItem[],
): string {
	const { added, removed, moved, renamed } = diffFocus(current, after);
	const what: string[] = [];
	if (added.length > 0) what.push(`移除${namesOf(added)}`);
	if (removed.length > 0) what.push(`添加${namesOf(removed)}`);
	if (moved === "several") what.push("顺序的调整");
	else if (moved) what.push(`「${focusName(moved)}」的移动`);
	if (renamed.length === 1)
		what.push(`「${focusName((renamed[0] as { now: FocusItem }).now)}」的改名`);
	else if (renamed.length > 1) what.push(`${renamed.length} 项的改名`);
	return `撤销了${what.length === 1 ? what[0] : "上一次修改"}`;
}
