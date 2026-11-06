import {
	BookOpenIcon,
	BoxIcon,
	LayoutDashboardIcon,
	type LucideIcon,
	PlayIcon,
	ServerIcon,
	WorkflowIcon,
} from "lucide-react";
import { PAGE } from "#/lib/copy";
import type { ShortcutId } from "#/lib/shortcuts";

/**
 * 外壳的主导航：侧边栏、命令面板的「跳转」分组、G 开头的跳转快捷键都从这里生成。
 * 新增一级页面时在这里加一项（并在 #/lib/shortcuts 登记跳转快捷键）。
 */
export interface NavItem {
	to: "/" | "/orchestrations" | "/runs" | "/agents" | "/packages" | "/docs";
	label: string;
	icon: LucideIcon;
	shortcut: ShortcutId;
}

export const NAV_ITEMS: readonly NavItem[] = [
	{ to: "/", label: PAGE.dashboard, icon: LayoutDashboardIcon, shortcut: "go-dashboard" },
	{ to: "/orchestrations", label: PAGE.scenarios, icon: WorkflowIcon, shortcut: "go-scenarios" },
	{ to: "/runs", label: PAGE.runs, icon: PlayIcon, shortcut: "go-runs" },
	{ to: "/agents", label: PAGE.agents, icon: ServerIcon, shortcut: "go-agents" },
	{ to: "/packages", label: PAGE.packages, icon: BoxIcon, shortcut: "go-packages" },
	{ to: "/docs", label: PAGE.docs, icon: BookOpenIcon, shortcut: "go-docs" },
];
