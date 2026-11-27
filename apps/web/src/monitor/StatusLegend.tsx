import { StatusDot } from "#/components/status";
import { LIST_LABEL } from "#/lib/copy";
import type { LegendEntry } from "./status-legend";

/**
 * 概览「链路」区的状态图例（`statusLegend`）：圆点加状态文字，写法和时间线的图例一致（`text-xs text-fg-3`、间距、圆点在文字前）。
 * 行高固定（一行，放不下的部分不折行也不撑高）：运行在变、出现的状态跟着增减时，下面的版面不跳。
 */
export function StatusLegend({ entries }: { entries: LegendEntry[] }) {
	return (
		<ul
			aria-label={`状态${LIST_LABEL.legend}`}
			data-viz
			data-testid="status-legend"
			className="m-0 ml-auto flex h-5 min-w-0 self-center list-none items-center justify-end gap-3 overflow-hidden p-0 text-xs whitespace-nowrap text-fg-3"
		>
			{entries.map(({ kind, label }) => (
				<li key={kind} className="inline-flex items-center gap-1.25">
					<StatusDot kind={kind} />
					{label}
				</li>
			))}
		</ul>
	);
}
