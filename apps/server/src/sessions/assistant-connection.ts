import type { AssistantStreamHello, AssistantStreamRecord } from "@sfly/schema";
import type { AssistantClient } from "./assistant-client.js";
import {
	type AssistantSource,
	type DropReason,
	isPersistedType,
	SessionNotFoundError,
	type SessionStore,
} from "./session-store.js";

/** 事件连接的 `hello` 说助手服务重启了、或者断得太久错过了事件时，对在做的会话要做的事（会话服务做）。 */
export interface AssistantRecovery {
	/** 助手服务重启了：连接断开那一刻在做的会话（会话 → 轮次，不知道时是 undefined）这一轮以 `interrupted` 结束。 */
	restarted(candidates: ReadonlyMap<string, number> | undefined): Promise<unknown>;
	/** 纪元相同、断得太久、事件补不回来：在做的会话各写一条 `events_lost` 的提示。 */
	eventsLost(): Promise<unknown>;
	/**
	 * `hello` 处理完、事件连接标成连着**之后**调用（每次连上都调，包括控制面刚启动的第一次）：这之前新的一轮因为事件流没连上被挡着
	 * （`SessionService` 的就绪状态），重启补结局、控制面启动时排队的会话的开始都发生在连上之前，被挡掉了，在这里补开始；
	 * 也让会话服务记下连上的时刻（兜底的 30 分钟从它算起）。出错只记日志，不影响连接。
	 */
	connected(): Promise<unknown>;
}

export interface AssistantConnectionOptions {
	client: AssistantClient;
	sessions: SessionStore;
	/** 不给时 `hello` 只用来记下纪元，不对在做的会话做什么（不处理重启和缺口）。 */
	recovery?: AssistantRecovery;
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
 * **断线之后续传**（#545，协议见 `@sfly/schema` 的 `AssistantEventsQuery`）：连上时带着最后收到的那条持久事件的位置（纪元加助手服务内的序号）；
 * 第一次连接用库里最后一条助手事件的位置（`SessionStore.lastAssistantSource`），之后用内存里的。助手服务把它之后的持久事件补发过来，
 * 补发的和已经在库里的同一个位置的事件不存两次（`appendFromAssistant` 的 `source`）。不持久的事件（增量……）错过了就是错过了，由事件流的
 * 快照补上。第一行 `hello`：
 * - **纪元和记着的不同**（助手服务重启了）：先查库里有没有这个纪元的事件——有，说明记着的位置不是最后收到的那条（`lastAssistantSource`
 *   按助手服务盖的事件时间找，两个容器的时钟偏差会让它找到旧纪元），那就是找错了位置：改用这个纪元在库里的最大序号，断开重连补回缺的，
 *   不当成重启；没有才是助手服务重启了：连接断开那一刻在做的会话以 `interrupted` 结束（{@link AssistantRecovery.restarted}），
 *   之后的位置是新纪元的 0；
 * - **纪元相同、`gap` 为真**（断开太久，事件被挤出缓冲）：在做的会话各写一条 `events_lost`（{@link AssistantRecovery.eventsLost}）。
 *
 * **连不上期间什么都不判**：会话保持原状态（这一轮可能还在做，只是网络断了），{@link AssistantConnection.connected} 说连着没有，
 * 兜底的 `expireStale` 看它；就绪状态和新的一轮也看它（事件流没连上时不开始新的一轮，`SessionService`）。每次 `hello` 处理完、标成连着之后
 * 调 {@link AssistantRecovery.connected}，补开始这期间被挡着的排队的会话。
 */
export class AssistantConnection {
	readonly #abort = new AbortController();
	#done: Promise<void> | undefined;
	#wake: (() => void) | undefined;
	/** 最后收到的那条持久事件的位置（带着它连上助手服务续传）；不知道（库里没有助手事件）时是 undefined。 */
	#position: AssistantSource | undefined;
	#positionLoaded = false;
	/** 已经为这个位置写过 `events_lost`：反复重连、位置没动时不重复写。 */
	#lostFor: string | undefined;
	/** 事件连接此刻连着（收到了 `hello`、`hello` 的处理做完了）。 */
	#connected = false;
	/**
	 * 连接断开那一刻（控制面启动、第一次连接之前也算）在做的会话：会话 → 轮次。助手服务重启之后，只有它们这一轮被打断了；
	 * 连接断开之后才开始的一轮是在新的助手服务上开始的，不是被打断的。不知道（读库出错）时是 undefined。
	 */
	#candidates: Map<string, number> | undefined;
	/** 已经记过日志的不持久事件的丢弃（会话:轮次:原因），不让一轮迟到的几百条增量刷屏。 */
	readonly #loggedDrops = new Set<string>();

	constructor(private readonly options: AssistantConnectionOptions) {}

	/**
	 * 事件连接此刻连着没有：收到了 `hello` 并处理完，到连接断开之间是 true。会话服务据此在连不上期间不把在做的会话判成中断
	 * （`SessionServiceDeps.assistantConnected`）。
	 */
	get connected(): boolean {
		return this.#connected;
	}

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
		// 第一次连接之前先记下此刻在做的会话：之后才开始的一轮不算助手服务重启时被打断的（见 `#candidates`）。
		await this.#snapshotRunning();
		while (!this.#abort.signal.aborted) {
			let reposition = false;
			try {
				let first = true;
				const after = await this.#after();
				const lines = this.options.client.events(
					this.#abort.signal,
					(reason) => this.options.log(`助手服务的事件流里有一行不是约定的形状，已跳过：${reason}`),
					after,
				);
				for await (const line of lines) {
					if (first) {
						first = false;
						wait = minMs;
					}
					if ("type" in line) {
						if (line.type === "hello" && (await this.#hello(line)) === "reconnect") {
							// 位置改过了：断开，带新的位置重连（补回库里这个纪元最后一条之后的）。
							reposition = true;
							break;
						}
						continue; // 心跳
					}
					await this.#handle(line);
				}
				if (!this.#abort.signal.aborted && !reposition) {
					this.options.log("助手服务的事件流结束了，重新连接");
				}
			} catch (error) {
				if (this.#abort.signal.aborted) break;
				this.options.log(`助手服务的事件流出错，${wait} 毫秒后重新连接`, error);
			}
			// 连着变成连不上的这一刻记下在做的会话；一直连不上时不重复记（那样连接断开之后才开始的一轮也被记进去了）。
			if (this.#connected) {
				this.#connected = false;
				await this.#snapshotRunning();
			}
			await this.#sleep(wait);
			wait = Math.min(wait * 2, maxMs);
		}
	}

	/** 连上助手服务时带的 `after`：内存里最后收到的位置，第一次是库里最后一条助手事件的位置。 */
	async #after(): Promise<AssistantSource | undefined> {
		if (!this.#positionLoaded) {
			this.#position = await this.options.sessions.lastAssistantSource();
			this.#positionLoaded = true;
		}
		return this.#position;
	}

	async #snapshotRunning(): Promise<void> {
		try {
			this.#candidates = await this.options.sessions.runningTurns();
		} catch (error) {
			this.#candidates = undefined;
			this.options.log("读不到在做的会话，助手服务重启时这些会话的中断留给兜底", error);
		}
	}

	/**
	 * 事件流的第一行：纪元变了（助手服务重启了）或者有缺口时，处理在做的会话，再记下新的位置。返回 `"reconnect"` 表示位置改过了、要断开
	 * 重连（不标成连着）。
	 */
	async #hello(hello: AssistantStreamHello): Promise<"ok" | "reconnect"> {
		const known = this.#position?.epoch;
		const { recovery, sessions } = this.options;
		if (known !== undefined && hello.epoch !== known) {
			// 库里已经有这个纪元的事件：记着的位置是找错的（时钟偏差），不是助手服务重启了。
			const last = await sessions.lastSeqOfEpoch(hello.epoch);
			if (last !== undefined) {
				this.options.log(
					`库里记着的最后一条助手事件在旧纪元（${known}），而这个纪元（${hello.epoch}）在库里已经有事件：改用它的位置重连，不当成助手服务重启`,
				);
				this.#position = { epoch: hello.epoch, seq: last };
				return "reconnect";
			}
			this.options.log(`助手服务重启了（纪元 ${known} → ${hello.epoch}）：在做的会话按中断处理`);
			await recovery?.restarted(this.#candidates);
			this.#position = { epoch: hello.epoch, seq: 0 };
			this.#lostFor = undefined;
		} else if (known === undefined) {
			// 第一次见到助手服务（库里没有助手事件）：不知道有没有错过什么，从现在起记。
			this.#position = { epoch: hello.epoch, seq: 0 };
		} else if (hello.gap) {
			const at = `${known}:${this.#position?.seq}`;
			if (this.#lostFor !== at) {
				this.options.log(
					"控制面和助手服务断开太久，一部分事件补不回来，在做的会话各记一条 events_lost",
				);
				await recovery?.eventsLost();
				this.#lostFor = at;
			}
		}
		this.#candidates = undefined;
		this.#connected = true;
		// 标成连着之后：补开始这期间被挡着的排队的会话（重启补结局触发的开始发生在标成连着之前，被挡掉了）。
		try {
			await recovery?.connected();
		} catch (error) {
			this.options.log("事件连接连上之后开始排队的会话失败", error);
		}
		return "ok";
	}

	/**
	 * 一条助手服务发来的记录：**落库或发布之前先核对**——会话存在、在做、记录里的 `turn` 是会话此刻在做的那一轮，
	 * `turn_end` 的轮次和记录的轮次一致；不符合的（上一轮迟到的事件、空闲或已结束的会话收到的事件）不落库、不推给
	 * 浏览器、不改状态，记一条日志（会话、轮次、事件类型，不含内容）。只该由控制面产生的事件（用户的话、一轮开始、
	 * 会话结束……，和 `platform` 的 `run`、`scenario_version`：控制面在记下那条记录的事务里自己写）不在 `AssistantEvent` 里，
	 * 整行过不了 schema，在 `AssistantClient.events` 就跳过了。助手服务发的 `platform`（`commit`，一轮结束时工作区的提交，#546）
	 * 在里面，照别的持久事件落库、发布：它的 `turn` 是提交属于第几轮，被打断那一轮的补提交在下一轮的事件流里发出，所以
	 * 事件里的 `turn` 可以比记录的 `turn` 小，核对的是记录的 `turn`。
	 */
	async #handle(record: AssistantStreamRecord): Promise<void> {
		const { sessions, log } = this.options;
		const { event, session_id: sessionId, turn } = record;
		if (event.type === "turn_end" && event.turn !== turn) {
			this.#dropped("turn_mismatch", record);
			this.#advance(record);
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
				record.seq === undefined ? undefined : { epoch: record.epoch, seq: record.seq },
			);
			// 重复的（补发已经收过的）什么也不做：已经在库里了。
			if ("dropped" in result) this.#dropped(result.dropped, record);
		} catch (error) {
			if (error instanceof SessionNotFoundError) {
				this.#dropped("unknown_session", record);
				// 丢弃的也算处理过：重连不再补发它、不再记第二遍日志（和下面的 `#advance` 一致）。
				this.#advance(record);
				return;
			}
			// 写库出错：这条事件丢了，连接继续（后面的事件照常处理）。
			log(
				`助手服务的事件落库失败，已丢弃（会话 ${sessionId}，轮次 ${turn}，${event.type}）`,
				error,
			);
		}
		this.#advance(record);
	}

	/** 这条持久事件处理过了（存了、丢弃了、重复的都算）：下次重连从它之后续传。 */
	#advance(record: AssistantStreamRecord): void {
		if (record.seq === undefined) return;
		this.#position = { epoch: record.epoch, seq: record.seq };
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
