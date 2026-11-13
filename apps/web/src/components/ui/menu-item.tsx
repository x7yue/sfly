import { cn } from "cn";
import type { ReactNode } from "react";
import { MENU_SURFACE, POPUP_MOTION } from "@/components/ui/overlay";

/**
 * 下拉菜单（DropdownMenu）与右键菜单（ContextMenu）共用的外观，两者看起来、用起来是同一种菜单：
 * - 当前项 `raised-2` 底；危险项只把文字换成 `danger-fg`，高亮底色不变红。
 * - 禁用项不降整项的不透明度（「为什么做不了」是要读的说明）：文字退到三级，图标与按键 40%，原因单独一行 12px。
 */
export const MENU_POPUP_CLASS = cn(
	"z-50 max-h-(--available-height) origin-(--transform-origin) overflow-x-hidden overflow-y-auto p-1",
	MENU_SURFACE,
	POPUP_MOTION,
);

export const MENU_ITEM_CLASS =
	"flex cursor-default items-center gap-2 rounded-md px-2 py-1 text-sm outline-hidden select-none data-highlighted:bg-raised-2 data-popup-open:bg-raised-2 data-disabled:cursor-not-allowed data-disabled:text-fg-3 data-disabled:[&_svg]:opacity-40 data-disabled:**:data-[slot=kbd]:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

export type MenuItemVariant = "default" | "danger";

export const menuItemClass = (
	variant: MenuItemVariant,
	className?: Parameters<typeof cn>[number],
) => cn(MENU_ITEM_CLASS, variant === "danger" && "text-danger-fg", className);

/** 菜单项的文字；禁用原因写在下面一行，也读给读屏用户。 */
export function MenuItemText({ children, reason }: { children: ReactNode; reason?: string }) {
	return (
		<span className="flex min-w-0 flex-1 flex-col">
			<span className="flex items-center gap-2">{children}</span>
			{reason && <span className="text-xs">{reason}</span>}
		</span>
	);
}
