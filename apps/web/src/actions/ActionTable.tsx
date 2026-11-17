import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { cn } from "cn";
import { FlagIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Elapsed } from "#/components/elapsed";
import { STATUS, StatusDot } from "#/components/status";
import { ACTION_PAGE, DURATION_LABEL, MESSAGE, NODE_ACTIONS } from "#/lib/copy";
import {
	formatClock,
	formatClockMs,
	formatDuration,
	formatFullDateTime,
	formatFullDateTimeMs,
	formatInteger,
	spansOtherDay,
} from "#/lib/format";
import type { LogTimeKind } from "#/monitor/log-time-kind";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Truncate } from "@/components/ui/truncate";
import { partitionPoint } from "./action-details";
import {
	type ActionGroupName,
	type ActionRow,
	type ActionTableGroup,
	fieldsText,
} from "./action-table";

/** 离底部多近时读更早的一页（像素）。 */
const LOAD_OLDER_AT = 160;
/** 离顶部这么近算停在顶部：新的行出现在最上面，不保持视口里的行不动。 */
const AT_TOP = 4;
/** 子动作每一层缩进的宽度（像素）。 */
const INDENT_PX = 16;
const COLUMNS = 5;

/** 三组的名称：只看失败时，第三组读到的都是失败的动作。 */
const groupLabel = (group: ActionGroupName, failedOnly: boolean): string =>
	group === "earlier" && failedOnly ? ACTION_PAGE.groups.earlierFailed : ACTION_PAGE.groups[group];

type CountOnlyRow = Extract<ActionRow, { kind: "count-only" }>;
type RecordRow = Exclude<ActionRow, { kind: "count-only" }>;
const isRecord = (item: Item): item is Item & { kind: "row"; row: RecordRow } =>
	item.kind === "row" && item.row.kind !== "count-only";

/** 虚拟列表里的一项：组名一行，或表格的一行。 */
type Item = { key: string; group: ActionGroupName } & (
	| { kind: "heading"; note: string | undefined }
	| { kind: "row"; row: ActionRow }
);

/** 一格时间的格式：整张表有不在运行开始那天的时间时，都带上日期。 */
interface TimeFormat {
	time: (iso: string) => string;
	periodTime: (iso: string) => string;
}

/**
 * 「动作」页签的表格（原型 `actRows`）：三组行（action-table.ts 整理好的）画在一张 `<table>` 里，表头吸顶。
 * 明细最多 10 万条，所以是虚拟滚动：只渲染视口附近的行，上下用占位行撑出高度；每组是一个 `<tbody>`，组名是
 * `scope="rowgroup"` 的表头。列宽固定（`table-fixed`）：只渲染一部分行时自动列宽会随滚动跳动。
 * 滚动到底部附近（或点表格下面的按钮）读更早的一页。离开顶部以后，新推送来的行插在上面时视口里的行保持不动；
 * 停在顶部时新的行出现在最上面。
 *
 * 开始一列按 `timeKind` 显示 Agent 时间或控制面时间（ADR 0018），Agent 时间时表头写明时钟偏差（`clockNote`）；
 * 每行的开始时间是按钮，点它调 `onLocate`（控制面时间，毫秒）：日志跳到那一刻，不论这一列显示哪种时间。
 * 开始时间的按钮合起来只有一个 Tab 停靠点（漫游焦点，同日志列表；只计数的一行里的按钮照常可以 Tab）：Tab 不必穿过
 * 几十上百行，行间用方向键、PageUp / PageDown、Home / End 移动（跳过只计数的行），虚拟滚动卸掉了的行也能靠它找回来。
 * 焦点所在的行被卸掉（滚出渲染范围、结束后换了组、被挤出「最近 20 个」）时焦点落到页面上，Tab 再进来落在停靠点。
 */
export function ActionTable({
	groups,
	notes,
	caption,
	day,
	timeKind,
	clockNote,
	failedOnly,
	onLocate,
	onFailedOnly,
	hasOlder,
	loadingOlder,
	loadOlder,
	busy = false,
}: {
	groups: readonly ActionTableGroup[];
	/** 写在组名后面的说明。 */
	notes?: Partial<Record<ActionGroupName, string>>;
	/** 表格的标题（读屏用）。 */
	caption: string;
	/** 运行开始的时刻：时间要不要带日期按它那一天判断。 */
	day: string;
	/** 开始一列显示哪一种时间；时间线始终按控制面时间画，不跟着它变。 */
	timeKind: LogTimeKind;
	/** 这次尝试的时钟偏差（`attemptClockNote`）：显示 Agent 时间时写在表头。 */
	clockNote: string;
	/** 现在只看失败：第三组换名称，只计数的一行里不再给「只看失败」。 */
	failedOnly: boolean;
	/** 点一行的开始时间：参数是开始的控制面时间（毫秒）。 */
	onLocate: (at: number) => void;
	/** 点只计数的一行里的「只看失败」。 */
	onFailedOnly: () => void;
	hasOlder: boolean;
	loadingOlder: boolean;
	loadOlder: () => void;
	/** 换筛选条件，新的行还没读到：这是上一个条件的行，先显示着。 */
	busy?: boolean;
}) {
	const items = useMemo(
		() =>
			groups.flatMap((g): Item[] => [
				{ key: `h:${g.name}`, group: g.name, kind: "heading", note: notes?.[g.name] },
				...g.rows.map((row): Item => ({ key: row.key, group: g.name, kind: "row", row })),
			]),
		[groups, notes],
	);
	const dated = useMemo(
		() => spansOtherDay(edgeTimes(groups, timeKind), day),
		[groups, timeKind, day],
	);
	const box = useRef<HTMLDivElement>(null);
	const head = useRef<HTMLTableSectionElement>(null);
	const [headHeight, setHeadHeight] = useState(0);
	// 表头的高度随时间一列的说明（偏差）换行变化。
	useLayoutEffect(() => {
		const el = head.current;
		if (!el) return;
		const measure = () => setHeadHeight(el.offsetHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	const getItemKey = useCallback((i: number) => items[i]?.key ?? i, [items]);
	const virtualizer = useVirtualizer({
		count: items.length,
		getScrollElement: () => box.current,
		estimateSize: () => 27,
		overscan: 16,
		scrollMargin: headHeight,
		scrollPaddingStart: headHeight,
		getItemKey,
	});

	/** 视口最上面那一行和滚过它的距离：行变了以后滚回它（停在顶部时为 null）。 */
	const anchor = useRef<{ key: string; offset: number } | null>(null);
	const remember = () => {
		const el = box.current;
		if (!el || el.scrollTop <= AT_TOP) {
			anchor.current = null;
			return;
		}
		// 吸顶的表头盖住视口最上面的一截：被它盖住的行不算。
		const first = virtualizer.getVirtualItems().find((v) => v.end > el.scrollTop + headHeight);
		anchor.current = first ? { key: String(first.key), offset: el.scrollTop - first.start } : null;
	};
	const loadOlderNearBottom = () => {
		const el = box.current;
		if (!el || !hasOlder || loadingOlder) return;
		if (el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_OLDER_AT) loadOlder();
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: 行变了以后才滚回记下的那一行、看要不要读下一页
	useLayoutEffect(() => {
		const saved = anchor.current;
		const index = saved ? items.findIndex((it) => it.key === saved.key) : -1;
		const start = index >= 0 ? virtualizer.measurementsCache[index]?.start : undefined;
		if (saved && start !== undefined) virtualizer.scrollToOffset(start + saved.offset);
		loadOlderNearBottom();
	}, [items, virtualizer]);

	/** 能聚焦的行（动作和标记）在 `items` 里的位置，从前到后。 */
	const focusable = useMemo(() => items.flatMap((it, i) => (isRecord(it) ? [i] : [])), [items]);
	/** 漫游焦点：最近停留的那一行；它没有渲染时，停靠点退回视口里的第一行（不是上方多渲染的那些）。 */
	const [stopKey, setStopKey] = useState<string | null>(null);
	const pendingFocus = useRef<number | null>(null);

	const virtual = virtualizer.getVirtualItems();
	const stopRendered = stopKey !== null && virtual.some((v) => items[v.index]?.key === stopKey);
	const visibleFrom = virtualizer.range?.startIndex ?? virtual[0]?.index ?? 0;
	const firstFocusable = virtual.find(
		(v) => v.index >= visibleFrom && items[v.index] && isRecord(items[v.index] as Item),
	);
	const tabStop = stopRendered ? stopKey : (items[firstFocusable?.index ?? -1]?.key ?? null);

	useLayoutEffect(() => {
		const index = pendingFocus.current;
		if (index === null) return;
		const button = box.current?.querySelector<HTMLElement>(`[data-index="${index}"] [data-locate]`);
		if (!button) return;
		pendingFocus.current = null;
		button.focus();
	});

	/** 把焦点移到第 position 个能聚焦的行（`focusable` 里的位置）；那一行还没渲染时先滚过去，渲染出来再聚焦。 */
	const focusRow = (position: number) => {
		const index = focusable[Math.max(0, Math.min(focusable.length - 1, position))];
		const item = index === undefined ? undefined : items[index];
		if (index === undefined || !item) return;
		setStopKey(item.key);
		pendingFocus.current = index;
		virtualizer.scrollToIndex(index, { align: "auto" });
		const rendered = box.current?.querySelector<HTMLElement>(
			`[data-index="${index}"] [data-locate]`,
		);
		if (rendered) {
			pendingFocus.current = null;
			rendered.focus();
		}
	};
	const page = Math.max(
		1,
		(virtualizer.range?.endIndex ?? 0) - (virtualizer.range?.startIndex ?? 0) - 1,
	);
	const onRowKeyDown = (event: React.KeyboardEvent<HTMLElement>, index: number) => {
		const position = partitionPoint(focusable, (i) => i < index);
		const target = {
			ArrowDown: position + 1,
			ArrowUp: position - 1,
			PageDown: position + page,
			PageUp: position - page,
			Home: 0,
			End: focusable.length - 1,
		}[event.key];
		if (target === undefined) return;
		event.preventDefault();
		focusRow(target);
	};

	const segments = groupSegments(virtual, items);
	const first = virtual[0];
	const last = virtual.at(-1);
	const padTop = first ? first.start - headHeight : 0;
	const padBottom = last ? virtualizer.getTotalSize() - (last.end - headHeight) : 0;
	const format: TimeFormat = {
		time: dated ? formatFullDateTimeMs : formatClockMs,
		periodTime: dated ? formatFullDateTime : formatClock,
	};
	const agent = timeKind === "agent";
	const startWidth = agent ? "w-56" : dated ? "w-44" : "w-28";

	return (
		<div
			ref={box}
			data-testid="action-table"
			aria-busy={busy}
			className={cn("h-full overflow-auto transition-opacity", busy && "opacity-60")}
			onScroll={() => {
				remember();
				loadOlderNearBottom();
			}}
		>
			<Table className="table-fixed text-xs">
				<caption className="sr-only">{caption}</caption>
				<colgroup>
					<col className={startWidth} />
					<col className="w-50" />
					<col />
					<col className="w-21" />
					<col />
				</colgroup>
				<TableHeader ref={head}>
					<TableRow>
						<TableHead className="py-1.5 whitespace-normal">
							{agent ? (
								<>
									{ACTION_PAGE.startAgentTime}
									<span className="block font-normal text-fg-3">
										{ACTION_PAGE.clockOffset(clockNote)}
									</span>
								</>
							) : (
								"开始"
							)}
						</TableHead>
						<TableHead className="py-1.5">名称</TableHead>
						<TableHead className="py-1.5">字段</TableHead>
						<TableHead className="py-1.5 text-right">{DURATION_LABEL}</TableHead>
						<TableHead className="py-1.5">结果</TableHead>
					</TableRow>
				</TableHeader>
				{segments.map((segment, i) => (
					<TableBody
						key={segment.group}
						data-group={segment.group}
						className="[&_tr:last-child]:border-b"
					>
						{i === 0 && padTop > 0 && <Spacer height={padTop} />}
						{segment.items.map(({ virtual: v, item }) => (
							<ItemRow
								key={v.key}
								index={v.index}
								measure={virtualizer.measureElement}
								item={item}
								format={format}
								timeKind={timeKind}
								failedOnly={failedOnly}
								tabStop={item.key === tabStop}
								headHeight={headHeight}
								onFocusRow={() => setStopKey(item.key)}
								onRowKeyDown={onRowKeyDown}
								onLocate={onLocate}
								onFailedOnly={onFailedOnly}
							/>
						))}
						{i === segments.length - 1 && padBottom > 0 && <Spacer height={padBottom} />}
					</TableBody>
				))}
			</Table>
			{hasOlder && (
				<div className="px-3 py-1.5">
					<button
						type="button"
						disabled={loadingOlder}
						onClick={loadOlder}
						className="text-xs text-fg-3 underline-offset-2 hover:text-fg-1 hover:underline"
					>
						{loadingOlder ? MESSAGE.loading : "向下滚动或点击加载更早的明细"}
					</button>
				</div>
			)}
		</div>
	);
}

/** 渲染范围里的项按组连成几段，每段一个 `<tbody>`。 */
function groupSegments(virtual: VirtualItem[], items: Item[]) {
	const segments: { group: ActionGroupName; items: { virtual: VirtualItem; item: Item }[] }[] = [];
	for (const v of virtual) {
		const item = items[v.index];
		if (!item) continue;
		const segment = segments.at(-1);
		if (segment?.group === item.group) segment.items.push({ virtual: v, item });
		else segments.push({ group: item.group, items: [{ virtual: v, item }] });
	}
	return segments;
}

/** 这一行开始的时刻，按这一列显示的那种时间。 */
const startedAtOf = (row: RecordRow, kind: LogTimeKind): string =>
	kind === "agent" ? row.agentStartedAt : row.startedAt;

/**
 * 每组最新和最早的时刻（每组从新到旧排）：用来判断时间要不要带日期，不用把 10 万行都看一遍。
 * 显示 Agent 时间时看的是 Agent 时间：它可以和控制面差出几百天。
 */
function edgeTimes(groups: readonly ActionTableGroup[], kind: LogTimeKind): string[] {
	const times: string[] = [];
	const add = (row: ActionRow | undefined) => {
		if (!row) return;
		if (row.kind !== "count-only") times.push(startedAtOf(row, kind));
		else if (kind === "agent") times.push(row.agentFrom);
		else times.push(row.from, ...(row.until === null ? [] : [row.until]));
	};
	for (const g of groups) {
		add(g.rows[0]);
		add(g.rows.at(-1));
	}
	return times;
}

function Spacer({ height }: { height: number }) {
	return <tr aria-hidden style={{ height }} />;
}

function ItemRow({
	index,
	measure,
	item,
	format,
	timeKind,
	failedOnly,
	tabStop,
	headHeight,
	onFocusRow,
	onRowKeyDown,
	onLocate,
	onFailedOnly,
}: {
	index: number;
	measure: (node: Element | null) => void;
	item: Item;
	format: TimeFormat;
	timeKind: LogTimeKind;
	failedOnly: boolean;
	tabStop: boolean;
	headHeight: number;
	onFocusRow: () => void;
	onRowKeyDown: (event: React.KeyboardEvent<HTMLElement>, index: number) => void;
	onLocate: (at: number) => void;
	onFailedOnly: () => void;
}) {
	if (item.kind === "heading") {
		return (
			<tr ref={measure} data-index={index}>
				<th
					scope="rowgroup"
					colSpan={COLUMNS}
					className="px-3 pt-2.5 pb-1 text-left text-xs font-normal text-fg-3"
				>
					<span className="mr-2 font-semibold text-fg-2">{groupLabel(item.group, failedOnly)}</span>
					{item.note}
				</th>
			</tr>
		);
	}
	const { row } = item;
	if (row.kind === "count-only") {
		return (
			<tr ref={measure} data-index={index} data-count-only={row.name}>
				<td
					colSpan={COLUMNS}
					className="border-b border-border-soft bg-[repeating-linear-gradient(135deg,var(--border-soft)_0_6px,transparent_6px_12px)] px-3 py-1.5 text-fg-3"
				>
					{countOnlyText(row, timeKind, format.periodTime)}
					{!row.failedGap && (
						<>
							{" "}
							<Button
								variant="link"
								size="sm"
								onClick={onFailedOnly}
								className="inline align-baseline text-xs text-fg-2"
							>
								{ACTION_PAGE.failedOnly}
							</Button>
						</>
					)}
				</td>
			</tr>
		);
	}
	const fields = fieldsText(row.fields);
	const shown = format.time(startedAtOf(row, timeKind));
	return (
		<TableRow
			ref={measure}
			data-index={index}
			data-action-id={row.id}
			data-result={row.kind === "mark" ? "mark" : row.outcome.status}
			style={{ scrollMarginTop: headHeight }}
		>
			<td className="px-3 py-1 align-top font-mono whitespace-nowrap text-fg-2">
				<button
					type="button"
					data-locate
					tabIndex={tabStop ? 0 : -1}
					aria-label={ACTION_PAGE.jumpToLog(shown)}
					onClick={() => onLocate(Date.parse(row.startedAt))}
					onFocus={onFocusRow}
					onKeyDown={(event) => onRowKeyDown(event, index)}
					className="cursor-pointer underline decoration-transparent underline-offset-3 hover:text-fg-1 hover:decoration-border-strong"
				>
					{shown}
				</button>
			</td>
			<td className="py-1 pr-3 align-top">
				<span
					className="flex min-w-0 items-center gap-1.5 text-fg-1"
					style={{ paddingLeft: 12 + row.indent * INDENT_PX }}
				>
					{row.kind === "mark" && <FlagIcon aria-hidden className="size-3 flex-none text-fg-3" />}
					<Truncate>{row.name}</Truncate>
				</span>
			</td>
			<td className="px-3 py-1 align-top font-mono text-fg-3">
				{fields && <Truncate>{fields}</Truncate>}
			</td>
			<td className="px-3 py-1 text-right align-top font-mono whitespace-nowrap text-fg-2">
				{row.kind === "mark" ? (
					"—"
				) : row.outcome.status === "running" ? (
					<Elapsed since={Date.parse(row.startedAt)} />
				) : (
					formatDuration(row.outcome.durationMs)
				)}
			</td>
			<td className="px-3 py-1 align-top">
				<Result row={row} />
			</td>
		</TableRow>
	);
}

/**
 * 只计数的一段：「09:19:12 至今的 1,234,794 个「下单」只计数、没有明细（…）」。显示 Agent 时间时只有起点的
 * Agent 时间（结束的只有控制面时间），写「起」。只看失败时接上失败的个数不知道。
 */
function countOnlyText(
	row: CountOnlyRow,
	kind: LogTimeKind,
	time: (iso: string) => string,
): string {
	const agent = kind === "agent";
	const span = ACTION_PAGE.countOnlySpan(
		time(agent ? row.agentFrom : row.from),
		row.until === null ? null : time(row.until),
		agent,
	);
	const text = `${span}的 ${formatInteger(row.count)} 个「${row.name}」${NODE_ACTIONS.countOnlyNoDetail}（${ACTION_PAGE.countOnlyReason(row.reason, row.totalFull)}）`;
	return row.failedGap
		? `${text}；${ACTION_PAGE.failedUnknown(row.name, row.failedGap.total === null ? null : formatInteger(row.failedGap.total))}`
		: text;
}

/** 结果：成功不着色；失败是红色菱形加完整的原因（换行，不截断）；进行中是执行中的形状；标记是小旗。 */
function Result({ row }: { row: Exclude<ActionRow, { kind: "count-only" }> }) {
	if (row.kind === "mark") {
		return (
			<span className="flex items-center gap-1.5 text-fg-3">
				<FlagIcon aria-hidden className="size-3 flex-none" />
				{NODE_ACTIONS.results.mark}
			</span>
		);
	}
	const { outcome } = row;
	switch (outcome.status) {
		case "running":
			return (
				<span className={cn("flex items-center gap-1.5", STATUS.running.text)}>
					<StatusDot kind="running" />
					{NODE_ACTIONS.results.running}
				</span>
			);
		case "failed":
			return (
				<span className={cn("flex items-start gap-1.5", STATUS.failed.text)}>
					<StatusDot kind="failed" className="mt-1.25" />
					<span className="min-w-0 wrap-anywhere whitespace-pre-wrap">
						{outcome.reason === null ? (
							NODE_ACTIONS.results.failed
						) : (
							<>
								<span className="sr-only">{NODE_ACTIONS.results.failed}：</span>
								{outcome.reason}
							</>
						)}
					</span>
				</span>
			);
		case "unfinished":
			return <span className="text-fg-2">{NODE_ACTIONS.results.unfinished}</span>;
		case "success":
			return <span className="text-fg-3">{NODE_ACTIONS.results.success}</span>;
	}
}
