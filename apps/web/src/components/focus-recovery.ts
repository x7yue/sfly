import { useEffect } from "react";

/**
 * 焦点所在的元素被移走时（归档、恢复、删除了它所在的列表项，空状态被列表替换），焦点不留在 body 上：
 *
 * - 它自己带着 `data-focus-successor`（一个 CSS 选择器）：交给选择器选中的元素。**选中的元素必须能获得焦点**（输入框、按钮、
 *   链接，或带 `tabindex` 的元素）；选不到、或选到了却聚焦不上（被禁用、被隐藏）时退回下面的规则。点了就会消失的按钮用它
 *   （会话页的「停止」：这一轮结束后焦点交给输入框，不交给标题）；
 * - 它在列表项（`data-list-item`，见 list-navigation）里：交给下一项的主链接，没有下一项交给上一项；
 * - 列表空了，或它不在列表项里：交给页面标题（`PageHeader` 的 h1）。
 *
 * 只管外壳页的主区域（`#main`）；全屏页（画布、运行监控）自己管焦点。弹窗、菜单关闭时焦点回到打开它的元素，
 * 那个元素随后被移走也照这个规则处理（归档确认的「更多」按钮随卡片一起消失）。根路由挂载一次（GlobalOverlays）。
 * 用户自己点空白处让焦点离开时不处理。
 */
const ITEM = "[data-list-item]";
const PRIMARY = "[data-list-primary]";

interface Focused {
	element: HTMLElement;
	/** 获得焦点时页面上的列表项（DOM 顺序）与它所在的那一项的位置；不在列表项里时 index 为 -1。 */
	items: HTMLElement[];
	index: number;
}

function snapshot(element: HTMLElement, main: HTMLElement): Focused {
	const items = [...main.querySelectorAll<HTMLElement>(ITEM)];
	const item = element.closest<HTMLElement>(ITEM);
	return { element, items, index: item ? items.indexOf(item) : -1 };
}

/** 焦点的去向，按优先顺序：声明的接班元素、相邻的列表项、页面标题。 */
function* recoveryTargets({ element, items, index }: Focused): Generator<HTMLElement> {
	const successor = element.dataset.focusSuccessor;
	if (successor) {
		const target = document.querySelector<HTMLElement>(successor);
		if (target) yield target;
	}
	if (index !== -1) {
		const next = items.slice(index + 1).find((item) => item.isConnected);
		const previous = items
			.slice(0, index)
			.reverse()
			.find((item) => item.isConnected);
		const item = next ?? previous;
		if (item)
			yield item.matches(PRIMARY) ? item : (item.querySelector<HTMLElement>(PRIMARY) ?? item);
	}
	const heading = document.querySelector<HTMLElement>("#main h1");
	if (heading) yield heading;
}

/** 按顺序试，第一个真的拿到了焦点的为止（聚焦不上的元素 `focus()` 什么也不做）。 */
export function focusFirst(targets: Iterable<HTMLElement>): HTMLElement | null {
	for (const target of targets) {
		target.focus();
		if (document.activeElement === target) return target;
	}
	return null;
}

export function useFocusRecovery() {
	useEffect(() => {
		let last: Focused | null = null;
		const onFocusIn = (event: FocusEvent) => {
			const main = document.getElementById("main");
			if (event.target instanceof HTMLElement && main?.contains(event.target)) {
				last = snapshot(event.target, main);
			}
		};
		const onFocusOut = (event: FocusEvent) => {
			const element = event.target;
			if (!(element instanceof HTMLElement) || event.relatedTarget !== null) return;
			if (element !== last?.element) return;
			// 焦点去了 body 而元素还在：用户点了空白处，不是元素被移走。
			queueMicrotask(() => {
				if (element.isConnected && document.activeElement === document.body) last = null;
			});
		};
		const observer = new MutationObserver(() => {
			if (!last || last.element.isConnected || document.activeElement !== document.body) return;
			const targets = recoveryTargets(last);
			last = null;
			focusFirst(targets);
		});
		document.addEventListener("focusin", onFocusIn);
		document.addEventListener("focusout", onFocusOut);
		observer.observe(document.body, { childList: true, subtree: true });
		return () => {
			document.removeEventListener("focusin", onFocusIn);
			document.removeEventListener("focusout", onFocusOut);
			observer.disconnect();
		};
	}, []);
}
