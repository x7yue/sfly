import type { LogLineView } from "@sfly/schema";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "cn";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { LOG_LEVEL_LABEL } from "#/lib/copy";
import {
	formatClockMs,
	formatFullDateTime,
	formatFullDateTimeMs,
	spansOtherDay,
	TIME_NOT_RECORDED,
} from "#/lib/format";
import { ContextMenu, type ContextMenuAnchor, ContextMenuItem } from "@/components/ui/context-menu";
import { type LogTimeKind, logLineTime } from "./log-time-kind";

/** 日志级别的颜色：INFO 不上色，只有 WARN / ERROR 着色，DEBUG 用辅助文字色（DESIGN-SYSTEM 2.4）。 */
export const LOG_LEVEL_STYLE: Record<LogLineView["level"], string> = {
	debug: "text-log-debug",
	info: "text-log-info",
	warn: "text-log-warn",
	error: "text-log-error",
};

/** 离顶部多近时加载更早的一页（像素）。 */
const LOAD_OLDER_AT = 120;
/** 离底部多近时加载更新的一页（像素）：定位到日志中间一页后，列表底部之后还有行。 */
const LOAD_NEWER_AT = 120;

/** 「这一刻」行的键：不会和任何日志行的键相同（行键是序号，或「任务 ID:序号」）。 */
const MOMENT_KEY = "moment";

/**
 * 定位到某一刻（#347）后列表怎么显示：正好有一行时高亮它，没有时在那一刻的位置插一条「这一刻」，并滚动到它。
 * 高亮用 `selected-row` 的中性白色短条，不用青色。
 */
export interface LogReveal<L> {
	/** 同一次定位的标识：换了就重新滚动到它（读者可能已经滚到别处）。 */
	id: unknown;
	/** 那一刻（控制面时间，ISO），写在「这一刻」上。 */
	at: string;
	/** 是不是正好对应那一刻的行；没有这样的行时为 null，改为在那一刻的位置标出「这一刻」。 */
	exact: ((line: L) => boolean) | null;
	/** 这一行是不是不早于那一刻：「这一刻」插在第一个这样的行前面。 */
	fromMoment: (line: L) => boolean;
}

/** 列表里的一项：一行日志，或「这一刻」（`line` 为 null）。 */
interface Row<L> {
	key: string;
	line: L | null;
}

/** 没有控制面时间的行（升级之前写入的）不能定位的原因。 */
const NOT_LOCATABLE = "这行日志没有记录控制面时间，不能在时间轴上定位";

const fullTime = (iso: string | null) => (iso ? formatFullDateTime(iso) : TIME_NOT_RECORDED);

/** 行的网格列：时间（只有时刻 / 带日期）、级别、来源节点（合并视图才有）、来源、正文。 */
const COLUMNS = {
	clock: {
		plain: "grid-cols-[96px_44px_52px_1fr]",
		origin: "grid-cols-[96px_44px_140px_52px_1fr]",
	},
	dated: {
		plain: "grid-cols-[168px_44px_52px_1fr]",
		origin: "grid-cols-[168px_44px_140px_52px_1fr]",
	},
};

/**
 * 日志行（虚拟滚动）：停在底部时跟随新行（实时跟随），滚到顶部时加载更早的一页（加载后视口内容不跳动）。
 * 时间列按 timeKind 显示 Agent 时间或控制面时间（ADR 0018），悬停时两种都给出；平时只显示时刻，
 * 列表里有一行显示的时间不在运行开始那天（day）时整列都带上日期。
 * 整个列表是一个 Tab 停靠点（漫游焦点），Tab 不必穿过几十上百行：进来落在上次停留的行（没有就是视口里第一行），
 * 行间用方向键、PageUp / PageDown、Home / End 移动。
 * 定位到某一刻时（`reveal`）列表停在那一刻、不跟随末尾；那一刻的位置在日志中间时（`hasNewer`）滚动到底部加载更新的一页，
 * 读到末尾之前不跟随。「这一刻」是列表里的一项，不能聚焦，方向键跳过它。
 * 点一行把它的控制面时间标到时间轴上（onPick），标记的行高亮；没有控制面时间的行不能点：
 * 正文退到辅助色，指针是「不可用」。合并多个任务的日志时（origin），每行多一列来源节点：
 * 点来源节点名，或在行上右键 / 按 Shift+F10 / 菜单键打开菜单，选「只看……的日志」（onOrigin），都是切到这个节点；
 * 点行的其他位置只标出时刻。
 */
export function LogList<L extends LogLineView>({
	lines,
	lineKey,
	origin,
	onOrigin,
	hasOlder,
	loadingOlder,
	loadOlder,
	hasNewer = false,
	loadingNewer = false,
	loadNewer,
	reveal,
	marked,
	onPick,
	timeKind,
	day,
}: {
	lines: L[];
	/** 行的唯一键：单个任务用序号，合并时用任务加序号。 */
	lineKey: (line: L) => string;
	/** 来源节点列的文字；不给时没有这一列。 */
	origin?: (line: L) => string;
	/** 选中这一行的来源节点（点来源节点名，或行的右键菜单）；不给时来源节点名不能点，也没有菜单。 */
	onOrigin?: (line: L) => void;
	hasOlder: boolean;
	loadingOlder: boolean;
	loadOlder: () => void;
	/** 最后一行之后还有没加载的行：不跟随末尾，滚动到底部或点按钮加载（`loadNewer`）。 */
	hasNewer?: boolean;
	loadingNewer?: boolean;
	loadNewer?: () => void;
	/** 定位到某一刻；不给时是普通的日志列表。正好对应的行被时间范围过滤掉时，不高亮也不标「这一刻」。 */
	reveal?: LogReveal<L>;
	/** 标记的行的键。 */
	marked: string | null;
	onPick: (line: L) => void;
	/** 时间列显示哪一种时间。 */
	timeKind: LogTimeKind;
	/** 运行开始的时刻（控制面时间）：时间列要不要带日期按它那一天判断。 */
	day: string;
}) {
	const dated = useMemo(
		() =>
			spansOtherDay(
				lines.map((l) => logLineTime(l, timeKind)),
				day,
			),
		[lines, timeKind, day],
	);
	const formatTime = dated ? formatFullDateTimeMs : formatClockMs;
	/** 定位的结果落到列表上：高亮的行的键，或「这一刻」插在 `lines` 的这个下标之前（等于行数时在末尾）。 */
	const placed = useMemo<{ highlight: string | null; moment: number | null } | undefined>(() => {
		if (!reveal) return undefined;
		if (reveal.exact) {
			const hit = lines.find(reveal.exact);
			return { highlight: hit ? lineKey(hit) : null, moment: null };
		}
		const from = lines.findIndex(reveal.fromMoment);
		return { highlight: null, moment: from < 0 ? lines.length : from };
	}, [reveal, lines, lineKey]);
	const rows = useMemo(() => {
		const out: Row<L>[] = lines.map((line) => ({ key: lineKey(line), line }));
		if (placed?.moment != null) out.splice(placed.moment, 0, { key: MOMENT_KEY, line: null });
		return out;
	}, [lines, lineKey, placed?.moment]);
	const [menu, setMenu] = useState<{ line: L; at: ContextMenuAnchor; open: boolean } | null>(null);
	const box = useRef<HTMLDivElement>(null);
	/** 停靠点所在的行；它不在渲染范围里时停靠点落在视口里的第一行。 */
	const [stopKey, setStopKey] = useState<string | null>(null);
	/** 键盘移动后要聚焦的行（虚拟列表里它可能还没渲染，渲染后再聚焦）。 */
	const pendingFocus = useRef<number | null>(null);
	const follow = useRef(reveal === undefined);
	/** 加载更早的一页之前，视口顶部那一行：加载后滚回它。 */
	const anchor = useRef<{ key: string; offset: number } | null>(null);
	/** 上一次贴底后的 scrollTop。 */
	const pinnedTop = useRef<number | null>(null);
	/**
	 * 跟随时贴底。虚拟列表的 onChange（测量、滚动）可能在用户滚动之后、滚动事件还没派发时调用，
	 * 这时 follow 还是旧值：上次贴底后视口被移开、又不在底部，就是用户在向上滚动，不再跟随，
	 * 否则会把他拉回底部（#47）。日志行变化后的贴底（force）不做这个判断：列表挂载时虚拟列表会把
	 * 滚动位置重置为 0，这不是用户移动的。
	 */
	const pin = (force = false) => {
		const el = box.current;
		if (!el || !follow.current || hasNewer) return;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
		const moved = pinnedTop.current !== null && Math.abs(el.scrollTop - pinnedTop.current) > 1;
		if (!force && moved && !atBottom) {
			follow.current = false;
			return;
		}
		el.scrollTop = el.scrollHeight;
		pinnedTop.current = el.scrollTop;
	};
	const virtualizer = useVirtualizer({
		onChange: () => pin(),
		count: rows.length,
		getScrollElement: () => box.current,
		estimateSize: () => 20,
		overscan: 24,
		paddingStart: 4,
		paddingEnd: 8,
		getItemKey: (i) => rows[i]?.key ?? i,
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: pin 只读 ref
	useLayoutEffect(() => {
		const saved = anchor.current;
		if (saved) {
			anchor.current = null;
			const index = rows.findIndex((r) => r.key === saved.key);
			if (index >= 0) {
				const start = virtualizer.getOffsetForIndex(index, "start")?.[0] ?? 0;
				virtualizer.scrollToOffset(start + saved.offset);
			}
			return;
		}
		pin(true);
	}, [rows, virtualizer]);

	/** 已经滚动到的那一次定位。 */
	const revealed = useRef<unknown>(undefined);
	useLayoutEffect(() => {
		if (!reveal || !placed || revealed.current === reveal.id) return;
		const index =
			placed.highlight === null ? placed.moment : rows.findIndex((r) => r.key === placed.highlight);
		if (index === null || index < 0) return;
		revealed.current = reveal.id;
		follow.current = false;
		virtualizer.scrollToIndex(index, { align: "center" });
	}, [reveal, placed, rows, virtualizer]);

	const items = virtualizer.getVirtualItems();
	const firstShown = virtualizer.range?.startIndex ?? items[0]?.index ?? 0;
	const stopRendered = stopKey !== null && items.some((i) => rows[i.index]?.key === stopKey);
	const firstLine = rows[firstShown]?.line ? rows[firstShown] : rows[firstShown + 1];
	const tabStop = stopRendered ? stopKey : firstLine?.line ? firstLine.key : null;

	useLayoutEffect(() => {
		const index = pendingFocus.current;
		if (index === null) return;
		const row = box.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
		if (!row) return;
		pendingFocus.current = null;
		row.focus();
	});

	/** 移到第 index 项；那一项是「这一刻」（不能聚焦）时沿方向再走一项。 */
	const moveTo = (index: number, direction: 1 | -1) => {
		const clamp = (i: number) => Math.max(0, Math.min(rows.length - 1, i));
		let target = clamp(index);
		if (rows[target]?.line === null) target = clamp(target + direction);
		const row = rows[target];
		if (!row?.line) return;
		setStopKey(row.key);
		pendingFocus.current = target;
		virtualizer.scrollToIndex(target, { align: "auto" });
		const rendered = box.current?.querySelector<HTMLElement>(`[data-index="${target}"]`);
		if (rendered) {
			pendingFocus.current = null;
			rendered.focus();
		}
	};
	const page = Math.max(1, (virtualizer.range?.endIndex ?? 0) - firstShown - 1);

	return (
		<div
			ref={box}
			role="log"
			aria-label="日志"
			aria-live="off"
			className="h-full overflow-auto font-mono text-xs"
			onScroll={(e) => {
				const el = e.currentTarget;
				const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
				follow.current = fromBottom < 8 && !hasNewer;
				if (hasNewer && !loadingNewer && fromBottom < LOAD_NEWER_AT) loadNewer?.();
				if (hasOlder && !loadingOlder && el.scrollTop < LOAD_OLDER_AT) {
					const first = items[0];
					const row = first ? rows[first.index] : undefined;
					if (first && row) {
						anchor.current = { key: row.key, offset: el.scrollTop - first.start };
					}
					loadOlder();
				}
			}}
		>
			{hasOlder && (
				<div className="px-3 pt-1">
					<button
						type="button"
						disabled={loadingOlder}
						onClick={loadOlder}
						className="text-xs text-fg-3 underline-offset-2 hover:text-fg-1 hover:underline"
					>
						{loadingOlder ? "正在加载更早的日志…" : "向上滚动或点击加载更早的日志"}
					</button>
				</div>
			)}
			<div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
				{items.map((item) => {
					const row = rows[item.index];
					if (!row) return null;
					const line = row.line;
					if (!line) {
						return (
							<MomentRow
								key={item.key}
								ref={virtualizer.measureElement}
								index={item.index}
								top={item.start}
								at={reveal?.at ?? ""}
								day={day}
							/>
						);
					}
					const locatable = line.time !== null;
					const shown = logLineTime(line, timeKind);
					return (
						// biome-ignore lint/a11y/useSemanticElements: 虚拟滚动的行需要绝对定位，不能用 button 包一整行的网格
						<div
							key={item.key}
							ref={virtualizer.measureElement}
							data-index={item.index}
							data-level={line.level}
							data-source={line.source}
							data-marked={marked === row.key || undefined}
							data-located={placed?.highlight === row.key || undefined}
							aria-current={placed?.highlight === row.key ? "location" : undefined}
							role="button"
							tabIndex={row.key === tabStop ? 0 : -1}
							aria-disabled={!locatable || undefined}
							aria-description={locatable ? undefined : NOT_LOCATABLE}
							title={locatable ? "在时间轴上标出这一时刻" : NOT_LOCATABLE}
							onClick={() => locatable && onPick(line)}
							onFocus={() => setStopKey(row.key)}
							onContextMenu={(e) => {
								if (!onOrigin) return;
								e.preventDefault();
								// 键盘触发的 contextmenu 事件（没有按右键）贴着这一行打开。
								setMenu({
									line,
									at: e.button === 2 ? { x: e.clientX, y: e.clientY } : e.currentTarget,
									open: true,
								});
							}}
							onKeyDown={(e) => {
								const step: Record<string, [index: number, direction: 1 | -1]> = {
									ArrowDown: [item.index + 1, 1],
									ArrowUp: [item.index - 1, -1],
									PageDown: [item.index + page, 1],
									PageUp: [item.index - page, -1],
									Home: [0, 1],
									End: [rows.length - 1, -1],
								};
								const move = step[e.key];
								if (move) {
									e.preventDefault();
									moveTo(...move);
								} else if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									if (locatable) onPick(line);
								} else if (
									onOrigin &&
									(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))
								) {
									e.preventDefault();
									setMenu({ line, at: e.currentTarget, open: true });
								}
							}}
							className={cn(
								"absolute top-0 left-0 grid w-full gap-2 px-3 leading-5 wrap-anywhere whitespace-pre-wrap",
								COLUMNS[dated ? "dated" : "clock"][origin ? "origin" : "plain"],
								locatable ? "cursor-pointer hover:bg-fg-1/3" : "cursor-not-allowed",
								"data-marked:selected-row data-located:selected-row",
							)}
							style={{ transform: `translateY(${item.start}px)` }}
						>
							<span
								data-log-time={timeKind}
								className="text-fg-3"
								title={`Agent 时间 ${fullTime(line.agent_time)}\n控制面时间 ${fullTime(line.time)}`}
							>
								{shown ? formatTime(shown) : TIME_NOT_RECORDED}
							</span>
							<span
								className={
									!locatable && line.level === "info" ? "text-fg-3" : LOG_LEVEL_STYLE[line.level]
								}
							>
								{LOG_LEVEL_LABEL[line.level]}
							</span>
							{origin && (
								// biome-ignore lint/a11y/noStaticElementInteractions: 嵌在整行的 button 里，不能再放 button；键盘用行上的菜单（Shift+F10）
								// biome-ignore lint/a11y/useKeyWithClickEvents: 同上
								<span
									data-log-origin
									title={onOrigin ? `${origin(line)}：只看这个节点的日志` : origin(line)}
									className={cn(
										"truncate text-fg-2",
										onOrigin && "cursor-pointer underline-offset-2 hover:text-fg-1 hover:underline",
									)}
									onClick={(e) => {
										if (!onOrigin) return;
										e.stopPropagation();
										onOrigin(line);
									}}
								>
									{origin(line)}
								</span>
							)}
							{/* Agent 自己写入的提示行（Agent 时间跳变）不是节点的输出：来源用正文色，与其余来源区分。 */}
							<span data-log-source className={line.source === "agent" ? "text-fg-1" : "text-fg-3"}>
								{line.source}
							</span>
							<span className={locatable ? LOG_LEVEL_STYLE[line.level] : "text-fg-3"}>
								{line.text}
							</span>
						</div>
					);
				})}
			</div>
			{hasNewer && (
				<div className="px-3 pt-1 pb-1.5">
					<button
						type="button"
						disabled={loadingNewer}
						onClick={loadNewer}
						className="text-xs text-fg-3 underline-offset-2 hover:text-fg-1 hover:underline"
					>
						{loadingNewer ? "正在加载更新的日志…" : "向下滚动或点击加载更新的日志"}
					</button>
				</div>
			)}
			{/* 菜单渲染在 body 里（Portal），放在这里只是和列表一起挂载 */}
			{onOrigin && origin && (
				<ContextMenu
					label="日志行菜单"
					open={menu?.open ?? false}
					anchor={menu?.at ?? null}
					onOpenChange={(open) => setMenu((m) => m && { ...m, open })}
				>
					{menu && (
						<ContextMenuItem onClick={() => onOrigin(menu.line)}>
							只看 {origin(menu.line)} 的日志
						</ContextMenuItem>
					)}
				</ContextMenu>
			)}
		</div>
	);
}

/**
 * 「这一刻」（没有正好对应那一刻的行时插在它的位置）：一行文字写着时刻（控制面时间），后面接一条贯穿整行的中性细线。
 * 它不是日志行：不能聚焦、不能点；读屏用户读到的就是这行文字。
 */
function MomentRow({
	ref,
	index,
	top,
	at,
	day,
}: {
	ref: (node: HTMLElement | null) => void;
	index: number;
	top: number;
	at: string;
	day: string;
}) {
	const time = spansOtherDay([at], day) ? formatFullDateTimeMs(at) : formatClockMs(at);
	return (
		<div
			ref={ref}
			data-index={index}
			data-moment
			className="absolute top-0 left-0 flex h-5 w-full items-center gap-2 px-3 text-xs text-fg-2"
			style={{ transform: `translateY(${top}px)` }}
		>
			<span className="flex-none">
				这一刻 <span className="font-mono text-fg-3">控制面时间 {time}</span>
			</span>
			<span aria-hidden className="h-px flex-1 bg-border-strong" />
		</div>
	);
}
