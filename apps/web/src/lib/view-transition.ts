/**
 * 编排画布的运行状态与运行监控之间的入口：只有这一对做 View Transition（app.css 里按 type 写了动画），
 * 全局路由和列表重排不做。运行状态标签（`vt-run-state`）在两页之间移动，整页朝前进的方向平移一小段并淡入淡出。
 * 系统开了「减少动效」时不发起过渡，直接切换。
 *
 *   <Link to="/runs/$id" viewTransition={runViewTransition("to-monitor")} />
 */
export const runViewTransition = (type: "to-monitor" | "to-canvas") => ({
	types: () =>
		window.matchMedia("(prefers-reduced-motion: reduce)").matches ? (false as const) : [type],
});
