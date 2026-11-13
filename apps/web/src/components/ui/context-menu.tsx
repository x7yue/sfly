import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "cn";
import { ChevronRightIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useMemo, useRef } from "react";
import { Kbd } from "@/components/ui/kbd";
import {
	MENU_POPUP_CLASS,
	MenuItemText,
	type MenuItemVariant,
	menuItemClass,
} from "@/components/ui/menu-item";
import { type ShortcutId, shortcutById, shortcutKeys } from "@/lib/shortcuts";

/**
 * 上下文菜单（右键菜单；Base UI Menu，没有 Trigger）：由使用方决定什么时候打开、出现在哪。
 *
 *   const [menu, setMenu] = useState<{ at: ContextMenuAnchor; open: boolean } | null>(null);
 *   <div onContextMenu={(e) => { e.preventDefault(); setMenu({ at: { x: e.clientX, y: e.clientY }, open: true }); }} />
 *   <ContextMenu label="节点菜单" open={menu?.open ?? false} anchor={menu?.at ?? null}
 *     onOpenChange={(open) => setMenu((m) => m && { ...m, open })}>
 *     <ContextMenuItem shortcut="canvas-delete" variant="danger" onClick={remove}>删除节点</ContextMenuItem>
 *   </ContextMenu>
 *
 * - `anchor`：屏幕坐标（鼠标右键处），或一个元素（键盘 Shift+F10 / 菜单键打开时贴着它）。
 *   关闭时保留上一次的 anchor（退场动画期间菜单不跳走），所以关闭只改 `open`。
 * - 键盘：↑ ↓ 移动、Enter / 空格执行、Esc 关闭（Base UI）；打开时焦点进入菜单。
 * - 焦点：Esc 或点外面关闭后回到打开前有焦点的元素。选了某一项时先把焦点交还给它，再执行该项的
 *   `onClick`——处理函数可以再把焦点移到别处（例如打开另一个弹层）。
 *   所以打开菜单前，使用方要先让右键的对象拿到焦点（画布空白处见 FlowCanvas 的 onPaneContextMenu）。
 * - 快捷键文字只从注册表取（`ContextMenuItem` 的 `shortcut`），不在菜单里另写。
 */
export type ContextMenuAnchor = { x: number; y: number } | Element;

/** 选了某一项：把焦点交还给打开前的元素，再执行这一项的操作。 */
const PickContext = createContext<(action: () => void) => void>((action) => action());

function ContextMenu({
	label,
	open,
	anchor,
	onOpenChange,
	className,
	children,
}: {
	/** 菜单的无障碍名称（「画布菜单」「节点菜单」……）。 */
	label: string;
	open: boolean;
	anchor: ContextMenuAnchor | null;
	onOpenChange(open: boolean): void;
	className?: string;
	children: ReactNode;
}) {
	/** 打开前有焦点的元素。在打开的那次渲染里记下：这时 Base UI 还没有把焦点移进菜单。 */
	const opener = useRef<HTMLElement | null>(null);
	const wasOpen = useRef(false);
	const picked = useRef(false);
	if (open && !wasOpen.current) {
		const active = document.activeElement;
		opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
		picked.current = false;
	}
	wasOpen.current = open;

	const x = anchor instanceof Element ? undefined : anchor?.x;
	const y = anchor instanceof Element ? undefined : anchor?.y;
	const positionAnchor = useMemo(() => {
		if (anchor instanceof Element) return anchor;
		if (x === undefined || y === undefined) return undefined;
		return { getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }) };
	}, [anchor, x, y]);

	const pick = useRef((action: () => void) => {
		picked.current = true;
		// 等 Base UI 处理完这次点击（关闭菜单，期间它会把焦点放回菜单项）再交还焦点、执行操作。
		queueMicrotask(() => {
			if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
			action();
		});
	}).current;

	return (
		<MenuPrimitive.Root open={open} onOpenChange={onOpenChange} modal={false}>
			<MenuPrimitive.Portal>
				<MenuPrimitive.Positioner
					className="isolate z-50 outline-none"
					anchor={positionAnchor}
					side="bottom"
					align="start"
					sideOffset={anchor instanceof Element ? 4 : 2}
					alignOffset={anchor instanceof Element ? 0 : 2}
				>
					<MenuPrimitive.Popup
						data-slot="context-menu"
						aria-label={label}
						finalFocus={() => {
							if (picked.current) return false;
							return opener.current?.isConnected ? opener.current : false;
						}}
						className={cn(MENU_POPUP_CLASS, "min-w-52", className)}
					>
						<PickContext.Provider value={pick}>{children}</PickContext.Provider>
					</MenuPrimitive.Popup>
				</MenuPrimitive.Positioner>
			</MenuPrimitive.Portal>
		</MenuPrimitive.Root>
	);
}

/** 菜单项右侧的快捷键（来自注册表）。 */
function ShortcutKeys({ id }: { id: ShortcutId }) {
	return (
		<span className="ml-auto inline-flex items-center gap-0.75 pl-4">
			{shortcutKeys(id)
				.flat()
				.map((key, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 同一快捷键里可能有重复的键
					<Kbd key={i}>{key}</Kbd>
				))}
		</span>
	);
}

/**
 * 菜单项。
 * - `shortcut`：快捷键注册表里的 id。右侧显示它的按键；不写 children 时用注册表里的名称作为文字。
 * - `disabledReason`：做不了的原因。给了就禁用，原因显示在文字下面（也读给读屏用户）。
 * - `variant="danger"`：删除等破坏性操作。
 */
function ContextMenuItem({
	shortcut,
	disabledReason,
	disabled,
	variant = "default",
	className,
	onClick,
	children,
	...props
}: MenuPrimitive.Item.Props & {
	shortcut?: ShortcutId;
	disabledReason?: string | null | undefined;
	variant?: MenuItemVariant;
}) {
	const pick = useContext(PickContext);
	const reason = disabledReason || undefined;
	return (
		<MenuPrimitive.Item
			data-slot="context-menu-item"
			disabled={disabled || reason !== undefined}
			className={menuItemClass(variant, className)}
			onClick={(event) => pick(() => onClick?.(event))}
			{...props}
		>
			<MenuItemText reason={reason}>
				{children ?? (shortcut ? shortcutById(shortcut).label : null)}
			</MenuItemText>
			{shortcut && <ShortcutKeys id={shortcut} />}
		</MenuPrimitive.Item>
	);
}

function ContextMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
	return (
		<MenuPrimitive.Separator
			data-slot="context-menu-separator"
			className={cn("-mx-1 my-1 h-px bg-border", className)}
			{...props}
		/>
	);
}

/** 子菜单（例如「复制输出引用」列出每个输出）：`ContextMenuSub` 里放 `ContextMenuSubTrigger` 和 `ContextMenuSubContent`。 */
function ContextMenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
	return <MenuPrimitive.SubmenuRoot {...props} />;
}

function ContextMenuSubTrigger({
	disabledReason,
	disabled,
	className,
	children,
	...props
}: MenuPrimitive.SubmenuTrigger.Props & { disabledReason?: string | null | undefined }) {
	const reason = disabledReason || undefined;
	return (
		<MenuPrimitive.SubmenuTrigger
			data-slot="context-menu-sub-trigger"
			disabled={disabled || reason !== undefined}
			className={menuItemClass("default", className)}
			{...props}
		>
			<MenuItemText reason={reason}>{children}</MenuItemText>
			<ChevronRightIcon className="ml-auto text-fg-3" />
		</MenuPrimitive.SubmenuTrigger>
	);
}

function ContextMenuSubContent({ className, ...props }: MenuPrimitive.Popup.Props) {
	return (
		<MenuPrimitive.Portal>
			<MenuPrimitive.Positioner
				className="isolate z-50 outline-none"
				side="right"
				align="start"
				alignOffset={-5}
			>
				<MenuPrimitive.Popup
					data-slot="context-menu-sub-content"
					className={cn(MENU_POPUP_CLASS, "min-w-40", className)}
					{...props}
				/>
			</MenuPrimitive.Positioner>
		</MenuPrimitive.Portal>
	);
}

export {
	ContextMenu,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubTrigger,
	ContextMenuSubContent,
};
