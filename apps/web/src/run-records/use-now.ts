import { useEffect, useState } from "react";

/** 每秒刷新一次的当前时间（只在 active 时计时），用于进行中运行的已运行时长。 */
export function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [active]);
	return now;
}
