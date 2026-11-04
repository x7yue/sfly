import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { type Client, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import {
	AgentGateway,
	type AgentMessage,
	AgentMessageSchema,
	type HelloSchema,
	type ServerMessage,
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
 * 后续票据在这里加上自动应答任务的行为（成功/失败/延迟等）。
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
		const transport = createGrpcTransport({ baseUrl: grpcUrl });
		const agent = new FakeAgent(hello.name, createClient(AgentGateway, transport));
		agent.send({ case: "hello", value: { agentVersion: "fake", ...hello } });
		await agent.next("welcome", options);
		return agent;
	}

	send(body: MessageInitShape<typeof AgentMessageSchema>["body"]): void {
		this.#outbox.push(create(AgentMessageSchema, { body }));
	}

	/** 等待下一条（尚未被 next 消费过的）指定类型的消息。 */
	next(kind?: ServerMessageCase, options: { timeoutMs?: number } = {}): Promise<ServerMessage> {
		const predicate = (m: ServerMessage) => kind === undefined || m.body.case === kind;
		const timeoutMs = options.timeoutMs ?? 5000;
		return new Promise<ServerMessage>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#waiters = this.#waiters.filter((w) => w !== waiter);
				reject(
					new Error(`agent ${this.name}: no '${kind ?? "any"}' message within ${timeoutMs}ms`),
				);
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

	#dispatch(): void {
		while (this.#waiters.length > 0) {
			const waiter = this.#waiters[0] as Waiter;
			let found = -1;
			for (let i = 0; i < this.received.length; i++) {
				if (!this.#consumed.has(i) && waiter.predicate(this.received[i] as ServerMessage)) {
					found = i;
					break;
				}
			}
			if (found < 0) {
				if (this.#ended) waiter.reject(this.#error ?? new Error("stream ended"));
				else return;
			} else {
				this.#consumed.add(found);
				waiter.resolve(this.received[found] as ServerMessage);
			}
			this.#waiters.shift();
		}
	}
}
