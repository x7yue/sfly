import type { DashboardRunningRun } from "@sfly/schema";
import { cn } from "cn";
import { useId, useState } from "react";
import { CompactRunRow, RunBlock } from "./RunBlock";
import { wallLayout } from "./wall-rules";

/**
 * 左栏上半：正在运行的运行，按开始时间从新到旧，每个一块；6 个以上时是一行一个的紧凑行，点开展开成运行块
 * （wall-rules）。此刻没有运行时只写一行「此刻没有运行」，不放按钮。
 */
export function RunningRuns({ runs }: { runs: readonly DashboardRunningRun[] }) {
	const headingId = useId();
	const layout = wallLayout(runs.length);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	// 展开、收起时整块被换掉：焦点放到换上来的那个元素上，不掉到页面上。
	const [toggled, setToggled] = useState<string | null>(null);
	const toggle = (id: string, open: boolean) => {
		setExpanded((current) => {
			const next = new Set(current);
			if (open) next.add(id);
			else next.delete(id);
			return next;
		});
		setToggled(id);
	};
	return (
		<section aria-labelledby={headingId}>
			<h2 id={headingId} className="sr-only">
				正在运行
			</h2>
			{runs.length === 0 ? (
				<p className="m-0 rounded-lg border border-border-soft bg-surface px-4 py-3 text-sm text-fg-3">
					此刻没有运行
				</p>
			) : (
				<ul
					className={cn("m-0 flex list-none flex-col p-0", layout.compact ? "gap-1.5" : "gap-3.5")}
				>
					{runs.map((run) => (
						<li key={run.id}>
							{layout.compact && !expanded.has(run.id) ? (
								<CompactRunRow
									run={run}
									onExpand={() => toggle(run.id, true)}
									focusExpand={toggled === run.id}
								/>
							) : (
								<RunBlock
									run={run}
									activeLimit={layout.activeLimit}
									onCollapse={layout.compact ? () => toggle(run.id, false) : undefined}
									focusCollapse={toggled === run.id}
								/>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
