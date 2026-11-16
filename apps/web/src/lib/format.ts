/** 显示用的格式化（时间按浏览器时区，数字等宽由样式保证）。 */

import { controlPlaneNow } from "./control-plane-time";

const pad = (n: number) => String(n).padStart(2, "0");

/** `01-01 08:00`：列表里的日期时间（当年省略年份；"当年"按控制面时间）。 */
export function formatDateTime(iso: string, now: Date = new Date(controlPlaneNow())): string {
	const d = new Date(iso);
	const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	return d.getFullYear() === now.getFullYear()
		? `${date} ${time}`
		: `${d.getFullYear()}-${date} ${time}`;
}

/** 没有记录的时间显示成这个，不猜一个值（ADR 0018：升级之前存下的数据缺一种时间）。 */
export const TIME_NOT_RECORDED = "未记录";

const fullDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** `2099-01-01 08:00:05`：完整的日期时间（总是带年份和秒），用于 Agent 时间这类可能离现在很远的时间。 */
export function formatFullDateTime(iso: string): string {
	const d = new Date(iso);
	return `${fullDate(d)} ${formatClock(d.getTime())}`;
}

/** `2099-01-01 08:00:05.120`：带日期的日志行时刻（列表里有不在运行开始那天的时间时用，见 spansOtherDay）。 */
export function formatFullDateTimeMs(iso: string): string {
	const d = new Date(iso);
	return `${fullDate(d)} ${formatClockMs(d.getTime())}`;
}

/**
 * 这些时间里有没有哪个和 day 不在同一天（浏览器时区）；没有记录的时间（null）不算。
 * 日志的时间列平时只显示时刻；列表里有一行显示的时间不在运行开始那天（控制面时间）时整列都带上日期，
 * 否则 Agent 时间差出几百天、或跨过零点的行看不出差别。
 */
export function spansOtherDay(times: Iterable<string | null>, day: string): boolean {
	const date = fullDate(new Date(day));
	for (const time of times) {
		if (time !== null && fullDate(new Date(time)) !== date) return true;
	}
	return false;
}

/** 字节数：`812 B`、`12.4 KB`、`3.1 MB`。 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 给定值的耗时（动作耗时、运行结束后的耗时）：`850ms`、`12.3s`、`3m 05s`、`1h 02m`、`2d 03h`。
 * 每秒刷新的「已持续多久」用 {@link formatElapsed}。
 */
export function formatDuration(ms: number): string {
	const d = Math.max(0, ms);
	if (d < 1000) return `${Math.round(d)}ms`;
	const s = d / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${pad(Math.floor(s % 60))}s`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ${pad(m % 60)}m`;
	// 长时间的浸泡测试：超过一天换成「天 + 小时」，不出现「7474h」。
	return `${Math.floor(h / 24)}d ${pad(h % 24)}h`;
}

/**
 * 每秒刷新的「已持续多久」和「多久前」：`2s`、`2m 10s`、`1h 02m`。秒取整，一分钟以内也不写小数：
 * 界面每秒刷新一次，带小数时小数位基本不动（5.3s、6.3s、7.3s），读起来像假的。
 */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 60 ? `${seconds}s` : formatDuration(seconds * 1000);
}

/** 还在走的时长（`live`，每秒刷新）用 {@link formatElapsed}，已经定下来的用 {@link formatDuration}。 */
export const formatSpan = (ms: number, live: boolean): string =>
	live ? formatElapsed(ms) : formatDuration(ms);

const CLOCK_OFFSET_UNITS: Array<[ms: number, unit: string]> = [
	[86_400_000, "天"],
	[3_600_000, "小时"],
	[60_000, "分钟"],
	[1000, "秒"],
];

/**
 * 时钟偏差（Agent 时间 − 控制面时间，毫秒）：`快 613 天`、`慢 3 秒`。正数是 Agent 比控制面快；
 * 按大小选天、小时、分钟、秒，只取最大的单位、舍去零头。要不要显示由接口的 `exceeds_threshold` 决定，这里只管格式。
 */
export function formatClockOffset(offsetMs: number): string {
	const abs = Math.abs(offsetMs);
	const [size, unit] =
		CLOCK_OFFSET_UNITS.find(([ms]) => abs >= ms) ?? (CLOCK_OFFSET_UNITS.at(-1) as [number, string]);
	return `${offsetMs >= 0 ? "快" : "慢"} ${Math.floor(abs / size)} ${unit}`;
}

/** `08:00`：一天内的时刻（只到分钟）。 */
export function formatHourMinute(iso: string): string {
	const d = new Date(iso);
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `08:00:05`：当天内的时刻（浏览器时区）。 */
export function formatClock(time: number | string): string {
	const d = new Date(time);
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `08:00:05.120`：日志行的时刻（带毫秒）。 */
export function formatClockMs(time: number | string): string {
	const d = new Date(time);
	return `${formatClock(d.getTime())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** 指标值：`1.2M`、`12.3k`、`812`、`3.14`；和运行通知的卡片共用同一个定义。 */
export { formatMetric } from "@sfly/schema";

/** 整数加千位分隔：`1,284,819`（计数）。 */
export const formatInteger = (n: number): string => Math.round(n).toLocaleString("en-US");

/** 一个值在界面上怎么写：字符串原样，其余按 JSON（预设参数的值、保存的值）。 */
export const valueText = (value: unknown): string =>
	typeof value === "string" ? value : JSON.stringify(value);

/** 错误写成一句话，放进弹窗里的 `FormAlert`。 */
export const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** 运行、链实例等 ID 的短形式（前 8 位）；和运行通知卡片里的链名称共用同一个定义。 */
export { shortId } from "@sfly/orchestration";
