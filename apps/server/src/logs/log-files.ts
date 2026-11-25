// 日志文件和数据库记的对不对得上（#669）：下载时文件不见了、变短了，响应不能照常 200、看起来下完了。
//
// 日志文件只追加，写入是先追加文件、再更新数据库（`tasks.log_bytes`、`tasks.log_seq`，每一批都是整行），所以文件不会比数据库记的短。
// 比它短、或者有行写入过文件却不存在，就是文件被删了或截短了：保留期清理（先删文件、再标记运行已清理，中间有一小段时间运行还没有标记）、
// 人为删除、磁盘出问题。从没有日志的任务（`seq` 是 0、没有文件）不算：它的日志本来就是空的。
import type { Stats } from "node:fs";
import type { TaskLogInfo } from "./task-logs.js";

/**
 * 文件现在的样子（`stats` 是它的 `stat`，文件不存在时为 undefined）有什么不对：不见了、比记的短；没有问题时为 undefined。
 * 路径上不是普通文件（比如被换成了目录）的不在这里认：它读不了，读的时候出错（500 或者连接断开，#647），不是「日志没了」。
 */
export function logFileProblem(
	info: Pick<TaskLogInfo, "recordedBytes" | "seq">,
	stats: Pick<Stats, "size" | "isFile"> | undefined,
): "missing" | "short" | undefined {
	if (stats === undefined) return info.seq > 0 || info.recordedBytes > 0 ? "missing" : undefined;
	if (!stats.isFile()) return undefined;
	return stats.size < info.recordedBytes ? "short" : undefined;
}

/** 日志文件不全的两种：不见了、比数据库记的短。 */
export type LogFileProblemKind = NonNullable<ReturnType<typeof logFileProblem>>;

/** 日志文件不全的一个任务：下载的 410 说明里写出是哪几个、各是什么情况（运维要知道去看哪个文件）。 */
export interface GoneTask {
	taskId: string;
	nodeId: string;
	attempt: number;
	reason: LogFileProblemKind;
}

/** 说明里写出的来路：文件比数据库记的短不只是「被删了、被截短了」。保留期清理不在这里（先判断，说明不同）。 */
export const LOG_FILE_GONE_CAUSES =
	"it was deleted or truncated, or the host lost power (appended lines are not fsynced, the database is), " +
	"or the database was restored from a newer backup than the data directory";

/** 410 `details` 里最多列出几个任务（总数在 `total`）。 */
const DETAILS_TASKS = 20;

/**
 * 下载要读的日志文件已经不全了（不见了、变短了）：下载之前认出来的，路由回 410 `expired`；下载过程中认出来的（响应已经开始），
 * 错误落到响应流上，连接被断开（直连或者代理用 HTTP/1.1 时客户端看得出没下完）。`tasks` 是有问题的任务。
 */
export class LogFilesGoneError extends Error {
	constructor(readonly tasks: readonly GoneTask[]) {
		const shown = tasks
			.slice(0, 5)
			.map(
				(t) =>
					`${t.reason === "missing" ? "missing" : "shorter than recorded"}: task ${t.taskId} (${t.nodeId}#${t.attempt})`,
			)
			.join("; ");
		const more = tasks.length > 5 ? `; and ${tasks.length - 5} more` : "";
		super(`log file of ${tasks.length} task(s) missing or shorter than recorded (${shown}${more})`);
		this.name = "LogFilesGoneError";
	}

	/** 410 `details`：哪几个任务、各是不见了还是变短了。 */
	get details(): {
		tasks: Array<{ task_id: string; node_id: string; attempt: number; reason: LogFileProblemKind }>;
		total: number;
	} {
		return {
			tasks: this.tasks.slice(0, DETAILS_TASKS).map((t) => ({
				task_id: t.taskId,
				node_id: t.nodeId,
				attempt: t.attempt,
				reason: t.reason,
			})),
			total: this.tasks.length,
		};
	}
}
