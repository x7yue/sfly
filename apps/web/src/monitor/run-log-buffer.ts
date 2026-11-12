import {
	compareRunLogKeys,
	type LogOrigin,
	type RunLogLine,
	type RunLogPage,
	runLogKey,
} from "@sfly/schema";
import { MAX_LOADED_LINES } from "./log-buffer";

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

/** 合并视图里一行的身份：任务加序号。 */
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
 * 位置按排序键二分查找，再夹在同一任务序号更小的行之后、序号更大的行之前。
 */
function insert(
	lines: RunLogLine[],
	fresh: RunLogLine[],
): { lines: RunLogLine[]; added: Set<string> } {
	const seen = new Set(lines.map(runLineKey));
	const added = new Set<string>();
	const out = [...lines];
	for (const line of fresh) {
		const key = runLineKey(line);
		if (seen.has(key)) continue;
		seen.add(key);
		added.add(key);
		const sortKey = runLogKey(line);
		let lo = 0;
		let hi = out.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (compareRunLogKeys(runLogKey(out[mid] as RunLogLine), sortKey) <= 0) lo = mid + 1;
			else hi = mid;
		}
		let after = 0;
		let before = out.length;
		for (let i = 0; i < out.length; i++) {
			const other = out[i] as RunLogLine;
			if (other.task_id !== line.task_id) continue;
			if (other.seq < line.seq) after = i + 1;
			else if (before === out.length) before = i;
		}
		out.splice(Math.min(Math.max(lo, after), before), 0, line);
	}
	return { lines: out, added };
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
	for (const { source, task_id, chain_instance_id, subflow, node_id, attempt } of fresh) {
		if (source === "system" && !truncatedTasks.some((t) => t.task_id === task_id)) {
			truncatedTasks.push({ task_id, chain_instance_id, subflow, node_id, attempt });
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
