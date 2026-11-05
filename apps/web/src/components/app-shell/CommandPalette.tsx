import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { KeyboardIcon, PanelLeftIcon, UserPenIcon, WorkflowIcon } from "lucide-react";
import { Keys } from "#/components/page";
import { listOrchestrations } from "#/lib/api";
import { shortcutById } from "#/lib/shortcuts";
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandShortcut,
} from "@/components/ui/command";
import { NAV_ITEMS } from "./navigation";
import type { Overlay } from "./overlays";
import { toggleSidebar } from "./sidebar-state";

/**
 * 命令面板（Ctrl K）：跳转页面、跳转场景、执行命令。
 * 分组：「跳转」来自 navigation.ts；「场景」来自场景列表；「命令」在下面的 commands 里登记。
 * 后续页面要加命令（如「新建场景」）时往 commands 里加一项；带快捷键的命令写上 shortcut，
 * 面板里会显示对应的按键。
 */
export function CommandPalette({
	open,
	onOpenChange,
	openOverlay,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	openOverlay: (overlay: Overlay) => void;
}) {
	const navigate = useNavigate();
	const orchestrations = useQuery({
		queryKey: ["orchestrations"],
		queryFn: listOrchestrations,
		enabled: open,
	});

	const run = (action: () => void) => {
		onOpenChange(false);
		action();
	};

	const commands = [
		{
			id: "shortcuts",
			label: "打开快捷键面板",
			icon: KeyboardIcon,
			shortcut: "shortcuts-help" as const,
			// 先关掉命令面板再打开另一个浮层，焦点仍回到打开命令面板之前的位置。
			perform: () => openOverlay("shortcuts"),
		},
		{
			id: "sidebar",
			label: "折叠 / 展开侧边栏",
			icon: PanelLeftIcon,
			shortcut: "toggle-sidebar" as const,
			perform: toggleSidebar,
		},
		{
			id: "nickname",
			label: "修改昵称",
			icon: UserPenIcon,
			perform: () => openOverlay("nickname"),
		},
	];

	return (
		<CommandDialog open={open} onOpenChange={onOpenChange}>
			<CommandRoot>
				<CommandInput placeholder="搜索页面、场景，或输入命令…" aria-label="命令" />
				<CommandList>
					<CommandEmpty>没有匹配的结果</CommandEmpty>
					<CommandGroup heading="跳转">
						{NAV_ITEMS.map((item) => (
							<CommandItem
								key={item.to}
								value={`nav:${item.to}`}
								keywords={[item.label]}
								onSelect={() => run(() => navigate({ to: item.to }))}
							>
								<item.icon />
								{item.label}
								<CommandShortcut>
									<Keys keys={shortcutById(item.shortcut).keys} />
								</CommandShortcut>
							</CommandItem>
						))}
					</CommandGroup>
					{orchestrations.data && orchestrations.data.orchestrations.length > 0 && (
						<CommandGroup heading="场景">
							{orchestrations.data.orchestrations.map((o) => (
								<CommandItem
									key={o.id}
									value={`scenario:${o.id}`}
									keywords={[o.name]}
									onSelect={() =>
										run(() => navigate({ to: "/orchestrations/$id", params: { id: o.id } }))
									}
								>
									<WorkflowIcon />
									{o.name}
								</CommandItem>
							))}
						</CommandGroup>
					)}
					<CommandGroup heading="命令">
						{commands.map((c) => (
							<CommandItem
								key={c.id}
								value={`command:${c.id}`}
								keywords={[c.label]}
								onSelect={() => run(c.perform)}
							>
								<c.icon />
								{c.label}
								{c.shortcut && (
									<CommandShortcut>
										<Keys keys={shortcutById(c.shortcut).keys} />
									</CommandShortcut>
								)}
							</CommandItem>
						))}
					</CommandGroup>
				</CommandList>
				<footer className="flex gap-3.5 border-t border-border-soft px-3.5 py-2 text-2xs text-fg-3">
					<span className="inline-flex items-center gap-1">
						<Keys keys="↑" />
						<Keys keys="↓" />
						选择
					</span>
					<span className="inline-flex items-center gap-1">
						<Keys keys="Enter" />
						执行
					</span>
					<span className="inline-flex items-center gap-1">
						<Keys keys="Esc" />
						关闭
					</span>
				</footer>
			</CommandRoot>
		</CommandDialog>
	);
}

/** 按名称子串匹配（cmdk 默认的模糊匹配对中文不友好）；value 只是唯一标识，名称放在 keywords。 */
const substring = (_value: string, search: string, keywords?: string[]) =>
	(keywords ?? []).join(" ").toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0;

function CommandRoot({ children }: { children: React.ReactNode }) {
	return (
		<Command filter={substring} loop label="命令面板">
			{children}
		</Command>
	);
}
