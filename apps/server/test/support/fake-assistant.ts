// 进程内的假助手服务：说 @sfly/schema 的 `assistant-protocol.ts` 里的协议（命令、事件流、健康检查），记下收到的命令，
// 测试可以往它的事件流里推事件。控制面的会话模块的测试和（之后）页面的 e2e 都用它，不用起真的助手服务和 pi。
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
	ASSISTANT_STREAM_HEARTBEAT_MS,
	type AssistantErrorBody,
	type AssistantErrorCode,
	type AssistantEvent,
	type AssistantHealth,
	AssistantStreamRecord,
	PERSISTED_SESSION_EVENT_TYPES,
	PromptCommandBody,
} from "@sfly/schema";

export const FAKE_SECRET = "fake-assistant-shared-secret-0123456789";

/** 收到的一条命令（`prompt` 的 `body` 已经过协议的 schema）。 */
export interface ReceivedPrompt {
	sessionId: string;
	body: PromptCommandBody;
	authorization: string | undefined;
}

/** 命令的回应：默认 202；要拒绝时给状态码和错误码。 */
export type Reply = { status: number; code?: AssistantErrorCode; message?: string };

export class FakeAssistant {
	readonly #server: Server;
	#port: number;
	readonly #streams = new Set<ServerResponse>();
	#seq = 0;
	#unauthorized = 0;
	readonly prompts: ReceivedPrompt[] = [];
	readonly aborts: string[] = [];
	/** 每个 prompt 的回应；默认全部 202。 */
	promptReply: (prompt: ReceivedPrompt) => Reply | undefined = () => undefined;
	/** 每个 abort 的回应；默认 202（重复调用无害）。 */
	abortReply: (sessionId: string) => Reply | undefined = () => undefined;
	/** `/health` 的回应；默认健康。 */
	health: () => AssistantHealth | Reply = () => this.healthy();
	/** 回应命令（prompt、abort）和 `/health` 之前先等多久（毫秒）：模拟助手服务冷启动慢、接了连接却不回话。 */
	promptDelayMs = 0;
	/** 收到 `abort` 之后先等这么久（毫秒）再回应：让测试在中止还在路上时让别的事发生。 */
	abortDelayMs = 0;
	healthDelayMs = 0;
	/** 收到过几次 `GET /health`。 */
	healthRequests = 0;
	/** 助手服务每次启动生成的随机 ID。 */
	epoch = "fake-epoch";
	/** 事件流里写心跳的间隔（毫秒），默认和协议一样 15 秒；0 是不写（模拟一个不发心跳的助手服务）。 */
	heartbeatMs: number = ASSISTANT_STREAM_HEARTBEAT_MS;
	/** 收到过几次 `GET /events`（连接断了重连会多一次）。 */
	#eventRequests = 0;

	private constructor(
		readonly secret: string,
		server: Server,
		port: number,
	) {
		this.#server = server;
		this.#port = port;
	}

	static async start(
		options: { secret?: string; heartbeatMs?: number } = {},
	): Promise<FakeAssistant> {
		const secret = options.secret ?? FAKE_SECRET;
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const fake = new FakeAssistant(secret, server, (server.address() as AddressInfo).port);
		if (options.heartbeatMs !== undefined) fake.heartbeatMs = options.heartbeatMs;
		server.on("request", (req, res) => void fake.#handle(req, res));
		return fake;
	}

	get url(): string {
		return `http://127.0.0.1:${this.#port}`;
	}

	/** 收到过几次 `GET /events`。 */
	get eventRequests(): number {
		return this.#eventRequests;
	}

	/** 密钥不对的请求被拒绝了几次。 */
	get unauthorized(): number {
		return this.#unauthorized;
	}

	/** 现在连着的事件流条数。 */
	get streams(): number {
		return this.#streams.size;
	}

	healthy(): AssistantHealth {
		return {
			epoch: this.epoch,
			versions: { assistant: "0.0.0-fake", pi: "0.0.0-fake" },
			model: {
				configured: true,
				endpoint: null,
				reachable: true,
				checked_at: null,
				reason: null,
				error_class: null,
			},
			processes: { active: 0, limit: null },
		};
	}

	/**
	 * 往所有连着的事件流里推一条事件记录（经协议的 schema 检查：持久的事件带助手服务内的序号，不持久的不带）。
	 * `at` 是助手服务产生它的时间。
	 */
	emit(
		sessionId: string,
		turn: number,
		event: AssistantEvent,
		at: Date | string = new Date("2026-01-01T00:00:00.000Z"),
	): AssistantStreamRecord {
		const persisted = (PERSISTED_SESSION_EVENT_TYPES as readonly string[]).includes(event.type);
		const record = AssistantStreamRecord.parse({
			epoch: this.epoch,
			...(persisted && { seq: ++this.#seq }),
			session_id: sessionId,
			turn,
			at: typeof at === "string" ? at : at.toISOString(),
			event,
		});
		this.#write(record);
		return record;
	}

	/** 往事件流里写一行任意的内容（测试不是约定形状的行）。 */
	emitRaw(line: string): void {
		this.#write(line);
	}

	/** 断开所有事件流（模拟连接断了）。 */
	dropStreams(): void {
		for (const res of [...this.#streams]) res.destroy();
		this.#streams.clear();
	}

	/** 等到至少有 `count` 条事件流连着。 */
	async connected(count = 1, timeoutMs = 5000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (this.#streams.size < count) {
			if (Date.now() > deadline)
				throw new Error(`等不到 ${count} 条事件流（现在 ${this.#streams.size} 条）`);
			await new Promise((r) => setTimeout(r, 10));
		}
	}

	/** 停止监听并断开连接（模拟助手服务连不上）；`resume()` 在同一个端口上重新开始。 */
	async stop(): Promise<void> {
		this.dropStreams();
		this.#server.closeAllConnections();
		await new Promise<void>((resolve) => this.#server.close(() => resolve()));
	}

	async resume(): Promise<void> {
		await new Promise<void>((resolve) => this.#server.listen(this.#port, "127.0.0.1", resolve));
	}

	async close(): Promise<void> {
		this.dropStreams();
		this.#server.closeAllConnections();
		if (this.#server.listening) {
			await new Promise<void>((resolve) => this.#server.close(() => resolve()));
		}
	}

	#write(record: unknown): void {
		const line = typeof record === "string" ? record : JSON.stringify(record);
		for (const res of this.#streams) res.write(`${line}\n`);
	}

	#authorized(req: IncomingMessage): boolean {
		const header = req.headers.authorization ?? "";
		const expected = Buffer.from(`Bearer ${this.secret}`);
		const given = Buffer.from(header);
		return given.length === expected.length && timingSafeEqual(given, expected);
	}

	#send(res: ServerResponse, status: number, body?: unknown): void {
		res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
		res.end(body === undefined ? undefined : JSON.stringify(body));
	}

	#error(res: ServerResponse, reply: Reply): void {
		const body: AssistantErrorBody = {
			code: reply.code ?? "start_failed",
			message: reply.message ?? `fake: ${reply.status}`,
		};
		this.#send(res, reply.status, body);
	}

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!this.#authorized(req)) {
			this.#unauthorized += 1;
			return this.#error(res, { status: 401, code: "unauthorized", message: "密钥不对" });
		}
		const url = new URL(req.url ?? "/", this.url);
		const route = `${req.method} ${url.pathname}`;
		if (route === "GET /health") {
			this.healthRequests += 1;
			if (this.healthDelayMs > 0) await new Promise((r) => setTimeout(r, this.healthDelayMs));
			const health = this.health();
			if ("status" in health) return this.#error(res, health);
			return this.#send(res, 200, health);
		}
		if (route === "GET /events") {
			res.writeHead(200, { "content-type": "application/x-ndjson" });
			res.write(`${JSON.stringify({ type: "hello", epoch: this.epoch, gap: false })}\n`);
			this.#eventRequests += 1;
			this.#streams.add(res);
			// 心跳：协议要求助手服务每隔一段时间写一行，让连接不空闲（控制面也靠它分清「静默」和「死了」）。
			const beat =
				this.heartbeatMs > 0
					? setInterval(
							() => res.write(`${JSON.stringify({ type: "heartbeat" })}\n`),
							this.heartbeatMs,
						)
					: undefined;
			beat?.unref();
			res.on("close", () => {
				clearInterval(beat);
				this.#streams.delete(res);
			});
			return;
		}
		const command = /^POST \/sessions\/([^/]+)\/(prompt|abort)$/.exec(route);
		if (!command) return this.#error(res, { status: 404, code: "invalid_request" });
		const sessionId = command[1] as string;
		if (command[2] === "abort") {
			this.aborts.push(sessionId);
			if (this.abortDelayMs > 0) await new Promise((r) => setTimeout(r, this.abortDelayMs));
			const reply = this.abortReply(sessionId);
			if (reply) return this.#error(res, reply);
			return this.#send(res, 202);
		}
		let json: unknown;
		try {
			json = JSON.parse(await readBody(req));
		} catch {
			return this.#error(res, { status: 400, code: "invalid_request", message: "不是 JSON" });
		}
		const parsed = PromptCommandBody.safeParse(json);
		if (!parsed.success) {
			return this.#error(res, {
				status: 400,
				code: "invalid_request",
				message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；"),
			});
		}
		const prompt = {
			sessionId,
			body: parsed.data,
			authorization: req.headers.authorization,
		};
		this.prompts.push(prompt);
		if (this.promptDelayMs > 0) await new Promise((r) => setTimeout(r, this.promptDelayMs));
		const reply = this.promptReply(prompt);
		if (reply) return this.#error(res, reply);
		this.#send(res, 202);
	}
}

async function readBody(req: IncomingMessage): Promise<string> {
	let text = "";
	for await (const chunk of req) text += chunk;
	return text;
}
