import { useSyncExternalStore } from "react";

/**
 * 暂停动效：运行监控页一盯就是几个小时，执行中的脉冲会一直在周边视野里动。
 * 停掉的只是脉冲，执行中的形状（带外圈的点、段尾的脉冲头）还在。
 * 系统开了「减少动效」时脉冲本来就不动（app.css），这个开关给没开系统设置的人。
 */
const STORAGE_KEY = "sfly.motion.paused";
const listeners = new Set<() => void>();

const read = () => window.localStorage.getItem(STORAGE_KEY) === "1";

export function setMotionPaused(paused: boolean) {
	window.localStorage.setItem(STORAGE_KEY, paused ? "1" : "0");
	for (const l of listeners) l();
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
