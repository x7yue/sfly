/**
 * 按运行分页的游标（#223，docs/ARCHITECTURE.md §6.3）：每个任务在自己日志文件里读到的字节偏移组成的向量。
 * 对外是不透明字符串。
 *
 * - 任务用它的创建顺序（`tasks.seq`，全局递增、不会变）代替任务 ID，几百个任务时游标也只有几 KB，放得进查询参数。
 * - 偏移为 0 的任务不写进去：游标里没有的任务一律按偏移 0 理解（往前翻页时之前没有内容，往后接续时从头读）。
 * - 格式：`1` 后面按任务创建顺序从小到大，每个任务一段 `-<与上一个任务的创建顺序之差>.<偏移>`，数字都是 36 进制。
 *   开头的 `1` 是格式版本，也让「全部为 0」的游标不是空字符串。
 */

/** 任务的创建顺序 → 字节偏移。 */
export type TaskPositions = ReadonlyMap<number, number>;

const VERSION = "1";
const ENTRY = /-([0-9a-z]{1,10})\.([0-9a-z]{1,10})/y;

export function encodeRunLogCursor(positions: TaskPositions): string {
	let out = VERSION;
	let previous = 0;
	for (const [order, offset] of [...positions].sort(([a], [b]) => a - b)) {
		if (offset <= 0) continue;
		out += `-${(order - previous).toString(36)}.${offset.toString(36)}`;
		previous = order;
	}
	return out;
}

/** 不是这里编码出来的字符串时为 undefined。 */
export function decodeRunLogCursor(cursor: string): TaskPositions | undefined {
	if (!cursor.startsWith(VERSION)) return undefined;
	const positions = new Map<number, number>();
	let order = 0;
	ENTRY.lastIndex = VERSION.length;
	while (ENTRY.lastIndex < cursor.length) {
		const match = ENTRY.exec(cursor);
		if (!match) return undefined;
		const delta = Number.parseInt(match[1] as string, 36);
		if (delta <= 0 && positions.size > 0) return undefined;
		order += delta;
		positions.set(order, Number.parseInt(match[2] as string, 36));
	}
	return positions;
}
