import type { LogOrigin, RunLogLine } from "@sfly/schema";
import type { Db } from "../db/database.js";
import { getRunView } from "../engine/run-queries.js";
import { type LogFilter, type LogPage, readLogPage } from "./log-pages.js";
import type { TaskLogs } from "./task-logs.js";

/**
 * 按运行合并读取日志（#220，docs/ARCHITECTURE.md §6.3）：把一次运行里每个任务的日志文件看作一条按 seq 排好的流，
 * 按控制面时间多路归并成一页。单个文件的读取沿用 log-pages.ts。
 *
 * 排序：
 * - 同一个任务内的行始终按 seq；不同任务之间比较各自的排序时间。
 * - 排序时间是这一行的控制面时间。没有控制面时间的旧行（升级之前写入的）沿用同一任务内上一行的排序时间，
 *   任务的第一行用任务开始时间。
 * - 排序时间相同时按任务在运行视图里的位置：链（运行视图的链顺序）、链上的节点、尝试。
 *
 * 往前读：每个任务各读最后 limit 行，从所有流的尾部往前归并，取最后 limit 行。一个任务读到的部分用完了、
 * 文件前面还有没读的内容（单个文件一次的扫描量有上限）时就停下：再往前的一行可能就在那段没读的内容里。
 */

export interface RunLogRequest {
	limit: number;
	filter: LogFilter;
}

export interface RunLogPage {
	/** 按上面的顺序。 */
	lines: RunLogLine[];
	/** 日志超过大小上限被截断的任务，按运行视图里的顺序。 */
	truncatedTasks: string[];
}

/** 一个任务的日志文件，作为归并里的一条流。 */
interface TaskStream {
	origin: LogOrigin;
	file: string;
	/** 任务开始时间（毫秒）：任务的第一行没有控制面时间时的排序时间。 */
	startMs: number;
	/** 排序时间相同时的先后：任务在运行视图里的位置。 */
	rank: number;
	truncated: boolean;
}

/** 同时打开的日志文件数的上限。 */
const OPEN_FILES = 32;

export class RunLogs {
	constructor(private readonly deps: { db: Db; logs: TaskLogs }) {}

	/** 一次运行的最新一页；运行不存在时为 undefined。 */
	async page(runId: string, request: RunLogRequest): Promise<RunLogPage | undefined> {
		const streams = await this.#streams(runId);
		if (!streams) return undefined;
		const windows: LogPage[] = [];
		for (let i = 0; i < streams.length; i += OPEN_FILES) {
			const batch = streams.slice(i, i + OPEN_FILES);
			windows.push(
				...(await Promise.all(
					batch.map((s) =>
						readLogPage(s.file, {
							direction: "backward",
							limit: request.limit,
							filter: request.filter,
						}),
					),
				)),
			);
		}
		return {
			lines: mergeBackward(streams, windows, request.limit),
			truncatedTasks: streams.filter((s) => s.truncated).map((s) => s.origin.task_id),
		};
	}

	/** 运行里的全部任务，按运行视图里链、节点、尝试的顺序。 */
	async #streams(runId: string): Promise<TaskStream[] | undefined> {
		const run = await getRunView(this.deps.db, runId);
		if (!run) return undefined;
		const files = await this.deps.logs.describeRun(runId);
		const streams: TaskStream[] = [];
		for (const chain of run.chains) {
			for (const node of chain.nodes) {
				for (const attempt of node.attempts) {
					const info = files.get(attempt.task_id);
					if (!info) continue;
					streams.push({
						origin: {
							task_id: attempt.task_id,
							chain_instance_id: chain.id,
							subflow: chain.name,
							node_id: node.node_id,
							attempt: attempt.attempt,
						},
						file: info.file,
						startMs: Date.parse(attempt.started_at ?? attempt.queued_at),
						rank: streams.length,
						truncated: info.truncated,
					});
				}
			}
		}
		return streams;
	}
}

/** 一行和它的排序时间。 */
interface Keyed {
	line: RunLogLine;
	key: number;
}

/** 归并里的一条流：已读到的行，`next` 是还没取走的最晚一行；`more`：文件前面还有没读的内容。 */
interface Lane {
	rank: number;
	keyed: Keyed[];
	next: number;
	more: boolean;
}

/**
 * 从各流的尾部往前归并，取最后 limit 行（按从早到晚返回）。每一步取各流尾部最晚的一行，
 * 所以同一个任务内的行总是保持 seq 顺序。
 */
function mergeBackward(streams: TaskStream[], windows: LogPage[], limit: number): RunLogLine[] {
	const lanes = streams.map((stream, i): Lane => {
		const window = windows[i] as LogPage;
		// 旧行只会出现在文件开头（升级之后写入的行都有控制面时间），所以读到的第一行是旧行时，
		// 它前面没读的行也都是旧行，沿用下来就是任务开始时间。
		let previous = stream.startMs;
		const keyed = window.lines.map(({ offset: _, ...line }) => {
			const key = line.time === null ? previous : Date.parse(line.time);
			previous = key;
			return { line: { ...line, ...stream.origin }, key };
		});
		return { rank: stream.rank, keyed, next: keyed.length - 1, more: window.start > 0 };
	});
	const out: RunLogLine[] = [];
	while (out.length < limit) {
		let pick: Lane | undefined;
		let latest: Keyed | undefined;
		for (const lane of lanes) {
			const head = lane.keyed[lane.next];
			if (!head) {
				if (lane.more) return out.reverse();
				continue;
			}
			if (
				!pick ||
				!latest ||
				head.key > latest.key ||
				(head.key === latest.key && lane.rank > pick.rank)
			) {
				pick = lane;
				latest = head;
			}
		}
		if (!pick || !latest) break;
		out.push(latest.line);
		pick.next--;
	}
	return out.reverse();
}
