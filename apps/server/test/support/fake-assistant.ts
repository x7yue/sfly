// 进程内的假助手服务：说 @sfly/schema 的 `assistant-protocol.ts` 里的协议（命令、事件流、健康检查），记下收到的命令，
// 测试可以往它的事件流里推事件。控制面的会话模块的测试和（之后）页面的 e2e 都用它，不用起真的助手服务和 pi。
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
	AbortCommandBody,
	ASSISTANT_STREAM_HEARTBEAT_MS,
	type AssistantErrorBody,
	type AssistantErrorCode,
	type AssistantEvent,
	type AssistantHealth,
	AssistantStreamRecord,
	PERSISTED_SESSION_EVENT_TYPES,
	PromptCommandBody,
	SteerCommandBody,
} from "@sfly/schema";

export const FAKE_SECRET = "fake-assistant-shared-secret-0123456789";

/** 收到的一条命令（`prompt` 的 `body` 已经过协议的 schema）。 */
export interface ReceivedPrompt {
	sessionId: string;
	body: PromptCommandBody;
	authorization: string | undefined;
}

/** 收到的一条插话（`steer` 的 `body` 已经过协议的 schema）。 */
export interface ReceivedSteer {
	sessionId: string;
	body: SteerCommandBody;
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
	/** 收到过中止的会话 ID（每次一条；带的轮次在 {@link abortRequests}）。 */
	readonly aborts: string[] = [];
	/** 收到过几次 `abort` 请求（不管请求体对不对）：测试要确认「没有发」时看它。 */
	abortAttempts = 0;
	/** 收到的中止：会话和它要结束的轮次（过了协议的 schema）。 */
	readonly abortRequests: Array<{ sessionId: string; turn: number }> = [];
	/**
	 * 「已被中止」的记号（会话 → 轮次，每个会话只留轮次最大的那一个）：和协议一致（{@link AbortCommandBody}），中止到达时记下；
	 * 之后**轮次不大于记号的 `prompt`**（过时的一轮：控制面已经在更晚的轮次上了）回 202、直接以 `stopped` 结束，不去做，也不回
	 * 409（更早的一轮还在做、还在停止时也一样）；轮次比记号大的 `prompt` 把记号清掉。
	 */
	readonly abortMarks = new Map<string, number>();
	/** 每个 prompt 的回应；默认全部 202。 */
	promptReply: (prompt: ReceivedPrompt) => Reply | undefined = () => undefined;
	/** 收到的插话（`steer`），按到达的先后。 */
	readonly steers: ReceivedSteer[] = [];
	/** 收到过 `end` 的会话 ID（每次一条）。 */
	readonly ends: string[] = [];
	/** 每个 steer 的回应；默认 202（`strictTurns` 开着时，没有可以送到的一轮回 409 `no_turn_running`）。 */
	steerReply: (steer: ReceivedSteer) => Reply | undefined = () => undefined;
	/** 每个 end 的回应；默认 202。 */
	endReply: (sessionId: string) => Reply | undefined = () => undefined;
	/**
	 * 按协议「在停止」的那一段有多久（毫秒，`strictTurns` 开着时）：收到中止之后，这一轮的结局（`turn_end`）过这么久才发
	 * （模拟 pi 不理 `abort`、助手服务等了又结束进程）；这期间这个会话的新一轮 `prompt` 回 202、登记着、等旧的一轮结束
	 * 再开始（协议「一轮的状态」第 1 条），`steer` 回 409 `no_turn_running`。默认 0：马上结束。
	 */
	stopSettleMs = 0;
	/** 每个 abort 的回应；默认 202（重复调用无害）。 */
	abortReply: (sessionId: string, turn: number) => Reply | undefined = () => undefined;
	/** `/health` 的回应；默认健康。 */
	health: () => AssistantHealth | Reply = () => this.healthy();
	/** 回应命令（prompt、abort）和 `/health` 之前先等多久（毫秒）：模拟助手服务冷启动慢、接了连接却不回话。 */
	promptDelayMs = 0;
	/** 收到 `abort` 之后先等这么久（毫秒）再回应：让测试在中止还在路上时让别的事发生。 */
	abortDelayMs = 0;
	/**
	 * 按真助手服务的样子记「哪一轮在做」（默认关，多数用例自己用 `emit` 和 `abortReply` 控制）：开着时，会话已经有一轮在做时
	 * 收到别的轮次的 `prompt` 回 409 `turn_running`；收到 `emit` 的这一轮的 `turn_end`，这一轮就不在做了；收到轮次是 N 的
	 * 中止（回应是 202 的话），**还在做的、轮次不大于 N 的那一轮也结束**（协议 {@link AbortCommandBody}），记在
	 * {@link endedByAbort}。
	 */
	strictTurns = false;
	/** `strictTurns` 开着时，被中止结束的轮次（会话和轮次，按结束的先后）。 */
	readonly endedByAbort: Array<{ sessionId: string; turn: number }> = [];
	readonly #running = new Map<string, number>();
	/** 「在停止」的轮次（`strictTurns` 开着、`stopSettleMs` 大于 0 时，收到中止到发出结局之间）。 */
	readonly #stopping = new Map<string, number>();
	/** 在旧的一轮停止期间登记的新一轮（会话 → 轮次）：旧的结束之后才开始。 */
	readonly #pending = new Map<string, number>();
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
		if (event.type === "turn_end" && this.#running.get(sessionId) === turn) {
			this.#running.delete(sessionId);
		}
		this.#write(record);
		if (event.type === "turn_end" && this.#stopping.get(sessionId) === turn) {
			this.#stopping.delete(sessionId);
			this.#startPending(sessionId);
		}
		return record;
	}

	/** 会话在「在停止」：收到了中止、结局还没发（`stopSettleMs` 内）。 */
	stoppingTurn(sessionId: string): number | undefined {
		return this.#stopping.get(sessionId);
	}

	/** 在旧的一轮停止期间登记、等着开始的新一轮。 */
	pendingTurn(sessionId: string): number | undefined {
		return this.#pending.get(sessionId);
	}

	/** 旧的一轮结束了：登记着的新一轮开始（被中止过的直接以 stopped 结束）。 */
	#startPending(sessionId: string): void {
		const turn = this.#pending.get(sessionId);
		if (turn === undefined) return;
		this.#pending.delete(sessionId);
		if ((this.abortMarks.get(sessionId) ?? 0) >= turn) {
			this.#emitEnd(sessionId, turn, "这一轮在开始之前就被中止了");
			return;
		}
		this.#running.set(sessionId, turn);
	}

	#emitEnd(sessionId: string, turn: number, reason: string): void {
		this.emit(sessionId, turn, {
			type: "turn_end",
			turn,
			outcome: "stopped",
			reason,
			steps: 0,
			model_calls: 0,
			duration_ms: 0,
			usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
		});
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
		const command = /^POST \/sessions\/([^/]+)\/(prompt|abort|steer|end)$/.exec(route);
		if (!command) return this.#error(res, { status: 404, code: "invalid_request" });
		const sessionId = command[1] as string;
		if (command[2] === "end") {
			this.ends.push(sessionId);
			const reply = this.endReply(sessionId);
			if (reply) return this.#error(res, reply);
			return this.#send(res, 202);
		}
		if (command[2] === "steer") {
			let steerJson: unknown;
			try {
				steerJson = JSON.parse(await readBody(req));
			} catch {
				return this.#error(res, { status: 400, code: "invalid_request", message: "不是 JSON" });
			}
			const steer = SteerCommandBody.safeParse(steerJson);
			if (!steer.success) {
				return this.#error(res, {
					status: 400,
					code: "invalid_request",
					message: steer.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；"),
				});
			}
			const received = { sessionId, body: steer.data };
			this.steers.push(received);
			const reply = this.steerReply(received);
			if (reply) return this.#error(res, reply);
			// 协议：在做（包括登记着、等旧的一轮结束的新一轮）回 202，没有一轮、在停止回 409 `no_turn_running`。
			if (
				this.strictTurns &&
				!this.#running.has(sessionId) &&
				!(
					this.#pending.has(sessionId) &&
					(this.abortMarks.get(sessionId) ?? 0) < (this.#pending.get(sessionId) as number)
				)
			) {
				return this.#error(res, {
					status: 409,
					code: "no_turn_running",
					message: "没有可以送到的一轮",
				});
			}
			return this.#send(res, 202);
		}
		if (command[2] === "abort") {
			this.abortAttempts++;
			let abortJson: unknown;
			try {
				abortJson = JSON.parse(await readBody(req));
			} catch {
				return this.#error(res, { status: 400, code: "invalid_request", message: "不是 JSON" });
			}
			const abort = AbortCommandBody.safeParse(abortJson);
			if (!abort.success) {
				return this.#error(res, {
					status: 400,
					code: "invalid_request",
					message: abort.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；"),
				});
			}
			const { turn } = abort.data;
			this.aborts.push(sessionId);
			this.abortRequests.push({ sessionId, turn });
			this.abortMarks.set(sessionId, Math.max(this.abortMarks.get(sessionId) ?? 0, turn));
			if (this.abortDelayMs > 0) await new Promise((r) => setTimeout(r, this.abortDelayMs));
			const reply = this.abortReply(sessionId, turn);
			if (reply) return this.#error(res, reply);
			this.#send(res, 202);
			// 还在做的、轮次不大于 N 的那一轮也结束（协议）；拒绝了中止的不算。
			const running = this.#running.get(sessionId);
			if (this.strictTurns && running !== undefined && running <= turn) {
				this.endedByAbort.push({ sessionId, turn: running });
				if (this.stopSettleMs > 0) {
					// 在停止：结局过一会儿才发，这期间新一轮的 `prompt` 登记着等它。
					this.#running.delete(sessionId);
					this.#stopping.set(sessionId, running);
					setTimeout(() => {
						if (this.#stopping.get(sessionId) === running) {
							this.#emitEnd(sessionId, running, "助手服务按中止结束了这一轮");
						}
					}, this.stopSettleMs).unref();
				} else {
					this.#emitEnd(sessionId, running, "助手服务按中止结束了这一轮");
				}
			}
			return;
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
		// 轮次不大于中止记号的 `prompt`（过时的一轮）：先于「在做的回 409」判断，回 202、以 stopped 结束，不去做；
		// 更早的一轮还在做、还在停止时也一样（协议「一轮的状态」第 2 条）。轮次比记号大的 `prompt` 把记号清掉。
		const mark = this.abortMarks.get(sessionId);
		const stale = mark !== undefined && parsed.data.turn <= mark;
		if (mark !== undefined && !stale) this.abortMarks.delete(sessionId);
		// 在做（正常地，包括登记着的新一轮）才回 409；旧的一轮在停止时不回（协议「一轮的状态」第 1 条）：
		// 登记这一轮、回 202，旧的一轮结束之后才开始。
		if (
			!stale &&
			this.strictTurns &&
			(this.#running.has(sessionId) || this.#pending.has(sessionId))
		) {
			return this.#error(res, {
				status: 409,
				code: "turn_running",
				message: `这个会话的第 ${this.#running.get(sessionId) ?? this.#pending.get(sessionId)} 轮还在做`,
			});
		}
		this.#send(res, 202);
		if (stale) {
			this.#emitEnd(sessionId, parsed.data.turn, "这一轮在开始之前就被中止了");
			return;
		}
		if (this.strictTurns && this.#stopping.has(sessionId)) {
			this.#pending.set(sessionId, parsed.data.turn);
			return;
		}
		if (this.strictTurns) this.#running.set(sessionId, parsed.data.turn);
	}
}

async function readBody(req: IncomingMessage): Promise<string> {
	let text = "";
	for await (const chunk of req) text += chunk;
	return text;
}
