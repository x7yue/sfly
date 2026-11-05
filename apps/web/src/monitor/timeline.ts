import type { NodeRunView } from "@sfly/schema";

/**
 * 链路时间线的计算（纯逻辑，单测见 timeline.test.ts）：节点每次尝试画成哪几段、时间轴显示的范围、刻度。
 * 时间一律是毫秒时间戳；「现在」由调用方传入（页面每秒刷新一次）。
 */

/**
 * 区段类型：queue 排队等待 Agent（含派发、安装节点包、启动执行器），run 执行中，ok 执行完成，
 * fail 失败的尝试，cancel 执行中被取消，wait 定时 / Sleep 节点在等待唤醒时间。
 */
export type SegmentKind = "queue" | "run" | "ok" | "fail" | "cancel" | "wait";

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

const WAIT_KINDS: ReadonlySet<NodeRunView["kind"]> = new Set(["timer", "sleep"]);

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

function executionKind(kind: NodeRunView["kind"], status: string): SegmentKind {
	if (status === "failed") return "fail";
	if (status === "cancelled") return "cancel";
	if (WAIT_KINDS.has(kind) || status === "waiting") return "wait";
	return status === "success" ? "ok" : "run";
}

/** 时间轴最短显示的时长：刚开始的运行也有可读的刻度。 */
export const MIN_SPAN = 10_000;

/** 运行占的时间：从开始到结束（运行中到现在），至少 {@link MIN_SPAN}。 */
export function runExtent(
	run: { started_at: string; ended_at: string | null },
	now: number,
): TimeRange {
	const start = Date.parse(run.started_at);
	const end = time(run.ended_at) ?? now;
	return { start, end: Math.max(end, start + MIN_SPAN) };
}

/**
 * 时间轴显示的范围：没有缩放时是整个运行（运行中即「实时跟随」，右端随现在推进）；
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

/** 时间在范围中的位置（0–1，可能超出）。 */
export const fractionOf = (t: number, range: TimeRange) =>
	(t - range.start) / (range.end - range.start);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const STEPS = [
	1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400,
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

/** 偏移标注：`+0s`、`+45s`、`+2m`、`+2m 30s`、`+1h 05m`。 */
function offsetLabel(ms: number): string {
	const total = Math.round(ms / SECOND);
	if (total < 60) return `+${total}s`;
	const m = Math.floor(total / 60);
	const sec = total % 60;
	if (m < 60) return sec === 0 ? `+${m}m` : `+${m}m ${pad(sec)}s`;
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
