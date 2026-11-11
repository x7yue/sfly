import { orchestrationsApi, runListApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	HistoryIcon,
	KeyboardIcon,
	PanelLeftIcon,
	PlayIcon,
	PlusIcon,
	UserPenIcon,
	WorkflowIcon,
} from "lucide-react";
import { KeyHint, Keys } from "#/components/page";
import { runStatusView } from "#/components/status";
import { apiQuery } from "#/lib/api";
import { ACTION } from "#/lib/copy";
import { shortId } from "#/lib/format";
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
import type { Overlay, RunTarget } from "./overlays";
import { toggleSidebar } from "./sidebar-state";

/**
 * 命令面板（Ctrl K）：跳转页面、跳转场景、跳转到运行、运行场景、执行命令（故事 4）。
 * 分组：「跳转」来自 navigation.ts；「场景」来自场景列表（进入编排画布）；「运行」是最近的运行（进入运行监控）；
 * 「运行场景」打开该场景的运行抽屉；「命令」在下面的 commands 里登记。
 * 后续页面要加命令时往 commands 里加一项；带快捷键的命令写上 shortcut，
 * 面板里会显示对应的按键。
 */
export function CommandPalette({
	open,
	onOpenChange,
	openOverlay,
	runScenario,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	openOverlay: (overlay: Overlay) => void;
	runScenario: (target: RunTarget) => void;
}) {
	const navigate = useNavigate();
	// 「场景」分组只列出没有归档的场景。
	const orchestrations = useQuery({
		...apiQuery(orchestrationsApi.list, { query: {} }),
		enabled: open,
	});
	// 「运行」分组：最近的运行（跨场景）。
	const runs = useQuery({
		...apiQuery(runListApi.list, { query: { limit: RECENT_RUNS } }),
		enabled: open,
	});
	const scenarios = orchestrations.data?.orchestrations ?? [];

	const run = (action: () => void) => {
		onOpenChange(false);
		action();
	};

	const commands = [
		{
			id: "new-scenario",
			label: "新建场景",
			icon: PlusIcon,
			perform: () => openOverlay("new-scenario"),
		},
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
									<Keys shortcut={item.shortcut} />
								</CommandShortcut>
							</CommandItem>
						))}
					</CommandGroup>
					{scenarios.length > 0 && (
						<CommandGroup heading="场景">
							{scenarios.map((o) => (
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
					{runs.data && runs.data.runs.length > 0 && (
						<CommandGroup heading="运行">
							{runs.data.runs.map((r) => {
								const status = runStatusView(r.status, { cancelling: r.cancelling });
								return (
									<CommandItem
										key={r.id}
										value={`run:${r.id}`}
										keywords={[r.id, r.orchestration_name, r.triggered_by]}
										onSelect={() => run(() => navigate({ to: "/runs/$id", params: { id: r.id } }))}
									>
										<HistoryIcon />
										<span className="font-mono">{shortId(r.id)}</span>
										{r.orchestration_name}
										<CommandShortcut>{status.label}</CommandShortcut>
									</CommandItem>
								);
							})}
						</CommandGroup>
					)}
					{scenarios.length > 0 && (
						<CommandGroup heading="运行场景">
							{scenarios.map((o) => (
								<CommandItem
									key={o.id}
									value={`run-scenario:${o.id}`}
									keywords={[ACTION.run, o.name]}
									onSelect={() =>
										run(() => runScenario({ id: o.id, name: o.name, description: o.description }))
									}
								>
									<PlayIcon />
									{ACTION.run}「{o.name}」
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
										<Keys shortcut={c.shortcut} />
									</CommandShortcut>
								)}
							</CommandItem>
						))}
					</CommandGroup>
				</CommandList>
				<footer className="flex gap-3.5 border-t border-border-soft px-3.5 py-2 text-2xs text-fg-3">
					<span className="inline-flex items-center gap-1">
						<KeyHint keys="↑" />
						<KeyHint keys="↓" />
						选择
					</span>
					<span className="inline-flex items-center gap-1">
						<KeyHint keys="Enter" />
						执行
					</span>
					<span className="inline-flex items-center gap-1">
						<KeyHint keys="Esc" />
						关闭
					</span>
				</footer>
			</CommandRoot>
		</CommandDialog>
	);
}

/** 「运行」分组最多列出的最近运行数。 */
const RECENT_RUNS = 20;

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
