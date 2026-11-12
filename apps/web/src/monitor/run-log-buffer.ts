import type { LogOrigin, RunLogLine, RunLogPage } from "@sfly/schema";
import { MAX_LOADED_LINES } from "./log-buffer";

/**
 * 合并视图已加载的日志（纯逻辑，单测见 run-log-buffer.test.ts）：先读最新一页，向上滚动时用 before 游标往前翻页。
 * 行的顺序由控制面决定（docs/ARCHITECTURE.md §6.3），往前翻的一页整页都在已加载的行之前，接在前面即可。
 *
 * 游标对前端不透明，所以只能在页的边界上丢掉行：每一页记下读它之前的行用的游标，丢掉最早的几页之后，
 * 剩下最早那一页的游标正好能把丢掉的行重新读回来。
 */

/** 已加载的一页：它加进来的行数，和读它之前的行用的游标（null：之前没有了）。 */
interface LoadedPage {
	size: number;
	before: string | null;
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

const loadedPage = (page: RunLogPage, size: number): LoadedPage => ({
	size,
	before: page.reached_start ? null : page.before,
});

/** 最新一页（第一次加载时）。 */
export function fromLatestPage(page: RunLogPage): RunLogBuffer {
	return {
		lines: page.lines,
		pages: [loadedPage(page, page.lines.length)],
		loaded: true,
		truncatedTasks: page.truncated_tasks,
		expired: page.expired,
	};
}

/** 往前翻的一页（`before = olderCursor(buffer)`）：接在前面，已经有的行（同一任务、同一序号）不重复。 */
export function withOlderPage(buffer: RunLogBuffer, page: RunLogPage): RunLogBuffer {
	const loaded = new Set(buffer.lines.map(runLineKey));
	const fresh = page.lines.filter((line) => !loaded.has(runLineKey(line)));
	return {
		...buffer,
		lines: [...fresh, ...buffer.lines],
		pages: [loadedPage(page, fresh.length), ...buffer.pages],
		truncatedTasks: page.truncated_tasks,
		expired: buffer.expired || page.expired,
	};
}

/**
 * 超过 maxLines 行时丢掉最早的几页，最新一页总是保留；丢掉的行再次向上滚动时重新加载。
 * 与单节点视图一样，只在加入更新的行之后调用（往前翻页加载的行是用户刚要看的，不丢）。
 */
export function keepLatest(buffer: RunLogBuffer, maxLines = MAX_LOADED_LINES): RunLogBuffer {
	let dropLines = 0;
	let dropPages = 0;
	while (buffer.lines.length - dropLines > maxLines && dropPages < buffer.pages.length - 1) {
		dropLines += (buffer.pages[dropPages] as LoadedPage).size;
		dropPages++;
	}
	if (dropPages === 0) return buffer;
	return {
		...buffer,
		lines: buffer.lines.slice(dropLines),
		pages: buffer.pages.slice(dropPages),
	};
}
