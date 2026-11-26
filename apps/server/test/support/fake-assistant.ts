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
	 * 中止记号（协议「中止记号」：每个会话一个只增不减的整数，「中止到第几轮」）：中止（`abort`，回应是 202 的）把它提到 N；
	 * 之后**轮次不大于记号的 `prompt`** 一律回 202、以 `stopped` 结束，不去做，也不回 409（别的轮次在做、在停止、在等时也一样），
	 * **收到 `prompt` 不清掉记号**；轮次比记号大的 `prompt` 不受影响。这里没有过期，也不限数量。
	 */
	readonly abortMarks = new Map<string, number>();
	/** 每个 prompt 的回应；默认全部 202。 */
	promptReply: (prompt: ReceivedPrompt) => Reply | undefined = () => undefined;
	/**
	 * **收下了、回应却是错误**：这一轮照常登记、开始（和回 202 时一样，包括轮次不大于记号的以 `stopped` 结束），回应的是这个错误
	 * （例如 500）：回应丢了或者助手服务在回应时出错。控制面看到失败、不知道这一轮已经在做（结果未知）。默认不用。
	 */
	promptAcceptedThenReply: (prompt: ReceivedPrompt) => Reply | undefined = () => undefined;
	/** 收到的插话（`steer`），按到达的先后。 */
	readonly steers: ReceivedSteer[] = [];
	/** 收到过 `end` 的会话 ID（每次一条）。 */
	readonly ends: string[] = [];
	/**
	 * 每个 steer 的回应；默认 202（`strictTurns` 开着时，`turn` 那一轮没有在做回 409 `no_turn_running`：没有一轮、在停止、
	 * 轮次对不上；在做的包括登记着、等旧的一轮结束的新一轮）。
	 */
	steerReply: (steer: ReceivedSteer) => Reply | undefined = () => undefined;
	/** 每个 end 的回应；默认 202。 */
	endReply: (sessionId: string) => Reply | undefined = () => undefined;
	/** `end` 处理完、回应之前先等这么久（毫秒）：让测试在 `end` 的回应还在路上时看控制面此刻的状态。 */
	endDelayMs = 0;
	/** 收到的命令按到达的先后，每条 `<命令>:<会话 ID>`（`prompt`、`steer`、`abort`、`end`）：测试看命令之间的先后。 */
	readonly log: string[] = [];
	/**
	 * 按协议「在停止」的那一段有多久（毫秒，`strictTurns` 开着时）：收到中止（或结束会话）之后，这一轮的结局（`turn_end`）
	 * 过这么久才发（模拟 pi 不理 `abort`、助手服务等了又结束进程）；这期间这个会话的新一轮 `prompt` 回 202、登记着、等旧的一轮结束
	 * 再开始（协议「`prompt` 的判断」第 3 条），`steer` 回 409 `no_turn_running`。默认 0：马上结束。
	 */
	stopSettleMs = 0;
	/** 每个 abort 的回应；默认 202（重复调用无害）。 */
	abortReply: (sessionId: string, turn: number) => Reply | undefined = () => undefined;
	/** `/health` 的回应；默认健康。 */
	health: () => AssistantHealth | Reply = () => this.healthy();
	/** 命令（`prompt`）处理完、回应之前先等多久（毫秒）：模拟助手服务冷启动慢、收到了却回应慢；状态先变、回应后到。 */
	promptDelayMs = 0;
	/** `abort` 处理完（记号提了、在做的一轮进入停止）、回应之前先等这么久（毫秒）：让测试在中止的回应还在路上时让别的事发生。 */
	abortDelayMs = 0;
	/** `steer` 处理完（收下了）、回应之前先等这么久（毫秒）：让测试在插话命令的回应还在路上时让别的事发生。 */
	steerDelayMs = 0;
	/**
	 * 按协议「一轮的状态」的表记每个会话的状态（没有一轮 / 在做 / 在停止 / 在停止且有一轮在等），**默认开**：假助手服务只照协议的表，
	 * 不照对实现的猜测（544-B 的助手服务要拿它做对照）。会话已经有一轮在做（包括登记着、在等的）时收到别的轮次的 `prompt` 回 409
	 * `turn_running`；收到 `emit` 的这一轮的 `turn_end`，这一轮就不在做了（**`emit` 直接发的 `turn_end` 也守插话的不变式**：这一轮没送到的
	 * 插话先各发一条 `steer_dropped`）；收到轮次是 N 的中止（回应是 202 的话），**还在做的、轮次不大于 N 的那一轮也结束**
	 * （协议 {@link AbortCommandBody}），记在 {@link endedByAbort}。关掉（非严格）时不回 409、不发 `steer_queue`、`abort` 和 `end`
	 * 不带回结局：不是协议，只给确实要它这样的用例用，用例里写明为什么。
	 */
	strictTurns = true;
	/** `strictTurns` 开着时，被中止结束的轮次（会话和轮次，按结束的先后）。 */
	readonly endedByAbort: Array<{ sessionId: string; turn: number }> = [];
	readonly #running = new Map<string, number>();
	/** 「在停止」的轮次（`strictTurns` 开着、`stopSettleMs` 大于 0 时，收到中止到发出结局之间）。 */
	readonly #stopping = new Map<string, number>();
	/** 在旧的一轮停止期间登记的新一轮（会话 → 轮次）：旧的结束之后才开始。 */
	readonly #pending = new Map<string, number>();
	/**
	 * 助手服务收下、还没送到的插话（`strictTurns` 开着时，会话 → 轮次 → 按收到顺序的列表，**每一轮各有一份**：第 m 轮在停止、第 k 轮在等
	 * 时两轮都可能有）：收下时发一份含它的 `steer_queue`；一轮结束时（中止、结束会话，或者测试用 `emit` 直接发的 `turn_end`），没送到的
	 * 各发一条 `steer_dropped`，排在这一轮的 `turn_end` 前面（协议的不变式）；测试用 {@link deliverSteers} 模拟送到。
	 */
	readonly #steerQueues = new Map<
		string,
		Map<number, Array<{ message_id: string; text: string }>>
	>();
	healthDelayMs = 0;
	/** 收到过几次 `GET /health`。 */
	healthRequests = 0;
	/** 助手服务每次启动生成的随机 ID。 */
	epoch = "fake-epoch";
	/**
	 * 续传的缓冲（#545，协议的 `AssistantEventsQuery`）：最近 {@link replayLimit} 条持久的事件的行，序号连续。`GET /events?after=` 据此补发
	 * 和判 `hello.gap`；{@link restartService} 清空它、换纪元。
	 */
	readonly #replay: Array<{ seq: number; sessionId: string; line: string }> = [];
	/** 缓冲留多少条持久的事件（默认和协议一样 1 万条；测试里改小，造「after 早于缓冲」）。 */
	replayLimit = 10_000;
	/**
	 * 打开时不管 `after`、把缓冲里的持久事件全部补发一遍（`hello.gap` 为 false）：造「助手服务重放控制面已经收过的事件」，
	 * 看库里不存第二遍。
	 */
	replayEverything = false;
	/** `replayEverything` 时只重放这些会话的事件（别的会话的事件库里没有对应的会话，重放它们会被当成「不认识这个会话」丢弃）。不给就是全部。 */
	replayOnly: string[] | undefined;
	/** 最近一次 `GET /events` 带的 `after` 原文（没带是 undefined）；每次连接记一条。 */
	readonly eventAfters: Array<string | undefined> = [];
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

	/** 在监听（`stop()` 之后不在，`resume()` 之后又在）。 */
	get listening(): boolean {
		return this.#server.listening;
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
		// 协议的不变式：这一轮没送到的插话，各有一条 `steer_dropped`，排在这一轮的 `turn_end` 前面（不论这条 `turn_end` 是谁发的）。
		if (event.type === "turn_end") this.#dropSteers(sessionId, turn);
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
		if (event.type === "turn_end" && this.#pending.get(sessionId) === turn) {
			this.#pending.delete(sessionId);
		}
		if (persisted) {
			this.#replay.push({
				seq: record.seq as number,
				sessionId: record.session_id,
				line: JSON.stringify(record),
			});
			while (this.#replay.length > this.replayLimit) this.#replay.shift();
		}
		this.#write(record);
		if (event.type === "turn_end" && this.#stopping.get(sessionId) === turn) {
			this.#stopping.delete(sessionId);
			this.#startPending(sessionId);
		}
		return record;
	}

	/**
	 * 模拟助手服务重启：换一个纪元（序号从头数）、清空续传的缓冲和每个会话的状态（pi 进程随它结束，没有一轮在做了）。事件流的连接断开
	 * （和 `stop()` 一样；要让它连不上一阵，先 `stop()`、再调这个、再 `resume()`）。
	 */
	restartService(epoch = `fake-epoch-${++this.#restarts}`): void {
		this.dropStreams();
		this.epoch = epoch;
		this.#seq = 0;
		this.#replay.length = 0;
		this.#running.clear();
		this.#stopping.clear();
		this.#pending.clear();
		this.#steerQueues.clear();
	}
	#restarts = 0;

	/** 缓冲里现在最后一条持久事件的序号（没有时 0）。 */
	get lastSeq(): number {
		return this.#seq;
	}

	/** 会话在「在停止」：收到了中止、结局还没发（`stopSettleMs` 内）。 */
	stoppingTurn(sessionId: string): number | undefined {
		return this.#stopping.get(sessionId);
	}

	/** 在旧的一轮停止期间登记、等着开始的新一轮。 */
	pendingTurn(sessionId: string): number | undefined {
		return this.#pending.get(sessionId);
	}

	/**
	 * 旧的一轮结束了：登记着的新一轮开始。被中止的那一轮（轮次不大于记号）在 `abort` 到的那一刻就已经立即结束了（协议表「在停止、
	 * 第 k 轮在等 × `abort`」），不会走到这里。
	 */
	#startPending(sessionId: string): void {
		const turn = this.#pending.get(sessionId);
		if (turn === undefined) return;
		this.#pending.delete(sessionId);
		this.#running.set(sessionId, turn);
	}

	/**
	 * 模拟助手服务把这个会话里这一轮（默认是在做的那一轮，没有就是在停止的、在等的）收下的插话都送到了模型（`strictTurns` 开着时）：
	 * 这一轮在做时发一份空的 `steer_queue`；**这一轮已经在停止时只更新自己的记录、不再外传**（协议「停止一轮」第 1 步：决定结束之后不再发
	 * `steer_queue`），所以这样送到的话在 `turn_end` 到的时候仍列在最后一份 `steer_queue` 里、又没有 `steer_dropped`，算送到。
	 */
	deliverSteers(sessionId: string, turn?: number): void {
		const target =
			turn ??
			this.#running.get(sessionId) ??
			this.#stopping.get(sessionId) ??
			this.#pending.get(sessionId);
		if (target === undefined) return;
		const queue = this.#steerQueues.get(sessionId)?.get(target);
		if (!queue) return;
		queue.length = 0;
		if (this.#stopping.get(sessionId) === target) return;
		this.emit(sessionId, target, { type: "steer_queue", messages: [] });
	}

	/**
	 * 模拟助手服务**在一轮中途**把一句插话处理掉了（pi 没收下、被清掉……）：这句话发一条 `steer_dropped`（协议的不变式：没送到的
	 * 插话各有一条），再发不含它的 `steer_queue`；之后这一轮的 `turn_end` 前不会再为它发（`strictTurns` 开着时）。
	 */
	dropSteer(sessionId: string, turn: number, messageId: string): void {
		const queue = this.#steerQueues.get(sessionId)?.get(turn);
		const index = queue?.findIndex((m) => m.message_id === messageId) ?? -1;
		if (!queue || index < 0) return;
		const [message] = queue.splice(index, 1);
		this.emit(sessionId, turn, {
			type: "notice",
			kind: "steer_dropped",
			message: `这句插话没有送到：「${message?.text ?? ""}」`,
			message_id: messageId,
		});
		this.emit(sessionId, turn, { type: "steer_queue", messages: [...queue] });
	}

	/** 这一轮的 `turn_end` 之前：没送到的插话各发一条 `steer_dropped`（协议的不变式），之后这一轮没有待送的插话。 */
	#dropSteers(sessionId: string, turn: number): void {
		const queues = this.#steerQueues.get(sessionId);
		const queue = queues?.get(turn);
		if (!queues || !queue) return;
		queues.delete(turn);
		for (const message of queue) {
			this.emit(sessionId, turn, {
				type: "notice",
				kind: "steer_dropped",
				message: `这句插话没有送到：「${message.text}」`,
				message_id: message.message_id,
			});
		}
	}

	/** 第 `running` 轮进入在停止（`stopSettleMs` 大于 0 时过一会儿才发结局，这期间新一轮的 `prompt` 登记着等它）。 */
	#stopTurn(sessionId: string, running: number, reason: string): void {
		if (this.stopSettleMs > 0) {
			this.#running.delete(sessionId);
			this.#stopping.set(sessionId, running);
			setTimeout(() => {
				if (this.#stopping.get(sessionId) === running) this.#emitEnd(sessionId, running, reason);
			}, this.stopSettleMs).unref();
		} else {
			this.#emitEnd(sessionId, running, reason);
		}
	}

	/** 在等的第 `turn` 轮立即以 `stopped` 结束（被中止、会话结束了）：不起 pi，状态回到「在停止」。 */
	#endPending(sessionId: string, turn: number, reason: string): void {
		this.#pending.delete(sessionId);
		this.#emitEnd(sessionId, turn, reason);
	}

	/** 发这一轮的 `stopped` 的 `turn_end`（`emit` 先为没送到的插话发 `steer_dropped`）。 */
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

	/** 协议的续传规则（`AssistantEventsQuery`）：纪元相同、缓冲里还有 `after` 之后的全部才补发，否则有缺口。 */
	#resume(after: string | undefined): { gap: boolean; lines: string[] } {
		if (this.replayEverything) {
			const only = this.replayOnly;
			const lines = this.#replay
				.filter((e) => only === undefined || only.includes(e.sessionId))
				.map((e) => e.line);
			return { gap: false, lines };
		}
		if (after === undefined) return { gap: false, lines: [] };
		const at = after.lastIndexOf(":");
		const epoch = after.slice(0, at);
		const seq = Number(after.slice(at + 1));
		if (epoch !== this.epoch || seq > this.#seq) return { gap: true, lines: [] };
		const first = this.#replay[0];
		if (first !== undefined && first.seq > seq + 1) return { gap: true, lines: [] };
		return { gap: false, lines: this.#replay.filter((e) => e.seq > seq).map((e) => e.line) };
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
			const after = url.searchParams.get("after") ?? undefined;
			this.eventAfters.push(after);
			const resumed = this.#resume(after);
			res.write(`${JSON.stringify({ type: "hello", epoch: this.epoch, gap: resumed.gap })}\n`);
			for (const line of resumed.lines) res.write(`${line}\n`);
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
		const wait = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : undefined);
		// 每条命令：**先按状态做完它该做的事、再等延迟、再回应**（助手服务收到了、处理了，只是回应慢）；回错误的（`*Reply`）命令没有处理。
		if (command[2] === "end") {
			this.ends.push(sessionId);
			this.log.push(`end:${sessionId}`);
			const reply = this.endReply(sessionId);
			if (reply) {
				await wait(this.endDelayMs);
				return this.#error(res, reply);
			}
			// 协议「结束会话」和表里 `end` 一列：202 收到就回；有一轮在做就照停止结束它、`turn_end` 照常发；在停止的照常停完；在停止、
			// 又有一轮在等的，等的那一轮立即 `stopped`；不动中止记号。**助手服务不记得会话结束了**：`end` 之后轮次比记号大的 `prompt`
			// 照表处理（正确的控制面不会发出这样的 `prompt`）。
			if (this.strictTurns) {
				const pending = this.#pending.get(sessionId);
				if (pending !== undefined) {
					this.#endPending(sessionId, pending, "会话结束了");
				}
				const running = this.#running.get(sessionId);
				if (running !== undefined) this.#stopTurn(sessionId, running, "会话结束了");
			}
			await wait(this.endDelayMs);
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
			this.log.push(`steer:${sessionId}`);
			const reply = this.steerReply(received);
			if (reply) {
				await wait(this.steerDelayMs);
				return this.#error(res, reply);
			}
			// 协议「插话」：只有 `turn` 那一轮「在做」（包括登记着、等旧的一轮结束的新一轮）才回 202；没有一轮、`turn` 那一轮在停止或者
			// 已经结束、`turn` 不是在做的那一轮回 409 `no_turn_running`。同一个 `message_id` 只认一次。**每一轮各有自己的待送队列**。
			if (this.strictTurns) {
				const turn = steer.data.turn;
				if (this.#running.get(sessionId) !== turn && this.#pending.get(sessionId) !== turn) {
					await wait(this.steerDelayMs);
					return this.#error(res, {
						status: 409,
						code: "no_turn_running",
						message: "没有可以送到的一轮",
					});
				}
				const queues =
					this.#steerQueues.get(sessionId) ??
					new Map<number, Array<{ message_id: string; text: string }>>();
				this.#steerQueues.set(sessionId, queues);
				const queue = queues.get(turn) ?? [];
				queues.set(turn, queue);
				if (!queue.some((m) => m.message_id === steer.data.message_id)) {
					queue.push({ message_id: steer.data.message_id, text: steer.data.text });
				}
				// 真的助手服务**先**发含这句话的 `steer_queue`、**再**回 202（收下、排进 pi 的队列、发队列、回应）：控制面先在事务里写
				// `user_message` 再发命令、认 `steer_queue` 时不看 202，所以接得上；这里照真的来，回应慢（`steerDelayMs`）时队列早就到了。
				this.emit(sessionId, turn, { type: "steer_queue", messages: [...queue] });
				await wait(this.steerDelayMs);
				return this.#send(res, 202);
			}
			await wait(this.steerDelayMs);
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
			this.log.push(`abort:${sessionId}`);
			this.abortRequests.push({ sessionId, turn });
			const reply = this.abortReply(sessionId, turn);
			if (reply) {
				await wait(this.abortDelayMs);
				return this.#error(res, reply);
			}
			// 协议：先把中止记号提到 N（只增不减），再按状态处理；回应不等这一轮的 `turn_end`。
			this.abortMarks.set(sessionId, Math.max(this.abortMarks.get(sessionId) ?? 0, turn));
			// 表里 `abort` 一列：在做的、轮次不大于 N 的那一轮进入在停止；比 N 新的不动；在停止的照常停完；在停止、第 k 轮在等时，k 不大于
			// N 的话**立即**以 `stopped` 结束（它的插话各发 `steer_dropped`，排在这条 `turn_end` 前面），状态回到「在停止」，k 大于 N 的不动。
			// 处理在先、回应在后：延迟（`abortDelayMs`）只是回应慢。
			if (this.strictTurns) {
				const pending = this.#pending.get(sessionId);
				if (pending !== undefined && pending <= turn) {
					this.#endPending(sessionId, pending, "用户停止了这一轮");
				}
				const running = this.#running.get(sessionId);
				if (running !== undefined && running <= turn) {
					this.endedByAbort.push({ sessionId, turn: running });
					this.#stopTurn(sessionId, running, "用户停止了这一轮");
				}
			}
			await wait(this.abortDelayMs);
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
		this.log.push(`prompt:${sessionId}`);
		const reply = this.promptReply(prompt);
		if (reply) {
			// 登记之前就拒绝（503 等）：没有登记、不会有任何事件。
			await wait(this.promptDelayMs);
			return this.#error(res, reply);
		}
		// 轮次不大于中止记号的 `prompt`（过时的一轮）：先于「在做的回 409」判断，回 202、以 stopped 结束，不去做，**不清掉记号**；
		// 别的轮次在做、在停止时也一样（协议「`prompt` 的判断」第 1 条）。
		const mark = this.abortMarks.get(sessionId);
		const stale = mark !== undefined && parsed.data.turn <= mark;
		// 在做（正常地，包括登记着的新一轮）才回 409；旧的一轮在停止时不回（协议「`prompt` 的判断」第 3 条）：
		// 登记这一轮、回 202，旧的一轮结束之后才开始。
		if (
			!stale &&
			this.strictTurns &&
			(this.#running.has(sessionId) || this.#pending.has(sessionId))
		) {
			await wait(this.promptDelayMs);
			return this.#error(res, {
				status: 409,
				code: "turn_running",
				message: `这个会话的第 ${this.#running.get(sessionId) ?? this.#pending.get(sessionId)} 轮还在做`,
			});
		}
		// 登记这一轮（先处理、再等延迟、再回应：助手服务收到了，只是回应慢）。
		if (!stale) {
			if (this.strictTurns && this.#stopping.has(sessionId)) {
				this.#pending.set(sessionId, parsed.data.turn);
			} else if (this.strictTurns) {
				this.#running.set(sessionId, parsed.data.turn);
			}
		}
		await wait(this.promptDelayMs);
		// 收下了（这一轮真的登记了、开始了），回应却是错误：回应丢了或者出错（5xx）。控制面看到的是失败，不知道这一轮已经在做。
		const late = this.promptAcceptedThenReply(prompt);
		if (late) {
			this.#error(res, late);
		} else {
			this.#send(res, 202);
		}
		if (stale) this.#emitEnd(sessionId, parsed.data.turn, "这一轮到之前已经要求停止了");
	}
}

async function readBody(req: IncomingMessage): Promise<string> {
	let text = "";
	for await (const chunk of req) text += chunk;
	return text;
}
