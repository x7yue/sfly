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

/** `2099-01-01 08:00:05`：完整的日期时间（总是带年份和秒），用于 Agent 时间这类可能离现在很远的时间。 */
export function formatFullDateTime(iso: string): string {
	const d = new Date(iso);
	const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	return `${date} ${formatClock(d.getTime())}`;
}

/** 字节数：`812 B`、`12.4 KB`、`3.1 MB`。 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 耗时：`850ms`、`12.3s`、`3m 05s`、`1h 02m`、`2d 03h`。 */
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

/** 指标值：`1.2M`、`12.3k`、`812`、`3.14`。 */
export function formatMetric(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1e6) return `${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
	if (abs >= 1e4) return `${(value / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`;
	if (Number.isInteger(value)) return String(value);
	return abs >= 100 ? value.toFixed(0) : abs >= 10 ? value.toFixed(1) : value.toFixed(2);
}

/** 运行、链实例等 ID 的短形式（前 8 位）。 */
export const shortId = (id: string) => id.slice(0, 8);
