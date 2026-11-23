/** 滚动容器的尺寸（`HTMLElement` 的子集）。 */
export interface ScrollBox {
	scrollTop: number;
	clientHeight: number;
	scrollHeight: number;
}

/** 容器下面还有没滚到的内容；`slack` 容许浏览器的亚像素误差。 */
export function hasMoreBelow({ scrollTop, clientHeight, scrollHeight }: ScrollBox, slack = 1) {
	return scrollTop + clientHeight < scrollHeight - slack;
}

/**
 * 下面还有内容时底边渐隐的类名（和 `trackMoreBelow` 配对用；Tailwind 只认源码里完整写出的类名，所以写在这里）：
 * 最后 2rem 渐隐。用方向键选中的项要滚到渐隐区上面，滚动容器加 `scroll-pb-9`（比渐隐区高 4px）。
 */
export const MORE_BELOW_FADE =
	"data-[more-below]:[mask-image:linear-gradient(to_bottom,#000_calc(100%-2rem),transparent)]";

/**
 * 滚动容器的 ref 回调：下面还有内容时给它加 `data-more-below`，样式用它在底边画渐隐（提示还能往下滚，
 * 滚动位置正好切在某一行中间时，那一行渐隐而不是被生硬地截断）。直接改属性、不经过 React 状态：滚动时不重新渲染。
 * 容器或它的第一个子元素（内容的包装层，cmdk 的列表就是这样）变大变小时重新量：筛选结果变化、数据晚到。
 * 清理函数由 React 在元素卸载时调用；回调是模块级的，不会随渲染重新挂。
 */
export function trackMoreBelow(element: HTMLElement | null): (() => void) | undefined {
	if (!element) return undefined;
	const update = () => element.toggleAttribute("data-more-below", hasMoreBelow(element));
	update();
	element.addEventListener("scroll", update, { passive: true });
	const observer = new ResizeObserver(update);
	observer.observe(element);
	if (element.firstElementChild) observer.observe(element.firstElementChild);
	return () => {
		element.removeEventListener("scroll", update);
		observer.disconnect();
	};
}
