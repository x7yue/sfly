import { type RefObject, useLayoutEffect, useState } from "react";

/** 顶栏上量出来的几个数（px），见 {@link measureChainsFit}。 */
export interface ChainsMeasure {
	/** 各链状态现在显示着，但内容比它的框宽（被裁掉了）：别的内容把它挤得放不下。 */
	clipped: boolean;
	/** 各链状态不显示时，失败摘要在它的最窄宽度之上多出来的宽度加上空白占位的宽度：各链状态能拿到的宽度。 */
	extra: number;
	/** 各链状态排成一行要的宽度。 */
	natural: number;
	/** 顶栏里相邻两项的间距（各链状态一显示，就多出一个间距）。 */
	gap: number;
}

/**
 * 顶栏写着失败摘要时，各链状态放不放得下：摘要始终有它的最窄宽度，各链状态只用剩下的。放得下才显示，放不下整个收起
 * （不裁掉半个徽标）。显示着的时候看有没有被裁；收起着的时候看摘要让出来的宽度够不够它排成一行：两个方向用的是同一个界限
 * （`extra >= natural + gap` 和 `clipped` 互为反面），所以显示和收起之间不会来回跳。
 */
export function chainsFitNext(fits: boolean, m: ChainsMeasure): boolean {
	return fits ? !m.clipped : m.extra >= m.natural + m.gap;
}

/** 从顶栏的元素量出 {@link ChainsMeasure}；顶栏里没有这几样（失败摘要没显示）时返回 null。 */
export function measureChainsFit(bar: HTMLElement): ChainsMeasure | null {
	const summary = bar.querySelector<HTMLElement>("[data-fit-summary]");
	const chains = bar.querySelector<HTMLElement>("[data-fit-chains]");
	const spacer = bar.querySelector<HTMLElement>("[data-fit-spacer]");
	if (!summary || !chains || !spacer) return null;
	const summaryMin = Number.parseFloat(getComputedStyle(summary).minWidth) || 0;
	return {
		clipped: chains.scrollWidth - chains.clientWidth > 0.5,
		extra: summary.clientWidth - summaryMin + spacer.clientWidth,
		natural: chains.scrollWidth,
		gap: Number.parseFloat(getComputedStyle(bar).columnGap) || 0,
	};
}

/**
 * 顶栏的各链状态放不放得下失败摘要旁边（`active`：顶栏写着失败摘要，只有这时要让位）。顶栏的尺寸变了、链变了
 * （`signature`）都重新量，在绘制之前就定下来，不会先画一帧再收起。收起的各链状态仍在页面里（宽度 0、不可见），
 * 所以随时量得到它排成一行要多宽。
 */
export function useChainsFit(
	bar: RefObject<HTMLElement | null>,
	active: boolean,
	signature: string,
): boolean {
	const [fits, setFits] = useState(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: signature 只是让链变了的时候重新量。
	useLayoutEffect(() => {
		const el = bar.current;
		if (!el || !active) return;
		const check = () => {
			const m = measureChainsFit(el);
			if (m) setFits((was) => chainsFitNext(was, m));
		};
		check();
		const observer = new ResizeObserver(check);
		observer.observe(el);
		return () => observer.disconnect();
	}, [bar, active, signature]);
	return active ? fits : true;
}
