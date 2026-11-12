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
import type { Db } from "../db/database.js";
import { getRunView } from "../engine/run-queries.js";
import { type LogFilter, readLogPage, SCAN_LIMIT } from "./log-pages.js";
import type { TaskPositions } from "./run-log-cursor.js";
import type { TaskLogs } from "./task-logs.js";

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
 * 一次请求最多扫描 `scanBytes` 字节（每次读取至少读完一行，可能多出一行）。第一轮每个要读的任务读一小段；
 * 某个任务读到的行都取完了、文件那一侧还有没读的内容时，归并不能接着往下取（它没读的下一行可能排在前面），
 * 剩下的扫描量就集中给这些任务补读，直到这一页取满或扫描量用完。用完时一页可能不满 limit 行，游标停在实际取到的位置。
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

export interface RunLogPage {
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
}

/** 一个任务的日志文件，作为归并里的一条流。 */
interface TaskStream {
	task: RunLogTask;
	/** 任务的创建顺序：游标里代表这个任务。 */
	order: number;
	file: string;
	/** 已写入的字节数（列出任务的那一刻）：不给游标时从这里往前读，往后最多读到这里。 */
	bytes: number;
	truncated: boolean;
}

/** 同时打开的日志文件数的上限。 */
const OPEN_FILES = 32;
/** 第一轮每个任务最多扫描的字节数：一次读取的量，够看出每个任务排在最前的几行。 */
const FIRST_SLICE = 4 * 1024;

export class RunLogs {
	constructor(
		private readonly deps: {
			db: Db;
			logs: TaskLogs;
			/** 一次请求最多扫描的字节数，所有任务分摊；默认与单个文件的分页相同（8 MB）。 */
			scanBytes?: number;
		},
	) {}

	/** 一次运行的一页；运行不存在时为 undefined。 */
	async page(runId: string, request: RunLogRequest): Promise<RunLogPage | undefined> {
		const streams = await this.#streams(runId, request.scope);
		if (!streams) return undefined;
		const forward = request.direction === "forward";
		const lanes = streams.map((stream): Lane => {
			const at =
				request.direction === "forward"
					? (request.after.get(stream.order) ?? 0)
					: request.before
						? (request.before.get(stream.order) ?? 0)
						: stream.bytes;
			return { stream, read: [], start: at, end: at, until: stream.bytes, taken: 0 };
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
			truncatedTasks: streams.filter((s) => s.truncated).map((s) => s.task.origin),
		};
	}

	/** 范围内、有日志记录的任务，按运行视图里链、节点、尝试的顺序。 */
	async #streams(runId: string, scope: RunLogScope | undefined): Promise<TaskStream[] | undefined> {
		const run = await getRunView(this.deps.db, runId);
		if (!run) return undefined;
		const files = await this.deps.logs.describeRun(runId);
		const inScope = runLogScopeMatcher(scope);
		return runLogTasks(run).flatMap((task) => {
			const info = inScope(task.origin) ? files.get(task.origin.task_id) : undefined;
			return info
				? [
						{
							task,
							order: info.order,
							file: info.file,
							bytes: info.bytes,
							truncated: info.truncated,
						},
					]
				: [];
		});
	}
}

/**
 * 归并里的一条流：已经读到的行（从早到晚）和已经取进这一页的行数。往前翻页从尾部往前取、补读时 start 往前移，
 * 往后接续从头部往后取、补读时 end 往后移，所以同一个任务内的行总是保持 seq 顺序。
 */
interface Lane {
	stream: TaskStream;
	read: Array<{ offset: number; line: RunLogLine; key: RunLogKey }>;
	/** 已读的范围 [start, end)。 */
	start: number;
	end: number;
	/** 往后最多读到哪里：列出任务那一刻已写入的字节数。 */
	until: number;
	taken: number;
}

/** 在读的方向上，文件里还有没读的内容。 */
const more = (lane: Lane, forward: boolean) => (forward ? lane.end < lane.until : lane.start > 0);

/** 往前翻页：最早取走的那一行；读到的行整个取完时是已读范围的起点（跳过扫描过但不符合筛选条件的行）；一行没取时不动。 */
const earliestTaken = ({ read, taken, start, end }: Lane) =>
	taken === read.length ? start : (read[read.length - taken]?.offset ?? end);

/** 往后接续：第一行没取走的；读到的行整个取完时是已读范围的终点。 */
const nextUntaken = ({ read, taken, end }: Lane) => read[taken]?.offset ?? end;

function positions(lanes: Lane[], at: (lane: Lane) => number): TaskPositions {
	return new Map(lanes.map((lane) => [lane.stream.order, at(lane)]));
}

/**
 * 每一步取各流在读的方向上最靠前的一行（往前翻页取最晚的，往后接续取最早的），按读的方向加进 `lines`，直到取满。
 * 某条流读到的行已经取完、文件那一侧还有没读的内容时停下：返回这些流，补读之后才能接着取。
 */
function take(lanes: Lane[], lines: RunLogLine[], limit: number, forward: boolean): Lane[] {
	while (lines.length < limit) {
		let pick: { lane: Lane; line: RunLogLine; key: RunLogKey } | undefined;
		const blocked: Lane[] = [];
		for (const lane of lanes) {
			const head = lane.read[forward ? lane.taken : lane.read.length - 1 - lane.taken];
			if (!head) {
				if (more(lane, forward)) blocked.push(lane);
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

/** 每条流在读的方向上接着读一段，返回扫描过的字节数。 */
async function extend(
	lanes: Lane[],
	forward: boolean,
	request: { limit: number; filter: LogFilter; scanLimit: number },
): Promise<number> {
	let scanned = 0;
	for (let i = 0; i < lanes.length; i += OPEN_FILES) {
		await Promise.all(
			lanes.slice(i, i + OPEN_FILES).map(async (lane) => {
				const { stream, until } = lane;
				const window = await readLogPage(
					stream.file,
					forward
						? { direction: "forward", after: lane.end, until, ...request }
						: { direction: "backward", before: lane.start, until, ...request },
				);
				const read = window.lines.map(({ offset, ...rest }) => {
					const line: RunLogLine = { ...rest, ...stream.task.origin, ...stream.task.order };
					return { offset, line, key: runLogKey(line) };
				});
				if (forward) {
					lane.read.push(...read);
					lane.end = window.end;
				} else {
					lane.read.unshift(...read);
					lane.start = window.start;
				}
				lane.until = Math.min(until, window.size);
				scanned += window.end - window.start;
			}),
		);
	}
	return scanned;
}
