import { useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useMemo, useState } from "react";
import { ShortcutListener, ShortcutsDialog, useShortcut } from "#/components/shortcuts";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CommandPalette } from "./CommandPalette";
import { NicknameDialog } from "./NicknameDialog";
import { NAV_ITEMS, type NavItem } from "./navigation";
import { toggleSidebar } from "./sidebar-state";

/**
 * 全局浮层：命令面板、快捷键面板、昵称弹窗与通知容器，挂在根路由，外壳页和全屏页都能用。
 * 同一时间只打开一个；任何组件用 `useOverlays().open("shortcuts")` 打开。
 * 弹窗（Base UI Dialog）负责锁定焦点、Esc 关闭，并在关闭后把焦点还给打开前的元素。
 */
export type Overlay = "command-palette" | "shortcuts" | "nickname";

interface OverlayApi {
	current: Overlay | null;
	open: (overlay: Overlay) => void;
	close: () => void;
}

const OverlayContext = createContext<OverlayApi | null>(null);

export function useOverlays(): OverlayApi {
	const api = useContext(OverlayContext);
	if (!api) throw new Error("useOverlays 必须在 GlobalOverlays 里使用");
	return api;
}

export function GlobalOverlays({ children }: { children: React.ReactNode }) {
	const [current, setCurrent] = useState<Overlay | null>(null);
	const api = useMemo<OverlayApi>(
		() => ({ current, open: setCurrent, close: () => setCurrent(null) }),
		[current],
	);
	const toggle = (overlay: Overlay) => setCurrent((c) => (c === overlay ? null : overlay));
	const setOpen = (overlay: Overlay) => (open: boolean) => setCurrent(open ? overlay : null);

	useShortcut("command-palette", () => toggle("command-palette"));
	useShortcut("shortcuts-help", () => toggle("shortcuts"));
	useShortcut("toggle-sidebar", toggleSidebar);

	return (
		<OverlayContext.Provider value={api}>
			<TooltipProvider delay={400}>
				{children}
				{NAV_ITEMS.map((item) => (
					<NavShortcut key={item.to} item={item} />
				))}
				<ShortcutListener />
				<CommandPalette
					open={current === "command-palette"}
					onOpenChange={setOpen("command-palette")}
					openOverlay={setCurrent}
				/>
				<ShortcutsDialog open={current === "shortcuts"} onOpenChange={setOpen("shortcuts")} />
				<NicknameDialog open={current === "nickname"} onOpenChange={setOpen("nickname")} />
				<Toaster />
			</TooltipProvider>
		</OverlayContext.Provider>
	);
}

function NavShortcut({ item }: { item: NavItem }) {
	const navigate = useNavigate();
	useShortcut(item.shortcut, () => navigate({ to: item.to }));
	return null;
}
