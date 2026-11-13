import { agentsApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { Link, useMatches } from "@tanstack/react-router";
import { cn } from "cn";
import {
	ChevronRightIcon,
	KeyboardIcon,
	PanelLeftCloseIcon,
	PanelLeftOpenIcon,
	SearchIcon,
} from "lucide-react";
import { Keys } from "#/components/page";
import { apiQuery } from "#/lib/api";
import { useNickname } from "#/lib/nickname";
import { BACKGROUND_POLL_MS } from "#/lib/polling";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NAV_ITEMS, type NavItem } from "./navigation";
import { useOverlays } from "./overlays";
import { toggleSidebar, useSidebarCollapsed } from "./sidebar-state";

/**
 * 中后台外壳（原型 shell()）：左侧可折叠的侧边栏 + 顶栏（面包屑、全局搜索入口、昵称）+ 可滚动的内容区。
 * 导航项右侧平时显示计数（Agent 在线数），悬停或键盘聚焦时换成跳转快捷键（占同一个位置，不挤宽）。
 * 由 routes/_shell.tsx 使用；全屏页（编排画布、运行监控）不放在 _shell 下面，不带外壳。
 * 面包屑来自各路由的 `staticData.crumb`。
 */
export function AppShell({ children }: { children: React.ReactNode }) {
	const collapsed = useSidebarCollapsed();
	return (
		<div
			className="fixed inset-0 grid"
			style={{
				gridTemplateColumns: `${collapsed ? "var(--sidebar-width-collapsed)" : "var(--sidebar-width)"} 1fr`,
			}}
		>
			<Sidebar collapsed={collapsed} />
			<div className="flex min-w-0 flex-col overflow-hidden">
				<Topbar />
				<main id="main" className="flex-1 overflow-auto">
					{children}
				</main>
			</div>
		</div>
	);
}

function Sidebar({ collapsed }: { collapsed: boolean }) {
	const { open } = useOverlays();
	const agents = useQuery({ ...apiQuery(agentsApi.list), refetchInterval: BACKGROUND_POLL_MS });
	const online = agents.data?.agents.filter((a) => a.status === "online").length;
	const counts: Partial<Record<NavItem["to"], string>> = {
		"/agents":
			agents.data && agents.data.agents.length > 0
				? `${online}/${agents.data.agents.length}`
				: undefined,
	};

	return (
		<aside
			aria-label="侧边栏"
			data-collapsed={collapsed || undefined}
			className="flex flex-col gap-0.5 overflow-hidden border-r border-border-soft bg-surface px-2 py-3"
		>
			<div className="flex items-center gap-2.5 px-1.5 pt-0.5 pb-3.5">
				<span className="grid size-7 flex-none place-items-center rounded-lg bg-primary font-mono text-xs font-semibold text-primary-foreground">
					sf
				</span>
				{!collapsed && (
					<div className="leading-tight">
						<b className="block text-base">sfly</b>
						<span className="block text-xs text-fg-3">测试编排平台</span>
					</div>
				)}
			</div>
			<nav aria-label="主导航" className="flex flex-col gap-0.5">
				{NAV_ITEMS.map((item) => (
					<SidebarItem key={item.to} collapsed={collapsed} label={item.label}>
						<Link
							to={item.to}
							activeOptions={{ exact: item.to === "/" }}
							className={cn("group", navItemClass(collapsed))}
							activeProps={{ "aria-current": "page" }}
						>
							<item.icon aria-hidden />
							<span className={cn(collapsed && "sr-only")}>{item.label}</span>
							{!collapsed && (
								<span className="ml-auto grid justify-items-end">
									{counts[item.to] && (
										<span className="col-start-1 row-start-1 font-mono text-2xs text-fg-3 group-hover:opacity-0 group-focus-visible:opacity-0">
											{counts[item.to]}
										</span>
									)}
									<span
										aria-hidden
										className="col-start-1 row-start-1 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
									>
										<Keys shortcut={item.shortcut} />
									</span>
								</span>
							)}
						</Link>
					</SidebarItem>
				))}
			</nav>
			<div className="flex-1" />
			<SidebarItem collapsed={collapsed} label="快捷键">
				<button type="button" className={navItemClass(collapsed)} onClick={() => open("shortcuts")}>
					<KeyboardIcon aria-hidden />
					<span className={cn(collapsed && "sr-only")}>快捷键</span>
					{!collapsed && <Keys shortcut="shortcuts-help" className="ml-auto" />}
				</button>
			</SidebarItem>
			<SidebarItem collapsed={collapsed} label={collapsed ? "展开侧边栏" : "折叠侧边栏"}>
				<button
					type="button"
					className={navItemClass(collapsed)}
					aria-expanded={!collapsed}
					onClick={toggleSidebar}
				>
					{collapsed ? <PanelLeftOpenIcon aria-hidden /> : <PanelLeftCloseIcon aria-hidden />}
					<span className={cn(collapsed && "sr-only")}>
						{collapsed ? "展开侧边栏" : "折叠侧边栏"}
					</span>
					{!collapsed && <Keys shortcut="toggle-sidebar" className="ml-auto" />}
				</button>
			</SidebarItem>
		</aside>
	);
}

/** 侧边栏项：选中为中性高亮（浅一级的表面 + 左侧白色短条），不用青色。 */
const navItemClass = (collapsed: boolean) =>
	cn(
		"relative flex h-8.5 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-sm whitespace-nowrap text-fg-2 no-underline hover:bg-raised hover:text-fg-1 [&_svg]:size-4 [&_svg]:flex-none",
		"aria-[current=page]:bg-raised-2 aria-[current=page]:text-fg-1 aria-[current=page]:before:absolute aria-[current=page]:before:inset-y-2 aria-[current=page]:before:-left-2 aria-[current=page]:before:w-0.5 aria-[current=page]:before:rounded-sm aria-[current=page]:before:bg-primary",
		collapsed && "justify-center px-0",
	);

/** 折叠时用悬浮提示显示名称。 */
function SidebarItem({
	collapsed,
	label,
	children,
}: {
	collapsed: boolean;
	label: string;
	children: React.ReactElement;
}) {
	if (!collapsed) return children;
	return (
		<Tooltip>
			<TooltipTrigger render={children} />
			<TooltipContent side="right">{label}</TooltipContent>
		</Tooltip>
	);
}

function Topbar() {
	const { open } = useOverlays();
	const nickname = useNickname();
	const crumbs = useMatches().flatMap((m) => m.staticData.crumb ?? []);

	return (
		<header className="flex h-(--topbar-height) flex-none items-center gap-2.5 border-b border-border-soft bg-bg pr-4 pl-5">
			<nav aria-label="面包屑">
				<ol className="m-0 flex list-none items-center gap-1.5 p-0 text-sm text-fg-3">
					<li>sfly</li>
					{crumbs.map((crumb, i) => (
						<li key={crumb} className="flex items-center gap-1.5">
							<ChevronRightIcon aria-hidden className="size-3.5" />
							{i === crumbs.length - 1 ? (
								<b aria-current="page" className="font-medium text-fg-1">
									{crumb}
								</b>
							) : (
								crumb
							)}
						</li>
					))}
				</ol>
			</nav>
			<span className="flex-1" />
			<button
				type="button"
				onClick={() => open("command-palette")}
				className="flex h-7.5 w-70 cursor-pointer items-center gap-2 rounded-lg border border-border bg-sunk pr-2 pl-2.5 text-sm text-fg-3 hover:border-border-strong"
			>
				<SearchIcon aria-hidden className="size-4" />
				搜索页面、场景、命令…
				<Keys shortcut="command-palette" className="ml-auto" />
			</button>
			{nickname && (
				<button
					type="button"
					title="修改昵称"
					onClick={() => open("nickname")}
					className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm text-fg-2 hover:bg-raised hover:text-fg-1"
				>
					<span
						aria-hidden
						className="grid size-6.5 flex-none place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
					>
						{[...nickname][0]?.toUpperCase()}
					</span>
					{nickname}
				</button>
			)}
		</header>
	);
}
