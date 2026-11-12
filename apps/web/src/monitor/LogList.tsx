import type { LogLineView } from "@sfly/schema";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "cn";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	formatClockMs,
	formatFullDateTime,
	formatFullDateTimeMs,
	spansOtherDay,
	TIME_NOT_RECORDED,
} from "#/lib/format";
import { ContextMenu, type ContextMenuAnchor, ContextMenuItem } from "@/components/ui/context-menu";
import { type LogTimeKind, logLineTime } from "./log-time-kind";

const LEVEL_LABEL: Record<LogLineView["level"], string> = {
	debug: "DEBUG",
	info: "INFO",
	warn: "WARN",
	error: "ERROR",
};

const LEVEL_STYLE: Record<LogLineView["level"], string> = {
	debug: "text-log-debug",
	info: "text-log-info",
	warn: "text-log-warn",
	error: "text-log-error",
};

/** 离顶部多近时加载更早的一页（像素）。 */
const LOAD_OLDER_AT = 120;

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
	const [menu, setMenu] = useState<{ line: L; at: ContextMenuAnchor; open: boolean } | null>(null);
	const box = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
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
		if (!el || !follow.current) return;
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
		count: lines.length,
		getScrollElement: () => box.current,
		estimateSize: () => 20,
		overscan: 24,
		paddingStart: 4,
		paddingEnd: 8,
		getItemKey: (i) => {
			const line = lines[i];
			return line ? lineKey(line) : i;
		},
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: pin 只读 ref
	useLayoutEffect(() => {
		const saved = anchor.current;
		if (saved) {
			anchor.current = null;
			const index = lines.findIndex((l) => lineKey(l) === saved.key);
			if (index >= 0) {
				const start = virtualizer.getOffsetForIndex(index, "start")?.[0] ?? 0;
				virtualizer.scrollToOffset(start + saved.offset);
			}
			return;
		}
		pin(true);
	}, [lines, lineKey, virtualizer]);

	const items = virtualizer.getVirtualItems();
	return (
		<div
			ref={box}
			role="log"
			aria-label="日志"
			aria-live="off"
			className="h-full overflow-auto font-mono text-xs"
			onScroll={(e) => {
				const el = e.currentTarget;
				follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
				if (hasOlder && !loadingOlder && el.scrollTop < LOAD_OLDER_AT) {
					const first = items[0];
					const line = first ? lines[first.index] : undefined;
					if (first && line) {
						anchor.current = { key: lineKey(line), offset: el.scrollTop - first.start };
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
					const line = lines[item.index];
					if (!line) return null;
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
							data-marked={marked === lineKey(line) || undefined}
							role="button"
							tabIndex={0}
							aria-disabled={!locatable || undefined}
							title={locatable ? "在时间轴上标出这一时刻" : NOT_LOCATABLE}
							onClick={() => locatable && onPick(line)}
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
								if (e.key === "Enter" || e.key === " ") {
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
								"absolute top-0 left-0 grid w-full gap-2 px-3 leading-5 break-all whitespace-pre-wrap",
								COLUMNS[dated ? "dated" : "clock"][origin ? "origin" : "plain"],
								locatable ? "cursor-pointer hover:bg-fg-1/3" : "cursor-not-allowed",
								"data-marked:bg-warn-soft",
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
									!locatable && line.level === "info" ? "text-fg-3" : LEVEL_STYLE[line.level]
								}
							>
								{LEVEL_LABEL[line.level]}
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
							<span className={locatable ? LEVEL_STYLE[line.level] : "text-fg-3"}>{line.text}</span>
						</div>
					);
				})}
			</div>
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
