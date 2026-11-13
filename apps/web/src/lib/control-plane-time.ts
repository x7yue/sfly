/**
 * 页面上的"现在"是控制面时间（GLOSSARY「时间」，ADR 0018），不是浏览器所在电脑的时间：
 * 运行的开始、结束时间都是控制面时间，拿浏览器时间去减，两边时钟一偏就会出现"已运行 613d"。
 *
 * 控制面在每个接口响应（响应头）和 SSE 心跳（`time` 事件）里带上自己的当前时间，API 客户端（`lib/api.ts`）
 * 收到后交给 {@link observeControlPlaneTime}，这里记下它与浏览器时间的差值。之后：
 *
 *   controlPlaneNow()          // 当前控制面时间（毫秒时间戳）：事件处理、一次性计算用
 *   const now = useNow(active) // 组件里每秒刷新的当前控制面时间（lib/use-now.ts）
 *
 * 需要"现在"的地方都用这两个，不直接用 `Date.now()` / `new Date()`。还没有收到过控制面时间时
 * （第一个响应返回之前，或者控制面是不带时间的旧版本），按浏览器时间算。
 */

/** 控制面时间 − 浏览器时间（毫秒）；null = 还没有收到过控制面时间。 */
let offset: number | null = null;
/** 上次通知订阅者时的差值。 */
let notified = 0;
const listeners = new Set<() => void>();

/** 差值变化达到这么多才通知订阅者立即刷新；更小的变化（网络延迟的抖动）等下一次每秒刷新。 */
const STEP_MS = 1000;

/** 当前控制面时间（毫秒时间戳）。 */
export function controlPlaneNow(): number {
	return Date.now() + (offset ?? 0);
}

/**
 * 记下刚收到的控制面时间（ISO 字符串；缺失或无法解析时忽略）。总是以最近一次为准：
 * 误差是这次响应的网络延迟，浏览器时间中途被修改后，下一次响应或心跳就能纠正。
 */
export function observeControlPlaneTime(time: string | null | undefined): void {
	const at = time ? Date.parse(time) : Number.NaN;
	if (Number.isNaN(at)) return;
	offset = at - Date.now();
	if (Math.abs(offset - notified) < STEP_MS) return;
	notified = offset;
	for (const listener of [...listeners]) listener();
}

/** 订阅"控制面时间与浏览器时间的差值变了"（第一次收到，或者某一边的时钟被改了）；返回取消函数。 */
export function subscribeControlPlaneTime(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
