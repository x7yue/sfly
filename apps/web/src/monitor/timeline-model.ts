import type { AttemptView, ChainRunView, NodeRunView } from "@sfly/schema";
import { NODE_STATUS } from "#/lib/node-status";

/**
 * 链路时间线的计算（纯逻辑，单测见 timeline-model.test.ts）：节点每次尝试画成哪几段、时间轴显示的范围、刻度。
 * 时间一律是毫秒时间戳；「现在」由调用方传入（页面每秒刷新一次）。
 */

/**
 * 区段类型：queue 排队等待 Agent（含派发、安装节点包、启动执行器），run 执行中，ok 执行完成，
 * fail 失败的尝试，cancel 执行中被取消，stop 执行中所在子流程被停止，
 * wait 定时 / Sleep 节点在等待唤醒时间、停止子流程节点在等被停止的子流程结束。
 * 尝试的状态对应哪一种执行段见 lib/node-status。
 */
export type SegmentKind = "queue" | "run" | "ok" | "fail" | "cancel" | "stop" | "wait";

export interface Segment {
	kind: SegmentKind;
	start: number;
	end: number;
	/** 还没结束，end 是现在。 */
	live: boolean;
	/** 第几次尝试。 */
	attempt: number;
	taskId: string;
}

export interface TimeRange {
	start: number;
	end: number;
}

const WAIT_KINDS: ReadonlySet<NodeRunView["kind"]> = new Set(["timer", "sleep", "stop_subflow"]);

const time = (iso: string | null) => (iso === null ? null : Date.parse(iso));

/** 一个节点在时间线上的区段：每次尝试先是排队段（有排队时间时），再是执行或等待段。 */
export function nodeSegments(node: NodeRunView, now: number): Segment[] {
	const segments: Segment[] = [];
	for (const a of node.attempts) {
		const queued = Date.parse(a.queued_at);
		const started = time(a.started_at);
		const ended = time(a.ended_at);
		const base = { attempt: a.attempt, taskId: a.task_id };
		const queueEnd = started ?? ended;
		if (queueEnd === null || queueEnd > queued) {
			segments.push({
				...base,
				kind: "queue",
				start: queued,
				end: queueEnd ?? now,
				live: queueEnd === null,
			});
		}
		if (started === null) continue;
		segments.push({
			...base,
			kind: executionKind(node.kind, a.status),
			start: started,
			end: ended ?? now,
			live: ended === null,
		});
	}
	return segments;
}

function executionKind(kind: NodeRunView["kind"], status: AttemptView["status"]): SegmentKind {
	const segment = NODE_STATUS[status].segment;
	// 定时 / Sleep 节点正常执行的时段就是在等待唤醒时间，停止子流程节点就是在等子流程结束。
	return WAIT_KINDS.has(kind) && (segment === "ok" || segment === "run") ? "wait" : segment;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 运行中时间轴的跨度只取这一级一级的值（10 秒起，到一天）：相邻两级相差 25% 到 50%，扩轴时区段最多压缩到原来的 2/3；
 * 只有最后一级（12 小时到一天）是翻倍，压缩一半。
 */
const LIVE_SPANS = [
	10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 450, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200,
	10800, 14400, 21600, 28800, 43200, 86400,
].map((n) => n * SECOND);

/** 运行中时间轴的右端在「现在」之后预留的余量（占已用时长的比例）。 */
export const LIVE_HEADROOM = 0.2;

/**
 * 运行中时间轴的跨度：已用时长加 {@link LIVE_HEADROOM} 的余量，向上取到 {@link LIVE_SPANS} 里的一级。
 * 「现在」越过轴的 1 / (1 + 余量) 才进下一级，两次扩轴之间区段与刻度纹丝不动，只有「现在」线向右推进；
 * 扩轴约每经过 25% 到 50% 的已用时长发生一次。
 */
export function liveSpan(elapsed: number): number {
	const wanted = Math.max(elapsed, 0) * (1 + LIVE_HEADROOM);
	return LIVE_SPANS.find((span) => span >= wanted) ?? Math.ceil(wanted / DAY) * DAY;
}

/** 已结束的运行在轨道末端留的空白（占实际时长的比例）：最后一段不贴着轨道边缘。 */
export const END_PADDING = 0.08;

/** 已结束的运行时间轴最短显示的时长：只防止零时长的运行把轴缩成一点。 */
export const MIN_ENDED_SPAN = 100;

/**
 * 运行占的时间轴：运行中从开始起 {@link liveSpan}（右端有余量，不随「现在」每秒移动）；
 * 已结束的按实际时长定轴并留 {@link END_PADDING} 的空白，短运行也铺满轨道，而不是缩在 10 秒轴的左端。
 */
export function runExtent(
	run: { started_at: string; ended_at: string | null },
	now: number,
): TimeRange {
	const start = Date.parse(run.started_at);
	const ended = time(run.ended_at);
	if (ended === null) return { start, end: start + liveSpan(now - start) };
	const span = Math.max(ended - start, MIN_ENDED_SPAN);
	return { start, end: start + span + Math.round(span * END_PADDING) };
}

/**
 * 时间轴显示的范围：没有缩放时是整个运行（运行中即「实时跟随」，「现在」线在轴上向右推进）；
 * 缩放后固定在选中的范围，直到「回到实时」（清除缩放）。
 */
export function visibleRange(extent: TimeRange, zoom: TimeRange | null): TimeRange {
	return zoom ?? extent;
}

/** 拖选缩放的最短范围。 */
export const MIN_ZOOM = 1000;

/** 拖选的两端（轨道宽度的比例 0–1，顺序不限，超出部分截掉）换算成缩放范围，至少 {@link MIN_ZOOM}。 */
export function zoomFromFractions(range: TimeRange, a: number, b: number): TimeRange {
	const clamp = (f: number) => Math.min(1, Math.max(0, f));
	const span = range.end - range.start;
	const start = range.start + clamp(Math.min(a, b)) * span;
	const end = range.start + clamp(Math.max(a, b)) * span;
	return { start, end: Math.max(end, start + MIN_ZOOM) };
}

/**
 * 放大（factor < 1）或缩小（factor > 1）：以当前范围的中点为中心，跨度乘 factor（至少 {@link MIN_ZOOM}），
 * 超出整个运行的部分平移回来；结果覆盖整个运行时返回 null（清除缩放，运行中即回到实时）。
 */
export function zoomStep(range: TimeRange, factor: number, extent: TimeRange): TimeRange | null {
	const full = extent.end - extent.start;
	const span = Math.min(full, Math.max((range.end - range.start) * factor, MIN_ZOOM));
	if (span >= full) return null;
	const center = (range.start + range.end) / 2;
	const start = Math.min(extent.end - span, Math.max(extent.start, center - span / 2));
	return { start, end: start + span };
}

/** 缩放到一个节点时，在它所有区段的两端各留的余量（占区段总跨度的比例）。 */
export const NODE_ZOOM_MARGIN = 0.05;

/** 缩放到一个节点：范围取它所有区段的起止（执行中的延伸到现在）并各留 {@link NODE_ZOOM_MARGIN}；没有区段为 null，覆盖整个运行也为 null。 */
export function zoomToSegments(segments: readonly Segment[], extent: TimeRange): TimeRange | null {
	if (segments.length === 0) return null;
	const first = Math.min(...segments.map((s) => s.start));
	const last = Math.max(...segments.map((s) => s.end));
	const margin = (last - first) * NODE_ZOOM_MARGIN;
	return zoomStep({ start: first - margin, end: last + margin }, 1, extent);
}

/** 时间在范围中的位置（0–1，可能超出）。 */
export const fractionOf = (t: number, range: TimeRange) =>
	(t - range.start) / (range.end - range.start);

const STEPS = [
	0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200,
	86400,
].map((n) => n * SECOND);

/** 超过这个时长的范围用当地时钟时间标刻度，否则用相对运行开始的偏移。 */
export const CLOCK_LABELS_AFTER = 5 * MINUTE;

export interface Tick {
	at: number;
	label: string;
}

export interface TickOptions {
	/** 运行开始时间：偏移刻度相对它对齐、标注。 */
	origin: number;
	/** 最多几个刻度（默认 8）。 */
	maxTicks?: number;
	/** 当地时间相对 UTC 的偏移（分钟，东八区为 480）；默认取浏览器时区。 */
	utcOffsetMinutes?: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 偏移标注：`+0s`、`+0.2s`、`+45s`、`+2m`、`+2m 30s`、`+1h 05m`。 */
function offsetLabel(ms: number): string {
	const tenths = Math.round(ms / 100);
	const fraction = tenths % 10 === 0 ? "" : `.${tenths % 10}`;
	const total = Math.floor(tenths / 10);
	if (total < 60) return `+${total}${fraction}s`;
	const m = Math.floor(total / 60);
	const sec = total % 60;
	if (m < 60) return sec === 0 && !fraction ? `+${m}m` : `+${m}m ${pad(sec)}${fraction}s`;
	return `+${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

/**
 * 时间轴刻度：选最小的「整」步长使刻度数不超过 maxTicks。5 分钟以内的范围标相对运行开始的偏移
 * （按运行开始对齐）；更长的范围标当地时钟时间（按当地时间的整点对齐）。
 */
export function ticks(range: TimeRange, options: TickOptions): Tick[] {
	const maxTicks = options.maxTicks ?? 8;
	const span = range.end - range.start;
	const step = STEPS.find((s) => span / s <= maxTicks) ?? Math.ceil(span / maxTicks / HOUR) * HOUR;
	const clock = span > CLOCK_LABELS_AFTER;
	const offset = (options.utcOffsetMinutes ?? -new Date(range.start).getTimezoneOffset()) * MINUTE;
	// 对齐的基准：偏移刻度对齐运行开始，时钟刻度对齐当地时间的零点。
	const base = clock ? -offset : options.origin;
	const out: Tick[] = [];
	for (let t = base + Math.ceil((range.start - base) / step) * step; t <= range.end; t += step) {
		if (!clock) {
			out.push({ at: t, label: offsetLabel(t - options.origin) });
			continue;
		}
		const local = new Date(t + offset);
		const hm = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
		out.push({ at: t, label: step < MINUTE ? `${hm}:${pad(local.getUTCSeconds())}` : hm });
	}
	return out;
}

const ATTENTION_STATUSES: ReadonlySet<NodeRunView["status"]> = new Set([
	"dispatched",
	"running",
	"failed",
]);

/**
 * 时间线要保证看得见的那一行：按链的顺序第一个正在执行或失败的节点；它所在的链收起（汇总模式）时是链的汇总行
 * （nodeId 为 null）。没有这样的节点为 null。
 */
export function attentionRow(
	chains: readonly ChainRunView[],
	isOpen: (chain: ChainRunView) => boolean,
): { chainId: string; nodeId: string | null } | null {
	for (const chain of chains) {
		const node = chain.nodes.find((n) => ATTENTION_STATUSES.has(n.status));
		if (node) return { chainId: chain.id, nodeId: isOpen(chain) ? node.node_id : null };
	}
	return null;
}

/** 时间线行的高度，单位 px。 */
export const AXIS_HEIGHT = 22;
export const CHAIN_ROW_HEIGHT = 30;
export const NODE_ROW_HEIGHT = 26;
/**
 * 最后一行下面留的空白：执行中段尾的脉冲光环会放大到超出行高，没有这块空白它会撑出一截滚动，
 * 行不多、主体刚好放下全部行时滚动条就随脉冲一闪一闪。
 */
export const ROWS_BOTTOM_PADDING = 8;

/** 时间线主体的内容高度；主体的最大高度据此定：行不多时全部露出，不让正在执行的节点藏到折叠线下面。 */
export function timelineContentHeight<C extends { nodes: readonly unknown[] }>(
	chains: readonly C[],
	isOpen: (chain: C) => boolean,
): number {
	return chains.reduce(
		(height, chain) =>
			height + CHAIN_ROW_HEIGHT + (isOpen(chain) ? chain.nodes.length * NODE_ROW_HEIGHT : 0),
		AXIS_HEIGHT + ROWS_BOTTOM_PADDING,
	);
}

/** 时间线默认用汇总模式的阈值：链实例多于这么多条，或展开后的行（链 + 节点）多于这么多行。 */
export const SUMMARY_CHAINS = 6;
export const SUMMARY_ROWS = 24;

/**
 * 打开页面时时间线的显示模式：链实例或节点很多时默认「汇总」（每条链一行），把高度留给图表；
 * 否则「展开节点」。用户切换过之后以用户的选择为准（由调用方保存）。
 */
export function defaultTimelineMode(chains: number, nodes: number): "summary" | "expanded" {
	return chains > SUMMARY_CHAINS || chains + nodes > SUMMARY_ROWS ? "summary" : "expanded";
}
