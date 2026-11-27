import { type RefObject, useCallback, useEffect, useRef } from "react";

/** 把一组对准到图表工作区里看得见的地方：上沿在吸顶的工具栏下面，第一张图表露出大半。已经看得见时不动。 */
function revealGroup(box: HTMLElement, el: HTMLElement, toolbarHeight: number): void {
	const top = el.offsetTop - toolbarHeight - 8;
	// 组标题和节点摘要在图表上面，只露出它们看不到曲线；图表还没有渲染出来时（组刚展开）只要求露出组标题那一截。
	const chart = el.querySelector<HTMLElement>("[data-chart]");
	const boxTop = box.getBoundingClientRect().top;
	const needed = chart
		? chart.getBoundingClientRect().top - boxTop + box.scrollTop + chart.offsetHeight * 0.75
		: el.offsetTop + 40;
	const visible = top >= box.scrollTop && needed <= box.scrollTop + box.clientHeight;
	if (!visible) box.scrollTop = Math.max(0, top);
}

/**
 * 图表工作区里要看的那一组（选中节点、打开页面时第一个执行中或失败的组）：`reveal(key)` 对准一次，之后保持「对准中」，
 * 工作区或内容的大小每变一次（底部面板换页签、日志页签收起、图表读到了）就再对一次，直到用户自己滚动工作区
 * （滚轮、按住、按键）（#383，同时间线的跟随定位，#359）。返回要挂在工作区上的事件处理。
 */
export function useRevealGroup({
	scroller,
	content,
	toolbar,
}: {
	scroller: RefObject<HTMLElement | null>;
	content: RefObject<HTMLElement | null>;
	toolbar: RefObject<HTMLElement | null>;
}) {
	const target = useRef<string | null>(null);
	const align = useCallback(() => {
		const box = scroller.current;
		const key = target.current;
		const el = key ? box?.querySelector<HTMLElement>(`[data-group="${CSS.escape(key)}"]`) : null;
		if (box && el) revealGroup(box, el, toolbar.current?.offsetHeight ?? 0);
	}, [scroller, toolbar]);

	useEffect(() => {
		const observer = new ResizeObserver(align);
		for (const el of [scroller.current, content.current]) if (el) observer.observe(el);
		return () => observer.disconnect();
	}, [scroller, content, align]);

	const reveal = useCallback(
		(key: string) => {
			target.current = key;
			align();
		},
		[align],
	);
	const stop = () => {
		target.current = null;
	};
	return {
		reveal,
		/** 换了筛选等回到顶部时不再对准。 */
		stop,
		userScroll: { onWheel: stop, onPointerDown: stop, onKeyDown: stop, onTouchStart: stop },
	};
}
