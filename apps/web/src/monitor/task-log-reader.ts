import type { LogChunk, LogFileProblem, LogLineView, LogLocate, LogPage } from "@sfly/schema";
import { createStore, type Reader } from "#/lib/reader";

/**
 * 一个任务的日志读取器（单测见 task-log-reader.test.ts）：先读最后一页历史（服务端按筛选条件过滤；给了 `at`
 * 时读包含那一刻的一页，#347），再用 `after_seq` 接上实时流（浏览器按同样的条件过滤），往前翻页补更早的行。
 * 合并规则和读取时序都在这里。
 *
 * 合并规则：已加载的行在日志文件里是连续的一段 [start, end)（筛掉的行除外），按序号排列、不重复。
 *
 * 读取时序：
 * - 定位读到的是文件中间的一页：之后还有行（`hasNewer`），要用 `after=end` 往后翻页读到文件末尾，实时流才能接上；
 *   `hasNewer` 为 true 时不连实时流，不然推来的行与已加载的行之间会有缺口。
 * - 往前、往后翻页各自同一时刻只读一页，`loadingOlder`、`loadingNewer` 就是在途标记；没有更早（更新）的行时翻页不读。
 * - 读取器 `dispose` 之后（任务、级别或定位的时刻变了），在途的结果都作废。
 */

/** 已加载的一行及其在日志文件中的字节偏移。 */
export type LoadedLine = LogLineView & { offset: number };

export interface LogBuffer {
	/** 符合筛选条件的行（按序号），最多 maxLines 行。 */
	lines: LoadedLine[];
	/** 已加载部分在文件中的起点：往前翻页用 `before=start`。 */
	start: number;
	/** 已加载部分在文件中的终点：实时流的下一批应从这里开始；`hasNewer` 时往后翻页用 `after=end`。 */
	end: number;
	hasOlder: boolean;
	/** 终点之后还有没读到的行（定位到中间一页时）：先往后翻页读到末尾，再连实时流。 */
	hasNewer: boolean;
	loaded: boolean;
	truncated: boolean;
	expired: boolean;
	/**
	 * 日志文件的问题（#721）：写过日志但文件不在了、或者比记录的短；没有问题时为 null。页里和实时流连上时的事件都会说；
	 * 说过的不会因为后来的页没带而消失（文件不会自己回来）。
	 */
	fileProblem: LogFileProblem | null;
	/** 读最后一页时已写入的最大序号：实时流从它之后接上。 */
	lastSeq: number;
	/** 定位到某一刻读到的位置和正好对应的行；不是定位读到的为 null。 */
	located: LogLocate | null;
}

/** 浏览器里最多保留的行数：实时追加超过时丢掉最早的行（仍可往前翻页重新加载）。 */
export const MAX_LOADED_LINES = 5000;

/** 控制面写满单个任务的日志上限后追加的截断标记（来源 system）。 */
export const isTruncationMarker = (line: Pick<LogLineView, "source">) => line.source === "system";

/** 读取器对外的状态：读到的行，加上在不在读、出了什么错。 */
export interface TaskLogState extends LogBuffer {
	loadingOlder: boolean;
	loadingNewer: boolean;
	/** 最近一次读取失败的原因；之后的读取成功不会清掉它。 */
	error: string | null;
}

export interface TaskLogReader extends Reader<TaskLogState> {
	/** 往前翻一页（`before=start`）。 */
	loadOlder(): void;
	/** 往后翻一页（`after=end`）：定位到中间一页之后，读到文件末尾后才连上实时流。 */
	loadNewer(): void;
}

/** 读取器向下依赖的两个口：读一页、订阅实时。每页行数、级别筛选由适配器带上。 */
export interface TaskLogPorts {
	/** 读一页：`at` 是定位的时刻，`before`、`after` 是往前、往后翻页的起点；都不给是最后一页。 */
	readPage(position: { at?: string; before?: number; after?: number }): Promise<LogPage>;
	/**
	 * 订阅实时流：从 `afterSeq` 之后接上；返回断开函数。`onChunk` 是一批新写入的行，`onFileProblem` 是连上时控制面说
	 * 日志文件有问题（#721）。
	 */
	subscribeLive(
		afterSeq: number,
		handlers: {
			onChunk: (chunk: LogChunk) => void;
			onFileProblem: (problem: LogFileProblem) => void;
		},
	): () => void;
	/** 实时流的行符不符合筛选条件（实时流不在服务端筛选）。 */
	accepts(line: LogLineView): boolean;
}

export interface TaskLogOptions {
	/** 要定位的时刻（ISO，控制面时间）；不定位时为 null。 */
	at?: string | null;
	maxLines?: number;
}

export const emptyTaskLogs: TaskLogState = {
	lines: [],
	start: 0,
	end: 0,
	hasOlder: false,
	hasNewer: false,
	loaded: false,
	truncated: false,
	expired: false,
	fileProblem: null,
	lastSeq: 0,
	located: null,
	loadingOlder: false,
	loadingNewer: false,
	error: null,
};

/** 新建一个读取器，立刻开始读第一页。 */
export function createTaskLogReader(
	ports: TaskLogPorts,
	{ at = null, maxLines = MAX_LOADED_LINES }: TaskLogOptions = {},
): TaskLogReader {
	const store = createStore(emptyTaskLogs);
	let closeLive: (() => void) | null = null;
	let disposed = false;

	/** 缓冲区追上了文件末尾才连实时流：`hasNewer` 时中间还有没读的行。 */
	const connectIfCaughtUp = () => {
		const { hasNewer, lastSeq } = store.get();
		if (hasNewer) return;
		closeLive = ports.subscribeLive(lastSeq, {
			onChunk: (chunk) => {
				const state = store.get();
				const next = withLive(state, chunk, ports.accepts, maxLines);
				if (next !== state) store.set(next);
			},
			onFileProblem: (problem) => store.set({ fileProblem: problem }),
		});
	};

	ports.readPage(at === null ? {} : { at }).then(
		(page) => {
			if (disposed) return;
			store.set(page.locate ? fromLocatedPage(page) : fromLatestPage(page));
			connectIfCaughtUp();
		},
		(e: Error) => {
			if (disposed) return;
			store.set({ loaded: true, error: e.message });
		},
	);

	return {
		get: store.get,
		subscribe: store.subscribe,
		loadOlder() {
			const { hasOlder, loadingOlder, start } = store.get();
			if (disposed || !hasOlder || loadingOlder) return;
			store.set({ loadingOlder: true });
			ports.readPage({ before: start }).then(
				(page) => {
					if (disposed) return;
					store.set({ ...withOlderPage(store.get(), page), loadingOlder: false });
				},
				(e: Error) => {
					if (disposed) return;
					store.set({ error: e.message, loadingOlder: false });
				},
			);
		},
		loadNewer() {
			const { hasNewer, loadingNewer, end } = store.get();
			if (disposed || !hasNewer || loadingNewer) return;
			store.set({ loadingNewer: true });
			ports.readPage({ after: end }).then(
				(page) => {
					if (disposed) return;
					store.set({ ...withNewerPage(store.get(), page), loadingNewer: false });
					connectIfCaughtUp();
				},
				(e: Error) => {
					if (disposed) return;
					store.set({ error: e.message, loadingNewer: false });
				},
			);
		},
		dispose() {
			disposed = true;
			closeLive?.();
		},
	};
}

const encoder = new TextEncoder();
/** 一行在日志文件中占的字节数（文件是 JSONL，与控制面写入的格式一致）。 */
const lineBytes = (line: LogLineView) => encoder.encode(`${JSON.stringify(line)}\n`).length;

/** 按序号合并两组行（去重，结果按序号排序）。 */
function mergeLines<L extends LogLineView>(a: L[], b: L[]): L[] {
	if (b.length === 0) return a;
	if (a.length === 0) return b;
	// 常见情况：新行都在已有行之后，或者更早的一页都在已有行之前。
	if ((b[0] as L).seq > (a.at(-1) as L).seq) return [...a, ...b];
	if ((b.at(-1) as L).seq < (a[0] as L).seq) return [...b, ...a];
	const bySeq = new Map<number, L>();
	for (const line of a) bySeq.set(line.seq, line);
	for (const line of b) bySeq.set(line.seq, line);
	return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

/** 最后一页历史（第一次加载）。 */
function fromLatestPage(page: LogPage): LogBuffer {
	return {
		lines: page.lines,
		start: page.start,
		end: page.end,
		hasOlder: page.start > 0,
		hasNewer: false,
		loaded: true,
		truncated: page.truncated,
		expired: page.expired,
		fileProblem: page.file_problem,
		lastSeq: page.last_seq,
		located: null,
	};
}

/** 这一页读到了文件末尾：之后只有实时流会带来新的行。 */
const reachedEnd = (page: LogPage) => page.end >= page.size;

/** 定位到某一刻读到的一页（`at`）：前后都可能还有行。 */
function fromLocatedPage(page: LogPage): LogBuffer {
	return {
		...fromLatestPage(page),
		hasNewer: !reachedEnd(page),
		located: page.locate,
	};
}

/** 往后翻的一页（`after=buffer.end`）；翻到文件末尾后不再有更新的行，实时流从这一页的 `last_seq` 接上。 */
function withNewerPage(buffer: LogBuffer, page: LogPage): LogBuffer {
	return {
		...buffer,
		lines: mergeLines(buffer.lines, page.lines),
		end: page.end,
		hasNewer: !reachedEnd(page),
		fileProblem: page.file_problem ?? buffer.fileProblem,
		lastSeq: page.last_seq,
	};
}

/** 往前翻的一页（`before=buffer.start`）。 */
function withOlderPage(buffer: LogBuffer, page: LogPage): LogBuffer {
	return {
		...buffer,
		lines: mergeLines(page.lines, buffer.lines),
		start: page.start,
		hasOlder: page.start > 0,
		fileProblem: page.file_problem ?? buffer.fileProblem,
	};
}

/**
 * 实时流推送的一批行。`accept` 是筛选条件；超过 maxLines 时丢掉最早的行。
 * 这一批没有接在已加载部分之后（读完历史到连上实时流、或断线重连期间写入太多）时，
 * 丢掉已加载的行，从这一批往前翻页，保证已加载的行在文件里是连续的。
 */
function withLive(
	buffer: LogBuffer,
	chunk: LogChunk,
	accept: (line: LogLineView) => boolean,
	maxLines: number,
): LogBuffer {
	if (chunk.lines.length === 0) return buffer;
	let offset = chunk.offset;
	const fresh: LoadedLine[] = [];
	for (const line of chunk.lines) {
		if (accept(line)) fresh.push({ ...line, offset });
		offset += lineBytes(line);
	}
	const gap = chunk.offset > buffer.end;
	let next: LogBuffer = {
		...buffer,
		lines: mergeLines(gap ? [] : buffer.lines, fresh),
		start: gap ? chunk.offset : buffer.start,
		end: Math.max(buffer.end, offset),
		hasOlder: gap || buffer.hasOlder,
		truncated: buffer.truncated || chunk.lines.some(isTruncationMarker),
	};
	if (next.lines.length > maxLines) {
		const kept = next.lines.slice(-maxLines);
		next = { ...next, lines: kept, start: (kept[0] as LoadedLine).offset, hasOlder: true };
	}
	return next;
}
