import { SECRET_MASK, type StoredOrchestrationDocument } from "@sfly/schema";

/**
 * secret 参数的值在日志和运行视图里替换成的掩码（docs/SEMANTICS.md §2.1：secret 参数在界面和日志中打码显示）。
 * 定义在 @sfly/schema：读取方（控制台、命令行）靠它认出占位符；运行预设的值、场景版本里的默认值用的是同一个。
 *
 * 打码按值匹配：一次运行里任何链实例（主链、子流程实例）起点声明为 secret 的参数值都是 secret 值。
 * secret 值经参数映射传进子流程时，子流程参数即使没有声明 secret，值仍是同一个字符串，照样被打码
 * （secret 属性按值传播）；子流程实例创建后，它声明的 secret 值也用于整个运行。
 */
export { SECRET_MASK };

/**
 * 值是对象或数组的 secret 参数，它里面的字符串、数字叶子按值打码的最短长度（字符数；数字按它的 JSON 文本算）。
 * 更短的叶子（`a`、`1`、`on`）多是配置里的标签和开关，不是凭据：按子串打码会把日志、错误、输出整片换掉，读不了
 * （#479 的决定）；它们只在整个对象被原样写出时随整段一起盖住，另给一条警告（`secret_short_leaf`）。
 * 值本身是字符串、数字、布尔的 secret 参数不受这个下限限制：使用者对这一个值明确说了保密，再短也打码。
 */
export const MIN_LEAF_CHARS = 4;

/** 值的 JSON 文本（`JSON.stringify` 返回不了文本的值，例如 undefined，退回 `String`）。 */
export const jsonText = (value: unknown): string => JSON.stringify(value) ?? String(value);

/** 一个字符串的字符数（按码点，一个 emoji 算一个）。 */
const charCount = (text: string): number => Array.from(text).length;

/**
 * 非 ASCII 字符和 DEL 写成 `\uXXXX`（小写十六进制，码元为单位，非 BMP 字符是一对代理）：Python 的 `json.dumps` 默认
 * （`ensure_ascii`）这样写，范围是 U+007F 起，比 `JSON.stringify` 多一个 DEL。
 */
const asciiEscaped = (text: string): string =>
	text.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/**
 * 一个字符串在文字里可能出现的写法：原文；放进 JSON 之后引号、反斜杠、换行是转义的，所以再加上转义后的写法；
 * 有非 ASCII 字符（或 DEL）时再加上 `\uXXXX` 的写法。没有要转义的字符时只有一份。
 */
function writtenForms(text: string, into: Set<string>): void {
	into.add(text);
	const inner = JSON.stringify(text).slice(1, -1);
	into.add(inner);
	into.add(asciiEscaped(inner));
}

/** 一个字符串里每一行（去掉两头的空白后）不少于 {@link MIN_LEAF_CHARS} 个字符的，这一行的内容。 */
function longLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => charCount(line) >= MIN_LEAF_CHARS);
}

/** 值里的叶子：非空字符串、数字、布尔（空串、null 是「空值」，不算内容）。 */
type Leaf = string | number | boolean;

function leavesOf(value: unknown, into: Leaf[]): void {
	if (typeof value === "string") {
		if (value !== "") into.push(value);
	} else if (typeof value === "number" || typeof value === "boolean") {
		into.push(value);
	} else if (Array.isArray(value)) {
		for (const item of value) leavesOf(item, into);
	} else if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) leavesOf(item, into);
	}
}

const isContainer = (value: unknown): value is object =>
	value !== null && typeof value === "object";

/**
 * 对象或数组里太短、不单独打码的叶子：字符串（去掉两头空白后）和数字，字符数不到 {@link MIN_LEAF_CHARS}。
 * 布尔和空值不算（它们没有可以被认出来的内容）。预检据此给警告（`secret_short_leaf`）。
 */
export function shortLeafCount(value: unknown): number {
	if (!isContainer(value)) return 0;
	const leaves: Leaf[] = [];
	leavesOf(value, leaves);
	return leaves.filter((leaf) => {
		if (typeof leaf === "boolean") return false;
		const text = typeof leaf === "string" ? leaf.trim() : jsonText(leaf);
		return text !== "" && charCount(text) < MIN_LEAF_CHARS;
	}).length;
}

/** Python `json.dumps` 默认的写法：`", "` 和 `": "` 分隔，`ensure_ascii` 时非 ASCII 写成 `\uXXXX`。 */
function pythonJson(value: unknown, ensureAscii: boolean): string {
	const text = (v: unknown): string => {
		if (Array.isArray(v)) return `[${v.map(text).join(", ")}]`;
		if (v !== null && typeof v === "object") {
			return `{${Object.entries(v)
				.map(([k, item]) => `${JSON.stringify(k)}: ${text(item)}`)
				.join(", ")}}`;
		}
		return jsonText(v);
	};
	const written = text(value);
	return ensureAscii ? asciiEscaped(written) : written;
}

/** 一个 secret 参数的值拆成的几类要打码的东西，见 {@link secretPartsOf}。 */
export interface SecretParts {
	/** 在文字里按子串换成掩码的文本。 */
	texts: string[];
	/** 值是数字、布尔时，作为节点（不是文字）整个等于它就换成掩码：这些值的 JSON 文本。 */
	scalars: string[];
	/** 值是对象、数组时，作为节点整个等于它就换成掩码：这个值的 JSON 文本（紧凑写法）。 */
	containers: string[];
}

/**
 * 一个 secret 参数的值，打码时要换掉的东西（不论值是什么类型，这是 secret 值进入「要打码的文本」的唯一一处，
 * 读取运行、写日志和动作、触发时的报错用的是同一份，规则见 docs/SEMANTICS.md §2.1）：
 *
 * - 字符串：值本身（不论多短），加它在 JSON 里的转义写法（{@link writtenForms}）。多行的：每一行（去掉两头空白后）
 *   不少于 {@link MIN_LEAF_CHARS} 个字符的也算，日志是按行写的，整段对不上。空串没有。
 * - 数字、布尔：JSON 文本（`4242`、`true`），不论多短；作为节点整个等于它时也换成掩码（{@link SecretParts.scalars}）。
 * - 对象、数组：
 *   - 里面的字符串叶子和数字叶子，写出来不少于 {@link MIN_LEAF_CHARS} 个字符的，按值打码（字符串带转义写法，
 *     多行的字符串按行）；数字叶子作为节点整个等于它时也换成掩码（{@link SecretParts.scalars}）。键不算。
 *   - 更短的叶子、布尔、空值不单独打码；整个对象被原样写出时随整段一起盖住：整段的几种写法都算，控制面的紧凑写法，
 *     Python `json.dumps` 默认的写法（`", "`、`": "` 分隔），各自带或不带 `\uXXXX` 转义（`ensure_ascii`）。
 *   - 没有任何内容（`{}`、`[]`、`[[]]`、`{"k": ""}`、`{"n": null}`）时什么都不算。
 *   - 作为节点整个等于它时换成掩码（{@link SecretParts.containers}）。
 * - null、undefined：没有。
 */
export function secretPartsOf(value: unknown): SecretParts {
	const parts: SecretParts = { texts: [], scalars: [], containers: [] };
	if (value === undefined || value === null) return parts;
	const texts = new Set<string>();
	if (typeof value === "string") {
		if (value === "") return parts;
		writtenForms(value, texts);
		for (const line of longLines(value)) writtenForms(line, texts);
	} else if (typeof value === "number" || typeof value === "boolean") {
		texts.add(jsonText(value));
		parts.scalars.push(jsonText(value));
	} else {
		const leaves: Leaf[] = [];
		leavesOf(value, leaves);
		if (leaves.length === 0) return parts;
		for (const leaf of leaves) {
			if (typeof leaf === "string") {
				for (const text of [leaf.trim(), ...longLines(leaf)]) {
					if (charCount(text) >= MIN_LEAF_CHARS) writtenForms(text, texts);
				}
			} else if (typeof leaf === "number" && charCount(jsonText(leaf)) >= MIN_LEAF_CHARS) {
				texts.add(jsonText(leaf));
				parts.scalars.push(jsonText(leaf));
			}
		}
		for (const ensureAscii of [false, true]) {
			texts.add(asciiIf(JSON.stringify(value), ensureAscii));
			texts.add(pythonJson(value, ensureAscii));
		}
		parts.containers.push(JSON.stringify(value));
	}
	parts.texts = [...texts];
	return parts;
}

const asciiIf = (text: string, ensureAscii: boolean): string =>
	ensureAscii ? asciiEscaped(text) : text;

/**
 * 编译好的匹配：一个 secret 值集合（长的在前）拼成的一个正则，按值集合缓存；值集合变了就是另一个键，重新编译。
 * 读取运行每次都算一份新的 {@link SecretSet}，同样的值集合不重复编译。
 */
const compiled = new Map<string, RegExp>();
const COMPILED_LIMIT = 64;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

function regexFor(texts: readonly string[]): RegExp {
	const key = texts.join("\u0000");
	let regex = compiled.get(key);
	if (!regex) {
		regex = new RegExp(texts.map(escapeRegExp).join("|"), "g");
		compiled.set(key, regex);
		if (compiled.size > COMPILED_LIMIT) {
			const oldest = compiled.keys().next().value;
			if (oldest !== undefined) compiled.delete(oldest);
		}
	}
	return regex;
}

/**
 * 一次运行此刻的全部 secret 值要打码的东西（{@link secretPartsOf} 汇总）。不可变：运行里有了新的 secret 值（子流程实例创建）
 * 就是另一个值集合，匹配用的正则按值集合编译、缓存：一批日志、动作经过它时，每一段文字只是一次正则替换，不是每个值各扫一遍
 * （值多的时候逐个扫一遍的代价和值的个数成正比，日志每行都要付）。
 */
export class SecretSet {
	/** 在文字里按子串换成掩码的文本，长的在前（整段的 JSON 先于它里面的叶子）。 */
	readonly texts: readonly string[];
	/** 作为节点整个等于它就换成掩码的数字、布尔和数字叶子：JSON 文本。 */
	readonly scalars: ReadonlySet<string>;
	/** 作为节点整个等于它就换成掩码的对象和数组：JSON 文本。 */
	readonly containers: ReadonlySet<string>;

	constructor(parts: Iterable<SecretParts> = []) {
		const texts = new Set<string>();
		const scalars = new Set<string>();
		const containers = new Set<string>();
		for (const part of parts) {
			for (const text of part.texts) texts.add(text);
			for (const text of part.scalars) scalars.add(text);
			for (const text of part.containers) containers.add(text);
		}
		this.texts = [...texts].sort((a, b) => b.length - a.length);
		this.scalars = scalars;
		this.containers = containers;
	}

	/** 没有任何要打码的东西：读取和写入都可以跳过打码。 */
	get isEmpty(): boolean {
		return this.texts.length === 0 && this.scalars.size === 0 && this.containers.size === 0;
	}

	/** 编译好的匹配，第一次用到时取（{@link regexFor}）：每次打码只是一次正则替换，不再按值集合查缓存。 */
	#regex: RegExp | undefined;

	#matcher(): RegExp {
		this.#regex ??= regexFor(this.texts);
		return this.#regex;
	}

	/** 把文本中出现的 secret 值替换成掩码；里面没有时返回同一个字符串。 */
	mask(text: string): string {
		if (this.texts.length === 0) return text;
		return text.replace(this.#matcher(), SECRET_MASK);
	}

	/** 文本里有没有 secret 值。 */
	appearsIn(text: string): boolean {
		if (this.texts.length === 0) return false;
		const regex = this.#matcher();
		regex.lastIndex = 0;
		return regex.test(text);
	}
}

/** 没有 secret 值。 */
export const NO_SECRETS: SecretSet = new SecretSet();

/** 把若干 secret 参数的值汇总成一份要打码的东西（{@link SecretSet}）。 */
export function secretSetOf(values: Iterable<unknown>): SecretSet {
	return new SecretSet([...values].map(secretPartsOf));
}

/** 一个链实例起点声明为 secret 的参数的值（有值的）。 */
export function secretParamValues(
	declarations: ReadonlyArray<{ name: string; secret?: boolean | undefined }>,
	params: Record<string, unknown>,
): unknown[] {
	return declarations
		.filter((d) => d.secret === true)
		.map((d) => params[d.name])
		.filter((value) => value !== undefined && value !== null);
}

/** 文档里有没有哪个入口、子流程入口声明了 secret 参数：没有时不论怎么触发，这个版本的运行都没有 secret 值要打码。 */
export function declaresSecrets(document: StoredOrchestrationDocument): boolean {
	return document.nodes.some(
		(n) => (n.kind === "entry" || n.kind === "subflow_entry") && n.params.some((p) => p.secret),
	);
}

/** 一个链实例起点（入口 / 子流程入口节点）声明为 secret 的参数名。 */
export function secretParamNames(
	document: StoredOrchestrationDocument,
	chainId: string,
): ReadonlySet<string> {
	const start = document.nodes.find((n) => n.id === chainId);
	if (!start || (start.kind !== "entry" && start.kind !== "subflow_entry")) return new Set();
	return new Set(start.params.filter((p) => p.secret).map((p) => p.name));
}

/**
 * 一次运行中所有 secret 参数的值要打码的东西（{@link SecretSet}）：每个链实例起点（入口 / 子流程入口节点）声明为 secret 的参数。
 */
export function secretValues(
	document: StoredOrchestrationDocument,
	chains: ReadonlyArray<{ chainId: string; params: Record<string, unknown> }>,
): SecretSet {
	const values: unknown[] = [];
	for (const chain of chains) {
		const start = document.nodes.find((n) => n.id === chain.chainId);
		if (!start || (start.kind !== "entry" && start.kind !== "subflow_entry")) continue;
		values.push(...secretParamValues(start.params, chain.params));
	}
	return secretSetOf(values);
}

/** 把文本中出现的 secret 值替换成掩码。 */
export function maskSecrets(text: string, secrets: SecretSet): string {
	return secrets.mask(text);
}

/**
 * 打码一个 JSON 值（节点里的某个值，或者值的一部分）：
 *
 * - 字符串：里面出现的 secret 值按子串换成掩码；
 * - 数字、布尔：整个等于 secret 值（顶层是数字、布尔的 secret 参数，或者 secret 对象里不短的数字叶子）时换成掩码，
 *   字符串叶子（`"1"`、`"true"`）不会让数字、布尔被换掉：打码不改变没有被打码的值的类型；
 * - 对象、数组：整个等于 secret 参数的值（JSON 文本相同，例如原样传给节点的输入、原样写进输出的对象）时整个换成掩码，
 *   不等于时递归里面的值。键不打码。
 */
export function maskValue<T>(value: T, secrets: SecretSet): T {
	if (secrets.isEmpty) return value;
	return mask(value, secrets) as T;
}

/**
 * 打码运行或链实例的参数：先按 {@link maskRecord} 逐个处理；再把声明为 secret 的参数整个读成掩码，不看值里有没有可以按值
 * 打码的内容（规则 1：secret 参数本身读出来是掩码，不论类型；`{}`、`[]` 这类没有内容的值按值打码时什么都不算，
 * 但它仍是这个参数的值）。没有值（缺省、null）和空串没有什么可隐藏的，原样。
 */
export function maskParams(
	params: Record<string, unknown>,
	declaredSecret: ReadonlySet<string>,
	secrets: SecretSet,
): Record<string, unknown> {
	const masked = maskRecord(params, secrets);
	if (declaredSecret.size === 0) return masked;
	const result = { ...masked };
	for (const name of declaredSecret) {
		const value = params[name];
		if (value !== undefined && value !== null && value !== "") result[name] = SECRET_MASK;
	}
	return result;
}

/**
 * 打码一个「名字到值」的映射（运行的参数、链实例的参数、任务的输入和输出）：映射本身不换成掩码，哪怕它整个等于某个 secret
 * 对象（节点把收到的 secret 对象原样作为整个输出），它是「名字到值」的映射，不是那个值：对里面的每个值逐个处理
 * （{@link maskValue}），某个值整个等于 secret 值时换的是那个值。契约要求这几处是映射。
 */
export function maskRecord<T extends Record<string, unknown> | null | undefined>(
	record: T,
	secrets: SecretSet,
): T {
	if (secrets.isEmpty || !record) return record;
	return Object.fromEntries(
		Object.entries(record).map(([key, value]) => [key, mask(value, secrets)]),
	) as T;
}

function mask(value: unknown, secrets: SecretSet): unknown {
	if (typeof value === "string") return secrets.mask(value);
	if (typeof value === "number" || typeof value === "boolean") {
		return secrets.scalars.has(jsonText(value)) ? SECRET_MASK : value;
	}
	if (value !== null && typeof value === "object") {
		if (secrets.containers.size > 0 && secrets.containers.has(JSON.stringify(value))) {
			return SECRET_MASK;
		}
		if (Array.isArray(value)) return value.map((item) => mask(item, secrets));
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v, secrets)]));
	}
	return value;
}
