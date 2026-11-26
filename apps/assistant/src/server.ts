import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
	AbortCommandBody,
	ASSISTANT_STREAM_BACKLOG_BYTES,
	ASSISTANT_STREAM_HEARTBEAT_MS,
	type AssistantErrorBody,
	type AssistantErrorCode,
	AssistantEventsQuery,
	type AssistantHealth,
	type AssistantModelHealth,
	type AssistantStreamHeartbeat,
	PromptCommandBody,
	SessionId,
	SteerCommandBody,
} from "@sfly/schema";
import type { EventBus, StreamPosition } from "./bus.js";
import { describeError } from "./output.js";
import type { SessionManager } from "./sessions.js";

/**
 * 助手服务协议（`@sfly/schema` 的 assistant-protocol.ts）的 HTTP 一侧：`POST /sessions/:id/prompt`、`/steer`、`/abort`、
 * `/end`，`GET /events`（每 15 秒一行心跳）、`GET /health`。每个请求先校验 `Authorization: Bearer <共享密钥>`
 * （常量时间比较），不对返回 401。命令都是收到并决定了怎么办就回，不等命令引起的事做完。
 */

/** 请求体的上限：一句话最多 2 万个字符，加上环境变量也远到不了。 */
const MAX_BODY_BYTES = 1024 * 1024;

export interface ServerDeps {
	secret: string;
	bus: EventBus;
	sessions: SessionManager;
	versions: { assistant: string; pi: string };
	/** 模型的就绪状态（配没配好、连不连得上，#548）：`GET /health` 原样报。 */
	model: () => AssistantModelHealth;
	log: (message: string) => void;
	/** 心跳的间隔，默认 {@link HEARTBEAT_MS}（测试里改短）。 */
	heartbeatMs?: number;
	/** 事件流连接上还没被对端读走的字节超过这个数就断开它，默认 {@link ASSISTANT_STREAM_BACKLOG_BYTES}（测试里改小）。 */
	maxBacklogBytes?: number;
}

/** 补发时一次写多少字节，写完等对端读走（背压）再写下一块。 */
const REPLAY_CHUNK_BYTES = 256 * 1024;

/**
 * 事件流的心跳间隔：协议定的 {@link ASSISTANT_STREAM_HEARTBEAT_MS}。控制面超过 3 个间隔收不到任何字节就断开重连，
 * 重连时持久的事件靠续传补回（`GET /events?after=`），不持久的丢：所以没有事件时也要按时写。
 */
export const HEARTBEAT_MS = ASSISTANT_STREAM_HEARTBEAT_MS;
const HEARTBEAT_LINE = `${JSON.stringify({ type: "heartbeat" } satisfies AssistantStreamHeartbeat)}\n`;

export function createAssistantServer(deps: ServerDeps): Server {
	const expected = digest(`Bearer ${deps.secret}`);
	const authorized = (req: IncomingMessage) =>
		timingSafeEqual(digest(req.headers.authorization ?? ""), expected);
	const server = createServer((req, res) => {
		void handle(req, res).catch((error: unknown) => {
			// 回应里不带原因（可能引用请求的内容），原因写日志。
			deps.log(`处理 ${req.method} ${req.url} 出错：${describeError(error)}`);
			if (!res.headersSent) sendError(res, 500, "start_failed", "助手服务内部出错，原因见它的日志");
			else res.destroy();
		});
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!authorized(req)) return sendError(res, 401, "unauthorized", "共享密钥不对或缺了");
		const url = new URL(req.url ?? "/", "http://assistant");
		const route = `${req.method} ${url.pathname}`;
		if (route === "GET /health") return send(res, 200, health());
		if (route === "GET /events") return events(req, res, url);
		const command = /^POST \/sessions\/([^/]+)\/(prompt|steer|abort|end)$/.exec(route);
		if (!command) return sendError(res, 404, "invalid_request", `没有 ${route}`);
		const id = SessionId.safeParse(command[1]);
		if (!id.success) return sendError(res, 400, "invalid_request", "会话 ID 不是 UUID");
		if (command[2] === "end") {
			// 没有请求体；不认识的会话也是 202。
			deps.sessions.end(id.data);
			return send(res, 202);
		}
		let json: unknown;
		try {
			json = JSON.parse(await readBody(req));
		} catch {
			// 不带解析器的报错：它会引用请求体的一段（里面可能有 secret 环境变量）。
			return sendError(res, 400, "invalid_request", "请求体不是 JSON（或太大）");
		}
		if (command[2] === "abort") {
			const abort = AbortCommandBody.safeParse(json);
			if (!abort.success)
				return sendError(res, 400, "invalid_request", "请求体要有要结束的轮次 turn");
			deps.sessions.abort(id.data, abort.data.turn);
			return send(res, 202);
		}
		if (command[2] === "steer") {
			const steer = SteerCommandBody.safeParse(json);
			if (!steer.success) {
				const where = steer.error.issues.map((i) => i.path.join(".")).join("、");
				return sendError(res, 400, "invalid_request", `请求体不对：${where}`);
			}
			const result = deps.sessions.steer(id.data, steer.data);
			if (!result.ok) return sendError(res, result.status, result.code, result.message);
			return send(res, 202);
		}
		const body = PromptCommandBody.safeParse(json);
		if (!body.success) {
			// 不把请求体的内容写进回应（里面有 secret 环境变量）。
			const where = body.error.issues.map((i) => i.path.join(".")).join("、");
			return sendError(res, 400, "invalid_request", `请求体不对：${where}`);
		}
		const result = deps.sessions.prompt(id.data, body.data);
		if (!result.ok) return sendError(res, result.status, result.code, result.message);
		send(res, 202);
	}

	/**
	 * 事件流（协议的 `GET /events`）：第一行 `hello`（`gap` 见 `EventBus.resume`），接着补发 `after` 之后的持久事件，再接实时的。
	 * 补发和订阅实时在同一步里切换：之前的在补发里，之后的在 `live` 里，不漏不重。**背压**：补发每写一块（256 KB）看一次
	 * 对端读走没有，没读走就等；补发期间到的实时事件先排在 `pending` 里，补发完再放；对端读得太慢——没被读走的字节（连接上
	 * 已经写出去的，加补发期间排着的）超过 `maxBacklogBytes`——就断开这条连接（控制面带 `after` 重连，持久的事件从缓冲补发，
	 * 不持久的丢，由快照补上），不让助手服务的内存跟着涨。
	 */
	function events(req: IncomingMessage, res: ServerResponse, url: URL): void {
		const query = AssistantEventsQuery.safeParse({
			after: url.searchParams.get("after") ?? undefined,
		});
		if (!query.success) {
			sendError(res, 400, "invalid_request", "after 要写成 <纪元>:<序号>");
			return;
		}
		const after = query.data.after === undefined ? undefined : parseAfter(query.data.after);
		const limit = deps.maxBacklogBytes ?? ASSISTANT_STREAM_BACKLOG_BYTES;
		let closed = false;
		let replaying = false;
		const pending: string[] = [];
		let pendingBytes = 0;
		const close = () => {
			if (closed) return;
			closed = true;
			clearInterval(heartbeat);
			unsubscribe();
		};
		const overflow = () => {
			deps.log(`事件流的对端读得太慢（没读走的超过 ${limit} 字节），断开它，等它带着 after 重连`);
			close();
			res.destroy();
		};
		const write = (line: string) => {
			if (closed) return;
			if (res.writableLength > limit) return overflow();
			res.write(line);
		};
		const live = (line: string) => {
			if (!replaying) return write(line);
			pending.push(line);
			pendingBytes += Buffer.byteLength(line);
			if (pendingBytes + res.writableLength > limit) overflow();
		};
		// 每条连接自己的心跳：不论有没有事件、有没有一轮在做，按间隔写一行。
		const heartbeat = setInterval(() => write(HEARTBEAT_LINE), deps.heartbeatMs ?? HEARTBEAT_MS);
		let unsubscribe: () => void = () => {};
		req.on("close", close);
		res.on("close", close);

		res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
		// 下面三步在同一个同步段里：补发的最后一条和订阅之后的第一条实时事件之间不会漏进别的事件。
		const resumption = deps.bus.resume(after);
		res.write(`${JSON.stringify(deps.bus.hello(resumption.gap))}\n`);
		replaying = resumption.lines.length > 0;
		unsubscribe = deps.bus.subscribe(live);
		if (!replaying) return;
		void (async () => {
			let index = 0;
			while (index < resumption.lines.length && !closed) {
				let chunk = "";
				while (index < resumption.lines.length && chunk.length < REPLAY_CHUNK_BYTES) {
					chunk += resumption.lines[index++];
				}
				if (!res.write(chunk)) await drained(res);
			}
			if (closed) return;
			// 补发完，放出补发期间排着的实时事件，切到实时：这两步之间没有 await。
			replaying = false;
			const queued = pending.splice(0);
			pendingBytes = 0;
			for (const line of queued) write(line);
		})().catch((error: unknown) => {
			deps.log(`事件流补发出错：${describeError(error)}`);
			close();
			res.destroy();
		});
	}

	function health(): AssistantHealth {
		return {
			epoch: deps.bus.epoch,
			versions: deps.versions,
			model: deps.model(),
			processes: { active: deps.sessions.activeProcesses, limit: deps.sessions.maxProcesses },
		};
	}

	return server;
}

const digest = (text: string) => createHash("sha256").update(text).digest();

/** `<纪元>:<序号>`（{@link AssistantEventsQuery} 已经校验过格式）。序号写得大到不是安全整数时当作对不上，按 `gap` 处理。 */
function parseAfter(after: string): StreamPosition {
	const at = after.lastIndexOf(":");
	const seq = Number(after.slice(at + 1));
	return {
		epoch: after.slice(0, at),
		seq: Number.isSafeInteger(seq) ? seq : Number.MAX_SAFE_INTEGER,
	};
}

/** 等对端读走已经写出去的数据（`drain`），连接关了也算。 */
function drained(res: ServerResponse): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			res.off("drain", done);
			res.off("close", done);
			resolve();
		};
		res.once("drain", done);
		res.once("close", done);
	});
}

function send(res: ServerResponse, status: number, body?: unknown): void {
	res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
	res.end(body === undefined ? undefined : JSON.stringify(body));
}

function sendError(
	res: ServerResponse,
	status: number,
	code: AssistantErrorCode,
	message: string,
): void {
	const body: AssistantErrorBody = { code, message };
	send(res, status, body);
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new Error("请求体太大");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}
