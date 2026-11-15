import type { RunListPreset } from "@sfly/schema";
import { presetLabel } from "#/lib/copy";
import { Truncate } from "@/components/ui/truncate";

/**
 * 运行记录里的场景名：这个运行用了运行预设时，后面跟次要文字「预设：<触发时的名称>」。
 * 没用预设时就是场景名本身，和没有这个功能时的显示完全一样。
 */
export function ScenarioWithPreset({
	name,
	preset,
	className,
}: {
	name: string;
	preset: Pick<RunListPreset, "name"> | null;
	className?: string;
}) {
	if (!preset) return <Truncate className={className}>{name}</Truncate>;
	return (
		<span className="flex min-w-0 items-baseline gap-2">
			<Truncate className={className}>{name}</Truncate>
			<Truncate className="max-w-[45%] text-xs text-fg-3">{presetLabel(preset.name)}</Truncate>
		</span>
	);
}
