/** 内置等待节点（定时节点、Sleep 节点，docs/SEMANTICS.md §5）在检查器里的显示。 */

/** 定时节点的默认时区（新节点也用它，见 ../add-node.ts）。 */
export const DEFAULT_TZ = "Asia/Shanghai";

/** 时长的中文描述：1 小时 30 分 5 秒。 */
export function describeDuration(ms: number): string {
	if (ms === 0) return "0 秒（立即继续）";
	const parts: string[] = [];
	let rest = ms;
	for (const [unit, label] of [
		[86_400_000, "天"],
		[3_600_000, "小时"],
		[60_000, "分"],
		[1000, "秒"],
		[1, "毫秒"],
	] as const) {
		const n = Math.floor(rest / unit);
		if (n > 0) parts.push(`${n} ${label}`);
		rest -= n * unit;
	}
	return parts.join(" ");
}
