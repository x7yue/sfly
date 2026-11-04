import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Section } from "#/canvas/Inspector";
import {
	LOG_LEVELS,
	LOG_SOURCES,
	type LogFilter,
	taskLogDownloadPath,
	useLogView,
} from "./log-viewer";
import type { LogLine } from "./logs";

const LEVEL_LABEL: Record<LogLine["level"], string> = {
	debug: "DEBUG",
	info: "INFO ",
	warn: "WARN ",
	error: "ERR  ",
};

const time = (iso: string) => {
	const d = new Date(iso);
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

/** 离顶部多近时加载更早的一页（像素）。 */
const LOAD_OLDER_AT = 160;

/**
 * 任务的完整日志（#18）：虚拟滚动；先加载最后一页历史，再接上实时流；滚到顶部时加载更早的一页。
 * 可以按级别和来源筛选、下载原始日志文件、展开成大窗口查看。
 */
export function LogViewer({ taskId, live }: { taskId: string; live: boolean }) {
	const [levels, setLevels] = useState<ReadonlySet<LogLine["level"]>>(new Set());
	const [sources, setSources] = useState<ReadonlySet<LogLine["source"]>>(new Set());
	const [expanded, setExpanded] = useState(false);
	const filter: LogFilter = { levels, sources };
	const view = useLogView(taskId, filter);
	const filtered = levels.size > 0 || sources.size > 0;

	useEffect(() => {
		if (!expanded) return;
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && setExpanded(false);
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [expanded]);

	const count = !view.loaded
		? "加载中…"
		: `${view.hasOlder ? "最近 " : ""}${view.lines.length} 行${filtered ? "（已筛选）" : ""}${live ? " · 实时" : ""}`;
	const empty = view.expired
		? "这次运行的日志已超过保留期，已被清理。"
		: filtered
			? "没有符合筛选条件的日志。"
			: live
				? "还没有日志输出。"
				: "这次尝试没有日志输出。";

	return (
		<div className="sf-logview" data-expanded={expanded}>
			{expanded && (
				<button
					type="button"
					className="sf-logview__backdrop"
					aria-label="收起日志"
					onClick={() => setExpanded(false)}
				/>
			)}
			<div className="sf-logview__panel">
				<Section
					title="日志"
					aside={
						<span className="sf-logview__aside">
							<span>{count}</span>
							<button
								type="button"
								className="sf-btn sf-btn--ghost sf-btn--sm"
								aria-pressed={expanded}
								onClick={() => setExpanded((e) => !e)}
							>
								{expanded ? "收起" : "展开"}
							</button>
							{!view.expired && (
								<a
									className="sf-btn sf-btn--ghost sf-btn--sm"
									href={taskLogDownloadPath(taskId)}
									download
								>
									下载
								</a>
							)}
						</span>
					}
				>
					{(filtered || view.lines.length > 0 || view.hasOlder) && (
						<div className="sf-logview__filters">
							<FilterSeg
								label="按级别筛选"
								all={LOG_LEVELS}
								picked={levels}
								onChange={setLevels}
								text={(l) => LEVEL_LABEL[l].trim()}
							/>
							<FilterSeg
								label="按来源筛选"
								all={LOG_SOURCES}
								picked={sources}
								onChange={setSources}
								text={(s) => s}
							/>
						</div>
					)}
					{view.truncated && (
						<p className="sf-warn-item sf-logview__note">
							日志超过单个任务的大小上限，之后的输出已被截断。
						</p>
					)}
					{view.error && <p className="sf-err">读取日志失败：{view.error}</p>}
					{view.loaded && view.lines.length === 0 && !view.hasOlder ? (
						<p className="sf-hint">{empty}</p>
					) : (
						<LogLines
							lines={view.lines}
							hasOlder={view.hasOlder}
							loadingOlder={view.loadingOlder}
							loadOlder={view.loadOlder}
						/>
					)}
				</Section>
			</div>
		</div>
	);
}

function FilterSeg<T extends string>({
	label,
	all,
	picked,
	onChange,
	text,
}: {
	label: string;
	all: ReadonlyArray<T>;
	picked: ReadonlySet<T>;
	onChange: (next: ReadonlySet<T>) => void;
	text: (value: T) => string;
}) {
	return (
		<fieldset className="sf-seg" aria-label={label}>
			<button type="button" aria-pressed={picked.size === 0} onClick={() => onChange(new Set())}>
				全部
			</button>
			{all.map((value) => (
				<button
					key={value}
					type="button"
					aria-pressed={picked.has(value)}
					data-value={value}
					onClick={() => {
						const next = new Set(picked);
						if (next.has(value)) next.delete(value);
						else next.add(value);
						// 全部选中等于不筛选。
						onChange(next.size === all.length ? new Set() : next);
					}}
				>
					{text(value)}
				</button>
			))}
		</fieldset>
	);
}

function LogLines({
	lines,
	hasOlder,
	loadingOlder,
	loadOlder,
}: {
	lines: LogLine[];
	hasOlder: boolean;
	loadingOlder: boolean;
	loadOlder: () => void;
}) {
	const box = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	/** 加载更早的一页之前，视口顶部那一行的序号：加载后滚回它，内容不跳动。 */
	const anchor = useRef<{ seq: number; offset: number } | null>(null);
	/** 跟随模式下钉在底部：新行到达、行高测量之后都要重新钉一次。 */
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
		paddingStart: 9,
		paddingEnd: 9,
		getItemKey: (i) => lines[i]?.seq ?? i,
	});

	// 新行到达时：之前停在底部就继续跟随；加载了更早的行时保持视口内容不动。
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
			className="sf-log sf-log--virtual"
			role="log"
			aria-live="off"
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
				<div className="sf-log__more">
					<span>{loadingOlder ? "正在加载更早的日志…" : "向上滚动加载更早的日志"}</span>
				</div>
			)}
			<div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
				{items.map((item) => {
					const line = lines[item.index];
					if (!line) return null;
					return (
						<div
							key={item.key}
							ref={virtualizer.measureElement}
							data-index={item.index}
							data-level={line.level}
							data-source={line.source}
							className="sf-log__row"
							style={{ transform: `translateY(${item.start}px)` }}
						>
							<span className="sf-log__t">{time(line.time)}</span>{" "}
							<span className="sf-log__lv">{LEVEL_LABEL[line.level]}</span>{" "}
							{line.source !== "stdout" && <span className="sf-log__src">{line.source}</span>}
							<span className="sf-log__msg">{line.text}</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}
