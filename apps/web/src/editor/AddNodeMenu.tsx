import type { Position } from "@sfly/orchestration";
import { cn } from "cn";
import { PlusIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { KIND_META } from "#/components/canvas/node-display";
import { KIND_CHIP } from "#/components/canvas/zoom-text";
import { shortcutKeys, shortcutText } from "#/lib/shortcuts";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
	type AddItem,
	availableBuiltins,
	type BuiltinItem,
	type BuiltinKind,
	builtinValue,
	itemValue,
	type PackageGroup,
	type PackageItem,
	packageValue,
	recentItems,
} from "./add-node";
import { readRecentNodes, rememberRecentNode } from "./recent-nodes";
import { AsyncForm, FormFooter, SubflowNameForm } from "./subflow-forms";

/** 菜单出现在哪、新节点放在哪。 */
interface AddPlacement {
	/** 菜单出现的屏幕坐标（松开鼠标、右键的位置）；不给时在「＋」按钮上方。 */
	client?: Position;
	/**
	 * 新节点在画布上的位置；不给时放在来源节点右侧，没有来源则放在视口中心。
	 * 没有来源时是卡片中心（右键处），其余是卡片左上角（拖线松开处对着卡片左边缘的中点）。
	 */
	position?: Position;
}

/**
 * 一次添加节点的请求。添加分两种（#183）：
 * - `free`，没有来源：工具条「＋」、`/`、空白处右键「添加节点」——新节点不连线，成为游离节点；
 * - `after`，有来源：从端口拖线到空白处、焦点在节点上按 Tab、节点菜单「在后面添加节点」、在连线上插入——
 *   新节点接在来源节点 `after` 之后，来源节点不是链尾时插在它和下一个节点 `before` 之间
 *   （编辑器按当前连线填写；在连线上插入时就是连线的终点）。
 * 另外，`dispatch`：从异步任务节点的调度端口拖线到空白处，只新建子流程入口并连上调度连线（#187），
 * 菜单直接是新建子流程的表单。
 */
export type AddRequest =
	| ({ kind: "free" } & AddPlacement)
	| ({ kind: "after"; after: string; before?: string } & AddPlacement)
	| { kind: "dispatch"; from: string; client: Position; position: Position };

function KindChip({ kind }: { kind: AddItem["kind"] }) {
	const Icon = KIND_META[kind].icon;
	return (
		<span aria-hidden className={cn(KIND_CHIP, "text-2xs")}>
			<Icon strokeWidth={2} />
		</span>
	);
}

/**
 * 添加节点菜单（原型 #/editor 的 addMenu）：可搜索；内置节点与各节点包的节点类型分组列出。
 * 「＋」按钮本身放在工具条最左侧（FlowCanvas 的 dockStart）；拖线到空白处、空白处右键时菜单出现在鼠标的位置。
 * 有来源节点时不列子流程入口（子流程入口只能由调度连线触发，不能接在链上）。菜单底部写明这次是接在谁之后还是不连线。
 * 「最近使用」所有场景共用，只在搜索框为空时显示；从调度连线新建的子流程不计入。
 * 选择子流程入口后菜单换成填写子流程名称的表单（名称必填、场景内唯一，SEMANTICS §1.2）；选择异步任务后换成
 * 可以勾选「同时新建子流程」的表单（#187）。表单在 subflow-forms.tsx。
 */
export function AddNodeMenu({
	request,
	groups,
	subflowNameProblem,
	onOpenChange,
	onPick,
}: {
	request: AddRequest | null;
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
	/** 已经记下过打开前焦点的弹层（每次打开都是新的弹层元素）。 */
	const seen = useRef(new WeakSet<Element>());
	/**
	 * 搜索框（或换成的表单里第一个输入框）一挂载就拿到焦点（React 提交阶段同步执行）。弹层自己的初始焦点要等下一帧
	 * （Base UI 的 FloatingFocusManager 用 requestAnimationFrame），按 / 后紧接着输入的字
	 * 会落在原来的焦点上丢掉，回车就选中了过滤前的第一项（#123）。
	 * 这样一来 FloatingFocusManager 记下的「打开前的焦点」成了搜索框本身，所以先在这里记下
	 * 打开前的焦点，关闭时由 finalFocus 显式交还。在列表和表单之间切换时是同一个弹层，不覆盖
	 * （切换时原来的焦点元素已经卸载，不能按焦点在不在弹层里判断）。
	 */
	const focusFirst = useCallback((input: HTMLInputElement | null) => {
		if (!input) return;
		const popup = input.closest('[data-slot="popover-content"]');
		if (popup && !seen.current.has(popup)) {
			seen.current.add(popup);
			const active = document.activeElement;
			opener.current = active instanceof HTMLElement ? active : null;
		}
		input.focus({ preventScroll: true });
	}, []);
	/** 选了子流程入口或异步任务之后，菜单换成对应的表单。 */
	const [form, setForm] = useState<"subflow" | "async" | null>(null);
	if (request === null && form !== null) setForm(null);
	const [query, setQuery] = useState("");
	if (request === null && query !== "") setQuery("");
	const [recent, setRecent] = useState(readRecentNodes);
	// 每次打开时清掉上一次「选了节点」的标记：Tab、拖线、右键打开不经过 Popover 的 onOpenChange，
	// 不清掉的话上一次选过节点后再打开、按 Esc 关闭，焦点就回不到打开前的位置。
	const wasOpen = useRef(false);
	if (request !== null && !wasOpen.current) picked.current = false;
	wasOpen.current = request !== null;
	const at = request?.client;
	const after = request?.kind === "after" ? request.after : undefined;
	const before = request?.kind === "after" ? request.before : undefined;
	const dispatch = request?.kind === "dispatch" ? request.from : undefined;
	const anchor = at
		? { getBoundingClientRect: () => DOMRect.fromRect({ x: at.x, y: at.y, width: 0, height: 0 }) }
		: undefined;
	const pick = (item: AddItem) => {
		picked.current = true;
		if (!dispatch) setRecent(rememberRecentNode(itemValue(item)));
		onPick(item);
	};
	const pickBuiltin = (kind: BuiltinKind) =>
		kind === "async"
			? setForm("async")
			: kind === "subflow_entry"
				? setForm("subflow")
				: pick({ kind });
	const builtins = availableBuiltins(after !== undefined);
	const recents = query === "" ? recentItems(recent, builtins, groups) : [];

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
					{shortcutKeys("canvas-add")
						.flat()
						.map((key) => (
							<Kbd key={key}>{key}</Kbd>
						))}
				</TooltipContent>
			</Tooltip>
			<PopoverContent
				aria-label="添加节点"
				anchor={anchor}
				side={at ? "bottom" : "top"}
				align={at ? "start" : "center"}
				sideOffset={at ? 6 : 16}
				// 选了节点之后焦点交给新节点（由使用方处理）；Esc 关闭时回到打开前的位置，
				// 打开前页面上没有焦点时回到「＋」按钮（与 Base UI 的默认行为一致）。
				finalFocus={() => {
					if (picked.current) return false;
					const back = opener.current;
					return back?.isConnected && back !== document.body ? back : trigger.current;
				}}
				className="w-80"
			>
				{dispatch ? (
					<SubflowNameForm
						focusRef={focusFirst}
						problemOf={subflowNameProblem}
						footer={
							<>
								调度连线从 <span className="font-mono text-fg-2">{dispatch}</span>{" "}
								连到新的子流程入口
							</>
						}
						onCreate={(name) => pick({ kind: "subflow_entry", name })}
					/>
				) : form === "subflow" ? (
					<SubflowNameForm
						focusRef={focusFirst}
						problemOf={subflowNameProblem}
						onBack={() => setForm(null)}
						onCreate={(name) => pick({ kind: "subflow_entry", name })}
					/>
				) : form === "async" ? (
					<AsyncForm
						focusRef={focusFirst}
						problemOf={subflowNameProblem}
						footer={<AddFooter after={after} before={before} />}
						onBack={() => setForm(null)}
						onCreate={(subflow) =>
							pick(subflow === undefined ? { kind: "async" } : { kind: "async", subflow })
						}
					/>
				) : (
					<Command loop className="bg-transparent">
						<CommandInput
							ref={focusFirst}
							value={query}
							onValueChange={setQuery}
							placeholder="搜索节点类型…"
							aria-label="搜索节点类型"
						/>
						<CommandList className="max-h-[min(360px,var(--available-height))]">
							<CommandEmpty>没有匹配的节点类型</CommandEmpty>
							{recents.length > 0 && (
								<CommandGroup heading="最近使用">
									{recents.map(({ value, entry }) => (
										<CommandItem
											key={value}
											value={`recent:${value}`}
											onSelect={() =>
												entry.kind === "package" ? pick(entry) : pickBuiltin(entry.kind)
											}
										>
											{entry.kind === "package" ? (
												<PackageRow item={entry} detail={`${entry.package}/${entry.node}`} />
											) : (
												<BuiltinRow item={entry} />
											)}
										</CommandItem>
									))}
								</CommandGroup>
							)}
							<CommandGroup heading="内置">
								{builtins.map((b) => (
									<CommandItem
										key={b.kind}
										value={builtinValue(b.kind)}
										keywords={[KIND_META[b.kind].label, b.kind, b.hint]}
										onSelect={() => pickBuiltin(b.kind)}
									>
										<BuiltinRow item={b} />
									</CommandItem>
								))}
							</CommandGroup>
							{groups.map((g) => (
								<CommandGroup key={g.name} heading={`${g.name} @${g.version}`}>
									{g.items.map((item) => (
										<CommandItem
											key={item.node}
											value={packageValue(item)}
											keywords={[item.title, item.node, g.name]}
											onSelect={() => pick(item)}
										>
											<PackageRow item={item} detail={item.node} />
										</CommandItem>
									))}
								</CommandGroup>
							))}
						</CommandList>
						<FormFooter>
							<AddFooter after={after} before={before} />
						</FormFooter>
					</Command>
				)}
			</PopoverContent>
		</Popover>
	);
}

function BuiltinRow({ item }: { item: BuiltinItem }) {
	return (
		<>
			<KindChip kind={item.kind} />
			<span>{KIND_META[item.kind].label}</span>
			<span className="ml-auto text-xs text-fg-3">{item.hint}</span>
		</>
	);
}

/** detail 是右侧的等宽说明：在包分组里是节点名，在「最近使用」里是 包名/节点名。 */
function PackageRow({ item, detail }: { item: PackageItem; detail: string }) {
	return (
		<>
			<KindChip kind="package" />
			<span className="truncate">{item.title}</span>
			<span className="ml-auto truncate font-mono text-2xs text-fg-3">{detail}</span>
		</>
	);
}

/** 菜单底部写明这次添加是插在两个节点之间、接在谁之后还是不连线。 */
function AddFooter({ after, before }: { after: string | undefined; before: string | undefined }) {
	return after && before ? (
		<>
			新节点插在 <span className="font-mono text-fg-2">{after}</span> 和{" "}
			<span className="font-mono text-fg-2">{before}</span> 之间
		</>
	) : after ? (
		<>
			新节点接在 <span className="font-mono text-fg-2">{after}</span> 之后
		</>
	) : (
		`新节点不连线 · 从端口拖线到空白处，或在节点上按 ${shortcutText("canvas-add-tab")}，可以接在节点之后`
	);
}
