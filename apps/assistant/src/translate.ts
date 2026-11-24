import {
	type AssistantEvent,
	SESSION_EVENT_LIMITS,
	type SessionTool,
	type TokenUsage,
} from "@sfly/schema";
import type { Redactor, StreamRedactor } from "./redact.js";
import { describeUpstreamError, type UpstreamError } from "./upstream-error.js";

/**
 * 把 pi 的事件（RPC 模式的 stdout，pi `docs/json.md`）翻成平台的会话事件（#538 第 3.1 节的表）。一轮一个
 * {@link TurnTranslator}：它也数这一轮的模型调用（`turn_start`）、工具调用和用量，`turn_end` 由看管这一轮的代码决定结局。
 *
 * - 工具名翻成平台的叫法（pi 的 `bash` 是 `command`）；认不出的工具不外传（`unknown`）。
 * - 文字和工具输出的增量先过保密值的打码（{@link Redactor}，一个值跨两条增量也认得出）；完整的消息、工具结果按整段打码。
 * - `assistant_message` 的文字以 pi 的 `message_end` 为准；没有文字的助手消息（只调了工具）不发。
 * - 认不出的 pi 事件返回 `unknown`，由调用方记一条日志，不抛错，不外传。
 */

type PiEvent = Record<string, unknown> & { type?: unknown };

export interface Translated {
	events: AssistantEvent[];
	/** 认不出的 pi 事件（只记日志）。 */
	unknown?: string;
	/**
	 * 上游模型出错时 pi 给的原文（没打码）：不进事件，由调用方打码后写进日志（#640）。一次模型调用失败只给一次
	 * （在它的 `message_end`）：之后的重试提示、重试用尽带的是同一段原文。
	 */
	upstreamError?: string;
	/** 压缩上下文失败时 pi 给的原文（没打码）：同上，只进日志。 */
	compactionError?: string;
}

/** pi 的工具名 → 平台的叫法（`SessionTool`）。 */
export const TOOL_NAMES: Readonly<Record<string, SessionTool>> = {
	read: "read",
	write: "write",
	edit: "edit",
	bash: "command",
};

/** 不用翻、也不用记日志的 pi 事件（平台没有对应的事件）。 */
const IGNORED = new Set([
	"response",
	"agent_start",
	"agent_end",
	"turn_end",
	"message_start",
	"queue_update",
	"entry_appended",
	"session_info_changed",
	"thinking_level_changed",
	"compaction_start",
	"summarization_retry_scheduled",
	"summarization_retry_attempt_start",
	"summarization_retry_finished",
	"extension_ui_request",
]);

export const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

export class TurnTranslator {
	/** 这一轮的模型调用次数（pi 的 `turn_start`）。 */
	modelCalls = 0;
	/** 工具调用次数（`tool_execution_end`）。 */
	steps = 0;
	usage: TokenUsage = { ...ZERO_USAGE };
	/**
	 * 最后一条助手消息是不是模型出错（`stopReason: error`）：一轮结束时据此判 `model_unavailable`。
	 * 只有助手服务自己的说法（类别、状态码），上游的原文不在这里（#640）。
	 */
	lastModelError: UpstreamError | undefined;
	/** pi 报告重试用尽（`auto_retry_end` 的 `success: false`）：最后一次的错误，同样只有自己的说法。 */
	retriesExhausted: UpstreamError | undefined;

	readonly #redactor: Redactor;
	#text: StreamRedactor | undefined;
	#thinking = false;
	readonly #outputs = new Map<string, { stream: StreamRedactor; seen: string }>();
	readonly #calls = new Map<string, SessionTool>();

	constructor(redactor: Redactor) {
		this.#redactor = redactor;
	}

	translate(event: PiEvent): Translated {
		const type = typeof event.type === "string" ? event.type : "";
		switch (type) {
			case "turn_start":
				this.modelCalls += 1;
				return { events: [] };
			case "message_update":
				return { events: this.#update(event) };
			case "message_end":
				return { events: this.#messageEnd(event), ...this.#modelError(event) };
			case "tool_execution_start":
				return { events: this.#toolStart(event) };
			case "tool_execution_update":
				return { events: this.#toolUpdate(event) };
			case "tool_execution_end":
				return { events: this.#toolEnd(event) };
			case "auto_retry_start":
				return { events: [this.#retry(event)] };
			case "auto_retry_end":
				return { events: [this.#retryEnd(event)] };
			case "compaction_end":
				return {
					events: this.#compaction(event),
					...(typeof event.errorMessage === "string" &&
						event.errorMessage !== "" && { compactionError: event.errorMessage }),
				};
			case "agent_settled":
				return { events: [] };
			default:
				if (IGNORED.has(type)) return { events: [] };
				return { events: [], unknown: type || "（没有 type）" };
		}
	}

	#update(event: PiEvent): AssistantEvent[] {
		const update = (event.assistantMessageEvent ?? {}) as Record<string, unknown>;
		switch (update.type) {
			case "thinking_start":
			case "thinking_delta":
				// 思考只说「在想」，不带内容；一段思考只发一条。
				if (this.#thinking) return [];
				this.#thinking = true;
				return [{ type: "thinking" }];
			case "text_delta": {
				this.#thinking = false;
				this.#text ??= this.#redactor.stream();
				const text = this.#text.push(String(update.delta ?? ""));
				return text ? [{ type: "assistant_delta", text }] : [];
			}
			default:
				return [];
		}
	}

	#messageEnd(event: PiEvent): AssistantEvent[] {
		const message = (event.message ?? {}) as Record<string, unknown>;
		if (message.role !== "assistant") return [];
		this.#thinking = false;
		const out: AssistantEvent[] = [];
		const rest = this.#text?.flush();
		this.#text = undefined;
		if (rest) out.push({ type: "assistant_delta", text: rest });
		const usage = usageOf(message.usage);
		this.usage = addUsage(this.usage, usage);
		this.lastModelError =
			message.stopReason === "error"
				? describeUpstreamError(String(message.errorMessage ?? ""))
				: undefined;
		const text = this.#redactor.redact(textOf(message.content));
		if (text.trim() !== "") out.push({ type: "assistant_message", text, usage });
		return out;
	}

	#toolStart(event: PiEvent): AssistantEvent[] {
		const tool = TOOL_NAMES[String(event.toolName)];
		const callId = String(event.toolCallId ?? "");
		if (!tool || !callId) return [];
		this.#calls.set(callId, tool);
		const args = (event.args ?? {}) as Record<string, unknown>;
		const raw = tool === "command" ? String(args.command ?? "") : String(args.path ?? "");
		return [
			{
				type: "tool_call",
				call_id: callId,
				tool,
				title: truncateBytes(this.#redactor.redact(raw), SESSION_EVENT_LIMITS.toolTitleBytes),
			},
		];
	}

	#toolUpdate(event: PiEvent): AssistantEvent[] {
		const callId = String(event.toolCallId ?? "");
		if (!this.#calls.has(callId)) return [];
		const partial = (event.partialResult ?? {}) as Record<string, unknown>;
		const snapshot = textOf(partial.content);
		let output = this.#outputs.get(callId);
		if (!output) {
			output = { stream: this.#redactor.stream(), seen: "" };
			this.#outputs.set(callId, output);
		}
		// pi 的命令工具每次给的是到目前为止的输出（超过上限后只留末尾）：算出比上一次多出来的部分。
		const added = newPart(output.seen, snapshot);
		output.seen = snapshot;
		if (!added) return [];
		const text = output.stream.push(added);
		return text ? [{ type: "tool_output", call_id: callId, text }] : [];
	}

	#toolEnd(event: PiEvent): AssistantEvent[] {
		const callId = String(event.toolCallId ?? "");
		const tool = this.#calls.get(callId);
		if (!tool) return [];
		this.steps += 1;
		const out: AssistantEvent[] = [];
		const output = this.#outputs.get(callId);
		this.#outputs.delete(callId);
		const rest = output?.stream.flush();
		if (rest) out.push({ type: "tool_output", call_id: callId, text: rest });
		const result = (event.result ?? {}) as Record<string, unknown>;
		const text = headAndTail(this.#redactor.redact(textOf(result.content)));
		const details = (result.details ?? {}) as Record<string, unknown>;
		const diff =
			tool === "edit" && typeof details.diff === "string"
				? headAndTail(this.#redactor.redact(details.diff))
				: undefined;
		// pi 自己截断过（命令的输出只留末尾、读文件只给了一部分）：结果里写着全文在哪，但模型看到的、事件里的都不是全部。
		// 命令超时时 pi 把结果包成没有 details 的错误，看不出截断过：这一种不标（协议里 ToolResultEvent 的说明写了）。
		const truncation = details.truncation as { truncated?: unknown } | undefined;
		const cutByPi = truncation?.truncated === true;
		const exitCode = tool === "command" ? exitCodeOf(result) : undefined;
		const durationMs = Number(event.durationMs);
		out.push({
			type: "tool_result",
			call_id: callId,
			is_error: event.isError === true,
			text: text.text,
			truncated: cutByPi || text.truncated || (diff?.truncated ?? false),
			...(exitCode !== undefined && { exit_code: exitCode }),
			...(diff !== undefined && { diff: diff.text }),
			duration_ms: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : 0,
		});
		return out;
	}

	/** 助手消息以模型出错结束：原文交给调用方记日志。 */
	#modelError(event: PiEvent): { upstreamError?: string } {
		const message = (event.message ?? {}) as Record<string, unknown>;
		if (message.role !== "assistant" || message.stopReason !== "error") return {};
		return { upstreamError: String(message.errorMessage ?? "") };
	}

	#retry(event: PiEvent): AssistantEvent {
		const attempt = positiveInt(event.attempt);
		const max = positiveInt(event.maxAttempts);
		const delay = Number(event.delayMs);
		const error = describeUpstreamError(String(event.errorMessage ?? ""));
		return {
			type: "notice",
			kind: "retry",
			message: `${error.text}，正在重试${attempt ? `第 ${attempt} 次` : ""}`,
			error_class: error.errorClass,
			...(attempt && { attempt }),
			...(max && { max_attempts: max }),
			...(Number.isFinite(delay) && delay >= 0 && { retry_delay_ms: Math.round(delay) }),
		};
	}

	#retryEnd(event: PiEvent): AssistantEvent {
		if (event.success === true) {
			return { type: "notice", kind: "retry_end", message: "重试成功" };
		}
		this.retriesExhausted = describeUpstreamError(String(event.finalError ?? ""));
		return {
			type: "notice",
			kind: "retry_end",
			message: `重试用尽：${this.retriesExhausted.text}`,
			error_class: this.retriesExhausted.errorClass,
		};
	}

	#compaction(event: PiEvent): AssistantEvent[] {
		if (!event.result || event.aborted === true) return [];
		const result = event.result as Record<string, unknown>;
		const before = Number(result.tokensBefore);
		const after = Number(result.estimatedTokensAfter);
		const sizes =
			Number.isFinite(before) && Number.isFinite(after)
				? `（约 ${before} → ${after} 个 token）`
				: "";
		return [{ type: "notice", kind: "compaction", message: `上下文太长，压缩了一次${sizes}` }];
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && (part as { type?: unknown }).type === "text"
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
}

function usageOf(raw: unknown): TokenUsage {
	const u = (raw ?? {}) as Record<string, unknown>;
	const n = (v: unknown) =>
		typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
	return {
		input: n(u.input),
		output: n(u.output),
		cache_read: n(u.cacheRead),
		cache_write: n(u.cacheWrite),
	};
}

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
	input: a.input + b.input,
	output: a.output + b.output,
	cache_read: a.cache_read + b.cache_read,
	cache_write: a.cache_write + b.cache_write,
});

const positiveInt = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : undefined;

/** 命令的退出码：pi 结构化结果里的 `exit_code`；没有时（超时、中止）不给。 */
function exitCodeOf(result: Record<string, unknown>): number | undefined {
	const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
	const code = structured.exit_code;
	return typeof code === "number" && Number.isInteger(code) ? code : undefined;
}

/** `snapshot` 比上一次的 `seen` 多出来的部分；末尾滚动过（只留最后一段）时按重叠找接上的位置。 */
export function newPart(seen: string, snapshot: string): string {
	if (snapshot.startsWith(seen)) return snapshot.slice(seen.length);
	const tail = seen.slice(-256);
	if (tail) {
		const at = snapshot.lastIndexOf(tail);
		if (at !== -1) return snapshot.slice(at + tail.length);
	}
	return snapshot;
}

/** 按 UTF-8 字节截断（不拆开一个字符），超过时末尾加「…」。 */
export function truncateBytes(text: string, limit: number): string {
	if (Buffer.byteLength(text) <= limit) return text;
	let bytes = 0;
	let out = "";
	for (const ch of text) {
		const size = Buffer.byteLength(ch);
		if (bytes + size > limit - 3) break;
		bytes += size;
		out += ch;
	}
	return `${out}…`;
}

/** 超过 `toolResultBytes` 时只留头尾，中间写明省略了多少。 */
export function headAndTail(
	text: string,
	limit: number = SESSION_EVENT_LIMITS.toolResultBytes,
): { text: string; truncated: boolean } {
	const total = Buffer.byteLength(text);
	if (total <= limit) return { text, truncated: false };
	const half = Math.floor((limit - 64) / 2);
	const head = truncateBytes(text, half).replace(/…$/, "");
	const chars = Array.from(text);
	let tail = "";
	let bytes = 0;
	for (let i = chars.length - 1; i >= 0; i--) {
		const ch = chars[i] as string;
		const size = Buffer.byteLength(ch);
		if (bytes + size > half) break;
		bytes += size;
		tail = ch + tail;
	}
	const omitted = total - Buffer.byteLength(head) - Buffer.byteLength(tail);
	return { text: `${head}\n…（中间省略 ${omitted} 字节）…\n${tail}`, truncated: true };
}
