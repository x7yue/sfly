import {
	BookOpenIcon,
	BotIcon,
	BoxIcon,
	LayoutDashboardIcon,
	type LucideIcon,
	MessageSquareIcon,
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
	to:
		| "/"
		| "/sessions"
		| "/orchestrations"
		| "/runs"
		| "/agents"
		| "/packages"
		| "/feishu-bots"
		| "/docs";
	label: string;
	icon: LucideIcon;
	shortcut: ShortcutId;
}

export const NAV_ITEMS: readonly NavItem[] = [
	{ to: "/", label: PAGE.dashboard, icon: LayoutDashboardIcon, shortcut: "go-dashboard" },
	{ to: "/sessions", label: PAGE.assistant, icon: MessageSquareIcon, shortcut: "go-assistant" },
	{ to: "/orchestrations", label: PAGE.scenarios, icon: WorkflowIcon, shortcut: "go-scenarios" },
	{ to: "/runs", label: PAGE.runs, icon: PlayIcon, shortcut: "go-runs" },
	{ to: "/agents", label: PAGE.agents, icon: ServerIcon, shortcut: "go-agents" },
	{ to: "/packages", label: PAGE.packages, icon: BoxIcon, shortcut: "go-packages" },
	{ to: "/feishu-bots", label: PAGE.feishuBots, icon: BotIcon, shortcut: "go-feishu-bots" },
	{ to: "/docs", label: PAGE.docs, icon: BookOpenIcon, shortcut: "go-docs" },
];
