import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "cn";
import { useLayoutEffect, useRef } from "react";
import { formatClockMs } from "#/lib/format";
import type { LoadedLine } from "./log-buffer";

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

/**
 * 日志行（虚拟滚动）：停在底部时跟随新行（实时跟随），滚到顶部时加载更早的一页（加载后视口内容不跳动）。
 * 点一行把它的时刻标到时间轴上（onPick），标记的行高亮。
 */
export function LogList({
	lines,
	hasOlder,
	loadingOlder,
	loadOlder,
	marked,
	onPick,
}: {
	lines: LoadedLine[];
	hasOlder: boolean;
	loadingOlder: boolean;
	loadOlder: () => void;
	/** 标记的行序号。 */
	marked: number | null;
	onPick: (line: LoadedLine) => void;
}) {
	const box = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	/** 加载更早的一页之前，视口顶部那一行：加载后滚回它。 */
	const anchor = useRef<{ seq: number; offset: number } | null>(null);
	const pin = () => {
		const el = box.current;
		if (el && follow.current) el.scrollTop = el.scrollHeight;
	};
	const virtualizer = useVirtualizer({
		onChange: pin,
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
		pin();
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
						className="text-2xs text-fg-3 underline-offset-2 hover:text-fg-1 hover:underline"
					>
						{loadingOlder ? "正在加载更早的日志…" : "向上滚动或点击加载更早的日志"}
					</button>
				</div>
			)}
			<div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
				{items.map((item) => {
					const line = lines[item.index];
					if (!line) return null;
					return (
						// biome-ignore lint/a11y/useSemanticElements: 虚拟滚动的行需要绝对定位，不能用 button 包一整行的网格
						<div
							key={item.key}
							ref={virtualizer.measureElement}
							data-index={item.index}
							data-level={line.level}
							data-marked={marked === line.seq || undefined}
							role="button"
							tabIndex={0}
							title="在时间轴上标出这一时刻"
							onClick={() => onPick(line)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									onPick(line);
								}
							}}
							className={cn(
								"absolute top-0 left-0 grid w-full cursor-pointer grid-cols-[96px_44px_52px_1fr] gap-2 px-3 leading-5 break-all whitespace-pre-wrap hover:bg-fg-1/3",
								"data-marked:bg-warn-soft",
							)}
							style={{ transform: `translateY(${item.start}px)` }}
						>
							<span className="text-fg-3">{formatClockMs(line.time)}</span>
							<span className={LEVEL_STYLE[line.level]}>{LEVEL_LABEL[line.level]}</span>
							<span className="text-fg-3">{line.source}</span>
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
