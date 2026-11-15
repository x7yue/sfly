import { Timestamp } from "@sfly/schema";
import { z } from "zod";
import { MONITOR_VIEWS } from "./monitor-view";

/** 底部面板的页签。 */
export const PANEL_TABS = ["logs", "actions", "attempts", "io", "artifacts"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

/**
 * 运行监控页（`/runs/:id`）的地址参数，路由校验与生成链接共用：
 *
 * - `view`：视图（{@link MONITOR_VIEWS}）：概览或详情。不给时按 monitor-view.ts 的 `initialView` 决定；
 * - `node`：节点 ID。打开时选中这个节点；
 * - `tab`：底部面板的页签（{@link PANEL_TABS}）。打开时切到这个页签并展开面板；
 * - `at`：日志里要定位的时刻，控制面时间，写法与 API 的 `Timestamp` 相同（UTC 的 ISO 8601，
 *   如 `2026-01-01T00:00:06.250Z`）。只在同时带 `node` 时有效，没给 `tab` 时打开日志页签，
 *   定位到包含那一刻的一页：正好有一行（1 秒以内）就高亮它，没有就在那一刻的位置标出「这一刻」。
 *
 * `view`、`tab` 与 `at` 不合法时当作没给。
 */
export const MonitorSearch = z.object({
	view: z.enum(MONITOR_VIEWS).optional().catch(undefined),
	node: z.string().optional(),
	tab: z.enum(PANEL_TABS).optional().catch(undefined),
	at: Timestamp.optional().catch(undefined),
});
export type MonitorSearch = z.infer<typeof MonitorSearch>;

/** 通往运行监控页某个位置的链接：`<Link {...runMonitorLink(id, target)}>`，或 `navigate(runMonitorLink(id, target))`。 */
export function runMonitorLink(runId: string, target: MonitorSearch) {
	const search: MonitorSearch = {};
	if (target.view !== undefined) search.view = target.view;
	if (target.node !== undefined) search.node = target.node;
	if (target.tab !== undefined) search.tab = target.tab;
	if (target.at !== undefined) search.at = target.at;
	return { to: "/runs/$id" as const, params: { id: runId }, search };
}
