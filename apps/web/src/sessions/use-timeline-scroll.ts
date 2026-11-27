import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** 离底部多近算「在底部」（像素）：差一两行也算，免得读完最后一行再被拉一下。 */
const AT_BOTTOM = 48;

/** 时间线里每一行都带着这个属性（值是行的 key）：往前翻页时靠它认出「刚才看着的那一行」。 */
export const ROW_KEY_ATTRIBUTE = "data-row-key";

/**
 * 人刚往上翻、滚动事件还没到：位置比上次定位时小（小于 2 像素的差当作抖动），就不再跟随。滚动事件在下一帧才派发，
 * 事件还没到时 `stuck` 仍是真，内容变高时只能从位置上看出人已经走了。**每一处「内容变了、要不要滚到底」都要先过这一道**
 * （复审 #762 第三轮：`follow` 少了它，人刚往上翻就被拉回去）。
 */
export function releaseIfScrolledUp(
	el: { scrollTop: number },
	lastTop: { current: number },
	stuck: { current: boolean },
): void {
	if (el.scrollTop < lastTop.current - 2) stuck.current = false;
}

/** 跟随：先看人是不是刚往上翻了，还在底部的才滚到最底并记下位置。 */
export function followToEnd(
	el: { scrollTop: number; scrollHeight: number },
	lastTop: { current: number },
	stuck: { current: boolean },
): void {
	releaseIfScrolledUp(el, lastTop, stuck);
	if (!stuck.current) return;
	el.scrollTop = el.scrollHeight;
	lastTop.current = el.scrollTop;
}

/** 一行相对滚动容器顶端的位置（滚动容器是定位元素，`offsetTop` 就是相对它的）。 */
interface Anchor {
	key: string;
	/** 这一行的上沿离可视区上沿多远（可以是负的：这一行只露出了下半截）。 */
	offset: number;
}

/**
 * 会话时间线的滚动（#550）：
 *
 * - **进入页面滚到最新**：一开始就是「跟随」状态，第一次排好版就滚到底。
 * - **跟随**：人在底部（或离底部不到几十像素）时，新内容出来（一条新的、逐字出现的话变长、命令的输出变长）就滚到最底；
 *   人往上翻看之后**不再替他滚**，页面不把他拉回去。
 * - **「有新内容」**：人在往上看、而底下有了新内容：不跳走，`hasNew` 为真，页面显示一个按钮，点了 `scrollToBottom` 回到底部；
 *   人自己滚回底部时它也消失。
 * - **往前翻页保持位置**（`captureAnchor` 在点「加载更早的」的那一刻量一次，之后每次滚动也量）：更早的一页放到最前面时（`head` 变了），把刚才看着的那一行放回原来的位置，页面上的东西纹丝不动。
 *   浏览器自己的滚动锚定在滚动位置是 0（正好在最顶，点「加载更早的」时就是这样）时不起作用，所以自己量、自己放回。
 *
 * `head` 是最前面一行的 key，`tail` 是描述最后一行状态的字符串（新来一行、最后一行变长了它都会变）。
 */
export function useTimelineScroll({ head, tail }: { head: string | null; tail: string }) {
	const scroller = useRef<HTMLDivElement>(null);
	const stuck = useRef(true);
	const anchor = useRef<Anchor | null>(null);
	const previous = useRef({ head, tail });
	/** 上次定位之后滚动区域的 scrollTop：比它小，说明人已经往上翻了（滚动事件在下一帧才派发）。 */
	const lastTop = useRef(0);
	const [hasNew, setHasNew] = useState(false);

	/** 记下此刻最靠上的、有一部分在可视区里的那一行。行是按顺序排的，二分查找。 */
	const measureAnchor = useCallback(() => {
		const el = scroller.current;
		if (!el) return;
		const rows = el.querySelectorAll<HTMLElement>(`[${ROW_KEY_ATTRIBUTE}]`);
		let low = 0;
		let high = rows.length - 1;
		let found: HTMLElement | null = null;
		while (low <= high) {
			const middle = (low + high) >> 1;
			const row = rows[middle] as HTMLElement;
			if (row.offsetTop + row.offsetHeight > el.scrollTop) {
				found = row;
				high = middle - 1;
			} else {
				low = middle + 1;
			}
		}
		const key = found?.getAttribute(ROW_KEY_ATTRIBUTE);
		anchor.current = found && key ? { key, offset: found.offsetTop - el.scrollTop } : null;
	}, []);

	// 人滚动：是不是在底部决定要不要跟随；一帧最多量一次锚点。
	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		let frame = 0;
		const onScroll = () => {
			stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM;
			lastTop.current = el.scrollTop;
			if (stuck.current) setHasNew(false);
			if (frame === 0) {
				frame = requestAnimationFrame(() => {
					frame = 0;
					measureAnchor();
				});
			}
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			el.removeEventListener("scroll", onScroll);
			cancelAnimationFrame(frame);
		};
	}, [measureAnchor]);

	// 滚动区域自己的高度变了（窗口变矮；窄窗口里「成果」收在下面，它的内容变高，时间线的可视高度就小了）：内容没变、滚动位置也没变，
	// 在底部（跟随）的人底下几行被切掉了。还在底部的要重新贴到最底；往上翻看的人不动。观察的是这个区域自己的盒子，不是里面的内容：
	// 在底部展开一个靠上的行不会触发它（那样会把人拉到底，见 `follow` 的说明）。变矮时没有滚动事件，`stuck` 还是变矮之前的状态。
	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		let height = el.clientHeight;
		const observer = new ResizeObserver(() => {
			if (el.clientHeight === height) return;
			height = el.clientHeight;
			if (!stuck.current) return;
			el.scrollTop = el.scrollHeight;
			lastTop.current = el.scrollTop;
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	// 内容变了：排好版之后（浏览器画出来之前）决定滚到哪里。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 只在最前和最后一行的状态变了才需要重新决定
	useLayoutEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const before = previous.current;
		previous.current = { head, tail };
		releaseIfScrolledUp(el, lastTop, stuck);
		const prepended = before.head !== head && before.head !== null;
		const row =
			prepended && anchor.current
				? el.querySelector<HTMLElement>(
						`[${ROW_KEY_ATTRIBUTE}="${CSS.escape(anchor.current.key)}"]`,
					)
				: null;
		if (row && anchor.current) {
			el.scrollTop = row.offsetTop - anchor.current.offset;
		} else if (stuck.current) {
			el.scrollTop = el.scrollHeight;
		} else if (before.tail !== tail) {
			setHasNew(true);
		}
		lastTop.current = el.scrollTop;
		measureAnchor();
	}, [head, tail]);

	/**
	 * 内容在事件到达之外的时刻变高了（逐字出现的话被节流，延后那次渲染才画出新的文字，见 `timeline-follow.ts`）：在底部（跟随）的才滚到最新，
	 * 往上翻看的人不动（包括刚往上翻、滚动事件还没到的：{@link releaseIfScrolledUp}）。
	 */
	const follow = useCallback(() => {
		const el = scroller.current;
		if (el) followToEnd(el, lastTop, stuck);
	}, []);

	const scrollToBottom = useCallback(() => {
		const el = scroller.current;
		if (!el) return;
		stuck.current = true;
		el.scrollTop = el.scrollHeight;
		lastTop.current = el.scrollTop;
		setHasNew(false);
	}, []);

	return { scroller, hasNew, scrollToBottom, captureAnchor: measureAnchor, follow };
}
