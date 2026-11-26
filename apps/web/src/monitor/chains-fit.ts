import { type RefObject, useLayoutEffect, useState } from "react";

/** 顶栏上量出来的几个数（px），见 {@link measureChainsFit}。 */
export interface ChainsMeasure {
	/** 各链状态现在显示着，但内容比它的框宽（被裁掉了）：别的内容把它挤得放不下。 */
	clipped: boolean;
	/** 失败摘要的全文比它现在的框宽多出来的宽度（被截成省略号的那一截）；全文放得下是 0。 */
	short: number;
	/** 空白占位的宽度：失败摘要放下全文之后剩下的宽度（各链状态不显示时才是各链状态能拿到的）。 */
	spare: number;
	/** 各链状态排成一行要的宽度。 */
	natural: number;
	/** 顶栏里相邻两项的间距（各链状态一显示，就多出一个间距）。 */
	gap: number;
}

/**
 * 顶栏写着失败摘要时，各链状态放不放得下：失败的原因比各链的徽标要紧，所以失败摘要放得下全文（不被截成省略号）、
 * 各链状态也排得下一行才一起显示；放不下整个收起（不裁掉半个徽标，摘要单独也放不下时各链状态一定是收起的）。
 * 显示着的时候看各链状态有没有被裁、摘要有没有被截；收起着的时候看摘要放下全文之后剩的宽度够不够各链状态排成一行：
 * 两个方向用的是同一个界限（摘要全文加各链状态加一个间距放得下），所以显示和收起之间不会来回跳。
 */
export function chainsFitNext(fits: boolean, m: ChainsMeasure): boolean {
	return fits ? !m.clipped && m.short === 0 : m.spare - m.short >= m.natural + m.gap;
}

/** 摘要全文宽出它的框不到这么多（px）就不算被截：布局的取整不该让显示和收起来回跳。 */
const TRUNCATION_EPSILON = 0.1;

/** 失败摘要全文要多宽（含它自己的内边距）：用文字范围量，不受它自己的溢出裁剪影响。 */
function summaryFullWidth(summary: HTMLElement): number {
	const range = document.createRange();
	range.selectNodeContents(summary);
	const style = getComputedStyle(summary);
	return (
		range.getBoundingClientRect().width +
		(Number.parseFloat(style.paddingLeft) || 0) +
		(Number.parseFloat(style.paddingRight) || 0)
	);
}

/** 从顶栏的元素量出 {@link ChainsMeasure}；顶栏里没有这几样（失败摘要没显示）时返回 null。 */
export function measureChainsFit(bar: HTMLElement): ChainsMeasure | null {
	const summary = bar.querySelector<HTMLElement>("[data-fit-summary]");
	const chains = bar.querySelector<HTMLElement>("[data-fit-chains]");
	const spacer = bar.querySelector<HTMLElement>("[data-fit-spacer]");
	if (!summary || !chains || !spacer) return null;
	const cut = summaryFullWidth(summary) - summary.getBoundingClientRect().width;
	return {
		clipped: chains.scrollWidth - chains.clientWidth > 0.5,
		short: cut > TRUNCATION_EPSILON ? cut : 0,
		spare: spacer.getBoundingClientRect().width,
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
