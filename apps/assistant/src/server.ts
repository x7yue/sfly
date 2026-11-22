import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
	type AssistantErrorBody,
	type AssistantErrorCode,
	type AssistantHealth,
	PromptCommandBody,
	SessionId,
} from "@sfly/schema";
import type { EventBus } from "./bus.js";
import type { SessionManager } from "./sessions.js";

/**
 * 助手服务协议（`@sfly/schema` 的 assistant-protocol.ts）的 HTTP 一侧：`POST /sessions/:id/prompt`、
 * `POST /sessions/:id/abort`、`GET /events`、`GET /health`。每个请求先校验 `Authorization: Bearer <共享密钥>`
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
}

export function createAssistantServer(deps: ServerDeps): Server {
	const expected = digest(`Bearer ${deps.secret}`);
	const authorized = (req: IncomingMessage) =>
		timingSafeEqual(digest(req.headers.authorization ?? ""), expected);
	const server = createServer((req, res) => {
		void handle(req, res).catch((error: unknown) => {
			if (!res.headersSent) {
				sendError(res, 500, "start_failed", error instanceof Error ? error.message : String(error));
			} else {
				res.destroy();
			}
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
		if (command[2] === "abort") {
			deps.sessions.abort(id.data);
			return send(res, 202);
		}
		let json: unknown;
		try {
			json = JSON.parse(await readBody(req));
		} catch (error) {
			return sendError(
				res,
				400,
				"invalid_request",
				error instanceof Error ? error.message : "不是 JSON",
			);
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
		req.on("close", unsubscribe);
		res.on("close", unsubscribe);
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
