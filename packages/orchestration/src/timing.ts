import type { OrchestrationDocument } from "@sfly/schema";
import { referencesIn } from "./references.js";

/**
 * 内置等待节点的配置（docs/SEMANTICS.md §5）：定时节点的 `at` / `tz`，Sleep 节点的 `duration`。
 * 控制面的引擎（计算唤醒时间）、保存 / 触发时的静态检查和画布共用这里的解析。
 */

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const DURATION = /^(?:\d+(?:ms|s|m|h|d))+$/;
const DURATION_PART = /(\d+)(ms|s|m|h|d)/g;

/**
 * Sleep 时长 → 毫秒：`30s`、`10m`、`1h`、`1h30m`、`250ms`、`2d`（整数 + 单位，可组合）；
 * 引用解析出的数字按秒。无法识别时为 null。
 */
export function parseDuration(value: unknown): number | null {
	if (typeof value === "number") {
		return Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) : null;
	}
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (!DURATION.test(text)) return null;
	let ms = 0;
	for (const [, n, unit] of text.matchAll(DURATION_PART)) {
		ms += Number(n) * UNIT_MS[unit as keyof typeof UNIT_MS];
	}
	return ms;
}

const TIME_OF_DAY = /^(\d{2}):(\d{2}):(\d{2})$/;
const DATE_TIME =
	/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?$/i;

interface WallClock {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
	ms: number;
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatter(tz: string): Intl.DateTimeFormat | null {
	let f = formatters.get(tz);
	if (f === undefined) {
		try {
			f = new Intl.DateTimeFormat("en-US", {
				timeZone: tz,
				hourCycle: "h23",
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
			});
		} catch {
			f = null;
		}
		formatters.set(tz, f);
	}
	return f;
}

/** IANA 时区名是否有效（例如 `Asia/Shanghai`、`UTC`）。 */
export const isTimeZone = (tz: string) => tz.trim() !== "" && formatter(tz) !== null;

/** 某个时刻在时区里的墙上时间（精确到秒）。 */
function wallClockAt(f: Intl.DateTimeFormat, instant: number): WallClock {
	const parts = Object.fromEntries(
		f.formatToParts(new Date(instant)).map((p) => [p.type, Number(p.value)]),
	);
	return {
		year: parts.year ?? 0,
		month: parts.month ?? 1,
		day: parts.day ?? 1,
		hour: (parts.hour ?? 0) % 24,
		minute: parts.minute ?? 0,
		second: parts.second ?? 0,
		ms: 0,
	};
}

const utcOf = (w: WallClock) =>
	Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.ms);

/** 时区在某个时刻相对 UTC 的偏移（毫秒）。 */
const offsetAt = (f: Intl.DateTimeFormat, instant: number) =>
	utcOf(wallClockAt(f, instant)) - Math.floor(instant / 1000) * 1000;

/** 时区里的墙上时间 → 时刻（夏令时切换时按切换后的偏移）。 */
function instantOf(f: Intl.DateTimeFormat, wall: WallClock): number {
	const guess = utcOf(wall);
	const first = guess - offsetAt(f, guess);
	const second = guess - offsetAt(f, first);
	return second;
}

function validWall(w: WallClock): boolean {
	if (w.hour > 23 || w.minute > 59 || w.second > 59) return false;
	const d = new Date(Date.UTC(w.year, w.month - 1, w.day));
	return (
		d.getUTCFullYear() === w.year && d.getUTCMonth() === w.month - 1 && d.getUTCDate() === w.day
	);
}

/**
 * 定时节点的目标时刻。`at` 为 `HH:MM:SS` 时是节点开始执行（start）当天（按 tz）的这个时刻；
 * 为完整日期时间时，带偏移（`Z` / `+08:00`）按偏移，不带偏移按 tz。格式或时区无效时为 null。
 * 目标时刻不晚于 start 时节点立即成功（late）。
 */
export function timerTarget(at: string, tz: string, start: Date): Date | null {
	const f = formatter(tz);
	if (!f) return null;
	const text = at.trim();
	const time = TIME_OF_DAY.exec(text);
	if (time) {
		const today = wallClockAt(f, start.getTime());
		const wall = {
			...today,
			hour: Number(time[1]),
			minute: Number(time[2]),
			second: Number(time[3]),
		};
		return validWall(wall) ? new Date(instantOf(f, wall)) : null;
	}
	const dt = DATE_TIME.exec(text);
	if (!dt) return null;
	const wall: WallClock = {
		year: Number(dt[1]),
		month: Number(dt[2]),
		day: Number(dt[3]),
		hour: Number(dt[4]),
		minute: Number(dt[5]),
		second: Number(dt[6] ?? 0),
		ms: Number((dt[7] ?? "0").padEnd(3, "0")),
	};
	if (!validWall(wall)) return null;
	const zone = dt[8];
	if (!zone) return new Date(instantOf(f, wall));
	if (zone.toUpperCase() === "Z") return new Date(utcOf(wall));
	const sign = zone.startsWith("-") ? -1 : 1;
	const digits = zone.slice(1).replace(":", "");
	const offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
	return new Date(utcOf(wall) - offset);
}

/** `at` 本身的格式是否有效（不看时区）。 */
export const isTimerAt = (at: string) => timerTarget(at, "UTC", new Date(0)) !== null;

export type TimingWarningCode = "timer_at_invalid" | "timer_tz_invalid" | "sleep_duration_invalid";

export interface TimingWarning {
	code: TimingWarningCode;
	message: string;
	node_id: string;
	/** 出问题的配置项：`at`、`tz` 或 `duration`。 */
	input: string;
}

/** 定时 / Sleep 节点的配置检查；含引用的 Sleep 时长到执行时才知道，这里不检查。 */
export function timingWarnings(doc: Pick<OrchestrationDocument, "nodes">): TimingWarning[] {
	const warnings: TimingWarning[] = [];
	for (const node of doc.nodes) {
		if (node.kind === "timer") {
			if (!isTimerAt(node.at)) {
				warnings.push({
					code: "timer_at_invalid",
					message: `定时节点 ${node.id} 的时刻 "${node.at}" 无效：需要 HH:MM:SS 或完整的日期时间（如 2026-01-02T09:30:00）`,
					node_id: node.id,
					input: "at",
				});
			}
			if (!isTimeZone(node.tz)) {
				warnings.push({
					code: "timer_tz_invalid",
					message: `定时节点 ${node.id} 的时区 "${node.tz}" 无效：需要 IANA 时区名（如 Asia/Shanghai）`,
					node_id: node.id,
					input: "tz",
				});
			}
		} else if (node.kind === "sleep") {
			if (referencesIn(node.duration).length === 0 && parseDuration(node.duration) === null) {
				warnings.push({
					code: "sleep_duration_invalid",
					message: `Sleep 节点 ${node.id} 的时长 "${node.duration}" 无效：例如 30s、10m、1h、1h30m`,
					node_id: node.id,
					input: "duration",
				});
			}
		}
	}
	return warnings;
}
