import { type RefObject, useEffect, useState } from "react";

/**
 * 元素外层（`selector` 选中的最近的祖先）有没有键盘焦点：`:focus-visible`，鼠标点选时不算。
 * 画布上的节点卡片不在 Tab 顺序里（方向键切换），卡片里的徽标、图标本身不可聚焦，
 * 要给键盘用户看的提示就跟着卡片的键盘焦点出现。`selector` 为 undefined 时恒为 false。
 */
export function useHostKeyboardFocus(
	anchor: RefObject<Element | null>,
	selector: string | undefined,
): boolean {
	const [focused, setFocused] = useState(false);
	useEffect(() => {
		const host = selector ? anchor.current?.closest<HTMLElement>(selector) : null;
		if (!host) return;
		const onFocus = () => setFocused(host.matches(":focus-visible"));
		const onBlur = () => setFocused(false);
		onFocus();
		host.addEventListener("focus", onFocus);
		host.addEventListener("blur", onBlur);
		return () => {
			host.removeEventListener("focus", onFocus);
			host.removeEventListener("blur", onBlur);
		};
	}, [anchor, selector]);
	return focused;
}
