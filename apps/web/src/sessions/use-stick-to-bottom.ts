import { useEffect, useLayoutEffect, useRef } from "react";

/** 离底部多近算「在底部」（像素）。 */
const NEAR_BOTTOM = 120;

/**
 * 内容增长时留在底部：用户在底部（或刚打开）时，`dependency` 变化后滚到最底；用户往上翻看之后不再替他滚。
 * 滚动的是外壳的主区域（`#main`）。
 */
export function useStickToBottom(dependency: unknown) {
	const stuck = useRef(true);
	useEffect(() => {
		const main = document.getElementById("main");
		if (!main) return;
		const onScroll = () => {
			stuck.current = main.scrollHeight - main.scrollTop - main.clientHeight < NEAR_BOTTOM;
		};
		main.addEventListener("scroll", onScroll, { passive: true });
		return () => main.removeEventListener("scroll", onScroll);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: 内容变了才需要重新滚
	useLayoutEffect(() => {
		const main = document.getElementById("main");
		if (main && stuck.current) main.scrollTop = main.scrollHeight;
	}, [dependency]);
}
