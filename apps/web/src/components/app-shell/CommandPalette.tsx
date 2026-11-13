import { orchestrationsApi, runListApi } from "@sfly/schema";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCommandState } from "cmdk";
import {
	CircleStopIcon,
	CircleXIcon,
	HistoryIcon,
	KeyboardIcon,
	ListFilterIcon,
	type LucideIcon,
	PanelLeftIcon,
	PlayIcon,
	PlusIcon,
	RadioIcon,
	RotateCcwIcon,
	SaveIcon,
	UserPenIcon,
	WorkflowIcon,
} from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { KeyHint, Keys } from "#/components/page";
import { runShortcut, usePaletteCommands } from "#/components/shortcuts";
import { runStatusView } from "#/components/status";
import { apiQuery } from "#/lib/api";
import { ACTION } from "#/lib/copy";
import { shortId } from "#/lib/format";
import type { PaletteShortcutId } from "#/lib/shortcuts";
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
 * 分组：「当前页面」是当前页面绑定了处理函数、并在注册表里带 `palette` 的快捷键（取消运行、保存……），名称和按键
 * 都取自注册表，页面状态变了（运行结束、没有失败节点）就自动出现或消失；「跳转」来自 navigation.ts；
 * 「场景」来自场景列表（进入编排画布）；「运行」是最近的运行（进入运行监控）；「运行场景」打开该场景的运行抽屉；
 * 「命令」在下面的 commands 里登记。
 * 页面要加命令先在注册表登记并加 `palette`，再用 useShortcut 绑定；与页面无关的命令往 commands 里加一项，
 * 带快捷键的命令写上 shortcut，面板里会显示对应的按键。
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
	const pageCommands = usePaletteCommands();
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
			shortcut: "new-scenario" as const,
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
				<ResultsStatus />
				<CommandList className="overscroll-contain">
					<CommandEmpty>没有匹配的结果</CommandEmpty>
					{pageCommands.length > 0 && (
						<CommandGroup heading="当前页面">
							{pageCommands.map((c) => {
								const Icon = PAGE_COMMAND_ICON[c.id];
								return (
									<CommandItem
										key={c.id}
										value={`page:${c.id}`}
										keywords={[c.label]}
										onSelect={() => run(() => runShortcut(c.id))}
									>
										<Icon />
										{c.label}
										<CommandShortcut>
											<Keys shortcut={c.id} />
										</CommandShortcut>
									</CommandItem>
								);
							})}
						</CommandGroup>
					)}
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
				<footer className="flex gap-3.5 border-t border-border-soft px-3.5 py-2 text-xs text-fg-3">
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

const PAGE_COMMAND_ICON: Record<PaletteShortcutId, LucideIcon> = {
	"monitor-next-failure": CircleXIcon,
	"monitor-errors-only": ListFilterIcon,
	"monitor-follow-live": RadioIcon,
	"monitor-rerun": RotateCcwIcon,
	"monitor-cancel": CircleStopIcon,
	"canvas-save": SaveIcon,
	"canvas-run": PlayIcon,
};

/** 「运行」分组最多列出的最近运行数。 */
const RECENT_RUNS = 20;

/** 按名称子串匹配（cmdk 默认的模糊匹配对中文不友好）；value 只是唯一标识，名称放在 keywords。 */
const substring = (_value: string, search: string, keywords?: string[]) =>
	(keywords ?? []).join(" ").toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0;

/**
 * cmdk 首次渲染时在自己的布局副作用里选中第一项，那时 aria-selected 还没渲染，
 * aria-activedescendant 因此为空：读屏用户要按一次方向键才知道当前项。
 * 第一项渲染好后补一次「End、Home」让 cmdk 重算当前项：这两个键按位置选，
 * 方向键要从 DOM 里的当前项出发，连按会绕到最后一项。
 */
function useAnnounceCurrentItem(root: RefObject<HTMLDivElement | null>) {
	useEffect(() => {
		let frame = 0;
		let tries = 0;
		const sync = () => {
			const input = root.current?.querySelector("[cmdk-input]");
			if (!root.current?.querySelector('[cmdk-item][aria-selected="true"]')) {
				if (++tries < 30) frame = requestAnimationFrame(sync);
				return;
			}
			if (input?.getAttribute("aria-activedescendant")) return;
			for (const key of ["End", "Home"]) {
				input?.dispatchEvent(
					new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
				);
			}
		};
		frame = requestAnimationFrame(sync);
		return () => cancelAnimationFrame(frame);
	}, [root]);
}

/** CommandEmpty 是 presentation，读屏不会读出，所以结果数和「没有匹配的结果」都由这里读。 */
function ResultsStatus() {
	const search = useCommandState((state) => state.search);
	const count = useCommandState((state) => state.filtered.count);
	const [text, setText] = useState("");
	useEffect(() => {
		if (!search.trim()) {
			setText("");
			return;
		}
		const timer = setTimeout(
			() => setText(count === 0 ? "没有匹配的结果" : `${count} 条结果`),
			300,
		);
		return () => clearTimeout(timer);
	}, [search, count]);
	return <output className="sr-only">{text}</output>;
}

function CommandRoot({ children }: { children: React.ReactNode }) {
	const root = useRef<HTMLDivElement>(null);
	useAnnounceCurrentItem(root);
	return (
		<Command ref={root} filter={substring} loop label="命令面板">
			{children}
		</Command>
	);
}
