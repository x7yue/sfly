/**
 * 按运行读取日志的两种游标（docs/ARCHITECTURE.md §6.3），对外都是不透明字符串，内容都是「任务 → 一个数」的向量：
 *
 * - 分页游标（#223）：每个任务在自己日志文件里读到的字节偏移。
 * - 实时推送的位置（#225）：每个任务已经推送到的序号（实时流起点 `live_after` 和每个事件的 ID）。
 *
 * 写法相同，开头的标记不同（分页是 `1`，实时推送是 `s`），一种游标传给另一种接口时解不出来，不会被当成另一种理解：
 *
 * - 任务用它的创建顺序（`tasks.seq`，全局递增、不会变）代替任务 ID，几百个任务时游标也只有几 KB，放得进查询参数和请求头。
 * - 为 0 的任务不写进去：游标里没有的任务一律按 0 理解（往前翻页时之前没有内容，往后接续和实时推送时从头读）。
 * - 标记后面按任务创建顺序从小到大，每个任务一段 `-<与上一个任务的创建顺序之差>.<数>`，数字都是 36 进制。
 *   有标记，所以「全部为 0」的游标也不是空字符串。
 */

/** 任务的创建顺序 → 字节偏移。 */
export type TaskPositions = ReadonlyMap<number, number>;
/** 任务的创建顺序 → 已推送的最大序号。 */
export type TaskSeqs = ReadonlyMap<number, number>;

const PAGE = "1";
const LIVE = "s";
const ENTRY = /-([0-9a-z]{1,10})\.([0-9a-z]{1,10})/y;

function encode(tag: string, vector: ReadonlyMap<number, number>): string {
	let out = tag;
	let previous = 0;
	for (const [order, value] of [...vector].sort(([a], [b]) => a - b)) {
		if (value <= 0) continue;
		out += `-${(order - previous).toString(36)}.${value.toString(36)}`;
		previous = order;
	}
	return out;
}

function decode(tag: string, cursor: string): Map<number, number> | undefined {
	if (!cursor.startsWith(tag)) return undefined;
	const vector = new Map<number, number>();
	let order = 0;
	ENTRY.lastIndex = tag.length;
	while (ENTRY.lastIndex < cursor.length) {
		const match = ENTRY.exec(cursor);
		if (!match) return undefined;
		const delta = Number.parseInt(match[1] as string, 36);
		if (delta <= 0 && vector.size > 0) return undefined;
		order += delta;
		vector.set(order, Number.parseInt(match[2] as string, 36));
	}
	return vector;
}

export const encodeRunLogCursor = (positions: TaskPositions): string => encode(PAGE, positions);

/** 不是 {@link encodeRunLogCursor} 编码出来的字符串时为 undefined。 */
export const decodeRunLogCursor = (cursor: string): TaskPositions | undefined =>
	decode(PAGE, cursor);

export const encodeRunLogLiveCursor = (seqs: TaskSeqs): string => encode(LIVE, seqs);

/** 不是 {@link encodeRunLogLiveCursor} 编码出来的字符串时为 undefined。 */
export const decodeRunLogLiveCursor = (cursor: string): TaskSeqs | undefined =>
	decode(LIVE, cursor);
