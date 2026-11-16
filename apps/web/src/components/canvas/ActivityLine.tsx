import { cn } from "cn";
import { activityLabel, type CurrentActivity } from "#/actions/current-activity";
import { Elapsed } from "#/components/elapsed";
import { StatusDot } from "#/components/status";
import { LOD_HIDDEN, ZOOM_TEXT_12 } from "./zoom-text";

/**
 * 节点卡片上「正在做」那一行（原型 `.actl`）：执行中的形状、动作名称和已持续多久；没有动作时是进度的说明。
 * 卡片只有 208px 宽，用形状代替「正在」两个字。读屏从卡片的名称里读到「正在做 X」（卡片用 `aria-labelledby` 引用
 * 带 `id` 的那段隐藏文字），不读每秒都在变的时长。
 */
export function ActivityLine({ id, activity }: { id: string; activity: CurrentActivity }) {
	return (
		<div
			aria-hidden
			data-testid="node-activity"
			className={cn(
				"mb-1 flex h-6 min-w-0 items-center gap-1.5 rounded-md bg-sunk px-2 text-fg-1",
				ZOOM_TEXT_12,
				LOD_HIDDEN,
			)}
		>
			<span id={id} className="sr-only">
				{activityLabel(activity)}
			</span>
			<StatusDot kind="running" />
			<span className="min-w-0 truncate">
				{activity.kind === "action" ? activity.name : activity.message}
			</span>
			{activity.kind === "action" && (
				<Elapsed
					since={activity.startedAt}
					className="ml-auto flex-none pl-1.5 font-mono text-fg-3"
				/>
			)}
		</div>
	);
}
