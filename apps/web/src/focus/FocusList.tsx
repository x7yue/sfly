import { FOCUS_ITEM_TITLE_MAX, type FocusItemInput, type FocusItemView } from "@sfly/schema";
import { cn } from "cn";
import { ChevronDownIcon, ChevronUpIcon, GripVerticalIcon, XIcon } from "lucide-react";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { formatDateTime } from "#/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { focusKey, indexAfterDrop, moveItem, renamedItem, sameFocusList } from "./focus-list-edit";
import { focusInputOf, useFocusItems } from "./use-focus-items";

const nameOf = (item: FocusItemView) => item.title ?? item.chart;

/** 失效的项为什么失效；可用的项没有。 */
function staleReason(item: FocusItemView, headVersion: number): string | null {
	switch (item.status) {
		case "ok":
			return null;
		case "node_missing":
			return item.last_version === null
				? `节点 ${item.node_id} 不在任何版本里（复制场景时带过来的），运行里不会显示这一项`
				: `节点 ${item.node_id} 不在最新版本 v${headVersion} 里，只在运行 v${item.last_version} 及更早版本时显示`;
		case "chart_missing":
			return `这个版本的节点没有图表 ${item.chart}`;
	}
}

/** 刚移除的一项：撤销就是把移除之前的列表写回去。 */
interface Removed {
	name: string;
	key: string;
	before: FocusItemInput[];
	after: FocusItemInput[];
}

/** 正在拖动的一项，和它现在悬在哪个空位上（第 `slot` 项的前面；项数是末尾；还没悬在任何位置时为 null）。 */
interface Drag {
	from: number;
	slot: number | null;
}

/**
 * 场景设置的「关注项」页（画布编辑模式，不选节点时的检查器）：按显示顺序列出本场景的全部关注项，
 * 可以拖动手柄或用上移、下移排序、改名（清空回到图表标题）、移除（移除后马上可以撤销）。
 * 失效的项照样列出并写明原因，也占名额。每次修改都是整份替换（`useFocusItems().replace`），立即生效，不产生新版本。
 *
 * 排序用上移、下移按钮时，焦点跟着那一项走，读屏播报新位置；到头的按钮用 `aria-disabled`，焦点才不会掉。
 */
export function FocusListPage({ orchestrationId }: { orchestrationId: string }) {
	const focus = useFocusItems(orchestrationId);
	const { items, edit } = focus;
	const current = items.map(focusInputOf);
	const [removed, setRemoved] = useState<Removed | null>(null);
	const [drag, setDrag] = useState<Drag | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const page = useRef<HTMLDivElement>(null);
	const refocus = useRef<string | null>(null);

	// 列表变了（新顺序已经画出来）以后，把焦点放回要去的那个控件：按钮随着那一项换了位置，撤销后回到恢复的那一行。
	// biome-ignore lint/correctness/useExhaustiveDependencies: 只在列表变化时执行
	useEffect(() => {
		const target = refocus.current;
		if (target === null) return;
		refocus.current = null;
		page.current?.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(target)}"]`)?.focus();
	}, [items]);

	const undoable = removed !== null && sameFocusList(current, removed.after);

	const moveTo = (from: number, to: number, refocusOn?: string) => {
		const item = items[from];
		if (item === undefined || to < 0 || to >= items.length || to === from) return;
		setRemoved(null);
		if (refocusOn !== undefined) refocus.current = refocusOn;
		focus.replace(moveItem(current, from, to));
		setAnnouncement(`${nameOf(item)} 移到第 ${to + 1} 位，共 ${items.length} 项`);
	};

	const rename = (index: number, typed: string) => {
		const was = current[index];
		if (was === undefined) return;
		const now = renamedItem(was, typed);
		if (sameFocusList([was], [now])) return;
		setRemoved(null);
		focus.replace(current.map((item, i) => (i === index ? now : item)));
	};

	const remove = (index: number) => {
		const item = items[index];
		if (item === undefined) return;
		const after = current.filter((_, i) => i !== index);
		setRemoved({ name: nameOf(item), key: focusKey(item), before: current, after });
		refocus.current = "undo";
		focus.replace(after);
		setAnnouncement(`已移除 ${nameOf(item)}，可以撤销`);
	};

	const undo = () => {
		if (removed === null) return;
		refocus.current = `${removed.key}/name`;
		focus.replace(removed.before);
		setAnnouncement(`已恢复 ${removed.name}`);
		setRemoved(null);
	};

	const dragStart = (e: DragEvent<HTMLElement>, index: number) => {
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setData("text/plain", String(index));
		const row = e.currentTarget.closest("li");
		if (row) e.dataTransfer.setDragImage(row, 12, 16);
		setDrag({ from: index, slot: null });
	};
	const dragOver = (e: DragEvent<HTMLLIElement>, index: number) => {
		if (drag === null) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
		const box = e.currentTarget.getBoundingClientRect();
		const slot = e.clientY < box.top + box.height / 2 ? index : index + 1;
		if (slot !== drag.slot) setDrag({ ...drag, slot });
	};
	const drop = (e: DragEvent<HTMLLIElement>) => {
		e.preventDefault();
		if (drag?.slot != null) moveTo(drag.from, indexAfterDrop(drag.from, drag.slot));
		setDrag(null);
	};
	const dropLine = (index: number) => {
		if (drag?.slot == null || indexAfterDrop(drag.from, drag.slot) === drag.from) return null;
		if (drag.slot === index) return "top";
		return drag.slot === items.length && index === items.length - 1 ? "bottom" : null;
	};

	return (
		<div ref={page} className="flex flex-col gap-2.5">
			<div className="flex flex-col gap-1 text-xs text-fg-3">
				<p className="m-0">
					本场景的关注项已用 <b className="font-mono font-medium text-fg-1">{focus.used}</b> /{" "}
					{focus.limit}
					{focus.stale > 0 && `（含 ${focus.stale} 项已失效的）`}
				</p>
				{edit && (
					<p className="m-0 text-fg-2">
						最后修改：<b className="font-medium text-fg-1">{edit.updated_by}</b> ·{" "}
						{formatDateTime(edit.updated_at)}，{edit.summary}
					</p>
				)}
			</div>
			{undoable && (
				<div className="flex items-center gap-2 rounded-md border border-border bg-raised px-2.5 py-2 text-xs text-fg-2">
					<span className="min-w-0 flex-1">
						已移除「{removed.name}」，正在跑的运行也去掉了这一项。
					</span>
					<Button size="sm" data-focus-id="undo" onClick={undo}>
						撤销
					</Button>
				</div>
			)}
			{items.length > 0 ? (
				<>
					<p className="m-0 text-xs text-fg-2">
						运行时按这个顺序显示，有异常的项临时排到最前。拖动左侧手柄，或用上移、下移调整顺序。
					</p>
					<ul
						aria-label="关注项"
						onDragLeave={(e) => {
							if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
								setDrag((d) => d && { ...d, slot: null });
							}
						}}
						className="m-0 flex list-none flex-col p-0"
					>
						{items.map((item, index) => {
							const key = focusKey(item);
							const reason = staleReason(item, focus.headVersion);
							const line = dropLine(index);
							const name = nameOf(item);
							return (
								<li
									key={key}
									onDragOver={(e) => dragOver(e, index)}
									onDrop={drop}
									className={cn(
										"relative flex items-start gap-1.5 border-t border-border-soft py-2 first:border-t-0",
										drag?.from === index && "opacity-50",
									)}
								>
									{line && (
										<span
											aria-hidden="true"
											className={cn(
												"pointer-events-none absolute inset-x-0 h-0.5 bg-selected",
												line === "top" ? "-top-px" : "-bottom-px",
											)}
										/>
									)}
									<span
										draggable
										data-focus-handle=""
										aria-hidden="true"
										onDragStart={(e) => dragStart(e, index)}
										onDragEnd={() => setDrag(null)}
										className="flex h-7.5 flex-none cursor-grab items-center text-fg-3 hover:text-fg-1 active:cursor-grabbing"
									>
										<GripVerticalIcon className="size-3.5" />
									</span>
									<div className="min-w-0 flex-1">
										<NameField
											item={item}
											focusId={`${key}/name`}
											onRename={(typed) => rename(index, typed)}
										/>
										<div className="px-2.25 text-xs text-fg-3">
											<span className="font-mono">{item.node_id}</span> · 图表 {item.chart}
										</div>
										{reason && <div className="px-2.25 text-xs text-fg-3">{reason}</div>}
									</div>
									<div className="flex h-7.5 flex-none items-center gap-0.5">
										{item.chart_type !== undefined && (
											<Badge className="mr-1">{item.chart_type === "stat" ? "数值" : "图表"}</Badge>
										)}
										<MoveButton
											label={`上移 ${name}`}
											focusId={`${key}/up`}
											disabled={index === 0}
											onMove={() => moveTo(index, index - 1, `${key}/up`)}
										>
											<ChevronUpIcon />
										</MoveButton>
										<MoveButton
											label={`下移 ${name}`}
											focusId={`${key}/down`}
											disabled={index === items.length - 1}
											onMove={() => moveTo(index, index + 1, `${key}/down`)}
										>
											<ChevronDownIcon />
										</MoveButton>
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={`移除关注项 ${name}`}
											onClick={() => remove(index)}
										>
											<XIcon />
										</Button>
									</div>
								</li>
							);
						})}
					</ul>
				</>
			) : (
				<p className="m-0 text-xs text-fg-3">还没有关注项。</p>
			)}
			<p className="m-0 text-xs text-fg-3">
				关注项属于场景设置，不属于版本：改动立即生效，正在跑的运行也会跟着变，不产生新版本。
				要添加：选中节点，在「说明与指标」里对图表点「关注」。
			</p>
			<output className="sr-only">{announcement}</output>
		</div>
	);
}

/**
 * 关注项的名字：输入框里是现在的名字（没起名时是图表标题），失焦或按回车写入，Esc 放弃这次输入。
 * 清空、或者写成图表标题，都回到没起名（renamedItem）。
 */
function NameField({
	item,
	focusId,
	onRename,
}: {
	item: FocusItemView;
	focusId: string;
	onRename(typed: string): void;
}) {
	const [typed, setTyped] = useState<string | null>(null);
	const commit = () => {
		if (typed === null) return;
		setTyped(null);
		onRename(typed);
	};
	return (
		<Input
			aria-label={`名称（${item.node_id} · ${item.chart}）`}
			data-focus-id={focusId}
			maxLength={FOCUS_ITEM_TITLE_MAX}
			value={typed ?? nameOf(item)}
			onChange={(e) => setTyped(e.target.value)}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === "Enter") commit();
				else if (e.key === "Escape" && typed !== null) {
					e.preventDefault();
					setTyped(null);
				}
			}}
			className="border-transparent bg-transparent font-medium hover:border-border-control focus:bg-sunk"
		/>
	);
}

/** 上移、下移按钮：到头的用 `aria-disabled`，键盘焦点停在原处（`disabled` 会让焦点掉到页面上）。 */
function MoveButton({
	label,
	focusId,
	disabled,
	onMove,
	children,
}: {
	label: string;
	focusId: string;
	disabled: boolean;
	onMove(): void;
	children: React.ReactNode;
}) {
	return (
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label={label}
			aria-disabled={disabled || undefined}
			data-focus-id={focusId}
			onClick={() => {
				if (!disabled) onMove();
			}}
			className="aria-disabled:pointer-events-none aria-disabled:opacity-40"
		>
			{children}
		</Button>
	);
}
