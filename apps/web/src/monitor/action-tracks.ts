import {
	type ActionDetailView,
	type ActionNameCount,
	type ActionResult,
	type ActionSummaryView,
	type CountOnlyPeriod,
	type EndedActionView,
	type RunningActionView,
	sdkCountOnlyPeriods,
} from "@sfly/schema";
import type { TimeRange } from "./timeline-model";

/**
 * 链路时间线上的动作轨道（规格 #345，原型 `tlSvg` 的「动作」「子动作」两条）：一个节点每次尝试读到的动作和摘要合在一起
 * （prepareTracks，数据变了才重算），再按看的范围和轨道的像素宽度排成要画的东西（layoutTracks，每秒随「现在」重算）。
 * 纯逻辑，单测见 action-tracks.test.ts；读哪些数据见 use-action-tracks.ts，取舍写在 docs/ARCHITECTURE.md §6.3。
 *
 * 一个节点最多 10 万条明细，所以画出来的元素数只和像素宽度有关：
 *
 * - 够长的动作（{@link LONG_PX} 以上）一条条画出来（最多 {@link MAX_BARS} 条）。
 * - 其余的按它占的像素分桶（每 {@link BUCKET_PX} 个像素一桶）：桶里只有它一个就单独画成短线；
 *   和别的动作挤在同一桶里就是分不开，这些桶连成密度带，按每桶的个数分三档。
 * - 密度带上失败的动作画红色短线、少见名称的子动作画白色短线，每桶每种至多一个；标记画小旗，少见名称的每桶一面，
 *   常见名称的挤在一起时隔开 {@link FLAG_PX} 才再画一面。
 * - 只计数的段画成斜线；最新一页不是全部明细时，没读到的那些只知道个数，平均分到尝试开始到最早读到的那条之间，
 *   并进密度带。
 * - 完全在范围外的不画，跨过边缘的裁到范围里。
 */

/** 两条轨道：最外层（第 0 层）的动作，和它们里面的子动作（第 1 层起，更深的也画在这一条）。 */
export type TrackId = "top" | "child";
export const TRACK_IDS: readonly TrackId[] = ["top", "child"];

/** 每桶的像素宽度：一个桶里的两个动作画出来会挨在一起、分不开。 */
export const BUCKET_PX = 2;
/** 至少这么长（像素）的动作一条条画出来，不进密度带。 */
export const LONG_PX = 16;
/** 小旗的宽度（像素）：挤在一起的常见名称的标记，隔开这么远才再画一面。 */
export const FLAG_PX = 12;
/** 每条轨道一条条画出来的动作最多这么多；多出来的按短动作处理，进密度带。 */
export const MAX_BARS = 200;
/** 密度带三档的起点：每桶至少几个（含没读到、按平均分进来的）。 */
const LEVEL_FROM = [2, 8, 32] as const;

/**
 * 少见的名称：个数不到最常见那种名称的 1%（{@link RARE_SHARE}），并且不超过 {@link RARE_MAX} 个。原型里「重连撮合网关」
 * （1 个，「下单」有 128 万个）是少见的，「下单」不是。名称都不多时没有少见的：能分开时本来就一个个画出来。
 * 依据是摘要里每种名称的个数（`names`），动作和标记一起算。
 */
export const RARE_SHARE = 0.01;
export const RARE_MAX = 50;

export function rareNames(names: readonly ActionNameCount[]): ReadonlySet<string> {
	const most = Math.max(0, ...names.map((n) => n.total));
	return new Set(
		names.filter((n) => n.total <= RARE_MAX && n.total <= most * RARE_SHARE).map((n) => n.name),
	);
}

/** 一次尝试画在轨道上的数据（use-action-tracks.ts 读）。时间都是控制面时间。 */
export interface TrackSource {
	taskId: string;
	summary: ActionSummaryView;
	/** 读到的明细：最新一页，以及最新一页不是全部时失败的和少见名称的那几页；可以有重复。 */
	details: readonly ActionDetailView[];
	/** 最新一页里最早一条的开始（毫秒）；最新一页就是全部明细时为 null。 */
	loadedFrom: number | null;
	/** 读到的页里控制面兜底的只计数的段。 */
	controlPlanePeriods: readonly CountOnlyPeriod[];
	/** 尝试开始执行的时刻（毫秒）。 */
	startedAt: number;
	/** 尝试结束的时刻（毫秒）；还在执行时为 null。 */
	endedAt: number | null;
}

/** 轨道上的一个动作或标记：明细和摘要里的正在做、最近结束、最近失败合在一起，同一尝试的同一 ID 只有一个。 */
export interface TrackItem {
	/** `任务 ID:动作 ID`。 */
	key: string;
	kind: "action" | "mark";
	name: string;
	start: number;
	/** 结束；还在做时为 null（画到现在）。标记等于开始。 */
	end: number | null;
	/** 结果；还在做时和标记为 null。 */
	result: ActionResult | null;
	/** 名称是少见的（{@link rareNames}）。 */
	rare: boolean;
}

/** 位置都是看的范围里的比例（0–1）。 */
export interface TrackBar {
	from: number;
	to: number;
	item: TrackItem;
	state: "running" | "failed" | "ended";
}

/**
 * 短线：单独的短动作（`marker` 为 false，宽度是它的实际长度），或者密度带上要突出的失败、少见的动作（`marker` 为 true）。
 */
export interface TrackTick {
	from: number;
	to: number;
	item: TrackItem;
	tone: "plain" | "running" | "failed" | "rare";
	marker: boolean;
}

export interface TrackFlag {
	at: number;
	item: TrackItem;
}

export interface BandRun {
	from: number;
	to: number;
	level: 1 | 2 | 3;
	/** 这一段只有没读到、按平均分进来的明细（没有读到的动作在这里）。 */
	unread: boolean;
}

export interface CountOnlySpan {
	from: number;
	to: number;
}

export interface TrackLayout {
	bars: TrackBar[];
	ticks: TrackTick[];
	flags: TrackFlag[];
	band: BandRun[];
	countOnly: CountOnlySpan[];
}

/** 可访问名称用的概括：和看的范围无关。 */
export interface TrackOverview {
	/** 动作（不含标记）的个数（摘要里的计数）。 */
	actions: number;
	/** 正在做的最外层动作的名称，按开始的先后。 */
	running: string[];
	/** 只计数的名称和从什么时候起（毫秒），按起点的先后。 */
	countOnly: { name: string; from: number }[];
	/** 失败的动作的个数（摘要里的计数）。 */
	failed: number;
	/** 子动作里少见名称的动作（不含标记）的名称，按最早一个的开始。 */
	rare: string[];
	/** 标记的个数。 */
	marks: number;
}

interface Spread {
	start: number;
	end: number;
	count: number;
}

interface PreparedTrack {
	/** 按开始的先后。 */
	items: TrackItem[];
	/** `items` 到第 i 个为止最晚的结束（还在做的是无穷大）：找和范围有交集的第一个用。 */
	maxEnd: Float64Array;
	countOnly: { start: number; end: number | null }[];
	spread: Spread[];
}

export interface PreparedTracks {
	tracks: Record<TrackId, PreparedTrack>;
	overview: TrackOverview;
}

const trackOf = (depth: number): TrackId => (depth === 0 ? "top" : "child");

type Summarized = RunningActionView | EndedActionView;

/** 一次尝试的动作：明细在前（来自分页），再用摘要补上；已结束的比还在做的新。 */
function sourceItems(source: TrackSource) {
	const rare = rareNames(source.summary.names);
	const items = new Map<number, { item: TrackItem; depth: number }>();
	/** 每种名称读到了几条明细（只算分页读到的：摘要里最近的那些可能是只计数的）。 */
	const paged = new Map<string, Set<number>>();
	const taskEnd = source.endedAt;
	const put = (id: number, depth: number, item: TrackItem) => {
		const before = items.get(id);
		if (before && (before.item.end !== null || item.end === null)) return;
		items.set(id, { item, depth });
	};
	const make = (
		id: number,
		kind: TrackItem["kind"],
		name: string,
		start: number,
		end: number | null,
		result: ActionResult | null,
	): TrackItem => ({
		key: `${source.taskId}:${id}`,
		kind,
		name,
		start,
		end: kind === "mark" ? start : end,
		result,
		rare: rare.has(name),
	});
	for (const d of source.details) {
		const start = Date.parse(d.started_at);
		const item =
			d.kind === "mark"
				? make(d.id, "mark", d.name, start, start, null)
				: make(
						d.id,
						"action",
						d.name,
						start,
						d.ended_at === null ? null : Date.parse(d.ended_at),
						d.result,
					);
		put(d.id, d.depth, item);
		const ids = paged.get(d.name) ?? new Set<number>();
		paged.set(d.name, ids);
		ids.add(d.id);
	}
	const summarized = (a: Summarized) => {
		const ended = "ended_at" in a;
		put(
			a.id,
			a.depth,
			make(
				a.id,
				"action",
				a.name,
				Date.parse(a.started_at),
				ended ? Date.parse(a.ended_at) : null,
				ended ? a.result : null,
			),
		);
	};
	const { summary } = source;
	for (const a of summary.recent_failed) summarized(a);
	for (const a of summary.recent) summarized(a);
	for (const a of summary.running) summarized(a);
	const merged = [...items.values()];
	if (taskEnd !== null) {
		// 任务结束时还在做的记为未结束，结束在任务结束的那一刻（控制面读取时也是这样算的）。
		for (const m of merged) {
			if (m.item.kind === "action" && m.item.end === null) {
				m.item = { ...m.item, end: Math.max(m.item.start, taskEnd), result: "unfinished" };
			}
		}
	}
	return { items: merged, paged };
}

/** 一个节点每次尝试的动作合在一起，按轨道分好、排好。 */
export function prepareTracks(sources: readonly TrackSource[]): PreparedTracks {
	const lists: Record<TrackId, TrackItem[]> = { top: [], child: [] };
	const countOnly: Record<TrackId, PreparedTrack["countOnly"]> = { top: [], child: [] };
	const spread: Record<TrackId, Spread[]> = { top: [], child: [] };
	const overview: TrackOverview = {
		actions: 0,
		running: [],
		countOnly: [],
		failed: 0,
		rare: [],
		marks: 0,
	};
	const rareChildren: TrackItem[] = [];
	const runningTop: TrackItem[] = [];

	for (const source of sources) {
		const { items, paged } = sourceItems(source);
		/** 名称所在的轨道：读到的这个名称的动作多数在哪一层；一个都没读到时算子动作。 */
		const depthVotes = new Map<string, number>();
		for (const { item, depth } of items) {
			lists[trackOf(depth)].push(item);
			depthVotes.set(item.name, (depthVotes.get(item.name) ?? 0) + (depth === 0 ? 1 : -1));
			if (depth === 0 && item.end === null) runningTop.push(item);
			if (depth > 0 && item.rare && item.kind === "action") rareChildren.push(item);
		}
		const nameTrack = (name: string): TrackId =>
			(depthVotes.get(name) ?? 0) > 0 ? "top" : "child";

		const { summary } = source;
		overview.failed += summary.names.reduce((n, c) => n + c.failed, 0);
		overview.marks += summary.marks;
		overview.actions += summary.total - summary.marks;
		const periods = [
			...sdkCountOnlyPeriods(
				summary,
				{},
				source.endedAt === null ? null : new Date(source.endedAt).toISOString(),
			),
			...source.controlPlanePeriods,
		];
		for (const p of periods) {
			const start = Date.parse(p.from);
			countOnly[nameTrack(p.name)].push({ start, end: p.to === null ? null : Date.parse(p.to) });
			overview.countOnly.push({ name: p.name, from: start });
		}
		if (source.loadedFrom !== null) {
			for (const n of summary.names) {
				const missing = n.reported - (paged.get(n.name)?.size ?? 0);
				if (missing <= 0) continue;
				// 没读到的是最新一页之前的；这个名称只计数以后只有失败的有明细，都已经读到了。
				const capped = n.capped_at === null ? Number.POSITIVE_INFINITY : Date.parse(n.capped_at);
				const end = Math.min(source.loadedFrom, capped);
				if (end > source.startedAt) {
					spread[nameTrack(n.name)].push({ start: source.startedAt, end, count: missing });
				}
			}
		}
	}
	const byStart = (a: TrackItem, b: TrackItem) => a.start - b.start;
	overview.running = runningTop.sort(byStart).map((a) => a.name);
	overview.rare = [...new Set(rareChildren.sort(byStart).map((a) => a.name))];
	overview.countOnly.sort((a, b) => a.from - b.from);
	const track = (id: TrackId): PreparedTrack => {
		const items = lists[id].sort((a, b) => a.start - b.start);
		const maxEnd = new Float64Array(items.length);
		let latest = Number.NEGATIVE_INFINITY;
		items.forEach((item, i) => {
			latest = Math.max(latest, item.end ?? Number.POSITIVE_INFINITY);
			maxEnd[i] = latest;
		});
		return { items, maxEnd, countOnly: countOnly[id], spread: spread[id] };
	};
	return { tracks: { top: track("top"), child: track("child") }, overview };
}

export interface TrackView {
	range: TimeRange;
	/** 现在：还在做的动作画到这里。 */
	now: number;
	/** 轨道的像素宽度。 */
	width: number;
}

/** 按看的范围和像素宽度排好两条轨道。 */
export function layoutTracks(
	prepared: PreparedTracks,
	view: TrackView,
): Record<TrackId, TrackLayout> {
	return {
		top: layoutTrack(prepared.tracks.top, view, false),
		child: layoutTrack(prepared.tracks.child, view, true),
	};
}

/** 第一个满足 `pass` 的下标（`pass` 对下标单调：前面不满足、后面满足）；都不满足时是 n。 */
function firstIndex(n: number, pass: (i: number) => boolean): number {
	let lo = 0;
	let hi = n;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (pass(mid)) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

const levelOf = (count: number): BandRun["level"] =>
	count >= LEVEL_FROM[2] ? 3 : count >= LEVEL_FROM[1] ? 2 : 1;

/**
 * `highlightRare`：少见名称的动作画白色短线（子动作这条）。最外层的动作多半只有几个、每个持续很久，
 * 不再单独突出；少见名称的标记在两条轨道上都画小旗。
 */
function layoutTrack(
	track: PreparedTrack,
	{ range, now, width }: TrackView,
	highlightRare: boolean,
): TrackLayout {
	const out: TrackLayout = { bars: [], ticks: [], flags: [], band: [], countOnly: [] };
	const span = range.end - range.start;
	if (width <= 0 || span <= 0) return out;
	const buckets = Math.max(1, Math.ceil(width / BUCKET_PX));
	const frac = (t: number) => (t - range.start) / span;
	const clamp = (f: number) => Math.min(1, Math.max(0, f));
	const bucketOf = (f: number) => Math.min(buckets - 1, Math.max(0, Math.floor(f * buckets)));

	const { items, maxEnd } = track;
	const lo = firstIndex(items.length, (i) => (maxEnd[i] as number) >= range.start);
	const hi = firstIndex(items.length, (i) => (items[i] as TrackItem).start > range.end);
	/** 每桶里短动作的个数（一个动作占它覆盖的每一桶）。 */
	const crowd = new Uint32Array(buckets);
	/** 每桶里没读到、按平均分进来的个数。 */
	const unread = new Float64Array(buckets);
	/** 短动作：在 `items` 里的下标和它覆盖的第一桶、最后一桶（10 万条时不为每条建对象）。 */
	const shortIndex = new Int32Array(Math.max(0, hi - lo));
	const shortFirst = new Int32Array(shortIndex.length);
	const shortLast = new Int32Array(shortIndex.length);
	let shorts = 0;
	for (let i = lo; i < hi; i++) {
		const item = items[i] as TrackItem;
		const end = item.end ?? now;
		if (end < range.start) continue;
		const from = clamp(frac(item.start));
		const to = clamp(frac(end));
		if (item.kind === "action" && (to - from) * width >= LONG_PX && out.bars.length < MAX_BARS) {
			const state = item.end === null ? "running" : item.result === "failed" ? "failed" : "ended";
			out.bars.push({ from, to, item, state });
			// 够长、一条条画出来的少见动作也在开头标一条白色短线，和密度带上的一样认得出来。
			if (highlightRare && item.rare && state !== "failed") {
				out.ticks.push({ from, to: from, item, tone: "rare", marker: true });
			}
			continue;
		}
		const first = bucketOf(from);
		const last = Math.max(first, bucketOf(to - 1e-9));
		for (let b = first; b <= last; b++) crowd[b] = (crowd[b] as number) + 1;
		shortIndex[shorts] = i;
		shortFirst[shorts] = first;
		shortLast[shorts] = last;
		shorts++;
	}
	const bucketMs = span / buckets;
	for (const s of track.spread) {
		const start = Math.max(s.start, range.start);
		const end = Math.min(s.end, range.end);
		if (end <= start) continue;
		const perMs = s.count / (s.end - s.start);
		for (let b = bucketOf(frac(start)); b <= bucketOf(frac(end) - 1e-9); b++) {
			const b0 = range.start + b * bucketMs;
			const overlap = Math.min(end, b0 + bucketMs) - Math.max(start, b0);
			if (overlap > 0) unread[b] = (unread[b] as number) + perMs * overlap;
		}
	}
	const dense = (b: number) => (crowd[b] as number) >= 2 || (unread[b] as number) > 0;

	const failedMarked = new Set<number>();
	const rareMarked = new Set<number>();
	const flagged = new Set<number>();
	/** 上一面小旗的位置（像素）：挤在一起的常见标记隔开 {@link FLAG_PX} 才再画一面。 */
	let lastFlag = Number.NEGATIVE_INFINITY;
	const flag = (at: number, item: TrackItem) => {
		out.flags.push({ at, item });
		lastFlag = at * width;
	};
	for (let k = 0; k < shorts; k++) {
		const item = items[shortIndex[k] as number] as TrackItem;
		const first = shortFirst[k] as number;
		const last = shortLast[k] as number;
		const from = clamp(frac(item.start));
		const to = clamp(frac(item.end ?? now));
		let crowded = false;
		for (let b = first; b <= last && !crowded; b++) crowded = dense(b);
		if (!crowded) {
			if (item.kind === "mark") flag(from, item);
			else out.ticks.push({ from, to, item, tone: toneOf(item, highlightRare), marker: false });
			continue;
		}
		if (item.kind === "mark") {
			if ((item.rare && !flagged.has(first)) || from * width - lastFlag >= FLAG_PX) {
				flagged.add(first);
				flag(from, item);
			}
		} else if (item.result === "failed") {
			if (!failedMarked.has(first)) {
				failedMarked.add(first);
				out.ticks.push({ from, to: from, item, tone: "failed", marker: true });
			}
		} else if (highlightRare && item.rare && !rareMarked.has(first)) {
			rareMarked.add(first);
			out.ticks.push({ from, to: from, item, tone: "rare", marker: true });
		}
	}

	let run: BandRun | null = null;
	for (let b = 0; b < buckets; b++) {
		if (!dense(b)) {
			run = null;
			continue;
		}
		const level = levelOf((crowd[b] as number) + (unread[b] as number));
		const onlyUnread = (crowd[b] as number) === 0;
		const from = b / buckets;
		const to = (b + 1) / buckets;
		if (run && run.level === level && run.unread === onlyUnread && run.to === from) run.to = to;
		else {
			run = { from, to, level, unread: onlyUnread };
			out.band.push(run);
		}
	}

	const spans = track.countOnly
		.filter((p) => (p.end ?? now) >= range.start && p.start <= range.end)
		.map((p) => ({ from: clamp(frac(p.start)), to: clamp(frac(p.end ?? now)) }))
		.sort((a, b) => a.from - b.from);
	for (const p of spans) {
		const prev = out.countOnly.at(-1);
		if (prev && p.from <= prev.to) prev.to = Math.max(prev.to, p.to);
		else out.countOnly.push({ from: p.from, to: p.to });
	}
	return out;
}

const toneOf = (item: TrackItem, highlightRare: boolean): TrackTick["tone"] =>
	item.result === "failed"
		? "failed"
		: item.end === null
			? "running"
			: highlightRare && item.rare
				? "rare"
				: "plain";
