import { EyeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type FocusItems, isFocused } from "./use-focus-items";

/**
 * 把一张图表设为本场景的关注项的开关（`aria-pressed`，文字始终是「关注」，可访问名称写明是哪一张）。
 * 名额用完以后，没按下的开关禁用：先在场景检查器里移除一项。
 */
export function FocusToggle({
	focus,
	nodeId,
	chart,
	enabled,
}: {
	focus: FocusItems;
	nodeId: string;
	chart: string;
	/** 这个节点的图表现在能不能设为关注项（见 FocusQuota 的说明）；已经是关注项的总能取消。 */
	enabled: boolean;
}) {
	const pressed = isFocused(focus.items, nodeId, chart);
	return (
		<Button
			size="sm"
			aria-pressed={pressed}
			aria-label={`把 ${chart} 设为关注项`}
			disabled={!pressed && (focus.full || !enabled)}
			onClick={() => focus.toggle(nodeId, chart, !pressed)}
			className="aria-pressed:bg-raised-2 aria-pressed:text-fg-1 aria-pressed:shadow-[inset_0_0_0_1px_var(--border-strong)]"
		>
			<EyeIcon aria-hidden="true" />
			关注
		</Button>
	);
}

/**
 * 「本场景的关注项已用 N / 8」，满了以后写明先移除一项（失效的项也占名额）。读屏在名额变化时读出来。
 * `saved` 为 false 时说明这个节点还不能设：服务端按已保存的场景版本检查新加的项。
 */
export function FocusQuota({ focus, saved }: { focus: FocusItems; saved: boolean }) {
	const stale = focus.items.filter((item) => item.status !== "ok").length;
	return (
		<>
			<output className="m-0 mb-2 block text-xs text-fg-3">
				本场景的关注项已用 <b className="font-mono font-medium text-fg-1">{focus.used}</b> /{" "}
				{focus.limit}
				{focus.full &&
					`，已满${stale > 0 ? `（含 ${stale} 项已失效的）` : ""}：先在场景检查器里移除一项`}
			</output>
			{!saved && (
				<p className="m-0 mb-2 text-xs text-fg-3">
					保存成场景版本以后，才能把这个节点的图表设为关注项。
				</p>
			)}
		</>
	);
}
