import { useReactFlow, useStore } from "@xyflow/react";
import { cn } from "cn";
import {
	HandIcon,
	MapIcon,
	MinusIcon,
	MousePointer2Icon,
	PanelRightIcon,
	PlusIcon,
	ScanIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** 悬浮控件组（原型 `.grp`）：半透明表面 + 浮起阴影。 */
export const floatGroupClass =
	"absolute z-10 flex items-center gap-1.5 rounded-xl border border-border-soft bg-surface/94 p-1.25 shadow-float";

export function GroupDivider() {
	return <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />;
}

/** 工具条上的图标按钮（原型 `.tool`），悬停显示名称与快捷键。 */
export function ToolButton({
	label,
	keys,
	pressed,
	onClick,
	children,
}: {
	label: string;
	keys?: string;
	pressed?: boolean;
	onClick(): void;
	children: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						aria-label={label}
						aria-pressed={pressed}
						onClick={onClick}
						className={cn(
							"grid size-7.5 cursor-pointer place-items-center rounded-md text-fg-2 hover:bg-raised hover:text-fg-1 [&_svg]:size-4",
							pressed && "bg-raised-2 text-fg-1",
						)}
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent>
				{label}
				{keys && <Kbd>{keys}</Kbd>}
			</TooltipContent>
		</Tooltip>
	);
}

export type CanvasTool = "pointer" | "hand";

/**
 * 底部居中的画布工具条（原型 `.dock`）：指针 / 抓手、缩放比例、适配视图、小地图与检查器开关。
 * `start` 放在最左侧（#39 的「＋ 添加节点」），`tools` 放在适配视图之后（#39 的撤销 / 重做 / 整理布局）。
 */
export function CanvasDock({
	tool,
	onTool,
	onFit,
	minimap,
	onToggleMinimap,
	inspector,
	start,
	tools,
}: {
	tool: CanvasTool;
	onTool(tool: CanvasTool): void;
	onFit(): void;
	minimap: boolean;
	onToggleMinimap(): void;
	inspector?: { open: boolean; onToggle(): void };
	start?: ReactNode;
	tools?: ReactNode;
}) {
	const { zoomIn, zoomOut } = useReactFlow();
	const zoom = useStore((s) => s.transform[2]);
	return (
		<div
			role="toolbar"
			aria-label="画布工具"
			className={cn(floatGroupClass, "bottom-3.5 left-1/2 -translate-x-1/2")}
		>
			{start && (
				<>
					{start}
					<GroupDivider />
				</>
			)}
			<ToolButton
				label="指针"
				keys="V"
				pressed={tool === "pointer"}
				onClick={() => onTool("pointer")}
			>
				<MousePointer2Icon />
			</ToolButton>
			<ToolButton label="抓手" keys="H" pressed={tool === "hand"} onClick={() => onTool("hand")}>
				<HandIcon />
			</ToolButton>
			<GroupDivider />
			<ToolButton label="缩小" onClick={() => zoomOut({ duration: 150 })}>
				<MinusIcon />
			</ToolButton>
			<output aria-label="缩放比例" className="min-w-13 text-center font-mono text-xs text-fg-2">
				{Math.round(zoom * 100)}%
			</output>
			<ToolButton label="放大" onClick={() => zoomIn({ duration: 150 })}>
				<PlusIcon />
			</ToolButton>
			<ToolButton label="适配视图" keys="0" onClick={onFit}>
				<ScanIcon />
			</ToolButton>
			{tools && (
				<>
					<GroupDivider />
					{tools}
				</>
			)}
			<GroupDivider />
			<ToolButton label="小地图" keys="M" pressed={minimap} onClick={onToggleMinimap}>
				<MapIcon />
			</ToolButton>
			{inspector && (
				<ToolButton label="检查器" keys="I" pressed={inspector.open} onClick={inspector.onToggle}>
					<PanelRightIcon />
				</ToolButton>
			)}
		</div>
	);
}
