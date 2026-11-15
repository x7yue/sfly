import type { ChartView } from "@sfly/schema";
import { EyeIcon } from "lucide-react";
import { ACTION, FOCUS, INSPECTOR_PAGE, TERM } from "#/lib/copy";
import { Button } from "@/components/ui/button";
import { type FocusItems, isFocused } from "./use-focus-items";

/**
 * 把一张图表设为本场景的关注项的开关（`aria-pressed`，文字始终是「关注」，可访问名称写明是哪一张）。
 * 名额用完以后，没按下的开关禁用：{@link FocusQuota} 写明去场景设置的「关注项」页移除一项。
 */
export function FocusToggle({
	focus,
	nodeId,
	chart,
	chartType,
	enabled,
}: {
	focus: FocusItems;
	nodeId: string;
	chart: string;
	/** 图表声明的类型：设为关注项后马上显示成数值或图表，不等服务端返回。 */
	chartType: ChartView["type"];
	/** 这个节点的图表现在能不能设为关注项（见 FocusQuota 的说明）；已经是关注项的总能取消。 */
	enabled: boolean;
}) {
	const pressed = isFocused(focus.items, nodeId, chart);
	return (
		<Button
			size="sm"
			aria-pressed={pressed}
			aria-label={`把 ${chart} 设为${TERM.focusItem}`}
			disabled={!pressed && (focus.full || !enabled)}
			onClick={() => focus.toggle(nodeId, chart, chartType, !pressed)}
			className="aria-pressed:bg-raised-2 aria-pressed:text-fg-1 aria-pressed:shadow-[inset_0_0_0_1px_var(--border-strong)]"
		>
			<EyeIcon aria-hidden="true" />
			{ACTION.focus}
		</Button>
	);
}

/** 「本场景的关注项已用 N / 8」：节点检查器的名额和场景设置的「关注项」页共用。 */
export function QuotaCount({ focus }: { focus: FocusItems }) {
	return (
		<>
			本场景的{TERM.focusItem}已用 <b className="font-mono font-medium text-fg-1">{focus.used}</b> /{" "}
			{focus.limit}
		</>
	);
}

/**
 * 名额，满了以后写明去场景设置的「关注项」页移除一项（失效的项也占名额）。读屏在名额变化时读出来。
 * `saved` 为 false 时说明这个节点还不能设：服务端按已保存的场景版本检查新加的项。
 */
export function FocusQuota({ focus, saved }: { focus: FocusItems; saved: boolean }) {
	return (
		<>
			<output className="m-0 mb-2 block text-xs text-fg-3">
				<QuotaCount focus={focus} />
				{focus.full &&
					`，已满${focus.stale > 0 ? FOCUS.staleNote(focus.stale) : ""}：先在${INSPECTOR_PAGE.sceneSettings}的「${INSPECTOR_PAGE.focus}」页移除一项`}
			</output>
			{!saved && (
				<p className="m-0 mb-2 text-xs text-fg-3">
					保存成场景版本以后，才能把这个节点的{TERM.chart}设为{TERM.focusItem}。
				</p>
			)}
		</>
	);
}
