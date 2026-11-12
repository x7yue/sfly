import {
	compareRunLogKeys,
	type LogOrigin,
	type RunLogKey,
	type RunLogLine,
	type RunLogTask,
	runLogKey,
	runLogTasks,
} from "@sfly/schema";
import type { Db } from "../db/database.js";
import { getRunView } from "../engine/run-queries.js";
import { type LogFilter, type LogPage, readLogPage, SCAN_LIMIT } from "./log-pages.js";
import type { TaskPositions } from "./run-log-cursor.js";
import type { TaskLogs } from "./task-logs.js";

/**
 * 按运行合并读取日志（#220，docs/ARCHITECTURE.md §6.3）：把一次运行里每个任务的日志文件看作一条按 seq 排好的流，
 * 按 @sfly/schema 的 run-log-order.ts 定下的全序多路归并成一页。单个文件的读取沿用 log-pages.ts。
 *
 * 分页（#223）：游标是每个任务读到的字节偏移（run-log-cursor.ts）。往前翻页从每个任务的位置各往前读，
 * 归并后取最后 limit 行；往后接续从每个任务的位置各往后读，取最前 limit 行。日志文件只追加，所以同一个游标
 * 什么时候用都读出同样的行，翻页期间写入的新行只会出现在 after 之后。
 *
 * 一次请求最多扫描 `scanBytes` 字节，由要读的任务平分。一个任务读到的部分用完、文件那一侧还有没读的内容时，
 * 这一页就停下（下一行可能就在那段没读的内容里）：一页可能不满 limit 行，游标停在实际取到的位置。
 */

export type RunLogRequest = {
	limit: number;
	filter: LogFilter;
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
	/** 日志超过大小上限被截断的任务，按运行视图里的顺序。 */
	truncatedTasks: LogOrigin[];
}

/** 一个任务的日志文件，作为归并里的一条流。 */
interface TaskStream extends RunLogTask {
	/** 任务的创建顺序：游标里代表这个任务。 */
	order: number;
	file: string;
	/** 已写入的字节数（列出任务的那一刻）：不给游标时从这里往前读。 */
	bytes: number;
	truncated: boolean;
}

/** 同时打开的日志文件数的上限。 */
const OPEN_FILES = 32;

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
		const streams = await this.#streams(runId);
		if (!streams) return undefined;
		const forward = request.direction === "forward";
		const from = streams.map((s) =>
			request.direction === "forward"
				? (request.after.get(s.order) ?? 0)
				: request.before
					? (request.before.get(s.order) ?? 0)
					: s.bytes,
		);
		// 在读的方向上还有内容的任务才读文件，扫描量由它们平分。
		const pending = streams.map((s, i) => {
			const at = from[i] as number;
			return forward ? at < s.bytes : at > 0;
		});
		const reading = Math.max(1, pending.filter(Boolean).length);
		const scanLimit = Math.max(1, Math.floor((this.deps.scanBytes ?? SCAN_LIMIT) / reading));
		const windows: LogPage[] = [];
		for (let i = 0; i < streams.length; i += OPEN_FILES) {
			const batch = streams.slice(i, i + OPEN_FILES).map((s, j) => {
				const at = from[i + j] as number;
				if (!pending[i + j]) return Promise.resolve({ lines: [], start: at, end: at, size: at });
				const { limit, filter } = request;
				return readLogPage(
					s.file,
					forward
						? { direction: "forward", after: at, limit, filter, scanLimit }
						: { direction: "backward", before: at, limit, filter, scanLimit },
				);
			});
			windows.push(...(await Promise.all(batch)));
		}
		const lanes = streams.map(
			(stream, i): Lane => ({
				stream,
				window: windows[i] as LogPage,
				keys: (windows[i] as LogPage).lines.map((line) => runLogKey(line, stream)),
				taken: 0,
			}),
		);
		const lines = merge(lanes, request.limit, forward);
		return {
			lines,
			before: positions(lanes, (lane) => (forward ? lane.window.start : earliestTaken(lane))),
			after: positions(lanes, (lane) => (forward ? nextUntaken(lane) : lane.window.end)),
			truncatedTasks: streams.filter((s) => s.truncated).map((s) => s.origin),
		};
	}

	/** 运行里有日志记录的任务，按运行视图里链、节点、尝试的顺序。 */
	async #streams(runId: string): Promise<TaskStream[] | undefined> {
		const run = await getRunView(this.deps.db, runId);
		if (!run) return undefined;
		const files = await this.deps.logs.describeRun(runId);
		return runLogTasks(run).flatMap((task) => {
			const info = files.get(task.origin.task_id);
			return info
				? [
						{
							...task,
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
 * 归并里的一条流：读到的窗口（从早到晚）和已经取走的行数。往前翻页从窗口尾部往前取，往后接续从窗口头部往后取，
 * 所以同一个任务内的行总是保持 seq 顺序。
 */
interface Lane {
	stream: TaskStream;
	window: LogPage;
	keys: RunLogKey[];
	taken: number;
}

/** 取走的行在窗口里的下标范围是 [n - taken, n)（往前）或 [0, taken)（往后）。 */
const headIndex = (lane: Lane, forward: boolean) =>
	forward ? lane.taken : lane.window.lines.length - 1 - lane.taken;

/** 窗口外、在读的方向上文件里还有没读的内容。 */
const more = (lane: Lane, forward: boolean) =>
	forward ? lane.window.end < lane.window.size : lane.window.start > 0;

/** 往前翻页：最早取走的那一行；窗口整个取完时是窗口起点（跳过扫描过但不符合筛选条件的行）；一行没取时不动。 */
const earliestTaken = ({ window, taken }: Lane) =>
	taken === window.lines.length
		? window.start
		: taken === 0
			? window.end
			: (window.lines[window.lines.length - taken] as LogPage["lines"][number]).offset;

/** 往后接续：第一行没取走的；窗口整个取完时是窗口终点。 */
const nextUntaken = ({ window, taken }: Lane) =>
	taken === window.lines.length
		? window.end
		: (window.lines[taken] as LogPage["lines"][number]).offset;

function positions(lanes: Lane[], at: (lane: Lane) => number): TaskPositions {
	return new Map(lanes.map((lane) => [lane.stream.order, at(lane)]));
}

/** 每一步取各流在读的方向上最靠前的一行（往前翻页取最晚的，往后接续取最早的），按从早到晚返回。 */
function merge(lanes: Lane[], limit: number, forward: boolean): RunLogLine[] {
	const out: RunLogLine[] = [];
	const done = () => (forward ? out : out.reverse());
	while (out.length < limit) {
		let pick: Lane | undefined;
		let pickKey: RunLogKey | undefined;
		for (const lane of lanes) {
			if (lane.taken === lane.window.lines.length) {
				if (more(lane, forward)) return done();
				continue;
			}
			const key = lane.keys[headIndex(lane, forward)] as RunLogKey;
			const order = pickKey ? compareRunLogKeys(key, pickKey) : 0;
			if (!pickKey || (forward ? order < 0 : order > 0)) {
				pick = lane;
				pickKey = key;
			}
		}
		if (!pick) break;
		const { offset: _, ...line } = pick.window.lines[
			headIndex(pick, forward)
		] as LogPage["lines"][number];
		out.push({ ...line, ...pick.stream.origin });
		pick.taken++;
	}
	return done();
}
