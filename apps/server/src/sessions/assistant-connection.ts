import type { AssistantStreamRecord } from "@sfly/schema";
import type { AssistantClient } from "./assistant-client.js";
import { isPersistedType, SessionNotFoundError, type SessionStore } from "./session-store.js";

export interface AssistantConnectionOptions {
	client: AssistantClient;
	sessions: SessionStore;
	/** 出了问题（连不上、断了、丢弃的事件、不是约定形状的行）：记日志。 */
	log: (message: string, error?: unknown) => void;
	/** 重连的等待：第一次出错等 `minMs`，之后每次翻倍，到 `maxMs` 为止；连上并收到第一行之后重新从 `minMs` 起。 */
	reconnect?: { minMs: number; maxMs: number };
}

const DEFAULT_RECONNECT = { minMs: 1000, maxMs: 30_000 };

/**
 * 控制面和助手服务的事件连接（协议里的 `GET /events`）：控制面启动时（配置了助手服务的话）打开它，断了按退避重连。
 * 收到的记录依次处理：持久的事件按会话落库（时间用助手服务盖的）并发布，不持久的只发布；会话不存在的（控制面不认识的
 * 会话 ID）记一条日志丢掉。一轮结束（`turn_end`）时会话回到空闲，和这条事件在同一个事务里（`SessionStore.append`）。
 *
 * 断线期间助手服务产生的事件丢掉：续传、纪元变化的处理、助手服务重启之后的中断是 #545。
 */
export class AssistantConnection {
	readonly #abort = new AbortController();
	#done: Promise<void> | undefined;
	#wake: (() => void) | undefined;

	constructor(private readonly options: AssistantConnectionOptions) {}

	/** 开始连接（立即返回，连接在后台）。 */
	start(): void {
		this.#done ??= this.#run();
	}

	/** 停止连接，等后台的循环结束。 */
	async close(): Promise<void> {
		this.#abort.abort();
		this.#wake?.();
		await this.#done;
	}

	async #run(): Promise<void> {
		const { minMs, maxMs } = this.options.reconnect ?? DEFAULT_RECONNECT;
		let wait = minMs;
		while (!this.#abort.signal.aborted) {
			try {
				let first = true;
				const lines = this.options.client.events(this.#abort.signal, (reason) =>
					this.options.log(`助手服务的事件流里有一行不是约定的形状，已跳过：${reason}`),
				);
				for await (const line of lines) {
					if (first) {
						first = false;
						wait = minMs;
					}
					if ("type" in line) continue; // hello：续传和缺口的处理是 #545
					await this.#handle(line);
				}
				if (!this.#abort.signal.aborted) this.options.log("助手服务的事件流结束了，重新连接");
			} catch (error) {
				if (this.#abort.signal.aborted) break;
				this.options.log(`助手服务的事件流出错，${wait} 毫秒后重新连接`, error);
			}
			await this.#sleep(wait);
			wait = Math.min(wait * 2, maxMs);
		}
	}

	async #handle(record: AssistantStreamRecord): Promise<void> {
		const { sessions, log } = this.options;
		const { event, session_id: sessionId } = record;
		if (!isPersistedType(event.type)) {
			sessions.publish(sessionId, event);
			return;
		}
		try {
			await sessions.append(sessionId, event, new Date(record.at));
		} catch (error) {
			if (error instanceof SessionNotFoundError) {
				log(`助手服务的事件属于控制面不认识的会话 ${sessionId}，已丢弃（${event.type}）`);
				return;
			}
			// 写库出错：这条事件丢了，连接继续（后面的事件照常处理）。
			log(`助手服务的事件落库失败，已丢弃（会话 ${sessionId}，${event.type}）`, error);
		}
	}

	#sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			if (this.#abort.signal.aborted) return resolve();
			const timer = setTimeout(done, ms);
			function done() {
				clearTimeout(timer);
				resolve();
			}
			this.#wake = done;
		});
	}
}
