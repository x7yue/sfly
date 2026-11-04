import type { FastifyInstance } from "fastify";
import type { LogChunk, TaskLogs } from "../logs/task-logs.js";
import type { Sse } from "../sse/sse.js";
import { isUuid, sendError } from "./errors.js";

/**
 * 任务日志的实时推送（#10）：`GET /tasks/:id/logs/events`，事件 `logs`，data 为 {@link LogChunk}，id 为最后一行的序号。
 *
 * 连上时先发一条日志文件尾部（最多 500 行；浏览器带 `Last-Event-ID` 重连时只发之后的行），没有日志时 lines 为空；
 * 之后每写入一批推送一条。前端按 seq 去重。按偏移量分页读取和下载完整日志由 #18 提供。
 */
export function registerLogRoutes(app: FastifyInstance, deps: { logs: TaskLogs; sse: Sse }): void {
	app.get<{ Params: { id: string } }>("/tasks/:id/logs/events", async (request, reply) => {
		const taskId = request.params.id;
		if (!isUuid(taskId) || !(await deps.logs.exists(taskId))) {
			return sendError(reply, 404, "not_found", "task not found");
		}
		deps.sse.open(request, reply, (stream) => {
			const resume = Number(stream.lastEventId);
			let sent = Number.isSafeInteger(resume) && resume > 0 ? resume : 0;
			// 先订阅再读文件：读文件期间写入的行先缓存，读完后按序号补发（不重复）。
			let buffered: LogChunk[] | undefined = [];
			const send = (chunk: LogChunk) => {
				const lines = chunk.lines.filter((l) => l.seq > sent);
				if (lines.length === 0) return;
				// 跳过的行在文件里就是它们的 JSON 文本加换行，据此算出第一行的偏移。
				const skipped = chunk.lines
					.filter((l) => l.seq <= sent)
					.reduce((n, l) => n + Buffer.byteLength(`${JSON.stringify(l)}\n`), 0);
				const last = lines.at(-1)?.seq ?? sent;
				stream.send({
					event: "logs",
					data: { ...chunk, lines, offset: chunk.offset + skipped },
					id: last,
				});
				sent = last;
			};
			const unsubscribe = deps.logs.lines.subscribe(taskId, (chunk) => {
				if (buffered) buffered.push(chunk);
				else send(chunk);
			});
			void deps.logs
				.tail(taskId, sent)
				.then((tail) => {
					stream.send({
						event: "logs",
						data: tail,
						...(tail.lines.length > 0 ? { id: tail.lines.at(-1)?.seq } : {}),
					});
					sent = Math.max(sent, tail.lines.at(-1)?.seq ?? 0);
					for (const chunk of buffered ?? []) send(chunk);
					buffered = undefined;
				})
				.catch((error) => {
					request.log.error(error);
					stream.close();
				});
			return unsubscribe;
		});
	});
}
