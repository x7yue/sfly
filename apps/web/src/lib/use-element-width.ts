import { useLayoutEffect, useState } from "react";

/**
 * 元素的宽度（px，`clientWidth`：含内边距，不含边框和滚动条）：返回 `[ref 回调, 宽度]`，把回调挂到要量的元素上。元素出现时量一次，之后随尺寸变化更新，
 * 在绘制之前就拿到，不会先按错的宽度画一帧；元素还没出现（或不渲染）时为 0。
 */
export function useElementWidth<E extends HTMLElement>(): readonly [
	(el: E | null) => void,
	number,
] {
	const [element, setElement] = useState<E | null>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		if (!element) return;
		setWidth(Math.round(element.clientWidth));
		const observer = new ResizeObserver(() => setWidth(Math.round(element.clientWidth)));
		observer.observe(element);
		return () => observer.disconnect();
	}, [element]);
	return [setElement, width];
}
