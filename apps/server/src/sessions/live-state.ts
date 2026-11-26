import {
	type RunningTool,
	SESSION_EVENT_LIMITS,
	type SessionEvent,
	type SessionTool,
	type SteerEntry,
} from "@sfly/schema";
import { maskSessionTokens } from "./session-tokens.js";

// 会话此刻在内存里的现场（#545 的快照，`SnapshotEvent`）：增量不持久，刚连上（或断线后重连）的页面没有见过的那一段靠它补上。
// 只放内存：控制面重启后是空的，到下一条持久事件才恢复正常（接受，#545）。一轮结束、会话结束时清掉。
//
// **文字在这里打码，不靠推送时那一道**：推送出去的每条增量在 `SessionStore.publishFromAssistant` 里逐条按令牌的格式打过码，
// 逐条打码认不出被拆在两条增量里的令牌（`sfly_ses_` 在上一条的末尾，后面的字符在下一条）。快照不能照搬逐条打码的结果拼起来，所以这里累积的是
// **通过了控制面校验（会话在做、轮次对）、还没有打码的原文**，发出之前**整段**过一次 `maskSessionTokens`：拼回来的令牌认得出，
// 而且先打码、后截断（见 {@link TailText}）。**累积的原文只在内存里，不落库、不进日志；发出去的只有打过码的。**

/** 窗口比上限多留的字符数：打码把一个令牌换成一个掩码会让文字变短，多留一些，打码之后仍能凑够上限。 */
const TAIL_MARGIN = 1024;
/**
 * 窗口开头可能是被削掉前半截的令牌：令牌固定 57 个字符（`sfly_ses_` 加 48 个十六进制字符），开头的半截最多 56 个字符，全是令牌的字符
 * （字母、数字、`_`、`-`）。削掉窗口开头这一段令牌字符，上限留有余量；比这更长的一串不是令牌的半截（是令牌后面又连着的普通字符），
 * 留着不碍事。
 */
const FRAGMENT_MAX = 128;
const LEADING_FRAGMENT = new RegExp(`^[A-Za-z0-9_-]{1,${FRAGMENT_MAX}}`);

/** 文字最后的至多 `limit` 个 UTF-8 字节，不切开字符（开头落在一个字符中间时，这个字符整个不要）。 */
export function tailBytes(text: string, limit: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= limit) return text;
	let start = bytes.length - limit;
	// UTF-8 的后续字节是 10xxxxxx：落在字符中间就往后挪到下一个字符的开头。
	while (start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

/**
 * 一段不断追加的文字，只留最后的 `limit` 个字节（工具输出的最后一段）。**先打码、后截断**：
 * - 内存里留的是最后 `limit + TAIL_MARGIN` 个字符的原文（不是 `limit` 个字节：原文是为了发出去时再整段打码，见文件开头）；
 * - 读的时候先削掉窗口开头可能是令牌前半截的一段（窗口是从原文中间截的才削；{@link FRAGMENT_MAX}），再整段按令牌的格式打码，
 *   最后才按字节截到 `limit`：令牌跨在窗口开头的边界上，开头的半截被削掉，不会留下半截原值；打码之后令牌已经是掩码，
 *   最后一步的截断不会落在令牌中间。
 * 打码的规矩和 `maskSessionTokens` 一样，只看文字里有没有完整的令牌格式，和令牌是不是真的无关（#529）。
 */
export class TailText {
	#text = "";
	/** 窗口的开头不是原文的开头（前面削掉过东西）。 */
	#cut = false;
	readonly #window: number;

	constructor(private readonly limit: number) {
		this.#window = limit + TAIL_MARGIN;
	}

	append(text: string): void {
		this.#text += text;
		// 超过两倍窗口才削一次（不在每条增量上复制整个窗口）。
		if (this.#text.length > this.#window * 2) {
			this.#text = this.#text.slice(-this.#window);
			this.#cut = true;
		}
	}

	/** 最后一段，打过码，至多 `limit` 个字节。 */
	read(): string {
		let text = this.#text;
		let cut = this.#cut;
		if (text.length > this.#window) {
			text = text.slice(-this.#window);
			cut = true;
		}
		if (cut) {
			// 切在代理对中间时开头是落单的低位代理，不要；再削掉开头可能是令牌前半截的一段。
			if (/^[\udc00-\udfff]/.test(text)) text = text.slice(1);
			text = text.replace(LEADING_FRAGMENT, "");
		}
		return tailBytes(maskSessionTokens(text), this.limit);
	}
}

/** 正在跑的一次工具调用。 */
interface LiveTool {
	callId: string;
	tool: SessionTool;
	title: string;
	output: TailText;
}

interface LiveEntry {
	/** 上一条持久的助手消息之后收到的增量文字（原文）。 */
	partial: string;
	tool: LiveTool | null;
	/** 最近一份还没送到模型的插话。 */
	steerQueue: readonly SteerEntry[];
}

/** 快照里来自内存的那几项（`status`、排队的位置和在等谁来自库，见 `SessionStore.follow`）。 */
export interface LiveParts {
	partial_text: string;
	running_tool: RunningTool | null;
	steer_queue: SteerEntry[];
}

/**
 * 每个会话的现场：上一条持久的助手消息之后的增量文字、正在跑的工具调用和它输出的最后一段、最新的插话队列。
 * `SessionStore` 每发布一条事件之前调用 {@link LiveStates.apply}（持久的和不持久的都经过那一个出口），
 * 所以这里和推给订阅者的事件是同一个先后，补发读完切到实时的那一刻读它，就是「到这一刻为止收到的全部」。
 * 累积用的只有**已经过了控制面校验**（会话在做、轮次对）的事件：被丢掉的事件到不了这里。
 */
export class LiveStates {
	readonly #entries = new Map<string, LiveEntry>();

	/** 内存里有现场的会话数（测试验证清空用）。 */
	get size(): number {
		return this.#entries.size;
	}

	/**
	 * 一条事件要发布了：更新这个会话的现场。`rawText` 是文字增量（`assistant_delta`）和工具输出（`tool_output`）**打码之前**的原文，
	 * 没有时用事件里的文字（持久的事件、不经过逐条打码的来源）。
	 */
	apply(sessionId: string, event: SessionEvent, rawText?: string): void {
		switch (event.type) {
			case "turn_started":
			case "turn_end":
			case "session_ended":
				// 一轮开始前、结束时、会话结束：这一轮的现场不再有意义。
				this.#entries.delete(sessionId);
				return;
			case "assistant_message": {
				// 整条消息到了：它取代之前的增量。
				const entry = this.#entries.get(sessionId);
				if (!entry) return;
				entry.partial = "";
				this.#drop(sessionId, entry);
				return;
			}
			case "assistant_delta":
				this.#entry(sessionId).partial += rawText ?? event.text;
				return;
			case "tool_call":
				this.#entry(sessionId).tool = {
					callId: event.call_id,
					tool: event.tool,
					title: event.title,
					output: new TailText(SESSION_EVENT_LIMITS.runningToolOutputBytes),
				};
				return;
			case "tool_output": {
				// 不是正在跑的那个调用的输出（控制面重启后没有见过它的 `tool_call`，或者另一个调用已经开始）：不认。
				const tool = this.#entries.get(sessionId)?.tool;
				if (tool?.callId === event.call_id) tool.output.append(rawText ?? event.text);
				return;
			}
			case "tool_result": {
				const entry = this.#entries.get(sessionId);
				if (entry?.tool?.callId !== event.call_id) return;
				entry.tool = null;
				this.#drop(sessionId, entry);
				return;
			}
			case "steer_queue": {
				const entry = this.#entry(sessionId);
				entry.steerQueue = event.messages.map((message) => ({ ...message }));
				this.#drop(sessionId, entry);
				return;
			}
			default:
				return;
		}
	}

	/** 这个会话现在的现场，文字都打过码（整段按令牌的格式打码，输出再按字节截到上限）；没有时都是空的。 */
	parts(sessionId: string): LiveParts {
		const entry = this.#entries.get(sessionId);
		if (!entry) return { partial_text: "", running_tool: null, steer_queue: [] };
		return {
			partial_text: maskSessionTokens(entry.partial),
			running_tool: entry.tool && {
				call_id: entry.tool.callId,
				tool: entry.tool.tool,
				title: entry.tool.title,
				output: entry.tool.output.read(),
			},
			steer_queue: entry.steerQueue.map((message) => ({ ...message })),
		};
	}

	/** 清掉一个会话的现场（会话被删）。 */
	clear(sessionId: string): void {
		this.#entries.delete(sessionId);
	}

	#entry(sessionId: string): LiveEntry {
		let entry = this.#entries.get(sessionId);
		if (!entry) {
			entry = { partial: "", tool: null, steerQueue: [] };
			this.#entries.set(sessionId, entry);
		}
		return entry;
	}

	/** 什么都没有了就不留这一项（内存里不为每个会话留一条空的）。 */
	#drop(sessionId: string, entry: LiveEntry): void {
		if (entry.partial === "" && entry.tool === null && entry.steerQueue.length === 0) {
			this.#entries.delete(sessionId);
		}
	}
}
