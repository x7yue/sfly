import { SECRET_MASK } from "@sfly/schema";

/**
 * 保密环境变量（`PromptCommandBody.secret_env`）的值按值打码（#540 的要求）：助手服务发出的每一条事件、写下的
 * pi 原始事件（`events.jsonl`）和自己的日志，在出去之前过一遍。
 *
 * 规则（和控制面给 secret 参数打码的 `apps/server/src/logs/secrets.ts` 一致）：
 * - 认的写法：原文；放进 JSON 之后的转义写法（引号、反斜杠、换行转义）；非 ASCII 字符写成 `\uXXXX` 的写法；
 *   值有几行时，每一行（去掉两头空白后不少于 4 个字符的）单独也认（值被换行拆开、分几次打出来）。
 * - 值本身再短也打码（使用者明确说了它保密）；空串不算。
 * - 替换成 {@link SECRET_MASK}；长的写法先换，免得短的写法把长的拆坏。
 * - 一个值跨两条增量（`assistant_delta`、`tool_output`）时：每条流留下末尾「最长的写法减一个字符」不发，
 *   和下一段拼起来再认（{@link StreamRedactor}）；这条流结束时（这条消息完整了、这个工具结束了）发出剩下的。
 *
 * 做不到的：值被编码成别的样子（base64、十六进制、逐字倒过来、每个字符之间插空格）后不认；shell 引号拼接
 * （`'ab''cd'`）不认。这些只能靠不把令牌交给模型能读到的地方之外的东西兜底：会话令牌的权限范围（ADR 0029）。
 */
export class Redactor {
	#forms: string[] = [];
	#formBytes: Buffer[] = [];
	readonly #mask = Buffer.from(SECRET_MASK);
	readonly #values = new Set<string>();

	/** 加进要打码的值（会话里每一轮的 `secret_env` 都加进来：pi 进程跨轮存活，模型可能在后面的轮里复述）。 */
	add(values: Iterable<string>): void {
		let changed = false;
		for (const value of values) {
			if (value === "" || this.#values.has(value)) continue;
			this.#values.add(value);
			changed = true;
		}
		if (!changed) return;
		const forms = new Set<string>();
		for (const value of this.#values) writtenForms(value, forms);
		this.#forms = [...forms].filter((f) => f !== "").sort((a, b) => b.length - a.length);
		this.#formBytes = this.#forms.map((f) => Buffer.from(f)).sort((a, b) => b.length - a.length);
	}

	/** 加进来过的值（交给扩展：它在源头打码）。 */
	get values(): string[] {
		return [...this.#values];
	}

	/** 有没有要打码的值。 */
	get empty(): boolean {
		return this.#forms.length === 0;
	}

	/** 最长的一种写法的长度（字符数，UTF-16 码元）。 */
	get longest(): number {
		return this.#forms[0]?.length ?? 0;
	}

	redact(text: string): string {
		let out = text;
		for (const form of this.#forms) {
			if (out.includes(form)) out = out.split(form).join(SECRET_MASK);
		}
		return out;
	}

	/** 文字里每一处要打码的写法的位置 `[开始, 结束)`（按出现先后，去掉被更长的写法盖住的）。 */
	matches(text: string): Array<[number, number]> {
		const spans: Array<[number, number]> = [];
		for (const form of this.#forms) {
			for (let i = text.indexOf(form); i !== -1; i = text.indexOf(form, i + 1)) {
				spans.push([i, i + form.length]);
			}
		}
		return spans.sort((a, b) => a[0] - b[0]);
	}

	/** 把任意 JSON 值里的字符串都打码（事件、pi 的原始事件）。 */
	redactValue<T>(value: T): T {
		if (this.empty) return value;
		return walk(value, (s) => this.redact(s)) as T;
	}

	stream(): StreamRedactor {
		return new StreamRedactor(this);
	}

	/** 最长的一种写法的字节数（UTF-8）。 */
	get longestBytes(): number {
		return this.#formBytes[0]?.length ?? 0;
	}

	/** 字节里每一处要打码的写法的位置 `[开始, 结束)`。 */
	byteMatches(data: Buffer): Array<[number, number]> {
		const spans: Array<[number, number]> = [];
		for (const form of this.#formBytes) {
			for (let i = data.indexOf(form); i !== -1; i = data.indexOf(form, i + 1)) {
				spans.push([i, i + form.length]);
			}
		}
		return spans.sort((a, b) => a[0] - b[0]);
	}

	/**
	 * 按字节打码（工作台返回的原始内容：命令的输出、读到的文件，可能不是 UTF-8 文字）：每种写法的 UTF-8 字节换成
	 * {@link SECRET_MASK}，长的写法先换；别的字节原样。
	 */
	redactBytes(data: Buffer): Buffer {
		let out = data;
		for (const form of this.#formBytes) {
			if (out.indexOf(form) === -1) continue;
			const parts: Buffer[] = [];
			let from = 0;
			for (let i = out.indexOf(form); i !== -1; i = out.indexOf(form, from)) {
				parts.push(out.subarray(from, i), this.#mask);
				from = i + form.length;
			}
			parts.push(out.subarray(from));
			out = Buffer.concat(parts);
		}
		return out;
	}

	byteStream(): ByteStreamRedactor {
		return new ByteStreamRedactor(this);
	}
}

/** 一条字节流（命令的输出、按块读的文件）的打码：和 {@link StreamRedactor} 同样留尾巴，按字节。 */
export class ByteStreamRedactor {
	#pending = Buffer.alloc(0);

	constructor(private readonly redactor: Redactor) {}

	push(chunk: Uint8Array): Buffer {
		if (this.redactor.empty) return Buffer.from(chunk);
		const combined = Buffer.concat([this.#pending, chunk]);
		const hold = Math.max(this.redactor.longestBytes - 1, 0);
		let cut = Math.max(combined.length - hold, 0);
		for (const [start, end] of this.redactor.byteMatches(combined)) {
			if (start < cut && end > cut) cut = end;
		}
		this.#pending = Buffer.from(combined.subarray(cut));
		return this.redactor.redactBytes(combined.subarray(0, cut));
	}

	flush(): Buffer {
		const rest = this.#pending;
		this.#pending = Buffer.alloc(0);
		return this.redactor.redactBytes(rest);
	}
}

/** 一条增量流（一条消息的文字增量、一个工具的输出）的打码：见 {@link Redactor}。 */
export class StreamRedactor {
	#pending = "";

	constructor(private readonly redactor: Redactor) {}

	/** 放进一段增量，返回现在可以发出的文字（可能是空串：全部留着等下一段）。 */
	push(chunk: string): string {
		const combined = this.#pending + chunk;
		const hold = Math.max(this.redactor.longest - 1, 0);
		let cut = Math.max(combined.length - hold, 0);
		// 切点落在一处完整的写法中间时，挪到这处的末尾（它完整了，可以打码发出）。
		for (const [start, end] of this.redactor.matches(combined)) {
			if (start < cut && end > cut) cut = end;
		}
		// 不把一个代理对拆开。
		if (cut > 0 && cut < combined.length && isHighSurrogate(combined.charCodeAt(cut - 1))) cut -= 1;
		this.#pending = combined.slice(cut);
		return this.redactor.redact(combined.slice(0, cut));
	}

	/** 流结束：发出留着的部分。 */
	flush(): string {
		const rest = this.#pending;
		this.#pending = "";
		return this.redactor.redact(rest);
	}
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** 每一行（去掉两头空白后）不少于这么多字符的，单独也认。 */
const MIN_LINE_CHARS = 4;

const asciiEscaped = (text: string): string =>
	text.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

function writtenForms(value: string, into: Set<string>): void {
	const add = (text: string) => {
		into.add(text);
		const inner = JSON.stringify(text).slice(1, -1);
		into.add(inner);
		into.add(asciiEscaped(inner));
	};
	add(value);
	const lines = value.split(/\r?\n/).map((line) => line.trim());
	if (lines.length > 1) {
		for (const line of lines) if (Array.from(line).length >= MIN_LINE_CHARS) add(line);
	}
}

function walk(value: unknown, fn: (s: string) => string): unknown {
	if (typeof value === "string") return fn(value);
	if (Array.isArray(value)) return value.map((item) => walk(item, fn));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, fn)]));
	}
	return value;
}

/** 写进助手服务日志的一段原文（上游的错误、工作台连接上的报错）最多这么多个字符（UTF-16 码元）。 */
export const LOG_TEXT_LIMIT = 500;

/**
 * 不靠值、靠形状认出的凭据：`Authorization` 头（含 JSON 里的写法）、`Bearer` 后面的串、`x-api-key` 一类的头、
 * 地址里的用户名和密码。上游的错误体可能把请求头、带凭据的地址回显出来。
 */
const CREDENTIAL_SHAPES: Array<[RegExp, string]> = [
	[/(authorization["']?\s*[:=]\s*["']?)[^"'\r\n,}]+/gi, `$1${SECRET_MASK}`],
	[/((?:x-)?api[-_]?key["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, `$1${SECRET_MASK}`],
	[/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${SECRET_MASK}`],
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${SECRET_MASK}@`],
];

/**
 * 一段原文写进助手服务的日志之前：按值打码（每个 `redactor`），再按形状打码，最后截到 {@link LOG_TEXT_LIMIT}
 * （先打码再截：截断不会把一个值切成认不出的半截）。
 */
export function forLog(text: string, redactors: Iterable<Redactor>): string {
	let out = text;
	for (const redactor of redactors) out = redactor.redact(out);
	for (const [shape, replacement] of CREDENTIAL_SHAPES) out = out.replace(shape, replacement);
	if (out.length <= LOG_TEXT_LIMIT) return out;
	return `${out.slice(0, LOG_TEXT_LIMIT)}…（后面截掉了 ${out.length - LOG_TEXT_LIMIT} 个字符）`;
}
