import { Command as CommandPrimitive } from "cmdk";
import { cn } from "cn";
import { SearchIcon } from "lucide-react";
import type * as React from "react";
import { useCallback, useRef } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
	return (
		<CommandPrimitive
			data-slot="command"
			className={cn("flex size-full flex-col overflow-hidden bg-surface text-fg-1", className)}
			{...props}
		/>
	);
}

function CommandDialog({
	title = "命令面板",
	description = "搜索页面、场景，或输入命令",
	children,
	className,
	showCloseButton = false,
	...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> & {
	title?: string;
	description?: string;
	className?: string;
	showCloseButton?: boolean;
	children: React.ReactNode;
}) {
	/** 打开面板前焦点所在的元素：Esc 关闭后回到这里。 */
	const opener = useRef<HTMLElement | null>(null);
	/** 已经处理过的弹窗（每次打开都是新的弹窗元素）。 */
	const seen = useRef(new WeakSet<Element>());
	/**
	 * 弹窗一挂载就把焦点交给搜索框（React 提交阶段同步执行）。弹窗自己的初始焦点要等下一帧
	 * （Base UI 的 FloatingFocusManager 用 requestAnimationFrame），按 Ctrl K 后紧接着输入的字
	 * 会落在背后的页面上丢掉，回车就执行了过滤前的第一条命令（#280，添加节点菜单的 #123 是同一个问题）。
	 * 这样一来 Base UI 记下的「打开前的焦点」成了搜索框本身，所以先在这里记下打开前的焦点，关闭时由 finalFocus 交还。
	 */
	const focusSearch = useCallback((popup: HTMLElement | null) => {
		if (!popup || seen.current.has(popup)) return;
		seen.current.add(popup);
		const active = document.activeElement;
		opener.current = active instanceof HTMLElement ? active : null;
		popup.querySelector<HTMLInputElement>("[cmdk-input]")?.focus({ preventScroll: true });
	}, []);

	return (
		<Dialog {...props}>
			<DialogContent
				className={cn("w-[620px] gap-0 p-0", className)}
				showCloseButton={showCloseButton}
				ref={focusSearch}
				// 打开前页面上没有焦点时按 Base UI 的默认行为处理。
				finalFocus={() => {
					const back = opener.current;
					return back?.isConnected && back !== document.body ? back : true;
				}}
			>
				{/* 标题只给读屏器（作为弹窗的名称），放在弹窗内部，关闭时不留在页面上。 */}
				<DialogHeader className="sr-only">
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				{children}
			</DialogContent>
		</Dialog>
	);
}

function CommandInput({
	className,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
	return (
		<div
			data-slot="command-input-wrapper"
			className="flex items-center gap-2.5 border-b border-border-soft px-4"
		>
			<SearchIcon className="size-4 shrink-0 text-fg-3" aria-hidden />
			<CommandPrimitive.Input
				data-slot="command-input"
				className={cn(
					"h-12 w-full bg-transparent text-base text-fg-1 outline-none placeholder:text-fg-3 disabled:cursor-not-allowed disabled:opacity-40",
					className,
				)}
				{...props}
			/>
		</div>
	);
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
	return (
		<CommandPrimitive.List
			data-slot="command-list"
			className={cn(
				"max-h-[380px] scroll-py-1.5 overflow-x-hidden overflow-y-auto p-1.5 outline-none",
				className,
			)}
			{...props}
		/>
	);
}

function CommandEmpty({
	className,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
	return (
		<CommandPrimitive.Empty
			data-slot="command-empty"
			className={cn("py-8 text-center text-sm text-fg-2", className)}
			{...props}
		/>
	);
}

function CommandGroup({
	className,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
	return (
		<CommandPrimitive.Group
			data-slot="command-group"
			className={cn(
				"overflow-hidden text-fg-1 **:[[cmdk-group-heading]]:px-2.5 **:[[cmdk-group-heading]]:pt-2 **:[[cmdk-group-heading]]:pb-1 **:[[cmdk-group-heading]]:text-2xs **:[[cmdk-group-heading]]:text-fg-3",
				className,
			)}
			{...props}
		/>
	);
}

function CommandSeparator({
	className,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
	return (
		<CommandPrimitive.Separator
			data-slot="command-separator"
			className={cn("-mx-1.5 my-1 h-px bg-border-soft", className)}
			{...props}
		/>
	);
}

function CommandItem({
	className,
	children,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
	return (
		<CommandPrimitive.Item
			data-slot="command-item"
			className={cn(
				"group/command-item relative flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-40 data-selected:bg-raised-2 data-selected:text-fg-1 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-fg-3 [&_svg:not([class*='size-'])]:size-4",
				className,
			)}
			{...props}
		>
			{children}
		</CommandPrimitive.Item>
	);
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			data-slot="command-shortcut"
			className={cn("ml-auto flex gap-1 text-2xs text-fg-3", className)}
			{...props}
		/>
	);
}

export {
	Command,
	CommandDialog,
	CommandInput,
	CommandList,
	CommandEmpty,
	CommandGroup,
	CommandItem,
	CommandShortcut,
	CommandSeparator,
};
