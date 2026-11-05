import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { type Client, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import {
	type Ack,
	AgentGateway,
	type AgentMessage,
	AgentMessageSchema,
	type AssignTask,
	type CancelTask,
	ErrorKind,
	type HelloSchema,
	LogLevel,
	type LogLineSchema,
	LogSource,
	type MetricPointSchema,
	type ServerMessage,
	TaskAction,
	TaskStatus,
	type Welcome,
} from "@sfly/proto";

const keyOf = (t: TaskRef) => `${t.taskId}:${t.attempt}`;

/** 可推送的异步队列，作为双向流的请求流。 */
class Outbox<T> implements AsyncIterable<T> {
	#items: T[] = [];
	#wake: (() => void) | undefined;
	#ended = false;

	push(item: T): void {
		if (this.#ended) throw new Error("outbox already ended");
		this.#items.push(item);
		this.#wake?.();
	}

	end(): void {
		this.#ended = true;
		this.#wake?.();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			const item = this.#items.shift();
			if (item !== undefined) {
				yield item;
				continue;
			}
			if (this.#ended) return;
			await new Promise<void>((resolve) => {
				this.#wake = resolve;
			});
			this.#wake = undefined;
		}
	}
}

type Waiter = {
	predicate: (m: ServerMessage) => boolean;
	resolve: (m: ServerMessage) => void;
	reject: (e: unknown) => void;
};

export type TaskResultInit = Extract<
	MessageInitShape<typeof AgentMessageSchema>["body"],
	{ case: "result" }
>["value"];
export type TaskRef = { taskId: string; attempt: number };
export type LogLineInit = MessageInitShape<typeof LogLineSchema>;
export type MetricPointInit = MessageInitShape<typeof MetricPointSchema>;
export { LogLevel, LogSource };
/** 派发的任务；`inputs` 是解析后的 inputs_json。 */
export type AssignedTask = AssignTask & { inputs: Record<string, unknown> };
export { ErrorKind, TaskStatus };

export type ServerMessageCase = NonNullable<ServerMessage["body"]["case"]>;
export type HelloInit = MessageInitShape<typeof HelloSchema> & { name: string };

/**
 * 可编程的假 Agent：用真实的 gRPC 协议（HTTP/2）连上控制面的 Agent 网关。
 *
 * - `FakeAgent.connect()` 建立双向流、发送 Hello 并等待 Welcome；
 * - `send()` 发送任意 AgentMessage；
 * - `next()` / `received` 观察控制面推送的消息；
 * - `close()` 正常结束请求流，`disconnect()` 模拟断线（直接中断连接）。
 *
 * - `nextAssign()` 等待下一个派发的任务（输入已解析为 `inputs`）；
 * - `succeed()` / `fail()` / `report()` 上报任务结果并等待控制面的 Ack。
 *
 * 后续票据在这里继续加可编程行为（延迟、断线重连等）。
 */
export class FakeAgent {
	readonly received: ServerMessage[] = [];
	#outbox = new Outbox<AgentMessage>();
	#abort = new AbortController();
	#waiters: Waiter[] = [];
	#consumed = new Set<number>();
	#closed: Promise<void>;
	#error: unknown;
	#ended = false;

	private constructor(
		readonly name: string,
		client: Client<typeof AgentGateway>,
	) {
		const responses = client.session(this.#outbox, { signal: this.#abort.signal });
		this.#closed = (async () => {
			try {
				for await (const message of responses) {
					this.received.push(message);
					this.#dispatch();
				}
			} catch (error) {
				this.#error = error;
			} finally {
				this.#ended = true;
				for (const w of this.#waiters.splice(0)) {
					w.reject(this.#error ?? new Error(`stream for agent ${name} ended`));
				}
			}
		})();
	}

	/** 连接网关，发送 Hello，等待 Welcome 后返回。 */
	static async connect(
		grpcUrl: string,
		hello: HelloInit,
		options: { timeoutMs?: number } = {},
	): Promise<FakeAgent> {
		return FakeAgent.connectRaw(
			grpcUrl,
			(agent) => agent.send({ case: "hello", value: { agentVersion: "fake", ...hello } }),
			{ ...options, name: hello.name },
		);
	}

	/** 建立双向流后由 `handshake` 自行发送消息（例如不合规的首条消息），然后等待 Welcome。 */
	static async connectRaw(
		grpcUrl: string,
		handshake: (agent: FakeAgent) => void,
		options: { timeoutMs?: number; name?: string } = {},
	): Promise<FakeAgent> {
		const transport = createGrpcTransport({ baseUrl: grpcUrl });
		const agent = new FakeAgent(options.name ?? "raw", createClient(AgentGateway, transport));
		handshake(agent);
		try {
			await agent.next("welcome", options);
		} catch (error) {
			agent.#abort.abort();
			throw error;
		}
		return agent;
	}

	send(body: MessageInitShape<typeof AgentMessageSchema>["body"]): void {
		this.#outbox.push(create(AgentMessageSchema, { body }));
	}

	/** 等待下一条（尚未被 next 消费过的）指定类型的消息。 */
	next(kind?: ServerMessageCase, options: { timeoutMs?: number } = {}): Promise<ServerMessage> {
		const predicate = (m: ServerMessage) => kind === undefined || m.body.case === kind;
		return this.#nextMatching(predicate, `'${kind ?? "any"}' message`, options.timeoutMs ?? 5000);
	}

	#nextMatching(
		predicate: (m: ServerMessage) => boolean,
		what: string,
		timeoutMs: number,
	): Promise<ServerMessage> {
		return new Promise<ServerMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#waiters = this.#waiters.filter((w) => w !== waiter);
				reject(new Error(`agent ${this.name}: no ${what} within ${timeoutMs}ms`));
			}, timeoutMs);
			const waiter: Waiter = {
				predicate,
				resolve: (m) => {
					clearTimeout(timer);
					resolve(m);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			};
			this.#waiters.push(waiter);
			this.#dispatch();
		});
	}

	/** 握手时收到的 Welcome（#15：含对 Hello.running_tasks 的处置）。 */
	get welcome(): Welcome {
		const message = this.received.find((m) => m.body.case === "welcome");
		if (!message) throw new Error(`agent ${this.name}: no welcome`);
		return message.body.value as Welcome;
	}

	/** Welcome 中对各任务的处置：task_id → "continue" | "abandon"。 */
	get dispositions(): Record<string, "continue" | "abandon"> {
		return Object.fromEntries(
			this.welcome.dispositions.map((d) => [
				d.taskId,
				d.action === TaskAction.ABANDON ? "abandon" : "continue",
			]),
		);
	}

	/**
	 * 发送心跳并等到控制面处理完它。心跳带上手上的任务（默认 {@link held}：派发给本 Agent、还没上报结果的），
	 * 控制面只为它们续约；连续两次心跳都没有上报的任务以 agent_lost 失败。
	 */
	async heartbeat(tasks: TaskRef[] = this.held): Promise<void> {
		this.send({
			case: "heartbeat",
			value: {
				runningTasks: tasks.map((t) => ({
					taskId: t.taskId,
					attempt: t.attempt,
					started: this.#started.has(keyOf(t)),
				})),
			},
		});
		await this.sync();
	}

	/** 手上的任务：派发给本 Agent、还没上报结果的。 */
	get held(): TaskRef[] {
		return [...this.#held.values()];
	}

	#held = new Map<string, TaskRef>();
	#started = new Set<string>();

	/** 上报 TaskStarted（执行器已启动：任务从派发阶段进入 running），并等到控制面处理完它。 */
	async started(task: TaskRef): Promise<void> {
		this.#started.add(keyOf(task));
		this.send({ case: "started", value: { taskId: task.taskId, attempt: task.attempt } });
		await this.sync();
	}

	/**
	 * 等到控制面处理完此前发出的全部消息：入站消息按顺序处理，
	 * 这里发一条不存在任务的结果（控制面忽略但仍回 Ack）并等它的 Ack。
	 */
	async sync(): Promise<void> {
		await this.report({
			taskId: "00000000-0000-4000-8000-000000000000",
			attempt: ++this.#syncs,
			status: TaskStatus.SUCCESS,
		});
	}

	#syncs = 0;

	/**
	 * 等待下一个派发给本 Agent 的任务。默认像真实 Agent 一样立即上报 TaskStarted（任务进入 running）；
	 * `start: false` 时停在派发阶段（下载、安装中），之后可以自己调用 {@link started}。
	 */
	async nextAssign(options: { timeoutMs?: number; start?: boolean } = {}): Promise<AssignedTask> {
		const message = await this.next("assign", options);
		const assign = message.body.value as AssignTask;
		this.#held.set(keyOf(assign), { taskId: assign.taskId, attempt: assign.attempt });
		if (options.start ?? true) await this.started(assign);
		return { ...assign, inputs: JSON.parse(assign.inputsJson) as Record<string, unknown> };
	}

	/** 断言在一段时间内没有收到新的任务派发。 */
	async expectNoAssign(withinMs = 200): Promise<void> {
		const assign = await this.nextAssign({ timeoutMs: withinMs }).catch(() => undefined);
		if (assign) {
			throw new Error(
				`agent ${this.name}: unexpected assign of ${assign.package}/${assign.node} (${assign.nodeId})`,
			);
		}
	}

	/** 等待下一条取消指令（#12）。 */
	async nextCancel(options: { timeoutMs?: number } = {}): Promise<CancelTask> {
		const message = await this.next("cancel", options);
		return message.body.value as CancelTask;
	}

	/** 断言在一段时间内没有收到新的取消指令。 */
	async expectNoCancel(withinMs = 200): Promise<void> {
		const cancel = await this.nextCancel({ timeoutMs: withinMs }).catch(() => undefined);
		if (cancel) {
			throw new Error(
				`agent ${this.name}: unexpected cancel of ${cancel.taskId} (force=${cancel.force})`,
			);
		}
	}

	/** 上报任务已被取消（收到 CancelTask 后终止），等待 Ack。 */
	cancelled(task: TaskRef, message = "任务已取消"): Promise<Ack> {
		return this.report({
			taskId: task.taskId,
			attempt: task.attempt,
			status: TaskStatus.CANCELLED,
			error: { kind: ErrorKind.UNSPECIFIED, message },
		});
	}

	/** 上报任务成功，等待 Ack。 */
	succeed(task: TaskRef, outputs: Record<string, unknown> = {}): Promise<Ack> {
		return this.report({
			taskId: task.taskId,
			attempt: task.attempt,
			status: TaskStatus.SUCCESS,
			outputsJson: JSON.stringify(outputs),
		});
	}

	/** 上报任务失败，等待 Ack。 */
	fail(task: TaskRef, message = "boom", kind: ErrorKind = ErrorKind.NODE_ERROR): Promise<Ack> {
		return this.report({
			taskId: task.taskId,
			attempt: task.attempt,
			status: TaskStatus.FAILED,
			error: { kind, message },
		});
	}

	/** 发送一批日志（#10）：每行 `[seq, text]` 或完整的 LogLine 字段；控制面不回 Ack。 */
	logs(task: TaskRef, lines: Array<[number, string] | LogLineInit>): void {
		this.send({
			case: "logs",
			value: {
				taskId: task.taskId,
				attempt: task.attempt,
				lines: lines.map((line) =>
					Array.isArray(line)
						? {
								seq: BigInt(line[0]),
								timeUnixMs: BigInt(Date.UTC(2026, 0, 1)),
								source: LogSource.STDOUT,
								level: LogLevel.INFO,
								text: line[1],
							}
						: line,
				),
			},
		});
	}

	/** 上报任务进度（#10）；控制面不回 Ack。 */
	progress(task: TaskRef, current: number, total?: number, message = ""): void {
		this.send({
			case: "progress",
			value: {
				taskId: task.taskId,
				attempt: task.attempt,
				current,
				total,
				message,
				timeUnixMs: BigInt(Date.UTC(2026, 0, 1, 0, 0, 1)),
			},
		});
	}

	/**
	 * 上报一批指标点（#29）：每个点 `[指标名, Unix 秒, 值]`（最小值、最大值与值相同）或完整的 MetricPoint 字段；
	 * `droppedPoints` 是 Agent 断线排队时丢弃的点数。控制面不回 Ack。
	 */
	metrics(
		task: TaskRef,
		points: Array<[string, number, number] | MetricPointInit>,
		droppedPoints = 0,
	): void {
		this.send({
			case: "metrics",
			value: {
				taskId: task.taskId,
				attempt: task.attempt,
				droppedPoints: BigInt(droppedPoints),
				points: points.map((p) =>
					Array.isArray(p)
						? { name: p[0], timeUnixS: BigInt(p[1]), value: p[2], min: p[2], max: p[2] }
						: p,
				),
			},
		});
	}

	/** 上报任意 TaskResult，等待对应的 Ack（task_id + attempt 相同）。 */
	async report(result: TaskResultInit): Promise<Ack> {
		this.send({ case: "result", value: result });
		const ackFor = (m: ServerMessage) =>
			m.body.case === "ack" &&
			m.body.value.taskId === result.taskId &&
			m.body.value.attempt === result.attempt;
		const message = await this.#nextMatching(ackFor, `ack for ${result.taskId}`, 5000);
		this.#held.delete(keyOf({ taskId: result.taskId ?? "", attempt: result.attempt ?? 0 }));
		return message.body.value as Ack;
	}

	/** 流是否已结束（被控制面关闭或断开）。 */
	get ended(): boolean {
		return this.#ended;
	}

	/** 正常关闭：结束请求流并等待响应流结束。 */
	async close(): Promise<void> {
		this.#outbox.end();
		await this.#closed;
	}

	/** 模拟断线：直接中断连接。 */
	async disconnect(): Promise<void> {
		this.#abort.abort();
		await this.#closed;
	}

	/** 按等待顺序给每个等待者分配第一条匹配且未被消费的消息；流结束时拒绝剩下的等待者。 */
	#dispatch(): void {
		const pending: Waiter[] = [];
		for (const waiter of this.#waiters) {
			let found = -1;
			for (let i = 0; i < this.received.length; i++) {
				if (!this.#consumed.has(i) && waiter.predicate(this.received[i] as ServerMessage)) {
					found = i;
					break;
				}
			}
			if (found >= 0) {
				this.#consumed.add(found);
				waiter.resolve(this.received[found] as ServerMessage);
			} else if (this.#ended) {
				waiter.reject(this.#error ?? new Error("stream ended"));
			} else {
				pending.push(waiter);
			}
		}
		this.#waiters = pending;
	}
}
