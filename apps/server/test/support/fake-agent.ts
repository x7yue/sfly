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
	type ServerMessage,
	TaskStatus,
} from "@sfly/proto";

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

	/** 等待下一个派发给本 Agent 的任务。 */
	async nextAssign(options: { timeoutMs?: number } = {}): Promise<AssignedTask> {
		const message = await this.next("assign", options);
		const assign = message.body.value as AssignTask;
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

	/** 上报任意 TaskResult，等待对应的 Ack（task_id + attempt 相同）。 */
	async report(result: TaskResultInit): Promise<Ack> {
		this.send({ case: "result", value: result });
		const ackFor = (m: ServerMessage) =>
			m.body.case === "ack" &&
			m.body.value.taskId === result.taskId &&
			m.body.value.attempt === result.attempt;
		const message = await this.#nextMatching(ackFor, `ack for ${result.taskId}`, 5000);
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
