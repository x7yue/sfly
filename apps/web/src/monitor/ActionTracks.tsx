import { cn } from "cn";
import { FlagIcon } from "lucide-react";
import { useMemo } from "react";
import { STATUS } from "#/components/status";
import { NODE_ACTIONS, TERM } from "#/lib/copy";
import { formatClock, formatClockMs, formatDuration, formatInteger } from "#/lib/format";
import {
	type BandRun,
	layoutTracks,
	type PreparedTracks,
	TRACK_IDS,
	type TrackId,
	type TrackItem,
	type TrackLayout,
	type TrackOverview,
	type TrackTick,
	type TrackView,
} from "./action-tracks";
import type { NodeRef } from "./monitor-state";
import { NODE_ROW_HEIGHT } from "./timeline-model";

/** 轨道的名字（标签列）和图例。 */
const TRACK_LABEL: Record<TrackId, string> = { top: TERM.action, child: `子${TERM.action}` };
const FAILED = `失败的${TERM.action}`;
const RARE = `少见的${TERM.action}`;
/** 轨道只是概览，逐个查看看底部面板「动作」页签里的表：可访问名称和没读到明细的说明共用这一句。 */
const SEE_TABLE = `逐个查看见下方${TERM.action}表`;
/** 没读到的明细：时间线只读每次尝试最新的一页（和失败的、少见的），更早的只知道个数（use-action-tracks.ts）。 */
const UNREAD = `这段的明细没有读进时间线，按个数平均画；${SEE_TABLE}`;

/** 只计数的段：浅斜纹，45°（排队段的灰色斜纹是 135°，在节点行上）。 */
const HATCH =
	"border border-border-soft bg-[repeating-linear-gradient(45deg,var(--border-strong)_0_1px,transparent_1px_4px)]";
const BAND_LEVEL: Record<BandRun["level"], string> = {
	1: "bg-border-strong/45",
	2: "bg-border-strong/70",
	3: "bg-border-strong",
};
/**
 * 一条条画出来的动作：已结束的中性灰，进行中、失败的按状态表（执行中是淡底加 signal-line 描边）。高度都一样，
 * 不按状态分高低（docs/DESIGN-SYSTEM.md §6.1「动作轨道」）。
 */
const BAR_STATE = {
	ended: "bg-border-strong",
	running: STATUS.running.area.box,
	failed: STATUS.failed.area.box,
} as const;
/** 能显示名称的最小宽度（像素）。 */
const LABEL_PX = 72;

/**
 * 有动作的节点下面的两条轨道（原型 `tlSvg` 的 lane）：「动作」是最外层的，「子动作」是里面的。轨道是一张图，
 * 可访问名称概括它画了什么，逐个查看用底部面板的「动作」页签。点轨道和点节点行一样选中节点（Rows 按坐标找 `data-segment`）。
 */
export function ActionTracks({
	prepared,
	view,
	node,
	name,
	indent,
}: {
	prepared: PreparedTracks;
	/** 看的范围、现在、轨道区域的像素宽度。 */
	view: TrackView;
	node: NodeRef;
	/** 节点的名字（读屏名称里用）。 */
	name: string;
	indent: number;
}) {
	const layout = useMemo(() => layoutTracks(prepared, view), [prepared, view]);
	return (
		<div
			role="img"
			aria-label={tracksLabel(name, prepared.overview)}
			data-action-tracks={node.nodeId}
		>
			{TRACK_IDS.map((id) => (
				<div
					key={id}
					data-track={id}
					className="grid items-center border-b border-fg-1/3"
					style={{ height: NODE_ROW_HEIGHT, gridTemplateColumns: "var(--label-w) 1fr" }}
				>
					<span
						className="truncate pr-2.5 text-xs whitespace-nowrap text-fg-3"
						style={{ paddingLeft: (id === "top" ? 44 : 52) + indent }}
					>
						{id === "child" && "└ "}
						{TRACK_LABEL[id]}
					</span>
					<div
						data-viz
						data-segment="action"
						data-chain={node.chainInstanceId}
						data-node={node.nodeId}
						className="relative mr-3.5 h-full cursor-pointer"
					>
						<Track layout={layout[id]} width={view.width} />
					</div>
				</div>
			))}
		</div>
	);
}

const pct = (f: number) => `${f * 100}%`;
/** 从 `from` 到 `to`（范围里的比例）的位置和宽度。 */
const place = (from: number, to: number) => ({
	left: pct(from),
	width: pct(Math.max(0, to - from)),
});

function Track({ layout, width }: { layout: TrackLayout; width: number }) {
	return (
		<>
			{layout.countOnly.map((s) => (
				<i
					key={`c${s.from}`}
					data-count-only
					className={cn("absolute top-2 h-2.5 rounded-[2px]", HATCH)}
					style={place(s.from, s.to)}
				/>
			))}
			{layout.band.map((r) => (
				<i
					key={`b${r.from}`}
					data-band={r.level}
					title={r.unread ? UNREAD : undefined}
					className={cn("absolute top-2 h-2.5", BAND_LEVEL[r.level])}
					style={place(r.from, r.to)}
				/>
			))}
			{layout.bars.map((b) => (
				<span
					key={b.item.key}
					data-track-item={b.item.key}
					title={itemTitle(b.item)}
					className={cn(
						// 14px 高：执行中的描边里面还放得下 12px 的名称。
						"absolute top-1.5 h-3.5 overflow-hidden rounded-[2px]",
						BAR_STATE[b.state],
					)}
					style={place(b.from, b.to)}
				>
					{(b.to - b.from) * width >= LABEL_PX && (
						<span className="block truncate px-1.5 text-xs/3 text-fg-1">{b.item.name}</span>
					)}
				</span>
			))}
			{layout.ticks.map((t) => (
				<i
					key={t.item.key}
					data-track-item={t.item.key}
					data-tone={t.tone}
					title={itemTitle(t.item)}
					className={cn("absolute", TICK[t.tone], t.marker && "-translate-x-1/2")}
					style={t.marker ? { left: pct(t.from) } : place(t.from, t.to)}
				/>
			))}
			{layout.flags.map((f) => (
				<FlagIcon
					key={f.item.key}
					data-track-item={f.item.key}
					aria-hidden
					className="absolute top-1.5 size-3 -translate-x-0.5 text-fg-1"
					style={{ left: pct(f.at) }}
				>
					<title>{itemTitle(f.item)}</title>
				</FlagIcon>
			))}
		</>
	);
}

/** 短线：单独的短动作按它的长度画（至少 1.5px），失败的、少见的是比密度带高的竖线。 */
const TICK: Record<TrackTick["tone"], string> = {
	plain: "top-2 h-2.5 min-w-[1.5px] bg-border-strong",
	running: cn("top-2 h-2.5 min-w-[1.5px]", STATUS.running.area.box),
	failed: cn("top-1.25 h-4 min-w-0.5 bg-current", STATUS.failed.tone),
	rare: "top-1.5 h-3.5 min-w-0.75 bg-fg-1",
};

/** 悬停提示：「下单 · 09:12:47.031 · 12ms · 失败」。 */
function itemTitle(item: TrackItem): string {
	const parts = [item.name, formatClockMs(item.start)];
	if (item.kind === "mark") return [...parts, TERM.mark].join(" · ");
	if (item.end === null) return [...parts, NODE_ACTIONS.results.running].join(" · ");
	const result = item.result ? NODE_ACTIONS.results[item.result] : NODE_ACTIONS.results.success;
	return [...parts, formatDuration(item.end - item.start), result].join(" · ");
}

const quoted = (names: readonly string[], most: number) =>
	names
		.slice(0, most)
		.map((n) => `「${n}」`)
		.join("") + (names.length > most ? ` 等 ${names.length} 种` : "");

/**
 * 轨道的可访问名称：「verify 的动作轨道：正在做「保持 4 小时」；「下单」从 08:00:10 起只计数；6 个失败的动作；
 * 少见的动作「风控检查」；1 个标记。逐个查看见下方动作表」。和看的范围无关。
 */
export function tracksLabel(name: string, o: TrackOverview): string {
	const parts: string[] = [];
	if (o.running.length > 0) parts.push(`${NODE_ACTIONS.doing}${quoted(o.running, 3)}`);
	for (const c of o.countOnly.slice(0, 3)) {
		parts.push(`「${c.name}」从 ${formatClock(c.from)} 起${NODE_ACTIONS.countOnly}`);
	}
	if (o.failed > 0) parts.push(`${formatInteger(o.failed)} 个${FAILED}`);
	if (o.rare.length > 0) parts.push(`${RARE}${quoted(o.rare, 5)}`);
	if (o.marks > 0) parts.push(`${formatInteger(o.marks)} 个${TERM.mark}`);
	const body =
		parts.length > 0 ? parts.join("；") : `共 ${formatInteger(o.actions)} 个${TERM.action}`;
	return `${name} 的${TERM.action}轨道：${body}。${SEE_TABLE}`;
}

/** 时间线图例里动作轨道的几项（有动作的节点时才出现）。 */
export function ActionLegend() {
	const items: [string, React.ReactNode][] = [
		[TERM.action, <b key="a" className="inline-block h-2 w-3.5 rounded-[2px] bg-border-strong" />],
		[
			NODE_ACTIONS.countOnly,
			<b key="c" className={cn("inline-block h-2.5 w-3.5 rounded-[2px]", HATCH)} />,
		],
		[FAILED, <b key="f" className={cn("inline-block h-3 w-0.5 bg-current", STATUS.failed.tone)} />],
		[RARE, <b key="r" className="inline-block h-3 w-0.75 bg-fg-1" />],
		[TERM.mark, <FlagIcon key="m" className="size-3 text-fg-1" />],
	];
	return (
		<>
			{items.map(([label, swatch]) => (
				<li key={label} className="inline-flex items-center gap-1.25">
					<span aria-hidden className="inline-flex">
						{swatch}
					</span>
					{label}
				</li>
			))}
		</>
	);
}
