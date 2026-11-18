import { Toolbar } from "@base-ui/react/toolbar";
import type { ArrangeMode } from "@sfly/orchestration";
import {
	type Annotation,
	type AnnotationColor,
	annotationColor,
	type StickyNote,
	stickyNoteColor,
} from "@sfly/schema";
import { cn } from "cn";
import {
	ChevronDownIcon,
	Columns3Icon,
	GroupIcon,
	LayoutGridIcon,
	Rows3Icon,
	Trash2Icon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { ANNOTATION_COLOR_LABEL, ARRANGE_LABEL } from "#/lib/copy";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AnnotationColorPicker } from "./AnnotationColorPicker";
import { GroupDivider, ToolButton } from "./CanvasDock";
import type { AnnotationEdit, StickyEdit } from "./context";

/**
 * 画布上的浮动工具条：贴着选中的注释框或一组节点，放在画布坐标里（跟着平移缩放走），
 * 再按缩放比例反向缩放，屏幕上始终是工具条本来的大小。`origin` 是贴着的那个角（缩放以它为原点）。
 * 按钮和底部工具条的是同一种（`ToolButton`）；工具条是一个 Tab 停靠点，← → 在按钮之间移动。
 */
function FloatingToolbar({
	label,
	origin,
	className,
	children,
}: {
	label: string;
	origin: "bottom-left" | "bottom";
	className?: string;
	children: ReactNode;
}) {
	return (
		<Toolbar.Root
			aria-label={label}
			// nopan / nodrag：在工具条上按住拖动不平移画布、不拖动节点。
			className={cn(
				"nopan nodrag pointer-events-auto flex w-max items-center gap-0.5 rounded-lg border border-border-strong bg-raised p-0.75 shadow-float",
				"[scale:calc(1/var(--canvas-zoom))]",
				origin === "bottom-left" ? "origin-bottom-left" : "origin-bottom",
				className,
			)}
		>
			{children}
		</Toolbar.Root>
	);
}

const ARRANGE: readonly { mode: ArrangeMode; icon: ReactNode }[] = [
	{ mode: "grid", icon: <LayoutGridIcon /> },
	{ mode: "row", icon: <Columns3Icon /> },
	{ mode: "column", icon: <Rows3Icon /> },
];

function ArrangeButtons({ ids, edit }: { ids: readonly string[]; edit: AnnotationEdit }) {
	return ARRANGE.map((a) => (
		<ToolButton
			key={a.mode}
			label={ARRANGE_LABEL[a.mode]}
			onClick={() => edit.arrange(ids, a.mode)}
		>
			{a.icon}
		</ToolButton>
	));
}

/** 颜色按钮：当前颜色的色块，点开是颜色选择，选了就关上。 */
function ColorButton({
	color,
	onChange,
}: {
	color: AnnotationColor;
	onChange(color: AnnotationColor): void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip>
				<TooltipTrigger
					render={
						<PopoverTrigger
							render={
								<Toolbar.Button
									aria-label={`颜色：${ANNOTATION_COLOR_LABEL[color]}`}
									className="flex h-7.5 cursor-pointer items-center gap-1 rounded-md px-1.5 text-fg-2 hover:bg-raised-2 hover:text-fg-1 data-popup-open:bg-raised-2 data-popup-open:text-fg-1 [&_svg]:size-3.5"
								/>
							}
						/>
					}
				>
					<span
						data-annotation-color={color}
						className="size-3.5 rounded-full bg-canvas-annotation-swatch forced-color-adjust-none"
					/>
					<ChevronDownIcon />
				</TooltipTrigger>
				<TooltipContent>颜色</TooltipContent>
			</Tooltip>
			<PopoverContent align="start" sideOffset={6} className="p-2">
				<AnnotationColorPicker
					aria-label="颜色"
					value={color}
					onChange={(next) => {
						setOpen(false);
						onChange(next);
					}}
				/>
			</PopoverContent>
		</Popover>
	);
}

/**
 * 选中注释框时，框外标题后面的工具条：颜色、排列成员（宫格 / 横向 / 纵向）、删除注释框（成员节点不动）。
 * 排列只排节点成员：有子流程成员时不显示（排列会把子流程拆散，用整理布局），节点成员少于两个时也不显示。
 */
export function AnnotationToolbar({
	annotation,
	nodeMembers,
	edit,
}: {
	annotation: Annotation;
	/** 画布上有的节点成员。 */
	nodeMembers: readonly string[];
	edit: AnnotationEdit;
}) {
	const arrangeable = annotation.subflows.length === 0 && nodeMembers.length > 1;
	return (
		<FloatingToolbar label={`注释框 ${annotation.title} 的工具条`} origin="bottom-left">
			<ColorButton
				color={annotationColor(annotation)}
				onChange={(color) => edit.setColor(annotation.id, color)}
			/>
			{arrangeable && (
				<>
					<GroupDivider />
					<ArrangeButtons ids={nodeMembers} edit={edit} />
				</>
			)}
			<GroupDivider />
			<ToolButton
				label="删除注释框（节点不动）"
				shortcut="canvas-annotation-delete"
				onClick={() => edit.remove(annotation.id)}
			>
				<Trash2Icon />
			</ToolButton>
		</FloatingToolbar>
	);
}

/** 选中便签时，贴在它左上方的工具条：颜色（不写是黄色）、删除便签。 */
export function StickyToolbar({ note, edit }: { note: StickyNote; edit: StickyEdit }) {
	return (
		<FloatingToolbar label="便签的工具条" origin="bottom-left">
			<ColorButton
				color={stickyNoteColor(note)}
				onChange={(color) => edit.setColor(note.id, color)}
			/>
			<GroupDivider />
			<ToolButton label="删除便签" shortcut="canvas-delete" onClick={() => edit.remove(note.id)}>
				<Trash2Icon />
			</ToolButton>
		</FloatingToolbar>
	);
}

/** 选中几个节点时，贴在它们上方居中的工具条：用它们新建注释框，排列它们。 */
export function SelectionToolbar({ ids, edit }: { ids: readonly string[]; edit: AnnotationEdit }) {
	return (
		<FloatingToolbar
			label="选中节点的工具条"
			origin="bottom"
			className="-translate-x-1/2 -translate-y-full"
		>
			<ToolButton label="新建注释框" shortcut="canvas-annotate" onClick={() => edit.create(ids)}>
				<GroupIcon />
			</ToolButton>
			<GroupDivider />
			<ArrangeButtons ids={ids} edit={edit} />
		</FloatingToolbar>
	);
}
