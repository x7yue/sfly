import { useSyncExternalStore } from "react";

/**
 * 右侧面板（编排画布的检查器、运行抽屉）的宽度：拖动左边缘调整，保存在 localStorage，
 * 所有场景、两种面板共用一个值，刷新后保持。没有保存过时各面板用自己的默认宽度（也是它的下限）。
 */
const STORAGE_KEY = "sfly.panel.width";
/** 上限：视口宽度的 60%。 */
const MAX_VIEWPORT_RATIO = 0.6;
const listeners = new Set<() => void>();

/** 检查器的默认宽度，也是它的下限。 */
export const INSPECTOR_MIN_WIDTH = 372;

export const maxPanelWidth = (viewportWidth: number) =>
	Math.floor(viewportWidth * MAX_VIEWPORT_RATIO);

/** 面板实际显示的宽度：保存的宽度（没有就用下限）收进 [下限, 视口宽度的 60%]。 */
export function clampPanelWidth(saved: number | null, viewportWidth: number, min: number): number {
	return Math.round(Math.max(min, Math.min(maxPanelWidth(viewportWidth), saved ?? min)));
}

function read(): number | null {
	const saved = Number(window.localStorage.getItem(STORAGE_KEY));
	return Number.isFinite(saved) && saved > 0 ? saved : null;
}

/** 保存宽度；null 表示恢复默认。 */
export function setPanelWidth(width: number | null) {
	if (width === null) window.localStorage.removeItem(STORAGE_KEY);
	else window.localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
	for (const l of listeners) l();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	window.addEventListener("resize", listener);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("resize", listener);
	};
}

/** 面板当前的宽度（px）；窗口缩小时按上限收回。min 是这个面板的默认宽度与下限。 */
export function usePanelWidth(min: number = INSPECTOR_MIN_WIDTH): number {
	return useSyncExternalStore(
		subscribe,
		() => clampPanelWidth(read(), window.innerWidth, min),
		() => min,
	);
}
