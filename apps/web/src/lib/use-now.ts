import { useEffect, useState } from "react";
import { controlPlaneNow, subscribeControlPlaneTime } from "./control-plane-time";

/**
 * 每秒刷新一次的当前控制面时间（毫秒时间戳，只在 active 时计时），用于运行中的耗时与实时跟随。
 * 控制面时间与浏览器时间的差值变化时立即刷新（见 ./control-plane-time.ts）。
 */
export function useNow(active: boolean): number {
	const [now, setNow] = useState(controlPlaneNow);
	useEffect(() => {
		const refresh = () => setNow(controlPlaneNow());
		const unsubscribe = subscribeControlPlaneTime(refresh);
		if (!active) return unsubscribe;
		refresh();
		const timer = setInterval(refresh, 1000);
		return () => {
			unsubscribe();
			clearInterval(timer);
		};
	}, [active]);
	return now;
}
