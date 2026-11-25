import { once } from "node:events";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline, Readable, Transform, type TransformCallback } from "node:stream";
import {
	LOG_EXPECT_HEADER,
	LOG_FILE_PROBLEMS_LIMIT,
	type LogLineView,
	logsApi,
	RunLogDownloadRow,
	type RunLogLine,
} from "@sfly/schema";
import type { FastifyInstance } from "fastify";
import {
	formatLogExpect,
	LOG_FILE_GONE_CAUSES,
	LogFilesGoneError,
	logFileProblem,
} from "../logs/log-files.js";
import type { LogMask } from "../logs/log-mask.js";
import { type LogFilter, readLogPage, readLogPageAt } from "../logs/log-pages.js";
import {
	decodeRunLogCursor,
	decodeRunLogLiveCursor,
	encodeRunLogCursor,
	encodeRunLogLiveCursor,
} from "../logs/run-log-cursor.js";
import type { FileProblem, RunLogs } from "../logs/run-log-pages.js";
import { type LogChunk, normalizeLogRow, type TaskLogs } from "../logs/task-logs.js";
import type { Sse } from "../sse/sse.js";
import { isUuid } from "../util/uuid.js";
import { attachment } from "./content-disposition.js";
import { contractDownload, contractRoute, contractStream } from "./contract-route.js";
import { sendError } from "./errors.js";

/**
 * 下载时日志文件已经不全了（#669）：410 `expired`，和保留期清理之后同一个状态码、错误码；保留期清理的说明不变（先判断），
 * 这里的说明写明是文件不见了或者变短了、可能的来路，`details` 写明是哪几个任务、各是什么情况（{@link LogFilesGoneError.details}）。
 */
const GONE_TASK =
	`the log file of this task is missing or shorter than the database records (${LOG_FILE_GONE_CAUSES}); ` +
	"the download of this task stays unavailable, the log pages show what is left";
const GONE_RUN =
	`the log file of at least one task of this run is missing or shorter than the database records (${LOG_FILE_GONE_CAUSES}); ` +
	"the download of this run stays unavailable while that holds, the log pages show what is left";
/** 保留期清理之后的下载（不是异常）。 */
const PURGED = "logs of this run were removed after retention";

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
 *   `at`（#347）：按控制面时间定位，返回包含那一刻的一页和 `locate`（那一刻的位置、正好对应的行）。
 * - `GET /tasks/:id/logs/download`：下载日志文件（JSONL），每行都带两种时间（升级之前写入的行在下载时补齐）。
 * - 运行的日志超过保留期被清理后（`expired`）：分页是空页、下载返回 410 `expired`。
 * - **下载不能悄悄少了内容**（#669）：有行写入过的任务，日志文件不见了或者比数据库记的短（被删除、截短，保留期清理删到一半，主机掉电——
 *   追加文件不 fsync、数据库提交了，数据库和数据目录分开恢复）：响应开始之前认出来的是 410 `expired`（`details` 写明是哪几个任务、
 *   各是不见了还是变短了，服务端日志也写出任务；已经过了保留期的运行是原来的「保留期清理」说明）；读的过程中被截短的（任务日志读到的字节数
 *   不到请求开始时的大小、按运行下载时某个任务的文件下一批读不到了），响应已经开始，**错误落到响应流上、连接被断开**：下载的是 JSONL，
 *   给读它的程序和命令行看，响应里插一行平台写的说明会和日志行混在一起（每一行都是日志）。
 *   **断开连接看不看得出没下完取决于传输**：直连、或者反向代理用 HTTP/1.1 连控制面（响应分块，没有结尾的 0 长度块）时，curl（退出码 18）、
 *   `fetch`、`@sfly/client`、浏览器的下载都看得出；反向代理用 HTTP/1.0 连控制面时（nginx 1.29.7 之前 `proxy_http_version` 的默认值就是 1.0）
 *   响应靠关闭连接来结束，断开和正常结束分不出来，客户端拿到半截文件、不报错（HTTP/1.0 的客户端直连也一样）；所以反向代理要配
 *   `proxy_http_version 1.1`（README「反向代理」）。不靠传输层的核对办法见 #721。
 *   读的过程中文件被删除：任务日志已经打开的文件不受影响，照常读完；按运行下载每一批都重新打开文件，所以会断开。两种都说得通
 *   （判断的时刻是请求开始那一刻）。文件比数据库记的长（任务正在写，或者进程在追加文件之后、更新库之前退出）不是问题。
 *   从没有日志的任务（没有行写入过）下载是空的。
 *
 * 按运行（#220）：`GET /runs/:id/logs` 把一次运行全部任务的日志合并分页读取（`before` / `after` 游标，#223），
 * 见 run-log-pages.ts 与 run-log-cursor.ts；游标不是这里返回的格式时 400 `invalid_request`。
 * `nodes`（节点范围）与 `level`（级别）在服务端执行（#224），写法见 @sfly/schema 的 run-log-scope.ts。
 * 实时推送（#225）：`GET /runs/:id/logs/events`，`after` 是分页返回的 `live_after`，事件 ID 是推送到的位置，
 * 浏览器重连时 URL 里仍是第一次的 `after`，`Last-Event-ID` 是推送到的位置，按每个任务取较大者接上（RunLogs.follow）。
 * 运行已过保留期时只保持连接、不推送（之后不会再有日志）。
 * `GET /runs/:id/logs/download`（#226）把范围内的整次运行日志按同样的顺序流式输出成 JSONL，不带 `level`；
 * 过了保留期 410 `expired`，运行不存在 404。
 */
export function registerLogRoutes(
	app: FastifyInstance,
	deps: {
		logs: TaskLogs;
		runLogs: RunLogs;
		sse: Sse;
		isPurged: (runId: string) => Promise<boolean>;
		/**
		 * 日志文件有问题时再核对一次保留期清理有没有在删（`Retention.isPurgedAfterWait`，#734 的审查）：两种页、两种流、两种下载认出问题之后
		 * 都先问它，是「保留期清理」就按 `expired` 说，不当成「文件不在了」。没有问题的请求不调用。
		 */
		isPurgedAfterWait: (runId: string) => Promise<boolean>;
	},
): void {
	contractRoute(app, logsApi.runPage, async ({ params, query }, reply) => {
		const before = query.before === undefined ? undefined : decodeRunLogCursor(query.before);
		const after = query.after === undefined ? undefined : decodeRunLogCursor(query.after);
		if ((query.before !== undefined && !before) || (query.after !== undefined && !after)) {
			return sendError(reply, 400, "invalid_request", "游标不是之前返回的 before / after");
		}
		const { limit, nodes: scope } = query;
		const filter = levelFilter(query);
		const page = isUuid(params.id)
			? await deps.runLogs.page(
					params.id,
					after
						? { direction: "forward", after, limit, filter, scope }
						: { direction: "backward", before, limit, filter, scope },
				)
			: undefined;
		if (!page) return sendError(reply, 404, "not_found", "run not found");
		// 清理之后文件已经不在，读出来本来就是空的；判断放在读取之后，读取期间被清理也不会返回半页。
		let expired = await deps.isPurged(params.id);
		// 认出了文件的问题：保留期清理正在删（删着目录、还没提交 `purged_at`）的话，是 `expired`，不是「文件不在了」。
		if (!expired && page.fileProblems.length > 0) expired = await deps.isPurgedAfterWait(params.id);
		const start = new Map<number, number>();
		// 日志文件不在了、变短了（#721）：页里说明，不当成「没有日志」；已过保留期的运行文件本来就被清理了，`expired` 已经说了。
		const problems = expired ? [] : page.fileProblems;
		return {
			run_id: params.id,
			lines: expired ? [] : page.lines,
			before: encodeRunLogCursor(expired ? start : page.before),
			after: encodeRunLogCursor(expired ? start : page.after),
			reached_start: expired || page.reachedStart,
			reached_end: expired || page.reachedEnd,
			live_after: encodeRunLogLiveCursor(expired ? start : page.live),
			truncated_tasks: expired ? [] : page.truncatedTasks,
			expired,
			file_problems: listedProblems(problems),
			file_problems_total: problems.length,
		};
	});

	contractDownload(app, logsApi.runDownload, async ({ params, query }, reply, request) => {
		let rows: AsyncGenerator<string> | undefined;
		let first: IteratorResult<string> | undefined;
		let expect = "";
		try {
			const read = isUuid(params.id)
				? await deps.runLogs.readAll(params.id, query.nodes)
				: undefined;
			if (!read) return sendError(reply, 404, "not_found", "run not found");
			expect = formatLogExpect(read.expect);
			rows = jsonRows(read.batches);
			// 第一批在响应开始之前读：检查通过之后、读第一批之前文件被删了，也是 410，不是响应还没开始就报错的 500（#669）。
			first = await rows.next();
		} catch (error) {
			if (!(error instanceof LogFilesGoneError)) throw error;
			// 过了保留期的运行文件本来就被清理了（清理正在删、还没提交的也算）：这是「保留期清理」，说明不变，不是异常，先判断。
			if (await deps.isPurgedAfterWait(params.id)) return sendError(reply, 410, "expired", PURGED);
			// 范围内有任务的日志文件不见了、变短了：不能照常 200 给一份缺内容的下载（#669）。
			request.log.warn({ run: params.id, tasks: error.tasks }, error.message);
			return sendError(reply, 410, "expired", GONE_RUN, error.details);
		}
		if (await deps.isPurged(params.id)) return sendError(reply, 410, "expired", PURGED);
		return reply
			.header("content-type", `${logsApi.runDownload.contentType}; charset=utf-8`)
			.header("content-disposition", attachment(`run-${params.id}.log.jsonl`))
			.header(LOG_EXPECT_HEADER, expect)
			.send(Readable.from(resumed(first, rows)));
	});

	contractStream(
		app,
		deps.sse,
		logsApi.runEvents,
		async ({ params, query }, open, reply, request) => {
			const after = query.after === undefined ? new Map() : decodeRunLogLiveCursor(query.after);
			if (!after) {
				return sendError(reply, 400, "invalid_request", "after 不是之前返回的 live_after");
			}
			const runId = params.id;
			if (!isUuid(runId) || !(await deps.runLogs.exists(runId))) {
				return sendError(reply, 404, "not_found", "run not found");
			}
			const purged = await deps.isPurged(runId);
			open((stream) => {
				if (purged) return undefined;
				const from = new Map(after);
				const resumed = stream.lastEventId && decodeRunLogLiveCursor(stream.lastEventId);
				for (const [order, seq] of resumed || []) {
					from.set(order, Math.max(seq, from.get(order) ?? 0));
				}
				return deps.runLogs.follow(
					runId,
					{
						scope: query.nodes,
						filter: levelFilter(query),
						after: from,
						// 连上时说一次范围内有哪些任务的日志文件有问题（#721）：在 `follow` 的第一步里查（复用它列任务的那一次），
						// 在补发之前发；保留期清理正在删的不说（#734 的审查）。
						onProblems: async (problems) => {
							if (await deps.isPurgedAfterWait(runId)) return;
							stream.send("file_problems", {
								file_problems: listedProblems(problems),
								file_problems_total: problems.length,
							});
						},
					},
					(event) => {
						const id = encodeRunLogLiveCursor(event.at);
						if (event.kind === "lines") stream.send("logs", { lines: event.lines }, id);
						else stream.send("reload", {}, id);
					},
					(error) => {
						request.log.error(error);
						stream.close();
					},
				);
			});
			return undefined;
		},
	);

	contractRoute(app, logsApi.page, async ({ params, query }, reply) => {
		const info = isUuid(params.id) ? await deps.logs.describe(params.id) : undefined;
		if (!info) return sendError(reply, 404, "not_found", "task not found");
		const setOf = <T>(values: T[] | undefined) => (values ? new Set(values) : undefined);
		const filter: LogFilter = { levels: setOf(query.level), sources: setOf(query.source) };
		const { after, before, limit, at } = query;
		// 读取时按这次运行此刻的 secret 值再打一遍码（早于子流程创建写下的行，log-mask.ts）。
		const mask = await deps.logs.logMask(info.runId);
		const located =
			at === undefined
				? undefined
				: await readLogPageAt(info.file, { at: Date.parse(at), limit, filter, mask });
		const page =
			located ??
			(await readLogPage(
				info.file,
				after !== undefined
					? { direction: "forward", after, limit, filter, mask }
					: { direction: "backward", before, limit, filter, mask },
			));
		// 文件不在了、变短了（#721）：页里说明，不当成「没有日志」；已过保留期的运行文件本来就被清理了，`expired` 已经说了。
		let expired = await deps.isPurged(info.runId);
		let fileProblem = expired ? null : await taskFileProblem(info);
		// 认出了文件的问题：保留期清理正在删（删着目录、还没提交 `purged_at`）的话，是 `expired`，不是「文件不在了」。
		if (fileProblem && (await deps.isPurgedAfterWait(info.runId))) {
			expired = true;
			fileProblem = null;
		}
		return {
			task_id: params.id,
			lines: page.lines,
			start: page.start,
			end: page.end,
			size: page.size,
			last_seq: info.seq,
			truncated: info.truncated,
			expired,
			file_problem: fileProblem,
			locate: located ? { at_offset: located.atOffset, exact_seq: located.exactSeq } : null,
		};
	});

	contractDownload(app, logsApi.download, async ({ params }, reply, request) => {
		const taskId = params.id;
		const info = isUuid(taskId) ? await deps.logs.describe(taskId) : undefined;
		if (!info) return sendError(reply, 404, "not_found", "task not found");
		if (await deps.isPurged(info.runId)) return sendError(reply, 410, "expired", PURGED);
		const stats = await stat(info.file).catch(() => undefined);
		const size = stats?.size;
		const gone = async (reason: "missing" | "short") => {
			// 保留期清理正在删（删着目录、还没提交 `purged_at`）：是「保留期清理」，说明不变，不是「文件不见了」。
			if (await deps.isPurgedAfterWait(info.runId)) return sendError(reply, 410, "expired", PURGED);
			const error = new LogFilesGoneError([
				{ taskId, nodeId: info.nodeId, attempt: info.attempt, reason },
			]);
			request.log.warn({ task: taskId, tasks: error.tasks }, error.message);
			return sendError(reply, 410, "expired", GONE_TASK, error.details);
		};
		// 有行写入过、文件却不见了或者比记录的短（被删除、截短，保留期清理删到一半，掉电，分开恢复）：410，不是 200 加空正文或缺了一截的
		// 正文（#669）。从没有日志的任务（没有行写入过）没有文件，下载是空的，不在这里。
		const problem = logFileProblem(info, stats);
		if (problem !== undefined) return gone(problem);
		const headers = () =>
			reply
				.header("content-type", `${logsApi.download.contentType}; charset=utf-8`)
				.header("content-disposition", attachment(`${info.nodeId}-${info.attempt}.log.jsonl`))
				// 应当到的最后一个序号（#721）：数据库记的；任务还在写时读到的可以更多，不会更少。
				.header(
					LOG_EXPECT_HEADER,
					formatLogExpect({ tasks: info.seq > 0 ? 1 : 0, lastSeqSum: info.seq }),
				);
		if (size === undefined || size === 0) {
			headers();
			return reply.send("");
		}
		// 只发送此刻的内容（文件可能还在追加）。每行都带两种时间：升级之前写入的行在这里补齐，
		// 所以长度事先不知道，不带 content-length。
		const mask = await deps.logs.logMask(info.runId);
		// 读的过程中文件被截短（读到的字节数不到 `size`）：错误落到响应流上，响应已经开始时连接被断开，客户端看得出没下完（#669）。
		const source = createReadStream(info.file, { start: 0, end: size - 1 });
		// 打开文件在响应开始之前：检查通过之后、打开之前文件被删了，也是 410，不是响应还没开始就出错的 500。
		try {
			await once(source, "open");
		} catch (error) {
			source.destroy();
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return gone("missing");
			throw error;
		}
		headers();
		return reply.send(normalizeLogStream(source, mask, size, taskId));
	});

	contractStream(app, deps.sse, logsApi.events, async ({ params, query }, open, reply, request) => {
		const taskId = params.id;
		if (!isUuid(taskId) || !(await deps.logs.exists(taskId))) {
			return sendError(reply, 404, "not_found", "task not found");
		}
		// 连上时说一次日志文件有没有问题（#721）；已过保留期的运行不说，连着期间才出的问题也不报。
		const info = await deps.logs.describe(taskId);
		let problem = info && !(await deps.isPurged(info.runId)) ? await taskFileProblem(info) : null;
		// 保留期清理正在删（删着目录、还没提交 `purged_at`）的不说（#734 的审查）。
		if (info && problem && (await deps.isPurgedAfterWait(info.runId))) problem = null;
		open((stream) => {
			if (problem) stream.send("file_problem", { file_problem: problem });
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

/** 这个任务日志文件的问题（#721）：不见了、比数据库记的短；没有问题时为 null。和下载是同一个判断。 */
async function taskFileProblem(
	info: Parameters<typeof logFileProblem>[0] & { file: string },
): Promise<"missing" | "short" | null> {
	return logFileProblem(info, await stat(info.file).catch(() => undefined)) ?? null;
}

/** 页里和事件里列出的有问题的任务：最多 {@link LOG_FILE_PROBLEMS_LIMIT} 个，总数另给。 */
const listedProblems = (problems: readonly FileProblem[]) =>
	problems.slice(0, LOG_FILE_PROBLEMS_LIMIT).map(({ origin, problem }) => ({ ...origin, problem }));

/** 按级别筛选（不给 `level` 是不筛选）：按运行的分页与实时推送共用。 */
const levelFilter = ({ level }: { level?: LogLineView["level"][] | undefined }): LogFilter => ({
	levels: level ? new Set(level) : undefined,
});

/** 下载文件里每行的字段：契约里 RunLogDownloadRow 声明的，顺序也一样。 */
const DOWNLOAD_FIELDS = Object.keys(RunLogDownloadRow.shape);

/** 已经取走第一批（`first`）的生成器接着往后：先给第一批，再给剩下的。 */
async function* resumed(
	first: IteratorResult<string>,
	rest: AsyncGenerator<string>,
): AsyncGenerator<string> {
	if (!first.done) yield first.value;
	yield* rest;
}

async function* jsonRows(batches: AsyncIterable<RunLogLine[]>): AsyncGenerator<string> {
	for await (const lines of batches) {
		yield lines.map((l) => `${JSON.stringify(l, DOWNLOAD_FIELDS)}\n`).join("");
	}
}

/**
 * 日志文件的字节流经 {@link LogRowNormalizer} 补齐时间，返回的流交给 `reply.send`。**源文件流出错（文件读不了：权限、被清理到
 * 一半）时，错误要落到返回的流上**：`source.pipe(transform)` 不转发源的错误，也没有人听源的 `error` 事件，没人接的 `error` 事件会让
 * 整个控制面进程退出（#647）；`pipeline` 出错时把两头一起销毁、错误落到返回的流上，由 Fastify 按响应开始发送了没有处理：
 * 还没开始是 500，已经开始是断开连接并记一条日志。别的请求不受影响。
 */
export function normalizeLogStream(
	source: Readable,
	mask: LogMask,
	/** 源应该给出的字节数：源读完时不到这么多（文件在读的过程中被截短），错误落到返回的流上（#669）；不给不检查。 */
	expectedBytes?: number,
	/** 任务 ID：错误（和服务端的日志）里写出是哪个任务。 */
	taskId?: string,
): Readable {
	const normalized = new LogRowNormalizer(mask, expectedBytes, taskId);
	// 回调不用：错误已经落在 `normalized` 上，`pipeline` 给两头各接了一个 error 监听，不会有没人接的 `error` 事件。
	pipeline(source, normalized, () => {});
	return normalized;
}

/**
 * 把日志文件的字节流逐行交给 {@link normalizeLogRow}：新写入的行原样通过，升级之前写入的行补成两种时间都有的格式。
 * 一块里没有需要改写的行时整块原样转发，不复制。
 */
class LogRowNormalizer extends Transform {
	/** 上一块末尾还没读到换行的半行。 */
	#partial: Buffer = Buffer.alloc(0);

	/** 已经读到的源的字节数。 */
	#received = 0;

	constructor(
		private readonly mask: LogMask,
		private readonly expectedBytes?: number,
		private readonly taskId?: string,
	) {
		super();
	}

	override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
		this.#received += chunk.length;
		// 每一块一份新的预算（完整的出现的段数）：不会因为前面的块用掉了预算，让后面的行都被整行盖住；块与块之间回到事件循环（文件是一块一块异步读出来的）。
		const mask = this.mask.fresh();
		const bytes = this.#partial.length ? Buffer.concat([this.#partial, chunk]) : chunk;
		const out: Buffer[] = [];
		let changed = false;
		let from = 0;
		for (;;) {
			const nl = bytes.indexOf(0x0a, from);
			if (nl < 0) break;
			const row = bytes.subarray(from, nl);
			// 升级之前的行补成两种时间都有的格式，再按此刻的 secret 值打码（行里没有 secret 值时原样通过）。
			const normalized = mask.row(normalizeLogRow(row));
			changed ||= normalized !== row;
			out.push(normalized, NEWLINE);
			from = nl + 1;
		}
		this.#partial = bytes.subarray(from);
		if (from > 0) this.push(changed ? Buffer.concat(out) : bytes.subarray(0, from));
		done();
	}

	override _flush(done: TransformCallback): void {
		if (this.expectedBytes !== undefined && this.#received < this.expectedBytes) {
			done(
				new Error(
					`日志文件在下载时被截短：读到 ${this.#received} 字节，请求开始时有 ${this.expectedBytes} 字节${this.taskId ? `（任务 ${this.taskId}）` : ""}`,
				),
			);
			return;
		}
		// 还在写入的最后半行原样发出（与直接发送文件时一样）。
		if (this.#partial.length) this.push(this.#partial);
		done();
	}
}

const NEWLINE = Buffer.from("\n");
