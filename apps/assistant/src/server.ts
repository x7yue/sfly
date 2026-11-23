import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
	ASSISTANT_STREAM_HEARTBEAT_MS,
	type AssistantErrorBody,
	type AssistantErrorCode,
	type AssistantHealth,
	type AssistantStreamHeartbeat,
	PromptCommandBody,
	SessionId,
} from "@sfly/schema";
import type { EventBus } from "./bus.js";
import { AbortCommandBody } from "./protocol-pending.js";
import type { SessionManager } from "./sessions.js";

/**
 * 助手服务协议（`@sfly/schema` 的 assistant-protocol.ts）的 HTTP 一侧：`POST /sessions/:id/prompt`、
 * `POST /sessions/:id/abort`、`GET /events`（每 15 秒一行心跳）、`GET /health`。每个请求先校验 `Authorization: Bearer <共享密钥>`
 * （常量时间比较），不对返回 401。插话、结束会话是 #544。
 */

/** 请求体的上限：一句话最多 2 万个字符，加上环境变量也远到不了。 */
const MAX_BODY_BYTES = 1024 * 1024;

export interface ServerDeps {
	secret: string;
	bus: EventBus;
	sessions: SessionManager;
	versions: { assistant: string; pi: string };
	modelsFile: string;
	log: (message: string) => void;
	/** 心跳的间隔，默认 {@link HEARTBEAT_MS}（测试里改短）。 */
	heartbeatMs?: number;
}

/**
 * 事件流的心跳间隔：协议定的 {@link ASSISTANT_STREAM_HEARTBEAT_MS}。控制面超过 3 个间隔收不到任何字节就断开重连，
 * 重连时现在不补发，断开那一会儿的事件会丢：所以没有事件时也要按时写。
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
			deps.log(
				`处理 ${req.method} ${req.url} 出错：${error instanceof Error ? error.message : String(error)}`,
			);
			if (!res.headersSent) sendError(res, 500, "start_failed", "助手服务内部出错，原因见它的日志");
			else res.destroy();
		});
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!authorized(req)) return sendError(res, 401, "unauthorized", "共享密钥不对或缺了");
		const url = new URL(req.url ?? "/", "http://assistant");
		const route = `${req.method} ${url.pathname}`;
		if (route === "GET /health") return send(res, 200, health());
		if (route === "GET /events") return events(req, res);
		const command = /^POST \/sessions\/([^/]+)\/(prompt|abort)$/.exec(route);
		if (!command) return sendError(res, 404, "invalid_request", `没有 ${route}`);
		const id = SessionId.safeParse(command[1]);
		if (!id.success) return sendError(res, 400, "invalid_request", "会话 ID 不是 UUID");
		let json: unknown;
		try {
			json = JSON.parse(await readBody(req));
		} catch {
			// 不带解析器的报错：它会引用请求体的一段（里面可能有保密的环境变量）。
			return sendError(res, 400, "invalid_request", "请求体不是 JSON（或太大）");
		}
		if (command[2] === "abort") {
			const abort = AbortCommandBody.safeParse(json);
			if (!abort.success)
				return sendError(res, 400, "invalid_request", "请求体要有要结束的轮次 turn");
			deps.sessions.abort(id.data, abort.data.turn);
			return send(res, 202);
		}
		const body = PromptCommandBody.safeParse(json);
		if (!body.success) {
			// 不把请求体的内容写进回应（里面有保密的环境变量）。
			const where = body.error.issues.map((i) => i.path.join(".")).join("、");
			return sendError(res, 400, "invalid_request", `请求体不对：${where}`);
		}
		const result = deps.sessions.prompt(id.data, body.data);
		if (!result.ok) return sendError(res, result.status, result.code, result.message);
		send(res, 202);
	}

	function events(req: IncomingMessage, res: ServerResponse): void {
		res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
		res.write(`${JSON.stringify(deps.bus.hello())}\n`);
		const unsubscribe = deps.bus.subscribe((line) => res.write(line));
		// 每条连接自己的心跳：不论有没有事件、有没有一轮在做，按间隔写一行。
		const heartbeat = setInterval(
			() => res.write(HEARTBEAT_LINE),
			deps.heartbeatMs ?? HEARTBEAT_MS,
		);
		const close = () => {
			clearInterval(heartbeat);
			unsubscribe();
		};
		req.on("close", close);
		res.on("close", close);
	}

	function health(): AssistantHealth {
		return {
			epoch: deps.bus.epoch,
			versions: deps.versions,
			// 模型的检查、端点和错误分类是 #548。
			model: {
				configured: existsSync(deps.modelsFile),
				endpoint: null,
				reachable: null,
				checked_at: null,
				reason: null,
				error_class: null,
			},
			processes: { active: deps.sessions.activeProcesses, limit: deps.sessions.maxProcesses },
		};
	}

	return server;
}

const digest = (text: string) => createHash("sha256").update(text).digest();

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
