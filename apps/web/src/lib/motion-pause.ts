import { useSyncExternalStore } from "react";

/**
 * 暂停动效：运行监控页一盯就是几个小时，执行中的脉冲会一直在周边视野里动。
 * 全站一个开关，值记在 localStorage，状态写在 `<html data-motion="paused">`，由 app.css 停掉持续循环的动画
 * （执行中的脉冲、骨架屏的呼吸、加载图标放慢）；执行中的形状（带外圈的点、段尾的脉冲头）还在。
 * 系统开了「减少动效」时这些动画本来就不动，这个开关给没开系统设置的人。
 */
const STORAGE_KEY = "sfly.motion.paused";
const listeners = new Set<() => void>();

const read = () => window.localStorage.getItem(STORAGE_KEY) === "1";

function apply() {
	if (read()) document.documentElement.dataset.motion = "paused";
	else delete document.documentElement.dataset.motion;
	for (const l of listeners) l();
}

/** 应用入口调用一次（首次渲染之前）：套用已保存的设置，并跟随其他标签页里的切换。 */
export function initMotionPause() {
	apply();
	window.addEventListener("storage", (event) => {
		if (event.key === STORAGE_KEY) apply();
	});
}

export function setMotionPaused(paused: boolean) {
	window.localStorage.setItem(STORAGE_KEY, paused ? "1" : "0");
	apply();
}

export const toggleMotionPaused = () => setMotionPaused(!read());

export function useMotionPaused(): boolean {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		read,
		() => false,
	);
}
