import { useSyncExternalStore } from "react";

/** 侧边栏是否折叠成一列图标；保存在 localStorage，刷新后保持。 */
const STORAGE_KEY = "sfly.sidebar.collapsed";
const listeners = new Set<() => void>();

const read = () => window.localStorage.getItem(STORAGE_KEY) === "1";

export function setSidebarCollapsed(collapsed: boolean) {
	window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
	for (const l of listeners) l();
}

export const toggleSidebar = () => setSidebarCollapsed(!read());

export function useSidebarCollapsed(): boolean {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		read,
		() => false,
	);
}
