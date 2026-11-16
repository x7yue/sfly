import type { CountOnlyPeriod } from "@sfly/schema";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { cn } from "cn";
import { FlagIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Elapsed } from "#/components/elapsed";
import { STATUS, StatusDot } from "#/components/status";
import { NODE_ACTIONS } from "#/lib/copy";
import {
	formatClock,
	formatClockMs,
	formatDuration,
	formatFullDateTime,
	formatFullDateTimeMs,
	formatInteger,
	spansOtherDay,
} from "#/lib/format";
import { TableHead, TableRow } from "@/components/ui/table";
import { Truncate } from "@/components/ui/truncate";
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

const GROUP_LABEL: Record<ActionGroupName, string> = {
	running: NODE_ACTIONS.doing,
	recent: "最近 20 个",
	earlier: "更早的明细",
};

/** 只计数的段为什么没有明细。 */
const COUNT_ONLY_REASON: Record<CountOnlyPeriod["reason"], string> = {
	name_limit: "每种名称最多记录 5 万个，失败的动作仍有明细",
	total_limit: "全部名称合计最多记录 10 万个",
	control_plane: "控制面收到的明细超过上限，超出的已丢弃",
};

/** 虚拟列表里的一项：组名一行，或表格的一行。 */
type Item = { key: string; group: ActionGroupName } & (
	| { kind: "heading"; note: string | undefined }
	| { kind: "row"; row: ActionRow }
);

/**
 * 「动作」页的表格（原型 `actRows`）：三组行（action-table.ts 整理好的）画在一张 `<table>` 里，表头吸顶。
 * 明细最多 10 万条，所以是虚拟滚动：只渲染视口附近的行，上下用占位行撑出高度；每组是一个 `<tbody>`，组名是
 * `scope="rowgroup"` 的表头。列宽固定（`table-fixed`）：只渲染一部分行时自动列宽会随滚动跳动。
 * 滚动到底部附近（或点表格下面的按钮）读更早的一页。离开顶部以后，新推送来的行插在上面时视口里的行保持不动；
 * 停在顶部时新的行出现在最上面。
 */
export function ActionTable({
	groups,
	notes,
	caption,
	day,
	hasOlder,
	loadingOlder,
	loadOlder,
}: {
	groups: readonly ActionTableGroup[];
	/** 写在组名后面的说明。 */
	notes?: Partial<Record<ActionGroupName, string>>;
	/** 表格的标题（读屏用）。 */
	caption: string;
	/** 运行开始的时刻：时间要不要带日期按它那一天判断。 */
	day: string;
	hasOlder: boolean;
	loadingOlder: boolean;
	loadOlder: () => void;
}) {
	const items = useMemo(
		() =>
			groups.flatMap((g): Item[] => [
				{ key: `h:${g.name}`, group: g.name, kind: "heading", note: notes?.[g.name] },
				...g.rows.map((row): Item => ({ key: row.key, group: g.name, kind: "row", row })),
			]),
		[groups, notes],
	);
	const dated = useMemo(() => spansOtherDay(edgeTimes(groups), day), [groups, day]);
	const box = useRef<HTMLDivElement>(null);
	const head = useRef<HTMLTableSectionElement>(null);
	const [headHeight, setHeadHeight] = useState(0);
	useLayoutEffect(() => setHeadHeight(head.current?.offsetHeight ?? 0), []);
	const getItemKey = useCallback((i: number) => items[i]?.key ?? i, [items]);
	const virtualizer = useVirtualizer({
		count: items.length,
		getScrollElement: () => box.current,
		estimateSize: () => 27,
		overscan: 16,
		scrollMargin: headHeight,
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

	const virtual = virtualizer.getVirtualItems();
	const segments = groupSegments(virtual, items);
	const first = virtual[0];
	const last = virtual.at(-1);
	const padTop = first ? first.start - headHeight : 0;
	const padBottom = last ? virtualizer.getTotalSize() - (last.end - headHeight) : 0;
	const time = dated ? formatFullDateTimeMs : formatClockMs;
	const periodTime = dated ? formatFullDateTime : formatClock;

	return (
		<div
			ref={box}
			data-testid="action-table"
			className="h-full overflow-auto"
			onScroll={() => {
				remember();
				loadOlderNearBottom();
			}}
		>
			<table className="w-full table-fixed border-collapse text-xs">
				<caption className="sr-only">{caption}</caption>
				<colgroup>
					<col className={dated ? "w-44" : "w-28"} />
					<col className="w-50" />
					<col />
					<col className="w-21" />
					<col />
				</colgroup>
				<thead ref={head}>
					<tr>
						<TableHead className="py-1.5">开始</TableHead>
						<TableHead className="py-1.5">名称</TableHead>
						<TableHead className="py-1.5">字段</TableHead>
						<TableHead className="py-1.5 text-right">耗时</TableHead>
						<TableHead className="py-1.5">结果</TableHead>
					</tr>
				</thead>
				{segments.map((segment, i) => (
					<tbody key={segment.group} data-group={segment.group}>
						{i === 0 && padTop > 0 && <Spacer height={padTop} />}
						{segment.items.map(({ virtual: v, item }) => (
							<ItemRow
								key={v.key}
								index={v.index}
								measure={virtualizer.measureElement}
								item={item}
								time={time}
								periodTime={periodTime}
							/>
						))}
						{i === segments.length - 1 && padBottom > 0 && <Spacer height={padBottom} />}
					</tbody>
				))}
			</table>
			{hasOlder && (
				<div className="px-3 py-1.5">
					<button
						type="button"
						disabled={loadingOlder}
						onClick={loadOlder}
						className="text-xs text-fg-3 underline-offset-2 hover:text-fg-1 hover:underline"
					>
						{loadingOlder ? "正在加载更早的明细…" : "向下滚动或点击加载更早的明细"}
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

/** 每组最新和最早的时刻（每组从新到旧排）：用来判断时间要不要带日期，不用把 10 万行都看一遍。 */
function edgeTimes(groups: readonly ActionTableGroup[]): string[] {
	const times: string[] = [];
	const add = (row: ActionRow | undefined) => {
		if (!row) return;
		if (row.kind !== "count-only") times.push(row.startedAt);
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
	time,
	periodTime,
}: {
	index: number;
	measure: (node: Element | null) => void;
	item: Item;
	time: (iso: string) => string;
	periodTime: (iso: string) => string;
}) {
	if (item.kind === "heading") {
		return (
			<tr ref={measure} data-index={index}>
				<th
					scope="rowgroup"
					colSpan={COLUMNS}
					className="px-3 pt-2.5 pb-1 text-left text-xs font-normal text-fg-3"
				>
					<span className="mr-2 font-semibold text-fg-2">{GROUP_LABEL[item.group]}</span>
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
					{countOnlyText(row, periodTime)}
				</td>
			</tr>
		);
	}
	const fields = fieldsText(row.fields);
	return (
		<TableRow
			ref={measure}
			data-index={index}
			data-action-id={row.id}
			data-result={row.kind === "mark" ? "mark" : row.outcome.status}
		>
			<td className="px-3 py-1 align-top font-mono whitespace-nowrap text-fg-2">
				{time(row.startedAt)}
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

/** 只计数的一段：「09:19:12 至今的 1,234,794 个「下单」只计数，没有明细（…）」。 */
function countOnlyText(
	row: Extract<ActionRow, { kind: "count-only" }>,
	time: (iso: string) => string,
): string {
	const until = row.until === null ? "今" : ` ${time(row.until)} `;
	return `${time(row.from)} 至${until}的 ${formatInteger(row.count)} 个「${row.name}」${NODE_ACTIONS.countOnly}，没有明细（${COUNT_ONLY_REASON[row.reason]}）`;
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
