/** 显示用的格式化（时间按浏览器时区，数字等宽由样式保证）。 */

const pad = (n: number) => String(n).padStart(2, "0");

/** `01-01 08:00`：列表里的日期时间（当年省略年份）。 */
export function formatDateTime(iso: string, now: Date = new Date()): string {
	const d = new Date(iso);
	const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	return d.getFullYear() === now.getFullYear()
		? `${date} ${time}`
		: `${d.getFullYear()}-${date} ${time}`;
}

/** 字节数：`812 B`、`12.4 KB`、`3.1 MB`。 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 耗时：`850ms`、`12.3s`、`3m 05s`、`1h 02m`。 */
export function formatDuration(ms: number): string {
	const d = Math.max(0, ms);
	if (d < 1000) return `${Math.round(d)}ms`;
	const s = d / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${pad(Math.floor(s % 60))}s`;
	return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
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
