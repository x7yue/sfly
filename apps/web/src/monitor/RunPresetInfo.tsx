import type { RunPresetView } from "@sfly/schema";
import { presetLabel } from "#/lib/copy";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * 监控页顶栏上这个运行用的运行预设：「预设：<触发时的名称>」，悬停、聚焦后按回车或点击展开预设参数的名单
 * （这些参数的值来自预设，触发时已固定）。
 */
export function RunPresetInfo({ preset }: { preset: RunPresetView }) {
	return (
		<Popover>
			<PopoverTrigger
				openOnHover
				delay={150}
				className="h-6.5 min-w-16 shrink-[3] cursor-pointer truncate rounded-md px-1.5 text-xs text-fg-2 hover:bg-raised hover:text-fg-1"
			>
				{presetLabel(preset.name)}
			</PopoverTrigger>
			<PopoverContent
				aria-label={presetLabel(preset.name)}
				align="start"
				className="flex w-72 flex-col gap-2 p-3"
			>
				<p className="m-0 text-xs text-fg-2 wrap-anywhere">
					这些参数的值来自预设「{preset.name}」，触发时已固定：
				</p>
				<ul aria-label="预设参数" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
					{preset.params.map((name) => (
						<li key={name}>
							<Badge className="font-mono">{name}</Badge>
						</li>
					))}
				</ul>
			</PopoverContent>
		</Popover>
	);
}
