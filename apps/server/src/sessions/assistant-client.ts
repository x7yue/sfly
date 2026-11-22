import {
	ASSISTANT_STREAM_HEARTBEAT_MS,
	ASSISTANT_STREAM_IDLE_INTERVALS,
	AssistantErrorBody,
	type AssistantErrorCode,
	AssistantHealth,
	AssistantStreamLine,
	type PromptCommandBody,
} from "@sfly/schema";
import type { z } from "zod";
import type { AssistantConfig } from "./assistant-config.js";

/** 助手服务拒绝了请求：状态码，和它给的错误码（回应体不是约定的形状时没有）。 */
export class AssistantError extends Error {
	constructor(
		readonly status: number,
		readonly code: AssistantErrorCode | undefined,
		message: string,
	) {
		super(message);
	}
}

/**
 * 连不上助手服务（网络出错、超时），或它回的不是约定的东西：命令没有送到，或送到了没有收到确认。
 * `message` 是稳定的一句说明（只有原因的种类，见 {@link reasonOf}），会回给请求的人、写进就绪状态和 `turn_end` 的原因；
 * 底层错误的原文（带着助手服务的地址和端口）在 `cause` 里，只进日志。
 */
export class AssistantUnreachableError extends Error {}

/**
 * Node 的 `fetch`（undici）对响应体的默认超时：连接上 300 秒没有数据就断开。事件流靠心跳（15 秒一行）不静默，
 * 控制面自己的空闲检测（{@link AssistantClientOptions.eventsIdleMs}，默认 45 秒）远比它短，所以先触发的总是后者，
 * 这里不去改 `fetch` 的超时（那要换成 undici 自己的 fetch 和连接池，和 Node 自带的 fetch 版本要配套）。
 * 空闲上限必须小于它，否则会先被这个默认值断开，原因写成「断了」而不是「没有心跳」。
 */
export const FETCH_BODY_TIMEOUT_MS = 300_000;

export interface AssistantClientOptions {
	/** 一个命令（不含事件流）最多等多久，默认 10 秒。 */
	timeoutMs?: number;
	/**
	 * 事件流多久没有收到任何字节（心跳、事件都算）就认为连接死了、主动断开（毫秒），默认
	 * {@link ASSISTANT_STREAM_IDLE_INTERVALS} 个心跳间隔（45 秒）。比 Node `fetch` 的响应体超时（默认 300 秒）短，
	 * 所以以这里为准：不会等 5 分钟才发现半开的连接，也不会因为没有会话在做、连接静默就被响应体超时掐断（心跳让它不静默）。
	 */
	eventsIdleMs?: number;
	/** 测试替身。 */
	fetch?: typeof fetch;
}

/**
 * 控制面发给助手服务的请求（协议见 `@sfly/schema` 的 `assistant-protocol.ts`）：命令是控制面发的请求，事件是控制面
 * 打开的一条长连接；每个请求带 `Authorization: Bearer <共享密钥>`。
 */
export class AssistantClient {
	readonly #fetch: typeof fetch;
	readonly #timeoutMs: number;
	readonly #eventsIdleMs: number;

	constructor(
		private readonly config: AssistantConfig,
		options: AssistantClientOptions = {},
	) {
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? 10_000;
		this.#eventsIdleMs =
			options.eventsIdleMs ?? ASSISTANT_STREAM_HEARTBEAT_MS * ASSISTANT_STREAM_IDLE_INTERVALS;
		if (this.#eventsIdleMs >= FETCH_BODY_TIMEOUT_MS) {
			throw new RangeError(
				`事件流的空闲上限 ${this.#eventsIdleMs} 毫秒要小于 fetch 的响应体超时 ${FETCH_BODY_TIMEOUT_MS} 毫秒，否则会先被它断开`,
			);
		}
	}

	#url(path: string): URL {
		return new URL(path, this.config.url);
	}

	#headers(extra: Record<string, string> = {}): Record<string, string> {
		return { authorization: `Bearer ${this.config.secret}`, ...extra };
	}

	/** 开始一轮：助手服务收下了就返回；它拒绝时抛 {@link AssistantError}，连不上抛 {@link AssistantUnreachableError}。 */
	async prompt(sessionId: string, body: PromptCommandBody): Promise<void> {
		await this.#command("POST", `/sessions/${sessionId}/prompt`, body);
	}

	/** 停止这一轮；重复调用无害。 */
	async abort(sessionId: string): Promise<void> {
		await this.#command("POST", `/sessions/${sessionId}/abort`);
	}

	/** 助手服务和它的模型、进程的状态。 */
	async health(timeoutMs?: number): Promise<AssistantHealth> {
		const res = await this.#request("GET", "/health", undefined, timeoutMs);
		await rejectUnlessOk(res);
		const parsed = AssistantHealth.safeParse(await res.json().catch(() => undefined));
		if (!parsed.success)
			throw new AssistantUnreachableError("助手服务的 /health 回应不是约定的形状");
		return parsed.data;
	}

	/**
	 * 打开事件流（一条 NDJSON 长连接），一行一条。连接断开、`signal` 中止、读出错时迭代结束或抛错；
	 * **超过 `eventsIdleMs` 没有收到任何字节**（助手服务按协议每 15 秒写一行心跳）就当连接死了，主动断开并抛
	 * {@link AssistantUnreachableError}，调用方重连；不是约定形状的行跳过（`onSkipped` 收到原因）。
	 */
	async *events(
		signal: AbortSignal,
		onSkipped: (reason: string) => void,
	): AsyncGenerator<AssistantStreamLine> {
		const idle = new AbortController();
		let timer: NodeJS.Timeout | undefined;
		let idled = false;
		const arm = () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				idled = true;
				idle.abort();
			}, this.#eventsIdleMs);
		};
		const idleMessage = () =>
			`助手服务的事件流 ${Math.round(this.#eventsIdleMs / 1000)} 秒没有收到任何内容（心跳也没有），当作连接已经死了`;
		try {
			arm();
			let res: Response;
			try {
				res = await this.#fetch(this.#url("/events"), {
					headers: this.#headers({ accept: "application/x-ndjson" }),
					signal: AbortSignal.any([signal, idle.signal]),
				});
			} catch (error) {
				throw new AssistantUnreachableError(
					idled ? idleMessage() : `连不上助手服务：${reasonOf(error)}`,
					{ cause: error },
				);
			}
			await rejectUnlessOk(res);
			if (!res.body) throw new AssistantUnreachableError("助手服务的事件流没有内容");
			const decoder = new TextDecoder();
			let buffer = "";
			const parse = (line: string): AssistantStreamLine | undefined => {
				if (line.trim() === "") return undefined;
				let json: unknown;
				try {
					json = JSON.parse(line);
				} catch {
					onSkipped("不是 JSON");
					return undefined;
				}
				const parsed = AssistantStreamLine.safeParse(json);
				if (!parsed.success) {
					onSkipped(describeSkippedLine(json, parsed.error.issues));
					return undefined;
				}
				return parsed.data;
			};
			try {
				for await (const chunk of res.body) {
					// 计时只算「没有收到字节」的时间：处理这一块（包括调用方处理每一行，`yield` 出去等它）的时候停表，
					// 处理完、回去等下一块时再重新计时。对端一直在写，调用方处理得慢，不能被当成连接死了。
					clearTimeout(timer);
					buffer += decoder.decode(chunk, { stream: true });
					for (;;) {
						const end = buffer.indexOf("\n");
						if (end < 0) break;
						const line = parse(buffer.slice(0, end));
						buffer = buffer.slice(end + 1);
						if (line) yield line;
					}
					arm();
				}
			} catch (error) {
				if (signal.aborted) return;
				throw new AssistantUnreachableError(
					idled ? idleMessage() : `助手服务的事件流断了：${reasonOf(error)}`,
					{ cause: error },
				);
			}
		} finally {
			clearTimeout(timer);
		}
	}

	async #command(method: string, path: string, body?: unknown): Promise<void> {
		const res = await this.#request(method, path, body);
		await rejectUnlessOk(res);
	}

	async #request(
		method: string,
		path: string,
		body?: unknown,
		timeoutMs: number = this.#timeoutMs,
	): Promise<Response> {
		try {
			return await this.#fetch(this.#url(path), {
				method,
				headers: this.#headers(body === undefined ? {} : { "content-type": "application/json" }),
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			throw new AssistantUnreachableError(`连不上助手服务：${reasonOf(error)}`, { cause: error });
		}
	}
}

async function rejectUnlessOk(res: Response): Promise<void> {
	if (res.ok) return;
	const text = await res.text().catch(() => "");
	let body: AssistantErrorBody | undefined;
	try {
		const parsed = AssistantErrorBody.safeParse(JSON.parse(text));
		body = parsed.success ? parsed.data : undefined;
	} catch {
		body = undefined;
	}
	throw new AssistantError(res.status, body?.code, body?.message ?? `助手服务回应了 ${res.status}`);
}

/**
 * 连不上的原因，写给人看：只有原因的种类，不带助手服务的地址、端口和底层错误的原文（那些在错误的 `cause` 里进日志，
 * 响应和就绪状态所有能读的人都看得到）。
 */
export function reasonOf(error: unknown): string {
	const codes = new Set<string>();
	let current: unknown = error;
	for (let depth = 0; current instanceof Error && depth < 5; depth++) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string") codes.add(code);
		codes.add(current.name);
		current = current.cause;
	}
	const has = (...names: string[]) => names.some((name) => codes.has(name));
	if (has("TimeoutError")) return "没有及时回应（超时）";
	if (has("ECONNREFUSED")) return "连接被拒绝";
	if (has("ENOTFOUND", "EAI_AGAIN")) return "域名解析不了";
	if (has("ECONNRESET", "EPIPE", "UND_ERR_SOCKET")) return "连接被对端关闭";
	if (has("EHOSTUNREACH", "ENETUNREACH")) return "网络不通";
	if (
		has("ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT")
	)
		return "连接超时";
	return "网络出错";
}

/**
 * 事件流里一行过不了 schema 时写进日志的说明：这一行说的是哪个会话、哪一轮、什么类型，以及是哪个字段不对
 * （联合类型的整体失败只有「Invalid input」，要钻进最像的那个分支）。只写标识和字段路径，不写内容。
 */
export function describeSkippedLine(json: unknown, issues: readonly z.core.$ZodIssue[]): string {
	const record =
		typeof json === "object" && json !== null ? (json as Record<string, unknown>) : undefined;
	const event = record?.event;
	const eventType =
		typeof event === "object" && event !== null ? (event as { type?: unknown }).type : undefined;
	const label = (value: unknown): string | undefined =>
		typeof value === "string" || typeof value === "number" ? String(value).slice(0, 80) : undefined;
	const who = [
		label(record?.type) && `行类型 ${label(record?.type)}`,
		label(record?.session_id) && `会话 ${label(record?.session_id)}`,
		label(record?.turn) && `轮次 ${label(record?.turn)}`,
		label(eventType) && `事件类型 ${label(eventType)}`,
	].filter(Boolean);
	const fields = flattenIssues(issues).map(({ path, message }) =>
		path === "" ? message : `${path}: ${message}`,
	);
	return `${who.length > 0 ? `${who.join("，")}：` : ""}${fields.join("；")}`;
}

function flattenIssues(
	issues: readonly z.core.$ZodIssue[],
): Array<{ path: string; message: string }> {
	const out: Array<{ path: string; message: string }> = [];
	for (const issue of issues) {
		if (issue.code === "invalid_union") {
			// 分支里第一个字段就是判别字段（`type`）对不上的，是别的类型的分支：去掉，剩下的才是这一行像的那个。
			const branches = issue.errors.filter(
				(branch) => !branch.some((i) => i.code === "invalid_value" && i.path.join(".") === "type"),
			);
			const best = branches.length > 0 ? branches : issue.errors;
			for (const branch of best) {
				for (const inner of flattenIssues(branch)) {
					const prefix = issue.path.join(".");
					out.push({
						path: prefix === "" ? inner.path : `${prefix}.${inner.path}`,
						message: inner.message,
					});
				}
			}
			continue;
		}
		out.push({ path: issue.path.join("."), message: issue.message });
	}
	return out;
}
