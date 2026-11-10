import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { type Client, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import {
	type Ack,
	AgentGateway,
	type AgentMessage,
	AgentMessageSchema,
	AgentUpdateState,
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
import packageJson from "../../package.json" with { type: "json" };

/**
 * 假 Agent 默认上报的版本：控制面的默认版本（package.json）。版本与控制面不一致的 Agent 不会被派任务（ADR 0014），
 * 控制面用 `version` 覆盖了版本号的测试要自己传 `agentVersion`。
 */
export const DEFAULT_AGENT_VERSION = packageJson.version;

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
export { AgentUpdateState, ErrorKind, TaskStatus };

/** Hello / Heartbeat / TaskStarted / TaskResult 里的时钟字段：Agent 时间和单调时钟读数。 */
export interface AgentClockInit {
	agentTimeUnixMs: bigint;
	monotonicMs: bigint;
}

/**
 * 任意的 Agent 时间（Date、ISO 字符串或 Unix 毫秒）加单调时钟读数（毫秒），展开进 Hello 或传给
 * {@link FakeAgent.heartbeat}：`FakeAgent.connect(url, { name, ...agentClock("2027-09-06T00:00:00Z", 5_000) })`。
 * 任务开始和结束时的读数传给 {@link FakeAgent.started}、`nextAssign({ clock })`、`succeed` / `fail` / `cancelled`。
 * 不带它的消息相当于旧版本 Agent（两个字段都是 0）。
 */
export function agentClock(agentTime: Date | string | number, monotonicMs: number): AgentClockInit {
	return {
		agentTimeUnixMs: BigInt(new Date(agentTime).getTime()),
		monotonicMs: BigInt(monotonicMs),
	};
}

/** {@link FakeAgent.connect} 的 `clock` 选项用的单调时钟读数起点（毫秒）：足够大，早于连接的时刻也折算得出正的读数。 */
const SYNCED_MONOTONIC_MS = 1_000_000_000_000;

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

	/**
	 * 连接网关，发送 Hello，等待 Welcome 后返回。
	 *
	 * `clock` 传控制面的时钟（测试里的手动时钟）时，这是一台时钟与控制面一致的新版本 Agent：Hello 带上 Agent 时间
	 * 和单调时钟读数，之后 {@link FakeAgent.metrics} 的点自动带上与它的 Unix 秒对应的单调时钟读数，
	 * 所以点的控制面时间就是给出的 Unix 秒（{@link FakeAgent.monotonicAt}）。不传时相当于旧版本 Agent。
	 */
	static async connect(
		grpcUrl: string,
		hello: HelloInit,
		options: { timeoutMs?: number; clock?: { now(): Date } } = {},
	): Promise<FakeAgent> {
		const now = options.clock?.now().getTime();
		const agent = await FakeAgent.connectRaw(
			grpcUrl,
			(agent) =>
				agent.send({
					case: "hello",
					value: {
						agentVersion: DEFAULT_AGENT_VERSION,
						...(now === undefined ? {} : agentClock(now, SYNCED_MONOTONIC_MS)),
						...hello,
					},
				}),
			{ ...options, name: hello.name },
		);
		// hello 里自己写了单调时钟读数时按它对应（Agent 时间可以另写，与控制面不一致）。
		if (now !== undefined) {
			agent.#monotonicShiftMs = Number(hello.monotonicMs ?? SYNCED_MONOTONIC_MS) - now;
		}
		return agent;
	}

	/** 单调时钟读数 − 控制面时间（毫秒）；只有用 `clock` 选项连接的才有。 */
	#monotonicShiftMs: number | undefined;

	/**
	 * 控制面时间为 `unixMs` 的时刻在这台 Agent 上的单调时钟读数（毫秒）。只有用 `clock` 选项连接的 Agent 才能用。
	 */
	monotonicAt(unixMs: number): bigint {
		if (this.#monotonicShiftMs === undefined) {
			throw new Error(`agent ${this.name}: 没有用 clock 选项连接，没有单调时钟读数`);
		}
		return BigInt(unixMs + this.#monotonicShiftMs);
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
	 * `clock`（{@link agentClock}）是心跳带的 Agent 时间和单调时钟读数，不传时相当于旧版本 Agent。
	 */
	async heartbeat(tasks: TaskRef[] = this.held, clock?: AgentClockInit): Promise<void> {
		this.send({
			case: "heartbeat",
			value: {
				...clock,
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

	/**
	 * 上报 TaskStarted（执行器已启动：任务从派发阶段进入 running），并等到控制面处理完它。
	 * `clock`（{@link agentClock}）是执行器启动时的 Agent 时间和单调时钟读数，不传时相当于旧版本 Agent。
	 */
	async started(task: TaskRef, clock?: AgentClockInit): Promise<void> {
		this.#started.add(keyOf(task));
		this.send({
			case: "started",
			value: { ...clock, taskId: task.taskId, attempt: task.attempt },
		});
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
	 * `clock` 是这条 TaskStarted 带的时钟读数。
	 */
	async nextAssign(
		options: { timeoutMs?: number; start?: boolean; clock?: AgentClockInit } = {},
	): Promise<AssignedTask> {
		const message = await this.next("assign", options);
		const assign = message.body.value as AssignTask;
		this.#held.set(keyOf(assign), { taskId: assign.taskId, attempt: assign.attempt });
		if (options.start ?? true) await this.started(assign, options.clock);
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

	/** 上报任务已被取消（收到 CancelTask 后终止），等待 Ack。`clock` 是任务结束时的时钟读数（下同）。 */
	cancelled(task: TaskRef, message = "任务已取消", clock?: AgentClockInit): Promise<Ack> {
		return this.report({
			...clock,
			taskId: task.taskId,
			attempt: task.attempt,
			status: TaskStatus.CANCELLED,
			error: { kind: ErrorKind.UNSPECIFIED, message },
		});
	}

	/** 上报任务成功，等待 Ack。 */
	succeed(
		task: TaskRef,
		outputs: Record<string, unknown> = {},
		clock?: AgentClockInit,
	): Promise<Ack> {
		return this.report({
			...clock,
			taskId: task.taskId,
			attempt: task.attempt,
			status: TaskStatus.SUCCESS,
			outputsJson: JSON.stringify(outputs),
		});
	}

	/** 上报任务失败，等待 Ack。 */
	fail(
		task: TaskRef,
		message = "boom",
		kind: ErrorKind = ErrorKind.NODE_ERROR,
		clock?: AgentClockInit,
	): Promise<Ack> {
		return this.report({
			...clock,
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
	 *
	 * 用 `clock` 选项连接的 Agent（{@link FakeAgent.connect}）：没有写 `monotonicMs` 的点自动带上与它的 Unix 秒
	 * 对应的读数，也就是 Agent 时间与控制面时间一致。要让两者不同，自己写 `monotonicMs`（{@link FakeAgent.monotonicAt}）。
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
				points: points.map((p) => {
					const point: MetricPointInit = Array.isArray(p)
						? { name: p[0], timeUnixS: BigInt(p[1]), value: p[2], min: p[2], max: p[2] }
						: p;
					if (this.#monotonicShiftMs === undefined || point.monotonicMs !== undefined) return point;
					return {
						...point,
						monotonicMs: this.monotonicAt(Number(point.timeUnixS ?? 0n) * 1000),
					};
				}),
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
