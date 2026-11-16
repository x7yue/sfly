import { useSyncExternalStore } from "react";

/**
 * 跟随执行（编排画布的运行状态）的选择：只有按钮和 `F` 的切换是用户的选择，记住在这个浏览器里。
 * 第一次默认打开，之后用上次的选择（所有场景共用）。拖动画布、缩放和用键盘选到视野外的节点时停止跟随，那只在当前页面
 * 有效（`editor/run-state/use-run-motion.ts`），不写在这里：刷新后回到这个选择。运行结束后跟随自动关闭，
 * 同样不改这个选择：下一次运行照旧跟随。
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
