import { Toolbar } from "@base-ui/react/toolbar";
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
import { type ReactNode, useRef } from "react";
import { type ShortcutId, shortcutText } from "#/lib/shortcuts";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MAX_ZOOM, MIN_ZOOM } from "./geometry";
import { viewportDuration } from "./motion";

/** 悬浮控件组（原型 `.grp`）：半透明表面 + 浮起阴影。 */
export const floatGroupClass =
	"absolute z-10 flex items-center gap-1.5 rounded-xl border border-border-soft bg-surface/94 p-1.25 shadow-float";

export function GroupDivider() {
	return <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />;
}

/** 工具条上的图标按钮（原型 `.tool`），悬停显示名称与快捷键（`shortcut` 是注册表 id）。 */
export function ToolButton({
	label,
	shortcut,
	pressed,
	disabled,
	onClick,
	children,
}: {
	label: string;
	shortcut?: ShortcutId;
	pressed?: boolean;
	disabled?: boolean;
	onClick(): void;
	children: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Toolbar.Button
						aria-label={label}
						aria-pressed={pressed}
						disabled={disabled}
						focusableWhenDisabled={false}
						onClick={onClick}
						className={cn(
							"grid size-7.5 cursor-pointer place-items-center rounded-md text-fg-2 hover:bg-raised hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent [&_svg]:size-4",
							pressed && "bg-raised-2 text-fg-1",
						)}
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent>
				{label}
				{shortcut && <Kbd>{shortcutText(shortcut)}</Kbd>}
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
	clearRight = 0,
}: {
	tool: CanvasTool;
	onTool(tool: CanvasTool): void;
	onFit(): void;
	minimap: boolean;
	onToggleMinimap(): void;
	inspector?: { open: boolean; onToggle(): void };
	start?: ReactNode;
	tools?: ReactNode;
	/** 画布右侧被悬浮面板（检查器）占住的宽度：居中放不下时工具条往左让开。 */
	clearRight?: number;
}) {
	const zoom = useStore((s) => s.transform[2]);
	const zoomBy = useZoomSteps();
	return (
		// 两侧的占位等宽时工具条居中；右侧占位不小于 clearRight，放不下就把工具条往左推。
		<div className="pointer-events-none absolute inset-x-0 bottom-3.5 z-10 flex">
			<span className="min-w-0 flex-1" />
			{/* Base UI 的工具条：整条只有一个 Tab 停靠点，← → 在按钮之间移动；禁用的按钮不参与。 */}
			<Toolbar.Root
				aria-label="画布工具"
				className={cn(floatGroupClass, "pointer-events-auto relative flex-none")}
			>
				{start && (
					<>
						{start}
						<GroupDivider />
					</>
				)}
				<ToolButton
					label="指针"
					shortcut="canvas-pointer"
					pressed={tool === "pointer"}
					onClick={() => onTool("pointer")}
				>
					<MousePointer2Icon />
				</ToolButton>
				<ToolButton
					label="抓手"
					shortcut="canvas-hand"
					pressed={tool === "hand"}
					onClick={() => onTool("hand")}
				>
					<HandIcon />
				</ToolButton>
				<GroupDivider />
				<ToolButton label="缩小" onClick={() => zoomBy(1 / ZOOM_STEP)}>
					<MinusIcon />
				</ToolButton>
				<output aria-label="缩放比例" className="min-w-13 text-center font-mono text-xs text-fg-2">
					{Math.round(zoom * 100)}%
				</output>
				<ToolButton label="放大" onClick={() => zoomBy(ZOOM_STEP)}>
					<PlusIcon />
				</ToolButton>
				<ToolButton label="适配视图" shortcut="canvas-fit" onClick={onFit}>
					<ScanIcon />
				</ToolButton>
				{tools && (
					<>
						<GroupDivider />
						{tools}
					</>
				)}
				<GroupDivider />
				<ToolButton
					label="小地图"
					shortcut="canvas-minimap"
					pressed={minimap}
					onClick={onToggleMinimap}
				>
					<MapIcon />
				</ToolButton>
				{inspector && (
					<ToolButton
						label="检查器"
						shortcut="canvas-inspector"
						pressed={inspector.open}
						onClick={inspector.onToggle}
					>
						<PanelRightIcon />
					</ToolButton>
				)}
			</Toolbar.Root>
			<span className="flex-1" style={{ minWidth: clearRight }} />
		</div>
	);
}

/** 缩放按钮每次的倍数（与 React Flow 的 zoomIn / zoomOut 相同）。 */
const ZOOM_STEP = 1.2;
const ZOOM_DURATION = 150;

/**
 * 缩放按钮：上一次的动画还没结束时，从它的目标继续缩放，而不是从动画中途的值。React Flow 的 zoomIn / zoomOut
 * 以当前（动画中途的）缩放为基准，连续快速点击时后一次打断前一次，前一次的那一步就丢了（机器慢时更明显）。
 */
function useZoomSteps() {
	const { zoomTo, getZoom } = useReactFlow();
	const pending = useRef<{ zoom: number; until: number } | null>(null);
	return (factor: number) => {
		const now = performance.now();
		const duration = viewportDuration(ZOOM_DURATION);
		const from = pending.current && now < pending.current.until ? pending.current.zoom : getZoom();
		const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, from * factor));
		pending.current = { zoom, until: now + duration };
		void zoomTo(zoom, { duration });
	};
}
