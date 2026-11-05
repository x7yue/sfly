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
