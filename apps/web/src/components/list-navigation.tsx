import { useShortcut } from "#/components/shortcuts";

/**
 * 列表页的行导航：J / K 在列表项之间移动真实的键盘焦点，焦点落在每一项的主链接上（Enter 走链接本来的行为），
 * 不保存状态，直接按页面上的 DOM 顺序找。使用方只要标记：
 *
 *   <article data-list-item>…<Link data-list-primary>…</Link>…</article>
 *
 * 列表页调用一次 `useListNavigation()`。当前项是包含焦点元素的那一项；焦点不在任何一项里时，J 去第一项、K 去最后一项，
 * 走到两端不循环。焦点环用全局的 `:focus-visible`；所在的行或卡片另加中性强调（与悬停相同），写在各自的类名里。
 */

const ITEMS = "#main [data-list-item]";
const PRIMARY = "[data-list-primary]";

const listItems = () => [...document.querySelectorAll<HTMLElement>(ITEMS)];

function focusItem(item: HTMLElement) {
	const primary = item.matches(PRIMARY) ? item : item.querySelector<HTMLElement>(PRIMARY);
	(primary ?? item).focus();
	item.scrollIntoView({ block: "nearest" });
}

/** 焦点移到第一项（搜索框按 ↓ 进入列表）；没有列表项时返回 false。 */
export function focusFirstListItem(): boolean {
	const [first] = listItems();
	if (first) focusItem(first);
	return first !== undefined;
}

function move(step: 1 | -1) {
	const items = listItems();
	const current = items.findIndex((item) => item.contains(document.activeElement));
	const next = current === -1 ? (step === 1 ? 0 : items.length - 1) : current + step;
	const target = items[next];
	if (target) focusItem(target);
}

export function useListNavigation() {
	useShortcut("list-next", () => move(1));
	useShortcut("list-prev", () => move(-1));
}
