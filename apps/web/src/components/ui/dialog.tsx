import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "cn";
import { XIcon } from "lucide-react";
import type * as React from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BACKDROP_MOTION, POPUP_MOTION } from "@/components/ui/overlay";

/**
 * 模态弹窗（Base UI Dialog）：锁定焦点、Esc 关闭、关闭后焦点回到打开前的元素。结构：
 *
 *   <Dialog open={open} onOpenChange={setOpen}>
 *     <DialogContent>
 *       <form onSubmit={…}>                      // 可选；表单本身不占版面，三段照样排开
 *         <DialogHeader><DialogTitle>…</DialogTitle><DialogDescription>…</DialogDescription></DialogHeader>
 *         <DialogBody>…字段、列表…</DialogBody>  // 内容变高时只有这一段滚动，标题和按钮一直看得见
 *         <DialogFooter>…</DialogFooter>
 *       </form>
 *     </DialogContent>
 *   </Dialog>
 *
 * 点遮罩关闭（`pointerDismiss`）：默认 "pristine"，在弹窗里输入过任何东西后点遮罩不再关闭，Esc 与「取消」照常；
 * 搜索类弹窗（命令面板）用 "always"；"never" 只能用按钮或 Esc 关闭。
 */
type PointerDismiss = "pristine" | "always" | "never";

/** 弹窗里输入过东西：之后点遮罩不再关闭（Sheet 也用）。 */
const EditedContext = createContext<() => void>(() => {});
export const useMarkEdited = () => useContext(EditedContext);

function Dialog({
	pointerDismiss = "pristine",
	disablePointerDismissal,
	onOpenChange,
	...props
}: DialogPrimitive.Root.Props & { pointerDismiss?: PointerDismiss }) {
	const [edited, setEdited] = useState(false);
	useEffect(() => {
		if (props.open) setEdited(false);
	}, [props.open]);
	const [markEdited] = useState(() => () => setEdited(true));
	return (
		<EditedContext.Provider value={markEdited}>
			<DialogPrimitive.Root
				data-slot="dialog"
				disablePointerDismissal={
					disablePointerDismissal ||
					pointerDismiss === "never" ||
					(pointerDismiss === "pristine" && edited)
				}
				onOpenChange={(open, details) => {
					if (open) setEdited(false);
					onOpenChange?.(open, details);
				}}
				{...props}
			/>
		</EditedContext.Provider>
	);
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
	return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
	return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
	return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
	return (
		<DialogPrimitive.Backdrop
			data-slot="dialog-overlay"
			className={cn("fixed inset-0 isolate z-50 bg-scrim", BACKDROP_MOTION, className)}
			{...props}
		/>
	);
}

function DialogContent({
	className,
	children,
	showCloseButton = true,
	onInput,
	...props
}: DialogPrimitive.Popup.Props & {
	showCloseButton?: boolean;
}) {
	const markEdited = useMarkEdited();
	return (
		<DialogPortal>
			<DialogOverlay />
			<DialogPrimitive.Popup
				data-slot="dialog-content"
				// 没有 DialogBody 的弹窗内容过高时整个弹窗滚动，按钮行贴在底边（DialogFooter 是 sticky）。
				// 包住整个弹窗的 form（里面有标题）不占版面（display: contents），标题、主体、按钮直接是这一列的三段；
				// 只包一行字段的 form 照常排版。
				// 水平居中用 inset-x-0 + mx-auto 而不是 translate：减少动效时进出场的 translate 会被清掉。
				className={cn(
					"fixed inset-x-0 top-[12vh] z-50 mx-auto flex max-h-[76vh] w-[520px] max-w-[calc(100vw-40px)] flex-col gap-3 overflow-y-auto overscroll-contain rounded-xl border border-border-strong bg-surface p-4.5 text-sm text-fg-1 shadow-pop outline-none [&>form:has(>[data-slot=dialog-header])]:contents",
					POPUP_MOTION,
					className,
				)}
				onInput={(event) => {
					markEdited();
					onInput?.(event);
				}}
				{...props}
			>
				{children}
				{showCloseButton && (
					<DialogPrimitive.Close
						data-slot="dialog-close"
						aria-label="关闭"
						render={<Button variant="ghost" className="absolute top-3 right-3" size="icon-sm" />}
					>
						<XIcon />
					</DialogPrimitive.Close>
				)}
			</DialogPrimitive.Popup>
		</DialogPortal>
	);
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-header"
			className={cn("flex shrink-0 flex-col gap-1.5", className)}
			{...props}
		/>
	);
}

/**
 * 弹窗的主体：标题与按钮之间唯一滚动的一段，上下还有内容时边缘出现阴影。子元素之间是 12px 间距。
 */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="dialog-body"
			// 阴影画在主体自己的 ::before / ::after 上（sticky 贴在滚动区两端），按滚动状态显隐。
			// 它们也是 flex 项：-mb-6 / -mt-6 抵掉自身 12px 高度和 12px 间距，不占版面。
			className={cn(
				"-mx-4.5 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4.5 [container-type:scroll-state]",
				"before:pointer-events-none before:sticky before:top-0 before:z-1 before:-mx-4.5 before:-mb-6 before:h-3 before:shrink-0 before:bg-linear-to-b before:from-black/50 before:to-transparent before:opacity-0 before:transition-opacity",
				"after:pointer-events-none after:sticky after:bottom-0 after:z-1 after:-mx-4.5 after:-mt-6 after:h-3 after:shrink-0 after:bg-linear-to-t after:from-black/50 after:to-transparent after:opacity-0 after:transition-opacity",
				"[@container_scroll-state(scrollable:top)]:before:opacity-100 [@container_scroll-state(scrollable:bottom)]:after:opacity-100",
				className,
			)}
			{...props}
		/>
	);
}

function DialogFooter({
	className,
	showCloseButton = false,
	children,
	...props
}: React.ComponentProps<"div"> & {
	showCloseButton?: boolean;
}) {
	return (
		<div
			data-slot="dialog-footer"
			// 铺到弹窗的左右与下边缘（负外边距抵掉弹窗内边距），sticky 贴的是弹窗的内边缘，所以 bottom 也要抵掉内边距。
			className={cn(
				"sticky -bottom-4.5 -mx-4.5 -mb-4.5 flex shrink-0 items-center justify-end gap-2 bg-surface px-4.5 pt-1 pb-4.5",
				className,
			)}
			{...props}
		>
			{children}
			{showCloseButton && (
				<DialogPrimitive.Close render={<Button variant="ghost" />}>关闭</DialogPrimitive.Close>
			)}
		</div>
	);
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
	return (
		<DialogPrimitive.Title
			data-slot="dialog-title"
			className={cn("pr-8 text-base font-semibold", className)}
			{...props}
		/>
	);
}

/** 弹窗说明：决定后果的信息，用 13px 正文、二级文字（不是 12px 的辅助说明）。 */
function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
	return (
		<DialogPrimitive.Description
			data-slot="dialog-description"
			className={cn(
				"text-sm text-pretty text-fg-2 *:[a]:underline *:[a]:underline-offset-2 *:[a]:hover:text-fg-1",
				className,
			)}
			{...props}
		/>
	);
}

export {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogOverlay,
	DialogPortal,
	DialogTitle,
	DialogTrigger,
};
