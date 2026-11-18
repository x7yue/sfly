import { cn } from "cn";
import { activityLabel, type CurrentActivity } from "#/actions/current-activity";
import { Elapsed } from "#/components/elapsed";
import { LOD_HIDDEN, ZOOM_TEXT_12 } from "./zoom-text";

/**
 * 节点卡片上「正在做」的事：执行中的动作名称和已持续多久，没有动作时是进度的说明。站点灯已经是执行中的形状，这里不再画。
 * `inline` 写在第二行的节点 ID 后面（代替配置摘要，卡片不变高）；卡片第二行已经有主指标时用 `row` 另起一行，卡片往下长。
 * 读屏从卡片的名称里读到「正在做 X」（卡片用 `aria-labelledby` 引用带 `id` 的那段隐藏文字），不读每秒都在变的时长。
 */
export function ActivityLine({
	id,
	activity,
	variant,
}: {
	id: string;
	activity: CurrentActivity;
	variant: "inline" | "row";
}) {
	return (
		<span
			aria-hidden
			data-testid="node-activity"
			className={cn(
				"flex min-w-0 items-center gap-2 text-fg-1",
				variant === "inline"
					? // 和配置摘要一样：放得下三个半字才显示，放得下再撑满。
						"shrink grow basis-[3.5em]"
					: cn("leading-[1.35]", ZOOM_TEXT_12, LOD_HIDDEN),
			)}
		>
			<span id={id} className="sr-only">
				{activityLabel(activity)}
			</span>
			<span className="min-w-0 truncate">
				{activity.kind === "action" ? activity.name : activity.message}
			</span>
			{activity.kind === "action" && (
				<Elapsed since={activity.startedAt} className="ml-auto flex-none font-mono text-fg-3" />
			)}
		</span>
	);
}
