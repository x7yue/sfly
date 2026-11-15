import { useSyncExternalStore } from "react";

/**
 * 跟随执行（编排画布的运行状态）的选择：按钮、`F` 切换，拖动画布和用键盘选到视野外的节点时关闭。
 * 第一次默认打开，之后记住这个浏览器里上次的选择（所有场景共用）。运行结束后跟随自动关闭，但不改这个选择：
 * 下一次运行照旧跟随。
 */
const STORAGE_KEY = "sfly.canvas.follow";
const listeners = new Set<() => void>();

const read = () => window.localStorage.getItem(STORAGE_KEY) !== "0";

export function setFollowExecution(on: boolean) {
	window.localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
	for (const l of listeners) l();
}

export function useFollowExecution(): boolean {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		read,
		() => true,
	);
}
