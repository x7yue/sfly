import { useSyncExternalStore } from "react";

/** 窗口现在匹不匹配这条媒体查询（窗口大小变了会重新渲染）。 */
export function useMediaQuery(query: string): boolean {
	return useSyncExternalStore(
		(onChange) => {
			const list = window.matchMedia(query);
			list.addEventListener("change", onChange);
			return () => list.removeEventListener("change", onChange);
		},
		() => window.matchMedia(query).matches,
		() => false,
	);
}
