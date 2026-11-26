import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** 离底部多近算「在底部」（像素）。 */
const AT_END = 24;

/**
 * 一块会增长的输出（命令跑着时的实时输出）里的滚动（#550）：人在底部时跟着滚到最新的一行，**往上翻看之后不再替他滚**（不抢滚动），
 * 这时有了新的输出 `behind` 为真，页面给一个「回到最新输出」，点了 `toEnd` 回到底部；人自己滚回底部时它消失。
 * `signal` 是描述内容的值（输出的长度）：变了才需要重新决定。第一次排好版就在底部。
 *
 * `ref` 是回调形式的 ref：输出的那一块可能晚一点才出现（先写「还没有输出」，之后才有），出现时才开始监听它的滚动。
 */
export function useFollowEnd<T extends HTMLElement>(signal: unknown) {
	const [element, ref] = useState<T | null>(null);
	const stuck = useRef(true);
	const seen = useRef(signal);
	/** 上次定位之后的 scrollTop：比它小，说明人已经往上翻了（滚动事件在下一帧才派发）。 */
	const lastTop = useRef(0);
	const [behind, setBehind] = useState(false);

	useEffect(() => {
		if (!element) return;
		const onScroll = () => {
			stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < AT_END;
			lastTop.current = element.scrollTop;
			if (stuck.current) setBehind(false);
		};
		element.addEventListener("scroll", onScroll, { passive: true });
		return () => element.removeEventListener("scroll", onScroll);
	}, [element]);

	useLayoutEffect(() => {
		if (!element) return;
		const changed = seen.current !== signal;
		seen.current = signal;
		// 滚动事件在下一帧才派发：人刚往上翻、事件还没到时，从位置上也看得出来。
		if (element.scrollTop < lastTop.current - 2) stuck.current = false;
		if (stuck.current) element.scrollTop = element.scrollHeight;
		else if (changed) setBehind(true);
		lastTop.current = element.scrollTop;
	}, [signal, element]);

	const toEnd = useCallback(() => {
		if (!element) return;
		stuck.current = true;
		element.scrollTop = element.scrollHeight;
		lastTop.current = element.scrollTop;
		setBehind(false);
	}, [element]);

	return { ref, behind, toEnd };
}
