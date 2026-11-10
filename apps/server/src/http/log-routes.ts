import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Transform, type TransformCallback } from "node:stream";
import { logsApi } from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import { type LogFilter, readLogPage } from "../logs/log-pages.js";
import { type LogChunk, normalizeLogRow, type TaskLogs } from "../logs/task-logs.js";
import type { Sse } from "../sse/sse.js";
import { isUuid } from "../util/uuid.js";
import { attachment } from "./content-disposition.js";
import { contractDownload, contractRoute, contractStream } from "./contract-route.js";
import { sendError } from "./errors.js";

/**
 * 任务日志（契约见 @sfly/schema 的 logsApi）。实时推送（#10）：`GET /tasks/:id/logs/events`，事件 `logs`，data 为 {@link LogChunk}，id 为最后一行的序号。
 *
 * 连上时先发一条日志文件尾部（最多 500 行；浏览器带 `Last-Event-ID` 重连时只发之后的行），没有日志时 lines 为空；
 * 之后每写入一批推送一条。前端按 seq 去重。
 *
 * #18：
 * - `?after_seq=<n>`：已经用分页接口读到了第 n 行，连上时只发之后的行（与 `Last-Event-ID` 取较大者）。
 * - `GET /tasks/:id/logs`：按字节偏移分页读取（`before` / `after`、`limit`、`level`、`source`），见 log-pages.ts；
 *   契约见 @sfly/schema 的 logsApi.page，查询参数不合法时 400 `invalid_request`。
 * - `GET /tasks/:id/logs/download`：下载日志文件（JSONL），每行都带两种时间（升级之前写入的行在下载时补齐）。
 * - 运行的日志超过保留期被清理后（`expired`）：分页是空页、下载返回 410 `expired`。
 */
export function registerLogRoutes(
	app: FastifyInstance,
	deps: { logs: TaskLogs; sse: Sse; isPurged: (runId: string) => Promise<boolean> },
): void {
	contractRoute(app, logsApi.page, async ({ params, query }, reply) => {
		const info = isUuid(params.id) ? await deps.logs.describe(params.id) : undefined;
		if (!info) return sendError(reply, 404, "not_found", "task not found");
		const setOf = <T>(values: T[] | undefined) => (values ? new Set(values) : undefined);
		const filter: LogFilter = { levels: setOf(query.level), sources: setOf(query.source) };
		const { after, before, limit } = query;
		const page = await readLogPage(
			info.file,
			after !== undefined
				? { direction: "forward", after, limit, filter }
				: { direction: "backward", before, limit, filter },
		);
		return {
			task_id: params.id,
			...page,
			last_seq: info.seq,
			truncated: info.truncated,
			expired: await deps.isPurged(info.runId),
		};
	});

	contractDownload(app, logsApi.download, async ({ params }, reply) => {
		const taskId = params.id;
		const info = isUuid(taskId) ? await deps.logs.describe(taskId) : undefined;
		if (!info) return sendError(reply, 404, "not_found", "task not found");
		if (await deps.isPurged(info.runId)) {
			return sendError(reply, 410, "expired", "logs of this run were removed after retention");
		}
		const size = await stat(info.file).then(
			(s) => s.size,
			() => undefined,
		);
		reply
			.header("content-type", `${logsApi.download.contentType}; charset=utf-8`)
			.header("content-disposition", attachment(`${info.nodeId}-${info.attempt}.log.jsonl`));
		if (size === undefined || size === 0) return reply.send("");
		// 只发送此刻的内容（文件可能还在追加）。每行都带两种时间：升级之前写入的行在这里补齐，
		// 所以长度事先不知道，不带 content-length。
		return reply.send(
			createReadStream(info.file, { start: 0, end: size - 1 }).pipe(new LogRowNormalizer()),
		);
	});

	contractStream(app, deps.sse, logsApi.events, async ({ params, query }, open, reply, request) => {
		const taskId = params.id;
		if (!isUuid(taskId) || !(await deps.logs.exists(taskId))) {
			return sendError(reply, 404, "not_found", "task not found");
		}
		open((stream) => {
			const resume = Number(stream.lastEventId);
			const known = Number(query.after_seq);
			let sent = Math.max(
				Number.isSafeInteger(resume) && resume > 0 ? resume : 0,
				Number.isSafeInteger(known) && known > 0 ? known : 0,
			);
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
				stream.send("logs", { ...chunk, lines, offset: chunk.offset + skipped }, last);
				sent = last;
			};
			const unsubscribe = deps.logs.lines.subscribe(taskId, (chunk) => {
				if (buffered) buffered.push(chunk);
				else send(chunk);
			});
			void deps.logs
				.tail(taskId, sent)
				.then((tail) => {
					stream.send("logs", tail, tail.lines.at(-1)?.seq);
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
		return undefined;
	});
}

/**
 * 把日志文件的字节流逐行交给 {@link normalizeLogRow}：新写入的行原样通过，升级之前写入的行补成两种时间都有的格式。
 * 一块里没有需要改写的行时整块原样转发，不复制。
 */
class LogRowNormalizer extends Transform {
	/** 上一块末尾还没读到换行的半行。 */
	#partial: Buffer = Buffer.alloc(0);

	override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
		const bytes = this.#partial.length ? Buffer.concat([this.#partial, chunk]) : chunk;
		const out: Buffer[] = [];
		let changed = false;
		let from = 0;
		for (;;) {
			const nl = bytes.indexOf(0x0a, from);
			if (nl < 0) break;
			const row = bytes.subarray(from, nl);
			const normalized = normalizeLogRow(row);
			changed ||= normalized !== row;
			out.push(normalized, NEWLINE);
			from = nl + 1;
		}
		this.#partial = bytes.subarray(from);
		if (from > 0) this.push(changed ? Buffer.concat(out) : bytes.subarray(0, from));
		done();
	}

	override _flush(done: TransformCallback): void {
		// 还在写入的最后半行原样发出（与直接发送文件时一样）。
		if (this.#partial.length) this.push(this.#partial);
		done();
	}
}

const NEWLINE = Buffer.from("\n");
