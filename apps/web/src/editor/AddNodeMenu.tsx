import { cn } from "cn";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { KIND_META } from "#/components/canvas/node-display";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type AddItem, BUILTIN_ITEMS, type PackageGroup } from "./add-node";

/**
 * 打开添加节点菜单的方式：工具条「＋」、Tab 或 /（接在当前链的链尾），
 * 或从链尾端口拖线到空白处（`drop`：接在拖出连线的节点之后，放在松开鼠标的位置）。
 */
export type AddRequest =
	| { via: "menu" }
	| {
			via: "drop";
			tail: string;
			/** 松开鼠标的屏幕坐标（菜单出现在这里）。 */
			client: { x: number; y: number };
			/** 新节点在画布上的位置。 */
			position: { x: number; y: number };
	  };

function KindChip({ kind }: { kind: AddItem["kind"] }) {
	return (
		<span
			aria-hidden
			className="grid size-4.5 flex-none place-items-center rounded-sm bg-raised-2 font-mono text-2xs leading-none font-semibold text-fg-2"
		>
			{KIND_META[kind].code}
		</span>
	);
}

/**
 * 添加节点菜单（原型 #/editor 的 addMenu）：可搜索；内置节点与各节点包的节点类型分组列出。
 * 「＋」按钮本身放在工具条最左侧（FlowCanvas 的 dockStart）；拖线到空白处时菜单出现在松开鼠标的位置，
 * 不列子流程入口（子流程入口只能由调度连线触发，不能接在链上）。
 * 选择子流程入口后菜单换成填写子流程名称的表单（名称必填、场景内唯一，SEMANTICS §1.2）。
 */
export function AddNodeMenu({
	request,
	tail,
	groups,
	subflowNameProblem,
	onOpenChange,
	onPick,
}: {
	request: AddRequest | null;
	/** 新节点接在哪个节点之后（菜单底部的提示）。 */
	tail: string | undefined;
	groups: PackageGroup[];
	/** 新子流程的名称有什么问题（为空、重名）；可以使用时返回 null。 */
	subflowNameProblem(name: string): string | null;
	onOpenChange(open: boolean): void;
	onPick(item: AddItem): void;
}) {
	const picked = useRef(false);
	const trigger = useRef<HTMLButtonElement>(null);
	/** 打开菜单前焦点所在的元素：Esc 关闭后回到这里。 */
	const opener = useRef<HTMLElement | null>(null);
	/**
	 * 搜索框一挂载就拿到焦点（React 提交阶段同步执行）。弹层自己的初始焦点要等下一帧
	 * （Base UI 的 FloatingFocusManager 用 requestAnimationFrame），按 / 后紧接着输入的字
	 * 会落在原来的焦点上丢掉，回车就选中了过滤前的第一项（#123）。
	 * 这样一来 FloatingFocusManager 记下的「打开前的焦点」成了搜索框本身，所以先在这里记下
	 * 打开前的焦点，关闭时由 finalFocus 显式交还。从子流程表单返回时焦点已在菜单里，不覆盖。
	 */
	const focusSearch = useCallback((input: HTMLInputElement | null) => {
		if (!input) return;
		const active = document.activeElement;
		const popup = input.closest('[data-slot="popover-content"]');
		if (!popup?.contains(active)) opener.current = active instanceof HTMLElement ? active : null;
		input.focus({ preventScroll: true });
	}, []);
	const [naming, setNaming] = useState(false);
	if (request === null && naming) setNaming(false);
	const drop = request?.via === "drop" ? request : null;
	const anchor = drop
		? {
				getBoundingClientRect: () =>
					DOMRect.fromRect({ x: drop.client.x, y: drop.client.y, width: 0, height: 0 }),
			}
		: undefined;
	const pick = (item: AddItem) => {
		picked.current = true;
		onPick(item);
	};
	const builtins = BUILTIN_ITEMS.filter((b) => !drop || b.kind !== "subflow_entry");

	return (
		<Popover
			open={request !== null}
			onOpenChange={(open) => {
				if (open) picked.current = false;
				onOpenChange(open);
			}}
		>
			<Tooltip>
				<TooltipTrigger
					render={
						<PopoverTrigger
							render={
								<button
									type="button"
									ref={trigger}
									aria-label="添加节点"
									className="grid size-8 cursor-pointer place-items-center rounded-full border border-border-strong bg-raised-2 text-fg-1 hover:bg-raised [&_svg]:size-4"
								/>
							}
						/>
					}
				>
					<PlusIcon />
				</TooltipTrigger>
				<TooltipContent>
					添加节点
					<Kbd>Tab</Kbd>
				</TooltipContent>
			</Tooltip>
			<PopoverContent
				aria-label="添加节点"
				anchor={anchor}
				side={drop ? "bottom" : "top"}
				align={drop ? "start" : "center"}
				sideOffset={drop ? 6 : 16}
				// 选了节点之后焦点交给新节点（由使用方处理）；Esc 关闭时回到打开前的位置，
				// 打开前页面上没有焦点时回到「＋」按钮（与 Base UI 的默认行为一致）。
				finalFocus={() => {
					if (picked.current) return false;
					const back = opener.current;
					return back?.isConnected && back !== document.body ? back : trigger.current;
				}}
				className="w-80"
			>
				{naming ? (
					<SubflowNameForm
						problemOf={subflowNameProblem}
						onBack={() => setNaming(false)}
						onCreate={(name) => pick({ kind: "subflow_entry", name })}
					/>
				) : (
					<Command loop className="bg-transparent">
						<CommandInput ref={focusSearch} placeholder="搜索节点类型…" aria-label="搜索节点类型" />
						<CommandList className="max-h-[min(360px,var(--available-height))]">
							<CommandEmpty>没有匹配的节点类型</CommandEmpty>
							<CommandGroup heading="内置">
								{builtins.map((b) => (
									<CommandItem
										key={b.kind}
										value={`builtin:${b.kind}`}
										keywords={[KIND_META[b.kind].label, b.kind, b.hint]}
										onSelect={() =>
											b.kind === "subflow_entry" ? setNaming(true) : pick({ kind: b.kind })
										}
									>
										<KindChip kind={b.kind} />
										<span>{KIND_META[b.kind].label}</span>
										<span className="ml-auto text-2xs text-fg-3">{b.hint}</span>
									</CommandItem>
								))}
							</CommandGroup>
							{groups.map((g) => (
								<CommandGroup key={g.name} heading={`${g.name} @${g.version}`}>
									{g.items.map((item) => (
										<CommandItem
											key={item.node}
											value={`package:${g.name}/${item.node}`}
											keywords={[item.title, item.node, g.name]}
											onSelect={() => pick(item)}
										>
											<KindChip kind="package" />
											<span className="truncate">{item.title}</span>
											<span className="ml-auto truncate font-mono text-2xs text-fg-3">
												{item.node}
											</span>
										</CommandItem>
									))}
								</CommandGroup>
							))}
						</CommandList>
						<p className={cn("border-t border-border-soft px-3 py-2 text-2xs text-fg-3")}>
							{tail ? (
								<>
									新节点接在 <span className="font-mono text-fg-2">{tail}</span> 之后
									{drop ? "" : " · 也可从链尾端口拖线到空白处"}
								</>
							) : (
								"场景没有入口节点，新节点不会接到链上"
							)}
						</p>
					</Command>
				)}
			</PopoverContent>
		</Popover>
	);
}

/** 新建子流程：填写名称。空名称在提交时提示，重名随输入提示。 */
function SubflowNameForm({
	problemOf,
	onBack,
	onCreate,
}: {
	problemOf(name: string): string | null;
	onBack(): void;
	onCreate(name: string): void;
}) {
	const inputId = useId();
	const input = useRef<HTMLInputElement>(null);
	const [name, setName] = useState("");
	const [submitted, setSubmitted] = useState(false);
	const problem = problemOf(name);
	const shown = submitted || name.trim() !== "" ? problem : null;
	useEffect(() => input.current?.focus(), []);
	return (
		<form
			aria-label="新建子流程"
			className="flex flex-col gap-2 p-3"
			onSubmit={(e) => {
				e.preventDefault();
				setSubmitted(true);
				if (problem === null) onCreate(name);
			}}
		>
			<label htmlFor={inputId} className="text-sm text-fg-2">
				子流程名称
			</label>
			<Input
				ref={input}
				id={inputId}
				value={name}
				placeholder="例如 压测监控"
				aria-invalid={shown !== null || undefined}
				onChange={(e) => setName(e.target.value)}
			/>
			{shown && <p className="m-0 text-2xs text-danger-fg">{shown}</p>}
			<p className="m-0 text-2xs text-fg-3">场景内唯一；停止子流程节点按名称选择子流程。</p>
			<div className="flex justify-end gap-1.5">
				<Button type="button" variant="ghost" size="sm" onClick={onBack}>
					返回
				</Button>
				<Button type="submit" size="sm">
					新建子流程
				</Button>
			</div>
		</form>
	);
}
