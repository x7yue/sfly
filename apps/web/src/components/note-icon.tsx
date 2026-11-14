import { cn } from "cn";
import { StickyNoteIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useHostKeyboardFocus } from "#/lib/host-focus";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const SCROLL_KEYS = ["PageUp", "PageDown", "Home", "End"];

/** 备注太长一屏放不下时，用键盘滚动提示里的全文。 */
function scrollNote(scroller: HTMLElement, key: string) {
	const page = scroller.clientHeight * 0.9;
	if (key === "PageDown") scroller.scrollBy({ top: page });
	else if (key === "PageUp") scroller.scrollBy({ top: -page });
	else if (key === "Home") scroller.scrollTo({ top: 0 });
	else scroller.scrollTo({ top: scroller.scrollHeight });
}

/**
 * 备注图标：悬停或键盘聚焦时，提示里显示备注全文（节点的备注，注释框的备注，运行监控页图表组标题上的备注）。
 *
 *   <NoteIcon note={node.note} />                                   // 页面上：图标是按钮，可以 Tab 到
 *   <NoteIcon note={node.note} host="[data-node-id]" textId={id} /> // 画布上：图标在节点卡片里
 *
 * - 全文显示在提示里，保留换行；长备注一屏放不下时提示不超出视口，在里面滚动：鼠标移进提示用滚轮，
 *   键盘用 PageUp、PageDown、Home、End（提示开着、焦点在图标或 `host` 上时）。提示不随画布缩放。
 * - 读屏：备注全文始终在 DOM 里（`sr-only`，页内查找也找得到）。图标是按钮时名称是「备注」、描述是全文；
 *   有 `host` 时图标本身对读屏隐藏，由外层把 `textId` 接成自己的 `aria-describedby`。
 * - `host`：外层元素的选择器。画布上的节点卡片不在 Tab 顺序里（方向键切换），卡片里的图标不可聚焦，
 *   键盘用户靠卡片的键盘焦点（`:focus-visible`，鼠标点选不算）看到提示，和 `WarningBadge` 一样。
 * - 大小跟着所在文字的字号（em），卡片头部语义缩放时随文字放大；颜色是三级文字色，悬停和打开时亮一档。
 *
 * 自动化测试用 `data-slot="note-icon"` 找图标，用 `getByRole("tooltip")` 找提示，提示里
 * `data-slot="note-text"` 是滚动区。注意同一段备注文字在 DOM 里出现两处（`sr-only` 的和提示里的）。
 */
export function NoteIcon({
	note,
	host,
	textId,
	side = "top",
	align = "center",
	className,
}: {
	note: string;
	/** 图标所在的键盘目标（外层元素）的选择器：它有键盘焦点时也显示提示，图标本身不可聚焦。 */
	host?: string;
	/** 全文元素的 id；外层要把它接成自己的 `aria-describedby` 时传入。 */
	textId?: string;
	side?: "top" | "bottom" | "left" | "right";
	align?: "start" | "center" | "end";
	className?: string;
}) {
	const generated = useId();
	const noteId = textId ?? generated;
	const anchor = useRef<Element | null>(null);
	const scroller = useRef<HTMLDivElement>(null);
	const [pointed, setPointed] = useState(false);
	const hostFocused = useHostKeyboardFocus(anchor, host);
	const open = pointed || hostFocused;

	// 键盘滚动全文：监听的是键盘目标本身，焦点在它里面的输入框里时不处理。
	useEffect(() => {
		const target = host ? anchor.current?.closest(host) : anchor.current;
		if (!open || !target) return;
		const onKeyDown = (event: Event) => {
			const { key, defaultPrevented } = event as KeyboardEvent;
			if (defaultPrevented || event.target !== target || !SCROLL_KEYS.includes(key)) return;
			if (!scroller.current) return;
			event.preventDefault();
			scrollNote(scroller.current, key);
		};
		target.addEventListener("keydown", onKeyDown);
		return () => target.removeEventListener("keydown", onKeyDown);
	}, [open, host]);

	const trigger = {
		ref: (element: Element | null) => {
			anchor.current = element;
		},
		"data-slot": "note-icon",
		className: cn(
			"inline-grid size-[1.6em] cursor-default place-items-center rounded-sm text-fg-3 transition-colors hover:text-fg-1 data-popup-open:text-fg-1 [&_svg]:size-[1.1em]",
			className,
		),
	};
	return (
		<>
			<Tooltip open={open} onOpenChange={setPointed}>
				<TooltipTrigger
					render={
						host ? (
							<span {...trigger} aria-hidden />
						) : (
							<button type="button" {...trigger} aria-label="备注" aria-describedby={noteId} />
						)
					}
				>
					<StickyNoteIcon aria-hidden />
				</TooltipTrigger>
				<TooltipContent role="tooltip" side={side} align={align} className="max-w-none p-0">
					<div
						ref={scroller}
						data-slot="note-text"
						// 提示本身没有 overflow（箭头画在它外面）；滚动区的最大高度是浮层算出来的可用高度，扣掉 1px 的上下描边。
						className="max-h-[calc(var(--available-height)-2px)] w-max max-w-[min(36rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain px-2.5 py-1.5 text-left wrap-anywhere whitespace-pre-wrap"
					>
						{note}
					</div>
				</TooltipContent>
			</Tooltip>
			<span id={noteId} className="sr-only">
				{note}
			</span>
		</>
	);
}
