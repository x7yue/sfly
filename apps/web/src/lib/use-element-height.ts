import { useLayoutEffect, useState } from "react";

/**
 * 元素的高度（px，`clientHeight`）：返回 `[ref 回调, 高度]`，把回调挂到要量的元素上。元素出现时量一次，之后随尺寸变化更新，
 * 在绘制之前就拿到；元素还没出现（或不渲染）时为 0。和 `useElementWidth` 对应。
 */
export function useElementHeight<E extends HTMLElement>(): readonly [
	(el: E | null) => void,
	number,
] {
	const [element, setElement] = useState<E | null>(null);
	const [height, setHeight] = useState(0);
	useLayoutEffect(() => {
		if (!element) {
			setHeight(0);
			return;
		}
		setHeight(Math.round(element.clientHeight));
		const observer = new ResizeObserver(() => setHeight(Math.round(element.clientHeight)));
		observer.observe(element);
		return () => observer.disconnect();
	}, [element]);
	return [setElement, height];
}
