import {
	compareRunLogKeys,
	LogOrigin,
	type RunLogLine,
	type RunLogPage,
	runLogKey,
} from "@sfly/schema";
import { isTruncationMarker, MAX_LOADED_LINES } from "./log-buffer";

/**
 * 合并视图已加载的日志（纯逻辑，单测见 run-log-buffer.test.ts）：先读最新一页，再从它的 `live_after` 接上实时推送，
 * 向上滚动时用 before 游标往前翻页。
 *
 * 行始终按合并日志的排序键（@sfly/schema 的 run-log-order.ts，与控制面同一个比较函数）排列：往前翻的页和实时推送的行
 * 都按排序键插到对应的位置，按「任务 + 序号」去重。断线后补发的行（晚到的行）可能比已有的别的任务的行更早，
 * 甚至比已加载的最早一行还早，同样插到它应在的位置；之后往前翻到的页再插到它前后。同一任务内永远按序号：
 * 个别任务的控制面时间有超过 2 秒的倒挂（§6.3），插入位置不早于这个任务序号更小的行、不晚于序号更大的行。
 *
 * 范围或级别变了就换一个缓冲区、从最新一页重新读：游标只对读它时的范围和级别有效。
 *
 * 游标对前端不透明，所以只能整页丢掉：每一页记下读它之前的行用的游标和它加入的行，丢掉最早的几页之后，
 * 剩下最早那一页的游标正好能把丢掉的行重新读回来。实时推送的行不属于任何一页，往前翻页读不回它们，所以不丢；
 * 它们多到超过上限时，整个缓冲区从最新一页重新读（{@link needsReload}），推送过的行都在那一页或它之前。
 */

/** 已加载的一页：读它之前的行用的游标（null：之前没有了），和它加入的行（已有的行不算）。 */
interface LoadedPage {
	before: string | null;
	keys: ReadonlySet<string>;
}

export interface RunLogBuffer {
	/** 按合并日志的顺序，从早到晚。 */
	lines: RunLogLine[];
	/** 已加载的页，从早到晚；最早那一页的 before 是向上滚动时读更早的行用的游标。 */
	pages: LoadedPage[];
	loaded: boolean;
	truncatedTasks: LogOrigin[];
	expired: boolean;
}

export const emptyRunBuffer: RunLogBuffer = {
	lines: [],
	pages: [],
	loaded: false,
	truncatedTasks: [],
	expired: false,
};

export const runLineKey = (line: Pick<RunLogLine, "task_id" | "seq">) =>
	`${line.task_id}:${line.seq}`;

/** 往前翻页用的游标；null 表示已经读到运行的开头。 */
export const olderCursor = (buffer: RunLogBuffer): string | null => buffer.pages[0]?.before ?? null;

/**
 * 已加载的页都没有行、前面还有内容：筛选很少匹配时，一页（单次请求的扫描量用完）可以一行都没有，
 * 要接着往前读，直到读到行或读到开头，不能显示成没有日志。
 */
export const needsOlder = (buffer: RunLogBuffer): boolean =>
	buffer.loaded && buffer.lines.length === 0 && olderCursor(buffer) !== null;

/**
 * 把 fresh 按排序键插进 lines（各自已排好），已有的行（同一任务、同一序号）不重复；返回插入后的行和新加入的行的键。
 * 每一行的位置按排序键二分查找，再夹在同一任务序号更小的行之后、序号更大的行之前（这两行也靠二分查找找到，
 * 所以插入一行不必扫过整个缓冲区）。
 */
function insert(
	lines: RunLogLine[],
	fresh: RunLogLine[],
): { lines: RunLogLine[]; added: Set<string> } {
	const byTask = new Map<string, RunLogLine[]>();
	for (const line of lines) {
		const mine = byTask.get(line.task_id);
		if (mine) mine.push(line);
		else byTask.set(line.task_id, [line]);
	}
	const out = [...lines];
	const added = new Set<string>();
	for (const line of fresh) {
		const mine = byTask.get(line.task_id) ?? [];
		byTask.set(line.task_id, mine);
		const at = partitionPoint(mine, (other) => other.seq < line.seq);
		if (mine[at]?.seq === line.seq) continue;
		mine.splice(at, 0, line);
		added.add(runLineKey(line));
		let position = insertionPoint(out, line);
		const previous = mine[at - 1];
		const next = mine[at + 1];
		if (previous) position = Math.max(position, indexOfLine(out, previous) + 1);
		if (next) position = Math.min(position, indexOfLine(out, next));
		out.splice(position, 0, line);
	}
	return { lines: out, added };
}

/** 数组开头连续满足 before 的元素个数（数组按 before 划分：前面都满足、后面都不满足）。 */
function partitionPoint<T>(items: readonly T[], before: (item: T) => boolean): number {
	let lo = 0;
	let hi = items.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (before(items[mid] as T)) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** 按排序键，line 应插在 lines 里的哪个位置：排在所有不晚于它的行之后。 */
function insertionPoint(lines: readonly RunLogLine[], line: RunLogLine): number {
	const key = runLogKey(line);
	return partitionPoint(lines, (other) => compareRunLogKeys(runLogKey(other), key) <= 0);
}

/**
 * 缓冲区里已有的 line 的下标。行都按排序键排列时，它就是「应插入的位置」的前一个，二分查找一次就找到；
 * 个别任务的控制面时间倒挂（§6.3）时行不在这里，再逐个找。
 */
function indexOfLine(lines: readonly RunLogLine[], line: RunLogLine): number {
	const guess = insertionPoint(lines, line) - 1;
	return lines[guess] === line ? guess : lines.indexOf(line);
}

const pageOf = (page: RunLogPage, keys: ReadonlySet<string>): LoadedPage => ({
	before: page.reached_start ? null : page.before,
	keys,
});

/** 最新一页（第一次加载或重新读时），控制面已经按排序键排好。 */
export function fromLatestPage(page: RunLogPage): RunLogBuffer {
	return {
		lines: page.lines,
		pages: [pageOf(page, new Set(page.lines.map(runLineKey)))],
		loaded: true,
		truncatedTasks: page.truncated_tasks,
		expired: page.expired,
	};
}

/** 往前翻的一页（`before = olderCursor(buffer)`）：按排序键插入，成为最早的一页。 */
export function withOlderPage(buffer: RunLogBuffer, page: RunLogPage): RunLogBuffer {
	const { lines, added } = insert(buffer.lines, page.lines);
	return {
		...buffer,
		lines,
		pages: [pageOf(page, added), ...buffer.pages],
		truncatedTasks: page.truncated_tasks,
		expired: buffer.expired || page.expired,
	};
}

/** 实时推送的一批行：按排序键插入，不属于任何一页。截断标记（来源 system）到了时把这个任务记为已截断。 */
export function withLiveLines(buffer: RunLogBuffer, fresh: RunLogLine[]): RunLogBuffer {
	const { lines, added } = insert(buffer.lines, fresh);
	if (added.size === 0) return buffer;
	const truncatedTasks = [...buffer.truncatedTasks];
	for (const line of fresh.filter(isTruncationMarker)) {
		if (!truncatedTasks.some((t) => t.task_id === line.task_id)) {
			truncatedTasks.push(LogOrigin.parse(line));
		}
	}
	return { ...buffer, lines, truncatedTasks };
}

/**
 * 超过 maxLines 行时丢掉最早的几页（只丢这些页加入的行），最新一页总是保留；丢掉的行再次向上滚动时重新加载。
 * 实时推送的行不丢。与单节点视图一样，只在加入实时推送的行之后调用（往前翻页加载的行是用户刚要看的，不丢）。
 */
export function keepLatest(buffer: RunLogBuffer, maxLines = MAX_LOADED_LINES): RunLogBuffer {
	let count = buffer.lines.length;
	let drop = 0;
	while (count > maxLines && drop < buffer.pages.length - 1) {
		count -= (buffer.pages[drop] as LoadedPage).keys.size;
		drop++;
	}
	if (drop === 0) return buffer;
	const dropped = new Set(buffer.pages.slice(0, drop).flatMap((p) => [...p.keys]));
	return {
		...buffer,
		lines: buffer.lines.filter((line) => !dropped.has(runLineKey(line))),
		pages: buffer.pages.slice(drop),
	};
}

/**
 * 丢掉更早的页之后仍超过 maxLines 行（实时推送的行太多）：要从最新一页重新读。推送过的行都已写进日志文件，
 * 在新的最新一页里，或者向上滚动时读得到。
 */
export const needsReload = (buffer: RunLogBuffer, maxLines = MAX_LOADED_LINES): boolean =>
	buffer.pages.length <= 1 && buffer.lines.length > maxLines;
