import type { AssistantStreamRecord } from "@sfly/schema";
import type { AssistantClient } from "./assistant-client.js";
import {
	type DropReason,
	isPersistedType,
	SessionNotFoundError,
	type SessionStore,
} from "./session-store.js";

export interface AssistantConnectionOptions {
	client: AssistantClient;
	sessions: SessionStore;
	/** 出了问题（连不上、断了、丢弃的事件、不是约定形状的行）：记日志。 */
	log: (message: string, error?: unknown) => void;
	/** 重连的等待：第一次出错等 `minMs`，之后每次翻倍，到 `maxMs` 为止；连上并收到第一行之后重新从 `minMs` 起。 */
	reconnect?: { minMs: number; maxMs: number };
}

const DEFAULT_RECONNECT = { minMs: 1000, maxMs: 30_000 };

const DROP_TEXT: Record<DropReason | "turn_mismatch", string> = {
	unknown_session: "控制面不认识这个会话",
	not_running: "会话不在做（空闲或已结束）",
	other_turn: "不是会话此刻在做的那一轮（上一轮迟到的事件）",
	turn_mismatch: "turn_end 的轮次和记录的轮次不一致",
};

/**
 * 控制面和助手服务的事件连接（协议里的 `GET /events`）：控制面启动时（配置了助手服务的话）打开它，断了按退避重连；
 * 助手服务每 15 秒写一行心跳，超过 45 秒没有收到任何字节就当连接死了、断开重连（`AssistantClient.events`）。
 * 收到的记录依次处理：持久的事件按会话落库（时间用助手服务盖的）并发布，不持久的只发布，**两者都先核对会话在做、
 * `turn` 是此刻在做的那一轮**（见 `#handle`）。一轮结束（`turn_end`）时会话回到空闲，和这条事件在同一个事务里
 * （`SessionStore.append`）。
 *
 * 断线期间助手服务产生的事件丢掉：续传、纪元变化的处理、助手服务重启之后的中断是 #545。
 */
export class AssistantConnection {
	readonly #abort = new AbortController();
	#done: Promise<void> | undefined;
	#wake: (() => void) | undefined;
	/** 已经记过日志的不持久事件的丢弃（会话:轮次:原因），不让一轮迟到的几百条增量刷屏。 */
	readonly #loggedDrops = new Set<string>();

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
					if ("type" in line) continue; // hello（续传和缺口的处理是 #545）和心跳
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

	/**
	 * 一条助手服务发来的记录：**落库或发布之前先核对**——会话存在、在做、记录里的 `turn` 是会话此刻在做的那一轮，
	 * `turn_end` 的轮次和记录的轮次一致；不符合的（上一轮迟到的事件、空闲或已结束的会话收到的事件）不落库、不推给
	 * 浏览器、不改状态，记一条日志（会话、轮次、事件类型，不含内容）。只该由控制面产生的事件（用户的话、一轮开始、
	 * 平台记录、会话结束……）不在 `AssistantEvent` 里，整行过不了 schema，在 `AssistantClient.events` 就跳过了。
	 */
	async #handle(record: AssistantStreamRecord): Promise<void> {
		const { sessions, log } = this.options;
		const { event, session_id: sessionId, turn } = record;
		if (event.type === "turn_end" && event.turn !== turn) {
			this.#dropped("turn_mismatch", record);
			return;
		}
		if (!isPersistedType(event.type)) {
			const result = await sessions.publishFromAssistant(sessionId, turn, event);
			if ("dropped" in result) this.#dropped(result.dropped, record);
			return;
		}
		try {
			const result = await sessions.appendFromAssistant(
				sessionId,
				turn,
				event,
				new Date(record.at),
			);
			if ("dropped" in result) this.#dropped(result.dropped, record);
		} catch (error) {
			if (error instanceof SessionNotFoundError) {
				this.#dropped("unknown_session", record);
				return;
			}
			// 写库出错：这条事件丢了，连接继续（后面的事件照常处理）。
			log(
				`助手服务的事件落库失败，已丢弃（会话 ${sessionId}，轮次 ${turn}，${event.type}）`,
				error,
			);
		}
	}

	/** 丢弃一条事件：持久的每条记一行；增量一类（量大）每个（会话、轮次、原因）只记第一条。 */
	#dropped(reason: DropReason | "turn_mismatch", record: AssistantStreamRecord): void {
		const { session_id: sessionId, turn, event } = record;
		if (!isPersistedType(event.type)) {
			const key = `${sessionId}:${turn}:${reason}`;
			if (this.#loggedDrops.has(key)) return;
			if (this.#loggedDrops.size >= 500) this.#loggedDrops.clear();
			this.#loggedDrops.add(key);
		}
		this.options.log(
			`助手服务的事件已丢弃：${DROP_TEXT[reason]}（会话 ${sessionId}，轮次 ${turn}，${event.type}）`,
		);
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
