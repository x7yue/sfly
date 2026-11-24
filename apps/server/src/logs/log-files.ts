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

/**
 * 下载要读的日志文件已经不全了（不见了、变短了）：下载之前认出来的，路由回 410 `expired`；下载过程中认出来的（响应已经开始），
 * 错误落到响应流上，连接被断开（客户端看得出没下完）。`tasks` 是有问题的任务的数目。
 */
export class LogFilesGoneError extends Error {
	constructor(readonly tasks: number) {
		super(
			tasks === 1
				? "一个任务的日志文件不见了或者比记录的短（被删除或截短了）"
				: `${tasks} 个任务的日志文件不见了或者比记录的短（被删除或截短了）`,
		);
		this.name = "LogFilesGoneError";
	}
}
