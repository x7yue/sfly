import { useRef } from "react";
import { MONITOR_VIEW_LABEL } from "#/lib/copy";
import { MONITOR_VIEWS, type MonitorView, nextView } from "./monitor-view";

/** 视图面板的 id：标签页的 `aria-controls` 指向它，面板（`<main>`）的名称来自当前的标签页。 */
export const VIEW_PANEL_ID = "monitor-view-panel";
export const viewTabId = (view: MonitorView) => `monitor-view-tab-${view}`;

/**
 * 运行监控页头的「概览 / 详情」标签页：tablist，只有选中的标签在 Tab 顺序里，方向键在两个标签之间切换并立即显示，
 * Home / End 到第一个 / 最后一个。选中的标签用分段选择的中性高亮（不用青色）。
 */
export function ViewTabs({
	view,
	onChange,
}: {
	view: MonitorView;
	onChange: (view: MonitorView) => void;
}) {
	const tabs = useRef(new Map<MonitorView, HTMLButtonElement>());
	return (
		<div
			role="tablist"
			aria-label="运行监控视图"
			className="inline-flex h-7.5 flex-none items-stretch gap-px rounded-md border border-border-control bg-sunk p-0.5"
		>
			{MONITOR_VIEWS.map((value) => (
				<button
					key={value}
					type="button"
					role="tab"
					id={viewTabId(value)}
					aria-selected={view === value}
					aria-controls={VIEW_PANEL_ID}
					tabIndex={view === value ? 0 : -1}
					ref={(el) => {
						if (el) tabs.current.set(value, el);
						else tabs.current.delete(value);
					}}
					onClick={() => onChange(value)}
					onKeyDown={(event) => {
						const next = nextView(view, event.key);
						if (!next) return;
						event.preventDefault();
						onChange(next);
						tabs.current.get(next)?.focus();
					}}
					className="inline-flex cursor-pointer items-center rounded-sm px-3 text-sm text-fg-2 transition-colors hover:text-fg-1 aria-selected:bg-raised-2 aria-selected:text-fg-1 aria-selected:shadow-[inset_0_0_0_1px_var(--border-strong)]"
				>
					{MONITOR_VIEW_LABEL[value]}
				</button>
			))}
		</div>
	);
}
