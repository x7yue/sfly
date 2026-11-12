import {
	compareRunLogKeys,
	type LogOrigin,
	type RunLogKey,
	type RunLogLine,
	type RunLogScope,
	type RunLogTask,
	runLogKey,
	runLogScopeMatcher,
	runLogTasks,
} from "@sfly/schema";
import { eq } from "drizzle-orm";
import type { Db } from "../db/database.js";
import { runs } from "../db/schema.js";
import { getRunView } from "../engine/run-queries.js";
import { type LogFilter, readLogPage, SCAN_LIMIT } from "./log-pages.js";
import type { TaskPositions, TaskSeqs } from "./run-log-cursor.js";
import type { LogLineView, TaskLogInfo, TaskLogs } from "./task-logs.js";

/**
 * 按运行合并读取日志（#220，docs/ARCHITECTURE.md §6.3）：把一次运行里每个任务的日志文件看作一条按 seq 排好的流，
 * 按 @sfly/schema 的 run-log-order.ts 的排序键多路归并成一页。单个文件的读取沿用 log-pages.ts。
 *
 * 分页（#223）：游标是每个任务读到的字节偏移（run-log-cursor.ts）。往前翻页从每个任务的位置各往前读，
 * 归并后取最后 limit 行；往后接续从每个任务的位置各往后读，取最前 limit 行。日志文件只追加，所以同一个游标
 * 什么时候用都读出同样的行，翻页期间写入的新行只会出现在 after 之后。每个任务只读到列出任务那一刻已写入的字节数：
 * 读取期间写入的行留给下一次请求，免得一页里只有部分任务带上它们。
 *
 * 范围（#224）：`scope` 是一组「链路实例 ID + 节点 ID」，只有这些节点的任务参与归并，游标、截断列表、
 * 「已读到开头 / 末尾」都只看它们；不给范围是全部节点。级别筛选（`filter.levels`）在读每个文件时执行，
 * 翻页时跳过不匹配的行。游标只对同一组范围和级别有效。
 *
 * 下载（#226，{@link RunLogs.readAll}）：从每个任务的开头往后读，同一套取行（`take`）和补读（`extend`）一批批归并到末尾，
 * 不用游标逐页重读。每个任务只读到调用那一刻已写入的字节数（整个下载共用这一份快照，之后写入的行不在里面）。
 * 内存只和任务数、批量有关，和日志总量无关：每个任务读到手里还没取走的行不超过 `scanBytes` 的一份，
 * 每批最多 {@link DOWNLOAD_BATCH} 行，取走的行随批丢掉。
 *
 * 一次请求最多扫描 `scanBytes` 字节（每次读取至少读完一行，可能多出一行）。第一轮每个要读的任务读一小段；
 * 某个任务读到的行都取完了、文件那一侧还有没读的内容时，归并不能接着往下取（它没读的下一行可能排在前面），
 * 剩下的扫描量就集中给这些任务补读，直到这一页取满或扫描量用完。用完时一页可能不满 limit 行，游标停在实际取到的位置。
 *
 * 实时推送（#225，{@link RunLogs.follow}）：每页还返回读取那一刻范围内每个任务已写入的最大序号（实时流起点）。
 * 从最新一页的这个位置接上：先补发之后已经写入的行，再推送之后写入的，包括订阅之后才开始的任务（TaskLogs 按运行发布）。
 * 推送到的位置也按任务记序号，断线重连时只补发更大的序号。
 */

export type RunLogRequest = {
	limit: number;
	filter: LogFilter;
	/** 只读这些节点的任务；不给是运行里的全部节点。 */
	scope?: RunLogScope;
} & (
	| { direction: "backward"; before?: TaskPositions }
	| { direction: "forward"; after: TaskPositions }
);

/** {@link RunLogs.page} 读到的一页：和 HTTP 契约的 RunLogPage 相比，游标还是位置，没有编码。 */
export interface RunLogPageResult {
	lines: RunLogLine[];
	/** 读这一页之前的行用的位置。 */
	before: TaskPositions;
	/** 读这一页之后的行用的位置。 */
	after: TaskPositions;
	/** before 之前已经没有任何行。 */
	reachedStart: boolean;
	/** after 之后（读取的那一刻）已经没有任何行。 */
	reachedEnd: boolean;
	/** 日志超过大小上限被截断的任务，按运行视图里的顺序。 */
	truncatedTasks: LogOrigin[];
	/** 实时流起点：读这一页那一刻每个任务已写入的最大序号。 */
	live: TaskSeqs;
}

export interface RunLogFollow {
	/** 只推送这些节点的任务；不给是运行里的全部节点。 */
	scope?: RunLogScope;
	filter: LogFilter;
	/** 已经读到（或推送过）的位置：只推送每个任务更大的序号。 */
	after: TaskSeqs;
}

/** 实时推送的一次推送，`at` 是推送到的位置。 */
export type RunLogLiveEvent =
	| { kind: "lines"; lines: RunLogLine[]; at: TaskSeqs }
	/** 要补发的行太多，没有补发：从最新一页重新读。 */
	| { kind: "reload"; at: TaskSeqs };

/** 一个任务的日志文件，作为归并里的一条流：它的来源与排序信息，加上列出任务那一刻的文件概况。 */
interface TaskStream {
	task: RunLogTask;
	log: TaskLogInfo;
}

const OPEN_FILES = 32;
/** 第一轮每个任务最多扫描的字节数：一次读取的量，够看出每个任务排在最前的几行。 */
const FIRST_SLICE = 4 * 1024;
const DOWNLOAD_BATCH = 1000;
/**
 * 实时推送连上时最多补发的行数（按序号估算，不看级别）：超过时改为让前端从最新一页重新读，
 * 而不是一次推几万行（浏览器最多也只保留 5000 行，SSE 也没有背压）。
 */
const REPLAY_LINES = 5000;

export class RunLogs {
	constructor(
		private readonly deps: {
			db: Db;
			logs: TaskLogs;
			/** 一次请求最多扫描的字节数，所有任务分摊；默认与单个文件的分页相同（8 MB）。 */
			scanBytes?: number;
		},
	) {}

	async exists(runId: string): Promise<boolean> {
		const [row] = await this.deps.db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId));
		return row !== undefined;
	}

	/** 一次运行的一页；运行不存在时为 undefined。 */
	async page(runId: string, request: RunLogRequest): Promise<RunLogPageResult | undefined> {
		const streams = await this.#streams(runId, request.scope);
		if (!streams) return undefined;
		const forward = request.direction === "forward";
		const lanes = streams.map((stream) => {
			const { order, bytes } = stream.log;
			const at = forward
				? (request.after.get(order) ?? 0)
				: request.before
					? (request.before.get(order) ?? 0)
					: bytes;
			return newLane(stream, at);
		});
		const lines: RunLogLine[] = [];
		let budget = this.deps.scanBytes ?? SCAN_LIMIT;
		for (let first = true; ; first = false) {
			const blocked = take(lanes, lines, request.limit, forward);
			if (blocked.length === 0 || budget <= 0) break;
			const share = Math.max(1, Math.floor(budget / blocked.length));
			budget -= await extend(blocked, forward, {
				limit: request.limit - lines.length,
				filter: request.filter,
				scanLimit: first ? Math.min(FIRST_SLICE, share) : share,
			});
		}
		if (!forward) lines.reverse();
		const before = (lane: Lane) => (forward ? lane.start : earliestTaken(lane));
		const after = (lane: Lane) => (forward ? nextUntaken(lane) : lane.end);
		return {
			lines,
			before: positions(lanes, before),
			after: positions(lanes, after),
			reachedStart: lanes.every((lane) => before(lane) === 0),
			reachedEnd: lanes.every((lane) => after(lane) >= lane.until),
			truncatedTasks: streams.filter((s) => s.log.truncated).map((s) => s.task.origin),
			live: new Map(streams.map((s) => [s.log.order, s.log.seq])),
		};
	}

	/**
	 * 范围内的全部日志，按合并视图的顺序从头到尾，一批一批（最多 {@link DOWNLOAD_BATCH} 行）；运行不存在时为 undefined。
	 * 读到的内容固定在这个方法返回的那一刻：之后写入的行不会出现，整个下载共用这一份快照。
	 */
	async readAll(
		runId: string,
		scope: RunLogScope | undefined,
	): Promise<AsyncGenerator<RunLogLine[], void> | undefined> {
		const streams = await this.#streams(runId, scope);
		return streams && this.#batches(streams);
	}

	async *#batches(streams: TaskStream[]): AsyncGenerator<RunLogLine[], void> {
		const scanLimit = Math.max(1, Math.floor((this.deps.scanBytes ?? SCAN_LIMIT) / streams.length));
		let lanes = streams.map((stream) => newLane(stream, 0));
		while (lanes.length > 0) {
			const lines: RunLogLine[] = [];
			for (
				let blocked = take(lanes, lines, DOWNLOAD_BATCH, true);
				blocked.length > 0;
				blocked = take(lanes, lines, DOWNLOAD_BATCH, true)
			) {
				await extend(blocked, true, { limit: DOWNLOAD_BATCH, filter: {}, scanLimit });
			}
			if (lines.length > 0) yield lines;
			for (const lane of lanes) {
				lane.entries.splice(0, lane.taken);
				lane.taken = 0;
			}
			lanes = lanes.filter((lane) => lane.entries.length > 0 || hasUnread(lane, true));
		}
	}

	/**
	 * 跟随一次运行范围内新写入的日志（实时推送）：先补发 `after` 之后已经写入的行，再推送之后写入的，
	 * 包括订阅之后才开始的任务；只推送级别符合的行，但位置照样前进。补发的行太多时改为一次 `reload`。
	 * 推送按到达顺序串行；出错时调用 onError，之后不再推送。返回取消函数。
	 */
	follow(
		runId: string,
		request: RunLogFollow,
		emit: (event: RunLogLiveEvent) => void,
		onError: (error: unknown) => void,
	): () => void {
		const inScope = runLogScopeMatcher(request.scope);
		const { levels } = request.filter;
		const shown = (line: LogLineView) => !levels || levels.has(line.level);
		const sent = new Map(request.after);
		/** 任务 ID → 它的流；范围外（或不在运行视图里）为 null。 */
		const known = new Map<string, TaskStream | null>();
		const learn = async () => {
			const streams = (await this.#streams(runId)) ?? [];
			for (const s of streams) known.set(s.task.origin.task_id, inScope(s.task.origin) ? s : null);
			return streams.filter((s) => inScope(s.task.origin));
		};

		let stopped = false;
		let queue = Promise.resolve();
		const serial = (work: () => Promise<void>) => {
			queue = queue
				.then(() => (stopped ? undefined : work()))
				.catch((error) => {
					if (stopped) return;
					stopped = true;
					onError(error);
				});
		};

		// 先排上补发再订阅（同步完成，中间不会有发布）：补发时取的快照之后写入的行，都排在补发之后按序号去重。
		serial(async () => {
			const streams = await learn();
			const sentSeq = (s: TaskStream) => sent.get(s.log.order) ?? 0;
			const behind = streams.filter((s) => s.log.seq > sentSeq(s));
			const missed = behind.reduce((n, s) => n + s.log.seq - sentSeq(s), 0);
			if (missed > REPLAY_LINES) {
				for (const s of behind) sent.set(s.log.order, s.log.seq);
				emit({ kind: "reload", at: new Map(sent) });
				return;
			}
			const read = await mapOpenFiles(behind, (s) => linesAfterSeq(s, sentSeq(s)));
			const lines: RunLogLine[] = [];
			behind.forEach((s, i) => {
				for (const line of read[i] ?? []) if (shown(line)) lines.push(runLogLine(s, line));
				sent.set(s.log.order, s.log.seq);
			});
			if (lines.length > 0) emit({ kind: "lines", lines, at: new Map(sent) });
		});
		const unsubscribe = this.deps.logs.runLines.subscribe(runId, (chunk) =>
			serial(async () => {
				if (!known.has(chunk.task_id)) {
					await learn();
					if (!known.has(chunk.task_id)) known.set(chunk.task_id, null);
				}
				const stream = known.get(chunk.task_id);
				if (!stream) return;
				const fresh = chunk.lines.filter((l) => l.seq > (sent.get(stream.log.order) ?? 0));
				const last = fresh.at(-1);
				if (!last) return;
				sent.set(stream.log.order, last.seq);
				const lines = fresh.filter(shown).map((line) => runLogLine(stream, line));
				if (lines.length > 0) emit({ kind: "lines", lines, at: new Map(sent) });
			}),
		);
		return () => {
			stopped = true;
			unsubscribe();
		};
	}

	/** 有日志记录的任务（不给范围是全部），按运行视图里链、节点、尝试的顺序；运行不存在时为 undefined。 */
	async #streams(runId: string, scope?: RunLogScope): Promise<TaskStream[] | undefined> {
		const run = await getRunView(this.deps.db, runId);
		if (!run) return undefined;
		const files = await this.deps.logs.describeRun(runId);
		const inScope = runLogScopeMatcher(scope);
		return runLogTasks(run).flatMap((task) => {
			const log = inScope(task.origin) ? files.get(task.origin.task_id) : undefined;
			return log ? [{ task, log }] : [];
		});
	}
}

const runLogLine = (stream: TaskStream, line: LogLineView): RunLogLine => ({
	...line,
	...stream.task.origin,
	...stream.task.order,
});

/** 一个任务在列出它那一刻已写入的、序号大于 afterSeq 的行，按序号；从文件尾部往前读到序号不大于 afterSeq 为止。 */
async function linesAfterSeq(stream: TaskStream, afterSeq: number): Promise<LogLineView[]> {
	const lines: LogLineView[] = [];
	const { file, bytes, seq } = stream.log;
	for (let before = bytes; before > 0; ) {
		const window = await readLogPage(file, {
			direction: "backward",
			before,
			until: bytes,
			limit: seq - afterSeq + 1,
			filter: {},
		});
		const fresh = window.lines.filter((l) => l.seq > afterSeq);
		lines.unshift(...fresh.map(({ offset: _, ...line }) => line));
		if (fresh.length < window.lines.length || window.lines.length === 0) break;
		before = window.start;
	}
	return lines;
}

/** 一条流里读到的一行：在文件里的偏移，和归并时比较先后用的排序键。 */
interface LaneEntry {
	offset: number;
	line: RunLogLine;
	key: RunLogKey;
}

/**
 * 归并里的一条流：已经读到的行（从早到晚）和已经取进这一页的行数。往前翻页从尾部往前取、补读时 start 往前移，
 * 往后接续从头部往后取、补读时 end 往后移，所以同一个任务内的行总是保持 seq 顺序。
 */
interface Lane {
	stream: TaskStream;
	entries: LaneEntry[];
	/** 已读的范围 [start, end)。 */
	start: number;
	end: number;
	/** 往后最多读到哪里：列出任务那一刻已写入的字节数。 */
	until: number;
	taken: number;
}

const newLane = (stream: TaskStream, at: number): Lane => ({
	stream,
	entries: [],
	start: at,
	end: at,
	until: stream.log.bytes,
	taken: 0,
});

const hasUnread = (lane: Lane, forward: boolean) =>
	forward ? lane.end < lane.until : lane.start > 0;

/** 往前翻页：最早取走的那一行；读到的行整个取完时是已读范围的起点（跳过扫描过但不符合筛选条件的行）；一行没取时不动。 */
const earliestTaken = ({ entries, taken, start, end }: Lane) =>
	taken === entries.length ? start : (entries[entries.length - taken]?.offset ?? end);

/** 往后接续：第一行没取走的；读到的行整个取完时是已读范围的终点。 */
const nextUntaken = ({ entries, taken, end }: Lane) => entries[taken]?.offset ?? end;

function positions(lanes: Lane[], at: (lane: Lane) => number): TaskPositions {
	return new Map(lanes.map((lane) => [lane.stream.log.order, at(lane)]));
}

/**
 * 每一步取各流在读的方向上最靠前的一行（往前翻页取最晚的，往后接续取最早的），按读的方向加进 `lines`，直到取满。
 * 某条流读到的行已经取完、文件那一侧还有没读的内容时停下：返回这些流，补读之后才能接着取。
 */
function take(lanes: Lane[], lines: RunLogLine[], limit: number, forward: boolean): Lane[] {
	while (lines.length < limit) {
		let pick: ({ lane: Lane } & LaneEntry) | undefined;
		const blocked: Lane[] = [];
		for (const lane of lanes) {
			const head = lane.entries[forward ? lane.taken : lane.entries.length - 1 - lane.taken];
			if (!head) {
				if (hasUnread(lane, forward)) blocked.push(lane);
				continue;
			}
			const order = pick ? compareRunLogKeys(head.key, pick.key) : 0;
			if (!pick || (forward ? order < 0 : order > 0)) pick = { lane, ...head };
		}
		if (blocked.length > 0) return blocked;
		if (!pick) break;
		lines.push(pick.line);
		pick.lane.taken++;
	}
	return [];
}

async function extend(
	lanes: Lane[],
	forward: boolean,
	request: { limit: number; filter: LogFilter; scanLimit: number },
): Promise<number> {
	const scanned = await mapOpenFiles(lanes, async (lane) => {
		const { stream, until } = lane;
		const window = await readLogPage(
			stream.log.file,
			forward
				? { direction: "forward", after: lane.end, until, ...request }
				: { direction: "backward", before: lane.start, until, ...request },
		);
		const read = window.lines.map(({ offset, ...rest }) => {
			const line = runLogLine(stream, rest);
			return { offset, line, key: runLogKey(line) };
		});
		if (forward) {
			lane.entries.push(...read);
			lane.end = window.end;
		} else {
			lane.entries.unshift(...read);
			lane.start = window.start;
		}
		lane.until = Math.min(until, window.size);
		return window.end - window.start;
	});
	return scanned.reduce((sum, bytes) => sum + bytes, 0);
}

/** 对每一项并发地做 work（每项读一个日志文件），同时最多 {@link OPEN_FILES} 个；结果与 items 同序。 */
async function mapOpenFiles<T, R>(
	items: readonly T[],
	work: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = [];
	for (let i = 0; i < items.length; i += OPEN_FILES) {
		results.push(...(await Promise.all(items.slice(i, i + OPEN_FILES).map(work))));
	}
	return results;
}
