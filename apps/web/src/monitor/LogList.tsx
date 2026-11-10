import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "cn";
import { useLayoutEffect, useRef } from "react";
import { formatClockMs, formatFullDateTime, TIME_NOT_RECORDED } from "#/lib/format";
import type { LoadedLine } from "./log-buffer";
import { type LogTimeKind, logLineTime } from "./log-time-kind";

const LEVEL_LABEL: Record<LoadedLine["level"], string> = {
	debug: "DEBUG",
	info: "INFO",
	warn: "WARN",
	error: "ERROR",
};

const LEVEL_STYLE: Record<LoadedLine["level"], string> = {
	debug: "text-log-debug",
	info: "text-log-info",
	warn: "text-log-warn",
	error: "text-log-error",
};

/** 离顶部多近时加载更早的一页（像素）。 */
const LOAD_OLDER_AT = 120;

/** 没有控制面时间的行（升级之前写入的）不能定位的原因。 */
export const NOT_LOCATABLE = "这行日志没有记录控制面时间，不能在时间轴上定位";

const fullTime = (iso: string | null) => (iso ? formatFullDateTime(iso) : TIME_NOT_RECORDED);

/**
 * 日志行（虚拟滚动）：停在底部时跟随新行（实时跟随），滚到顶部时加载更早的一页（加载后视口内容不跳动）。
 * 时间列按 timeKind 显示 Agent 时间或控制面时间（ADR 0018），悬停时两种都给出。
 * 点一行把它的控制面时间标到时间轴上（onPick），标记的行高亮；没有控制面时间的行不能点。
 */
export function LogList({
	lines,
	hasOlder,
	loadingOlder,
	loadOlder,
	marked,
	onPick,
	timeKind,
}: {
	lines: LoadedLine[];
	hasOlder: boolean;
	loadingOlder: boolean;
	loadOlder: () => void;
	/** 标记的行序号。 */
	marked: number | null;
	onPick: (line: LoadedLine) => void;
	/** 时间列显示哪一种时间。 */
	timeKind: LogTimeKind;
}) {
	const box = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	/** 加载更早的一页之前，视口顶部那一行：加载后滚回它。 */
	const anchor = useRef<{ seq: number; offset: number } | null>(null);
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
		getItemKey: (i) => lines[i]?.seq ?? i,
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: pin 只读 ref
	useLayoutEffect(() => {
		const saved = anchor.current;
		if (saved) {
			anchor.current = null;
			const index = lines.findIndex((l) => l.seq === saved.seq);
			if (index >= 0) {
				const start = virtualizer.getOffsetForIndex(index, "start")?.[0] ?? 0;
				virtualizer.scrollToOffset(start + saved.offset);
			}
			return;
		}
		pin(true);
	}, [lines, virtualizer]);

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
					if (first && line) anchor.current = { seq: line.seq, offset: el.scrollTop - first.start };
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
							data-marked={marked === line.seq || undefined}
							role="button"
							tabIndex={0}
							aria-disabled={!locatable || undefined}
							title={locatable ? "在时间轴上标出这一时刻" : NOT_LOCATABLE}
							onClick={() => locatable && onPick(line)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									if (locatable) onPick(line);
								}
							}}
							className={cn(
								"absolute top-0 left-0 grid w-full grid-cols-[96px_44px_52px_1fr] gap-2 px-3 leading-5 break-all whitespace-pre-wrap",
								locatable ? "cursor-pointer hover:bg-fg-1/3" : "cursor-default",
								"data-marked:bg-warn-soft",
							)}
							style={{ transform: `translateY(${item.start}px)` }}
						>
							<span
								data-log-time={timeKind}
								className="text-fg-3"
								title={`Agent 时间 ${fullTime(line.agent_time)}\n控制面时间 ${fullTime(line.time)}`}
							>
								{shown ? formatClockMs(shown) : TIME_NOT_RECORDED}
							</span>
							<span className={LEVEL_STYLE[line.level]}>{LEVEL_LABEL[line.level]}</span>
							{/* Agent 自己写入的提示行（Agent 时间跳变）不是节点的输出：来源用正文色，与其余来源区分。 */}
							<span data-log-source className={line.source === "agent" ? "text-fg-1" : "text-fg-3"}>
								{line.source}
							</span>
							<span className={line.level === "info" ? "text-log-info" : LEVEL_STYLE[line.level]}>
								{line.text}
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}
