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

/**
 * 被截断的文字（日志类异常的说明、动作的名称、字段、失败原因）结尾留下的半截 secret 值，按它的前缀盖住时，前缀最短多少个字符（码点）。
 * 太短的前缀（`a`、`te`）在别的文字里太常见，盖了会把正常的文字也换掉：不盖。真正的密钥、口令、令牌的前 4 个字符不会碰巧和
 * 一段普通文字的结尾一样，所以这里取和 {@link MIN_LEAF_CHARS} 一样的 4。这是读取这一侧的补救（根本的办法是写入时打码、
 * 原样另存，属于 #505），短于它的前缀盖不住，docs/SEMANTICS.md §2.1 的「没有覆盖的写法」里写明。
 */
export const MIN_CLIPPED_PREFIX_CHARS = 4;

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

/**
 * UTF-16 码元换成能按码点排序的数：BMP 之外的字符是一对代理（U+D800–U+DFFF），它们的码点比 BMP 里的 U+E000–U+FFFF 大，
 * 把代理排到 U+E000–U+FFFF 之后就和码点序一致。
 */
const sortableUnit = (unit: number): number =>
	unit >= 0xe000 ? unit - 0x800 : unit >= 0xd800 ? unit + 0x2000 : unit;

/**
 * 两个字符串按 UTF-8 字节序比较，也就是按码点序（UTF-8 保持码点的顺序）。JS 的 `<` 比的是 UTF-16 码元，BMP 之外的字符
 * （emoji）会排到 U+E000–U+FFFF 的字符前面；用 `Buffer.compare(Buffer.from(a), Buffer.from(b))` 能得到同样的结果，
 * 但排序时每次比较要分配两个 Buffer，这里在第一个不同的码元上比，不分配。和它的一致由 test/secret-texts.test.ts 随机对比。
 */
export function compareUtf8(a: string, b: string): number {
	const length = Math.min(a.length, b.length);
	for (let i = 0; i < length; i++) {
		const x = a.charCodeAt(i);
		const y = b.charCodeAt(i);
		if (x !== y) return sortableUnit(x) - sortableUnit(y);
	}
	return a.length - b.length;
}

/** 64 位整数的范围：Agent 的 serde_json 把控制面写出的整数文本落在这个范围里的当整数，超出的当浮点。 */
const I64_MIN = -(2n ** 63n);
const U64_MAX = 2n ** 64n - 1n;

/** Python `repr(float)` 的写法（`json.dumps` 写浮点用它）：十进制小数点在第 `point` 位数字之后，`point` 不大于 -4 或大于 16 时用科学计数法。 */
function pythonFloat(n: number): string {
	const sign = n < 0 ? "-" : "";
	// toExponential() 不给位数时是能还原这个数的最短的位数，和 Python repr 的位数一样，只是写法不同。
	const [mantissa = "", exponentText = "0"] = Math.abs(n).toExponential().split("e");
	const digits = mantissa.replace(".", "");
	const exponent = Number(exponentText);
	const point = exponent + 1;
	if (point <= -4 || point > 16) {
		const head = digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
		const abs = Math.abs(exponent);
		return `${sign}${head}e${exponent < 0 ? "-" : "+"}${abs < 10 ? `0${abs}` : abs}`;
	}
	if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
	if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
	return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * 一个数字被节点（Python）打印出来的写法（`json.dumps`、`repr`、`print`）。控制面写给 Agent 的是 JS 的 `JSON.stringify`，
 * Agent 的 serde_json 解析再写成 task.json，Python 的 SDK 用 `json.loads` 读进来，所以：
 * 控制面写出的整数文本落在 64 位整数范围里的，是整数，Python 打印的和控制面写的一样；超出范围的（小于 1e21 时控制面写成
 * 一长串数字）serde_json 按浮点解析，Python 写成科学计数法（`9.876543210987654e+19`）；带小数的，Python 用 `repr(float)`，
 * 绝对值在 1e-9 到 1e-4 之间时和 JS 不同（`0.00001` 写成 `1e-05`）。三端的用例表是 `testdata/number-form-cases.json`。
 */
export function pythonNumber(n: number): string {
	const text = jsonText(n);
	if (!Number.isFinite(n)) return text;
	if (/^-?\d+$/.test(text)) {
		const whole = BigInt(text);
		if (whole >= I64_MIN && whole <= U64_MAX) return text;
	}
	return pythonFloat(n);
}

/** 把值写成 JSON 文本的一种写法。 */
interface JsonStyle {
	/** 数组的元素之间、对象的键值对之间的分隔：`","`（紧凑）或 `", "`（Python `json.dumps` 默认）。 */
	item: string;
	/** 键和值之间的分隔：`":"` 或 `": "`。 */
	pair: string;
	/** 对象的键按 UTF-8 字节序排：Agent 交给节点的顺序，也是 `sort_keys=True` 的结果；false 时保持值里的顺序（参数里写的顺序）。 */
	sorted: boolean;
	/** 非 ASCII 字符和 DEL 写成 `\uXXXX`（Python 的 `ensure_ascii`）。 */
	ascii: boolean;
	/** 写数字的函数：{@link jsonText}（JS 的写法）或 {@link pythonNumber}（节点打印的写法）。 */
	number: (n: number) => string;
}

const COMPACT = { item: ",", pair: ":" } as const;
const PYTHON_DEFAULT = { item: ", ", pair: ": " } as const;

/**
 * 按 {@link JsonStyle} 写出 JSON 文本。键的顺序自己排，不靠 JS 对象的键顺序：JS 的对象会把 `"10"`、`"9"` 这样整数样子的键
 * 按数值提前，`Object.fromEntries` 排好序也会被它改回去，而 Agent 交给节点的顺序（`serde_json` 的 BTreeMap）是字节序。
 */
function renderJson(value: unknown, style: JsonStyle): string {
	const text = (v: unknown): string => {
		if (Array.isArray(v)) return `[${v.map(text).join(style.item)}]`;
		if (v !== null && typeof v === "object") {
			const entries = Object.entries(v).filter(([, item]) => item !== undefined);
			if (style.sorted) entries.sort(([a], [b]) => compareUtf8(a, b));
			const pairs = entries.map(([k, item]) => `${JSON.stringify(k)}${style.pair}${text(item)}`);
			return `{${pairs.join(style.item)}}`;
		}
		return typeof v === "number" ? style.number(v) : jsonText(v);
	};
	const written = text(value);
	return style.ascii ? asciiEscaped(written) : written;
}

/**
 * 值的标准写法：紧凑、键按字节序排好。节点整个等于一个 secret 对象（{@link SecretParts.containers}）时用它比较，
 * 键的顺序不同也算同一个对象；也是 `testdata/key-order-cases.json` 里两端共用的排序结果。
 */
export const canonicalJson = (value: unknown): string =>
	renderJson(value, { ...COMPACT, sorted: true, ascii: false, number: jsonText });

/** 一个 secret 参数的值拆成的几类要打码的东西，见 {@link secretPartsOf}。 */
export interface SecretParts {
	/** 在文字里按子串换成掩码的文本。 */
	texts: string[];
	/** 值是数字、布尔时，作为节点（不是文字）整个等于它就换成掩码：这些值的 JSON 文本。 */
	scalars: string[];
	/** 值是对象、数组时，作为节点整个等于它就换成掩码：这个值的标准写法（{@link canonicalJson}，键的顺序不同也算相等）。 */
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
 *   - 更短的叶子、布尔、空值不单独打码；整个对象被原样写出时随整段一起盖住：整段的几种写法都算，紧凑写法和
 *     Python `json.dumps` 默认的写法（`", "`、`": "` 分隔），键按节点收到的顺序（Agent 排好的，也是 `sort_keys=True` 的结果）
 *     和按参数里写的顺序，各自带或不带 `\uXXXX` 转义（`ensure_ascii`）。
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
		// 节点（Python）打印数字的写法和控制面写的不一样时，两种都认。
		if (typeof value === "number") texts.add(pythonNumber(value));
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
				texts.add(pythonNumber(leaf));
				parts.scalars.push(jsonText(leaf));
			}
		}
		// 整个对象被原样写出的各种写法：紧凑和 Python 默认的分隔，键按节点收到的顺序（排好序）和参数里写的顺序，
		// 各自带或不带 `\uXXXX` 转义。节点收到的对象，键是 Agent 排过序的，所以排序的那几份才是节点原样写出来的样子。
		// 数字用控制面的写法和节点（Python）打印的写法各写一遍；没有哪个数字两种写法不同时只写一遍。
		const numberWriters = leaves.some(
			(l) => typeof l === "number" && pythonNumber(l) !== jsonText(l),
		)
			? [jsonText, pythonNumber]
			: [jsonText];
		for (const separators of [COMPACT, PYTHON_DEFAULT]) {
			for (const sorted of [true, false]) {
				for (const ascii of [false, true]) {
					for (const number of numberWriters) {
						texts.add(renderJson(value, { ...separators, sorted, ascii, number }));
					}
				}
			}
		}
		parts.containers.push(canonicalJson(value));
	}
	parts.texts = [...texts];
	return parts;
}

/**
 * 单个要打码的文本超过这么长（UTF-16 码元）就不放进正则，改成字面量查找。V8 编译一个太大的正则会抛
 * `Regular expression too large`（单个模式在 32 K 码元上下），报错信息里还带着整个正则的源码，也就是 secret 值本身。
 * 能到这个长度的有长的字符串值（证书链）、对象的整段 JSON、几千个汉字的值（`\uXXXX` 写法是原长的 6 倍）。
 */
const MAX_REGEX_TEXT_CHARS = 1024;

/** 一个正则的源码（转义之后）最长这么长，远低于 V8 的上限；值集合更大时分成几个正则。 */
const MAX_REGEX_SOURCE_CHARS = 8192;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** 把一段源码编译成全局正则；测试里可以换成别的（让它失败），见 {@link SecretSet} 的 `compile` 选项。 */
type Compile = (source: string) => RegExp;
const compileGlobal: Compile = (source) => new RegExp(source, "g");

/** 一份值集合的匹配：几个正则（每个是一批文本的候选），加上不进正则、直接做字面量查找的文本。 */
interface Matcher {
	regexes: readonly RegExp[];
	literals: readonly string[];
}

/** 一批文本分成若干块，每块转义之后的源码不超过 {@link MAX_REGEX_SOURCE_CHARS}（文本已按长度从长到短排好）。 */
function chunksOf(texts: readonly string[]): string[][] {
	const chunks: string[][] = [];
	let current: string[] = [];
	let size = 0;
	for (const text of texts) {
		const escaped = escapeRegExp(text).length + 1;
		if (current.length > 0 && size + escaped > MAX_REGEX_SOURCE_CHARS) {
			chunks.push(current);
			current = [];
			size = 0;
		}
		current.push(text);
		size += escaped;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/**
 * 能进正则的文本编译好的结果，按这批文本缓存；值集合变了就是另一个键，重新编译。读取运行每次都算一份新的 {@link SecretSet}，
 * 同样的值集合不重复编译。编译失败的块的文本（`failed`）退回字面量查找，失败的错误不往外抛、不记录：它的消息里带着正则源码，
 * 也就是 secret 值。
 */
const compiled = new Map<string, { regexes: RegExp[]; failed: string[] }>();
const COMPILED_LIMIT = 64;

function compileInline(inline: readonly string[], compile: Compile | undefined) {
	const build = () => {
		const regexes: RegExp[] = [];
		const failed: string[] = [];
		for (const chunk of chunksOf(inline)) {
			try {
				regexes.push((compile ?? compileGlobal)(chunk.map(escapeRegExp).join("|")));
			} catch {
				failed.push(...chunk);
			}
		}
		return { regexes, failed };
	};
	// 注入的编译器只用于测试，不进共享的缓存。
	if (compile) return build();
	const key = JSON.stringify(inline);
	let found = compiled.get(key);
	if (!found) {
		found = build();
		compiled.set(key, found);
		if (compiled.size > COMPILED_LIMIT) {
			const oldest = compiled.keys().next().value;
			if (oldest !== undefined) compiled.delete(oldest);
		}
	}
	return found;
}

function buildMatcher(texts: readonly string[], compile: Compile | undefined): Matcher {
	const inline = texts.filter((t) => t.length <= MAX_REGEX_TEXT_CHARS);
	const { regexes, failed } = compileInline(inline, compile);
	return {
		regexes,
		literals: [...texts.filter((t) => t.length > MAX_REGEX_TEXT_CHARS), ...failed],
	};
}

/**
 * 打码：先找出每个正则和每个字面量在文字里的全部位置，重叠的合成一段，每段换成一个掩码（相邻但不重叠的各是一个掩码）。
 * 一个正则一次匹配就把匹配到的文字用掉了，从它后面接着找，会漏掉和它重叠的另一个值（`abcd` 和 `cdef` 在 `abcdef` 里重叠）：
 * 所以每找到一个匹配，下一次从它的开头的后一个字符再找。不论值是长是短、走正则还是字面量，重叠的结果都一样，
 * 不会留下一个值的尾巴。
 */
function maskSpans(text: string, matcher: Matcher): string {
	const spans: Array<[number, number]> = [];
	for (const regex of matcher.regexes) {
		regex.lastIndex = 0;
		for (let m = regex.exec(text); m; m = regex.exec(text)) {
			// 要打码的文本都不是空的，所以不会有空匹配；以防万一，往前走一格，不让它死循环。
			if (m[0].length === 0) regex.lastIndex += 1;
			else {
				spans.push([m.index, m.index + m[0].length]);
				regex.lastIndex = m.index + 1;
			}
		}
		regex.lastIndex = 0;
	}
	for (const literal of matcher.literals) {
		for (let at = text.indexOf(literal); at >= 0; at = text.indexOf(literal, at + 1)) {
			spans.push([at, at + literal.length]);
		}
	}
	if (spans.length === 0) return text;
	spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
	let out = "";
	let cursor = 0;
	let [from, to] = spans[0] as [number, number];
	const flush = () => {
		out += text.slice(cursor, from) + SECRET_MASK;
		cursor = to;
	};
	for (const [start, end] of spans.slice(1)) {
		if (start < to) {
			to = Math.max(to, end);
			continue;
		}
		flush();
		[from, to] = [start, end];
	}
	flush();
	return out + text.slice(cursor);
}

/**
 * 一次运行此刻的全部 secret 值要打码的东西（{@link secretPartsOf} 汇总）。不可变：运行里有了新的 secret 值（子流程实例创建）
 * 就是另一个值集合，匹配用的正则按值集合编译、缓存：一批日志、动作经过它时，每一段文字只是一次正则替换，不是每个值各扫一遍
 * （值多的时候逐个扫一遍的代价和值的个数成正比，日志每行都要付）。很长的文本不进正则（{@link MAX_REGEX_TEXT_CHARS}）。
 */
export class SecretSet {
	/** 在文字里按子串换成掩码的文本，长的在前（整段的 JSON 先于它里面的叶子）。 */
	readonly texts: readonly string[];
	/** 作为节点整个等于它就换成掩码的数字、布尔和数字叶子：JSON 文本。 */
	readonly scalars: ReadonlySet<string>;
	/** 作为节点整个等于它就换成掩码的对象和数组：标准写法（{@link canonicalJson}）。 */
	readonly containers: ReadonlySet<string>;
	readonly #compile: Compile | undefined;
	#matcher: Matcher | undefined;
	/** 保密对象和数组的形状：数组的元素个数、对象的键个数、标准写法的长度。读取运行时每个对象和数组都要问「是不是等于它」，先用这些排除。 */
	readonly #arraySizes = new Set<number>();
	readonly #objectSizes = new Set<number>();
	readonly #containerLengths = new Set<number>();
	#shapesKnown = true;

	/** `options.compile` 只给测试用：换掉编译正则的函数，验证它失败时打码照样完成、不抛错。 */
	constructor(parts: Iterable<SecretParts> = [], options: { compile?: Compile } = {}) {
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
		this.#compile = options.compile;
		for (const text of containers) {
			this.#containerLengths.add(text.length);
			try {
				const parsed: unknown = JSON.parse(text);
				if (Array.isArray(parsed)) this.#arraySizes.add(parsed.length);
				else if (parsed !== null && typeof parsed === "object") {
					this.#objectSizes.add(definedKeys(parsed));
				}
			} catch {
				// 标准写法一定是合法的 JSON；万一不是，不用形状排除，每个对象都算标准写法再比。
				this.#shapesKnown = false;
			}
		}
	}

	/**
	 * 这个对象或数组是不是整个等于某个 secret 对象或数组（标准写法相同，键的顺序不同也算相同）。
	 * 算标准写法要排序、写出全部文本，读取运行时每个对象和数组都问一遍，所以先用便宜的办法排除：元素或键的个数，
	 * 再是紧凑写法的长度（排序不改变长度），都对得上才算标准写法再比。
	 */
	equalsContainer(value: object): boolean {
		if (this.containers.size === 0) return false;
		if (this.#shapesKnown) {
			const size = Array.isArray(value) ? value.length : definedKeys(value);
			if (!(Array.isArray(value) ? this.#arraySizes : this.#objectSizes).has(size)) return false;
			if (!this.#containerLengths.has(JSON.stringify(value).length)) return false;
		}
		return this.containers.has(canonicalJson(value));
	}

	/** 没有任何要打码的东西：读取和写入都可以跳过打码。 */
	get isEmpty(): boolean {
		return this.texts.length === 0 && this.scalars.size === 0 && this.containers.size === 0;
	}

	/**
	 * 把文本中出现的 secret 值替换成掩码；里面没有时返回同一个字符串。**不抛错**：读取和写入（尤其是写日志）不能因为打码
	 * 失败而整个失败，万一出了意外（不应该发生），宁可把这段文字整个盖住，也不放行原文；错误本身不往外带，它的消息里可能有值。
	 */
	mask(text: string): string {
		if (this.texts.length === 0) return text;
		try {
			this.#matcher ??= buildMatcher(this.texts, this.#compile);
			return maskSpans(text, this.#matcher);
		} catch {
			return SECRET_MASK;
		}
	}

	/** 每个要打码的文本的第一个码元：找结尾的半截时，只看从这些码元开始的位置。 */
	#firstUnits: ReadonlySet<number> | undefined;

	/**
	 * 一段已经截到 `limit` 个字符（码点）的文字，按 {@link MIN_CLIPPED_PREFIX_CHARS} 把结尾留下的半截 secret 值盖住：
	 * 文字长度到了上限（说明被截断过），结尾又是某个要打码的文本的前缀（不短于下限，又不是整个文本；整个文本由 {@link mask} 换掉）时，
	 * 从这个前缀开头起换成一个掩码。`ellipsis`：截断时末尾补了「…」（失败原因，SDK 和控制面都这样截），判断时不算它，
	 * 盖住时连它一起换掉。长度没到上限的文字原样返回；任何意外同 {@link mask}：整段盖住。
	 */
	maskClippedTail(text: string, limit: number, options: { ellipsis?: boolean } = {}): string {
		if (this.texts.length === 0) return text;
		try {
			// UTF-16 长度不小于码点数：长度不够上限的一定没被截断，不用数码点。
			if (text.length < limit || charCount(text) < limit) return text;
			const body = options.ellipsis && text.endsWith("…") ? text.slice(0, -1) : text;
			const at = this.#clippedTailStart(body);
			return at < 0 ? text : body.slice(0, at) + SECRET_MASK;
		} catch {
			return SECRET_MASK;
		}
	}

	/**
	 * 读取时的打码，用于存下来时被截断过的文字：先 {@link mask}，再 {@link maskClippedTail}。读取运行、读取动作、运行摘要、
	 * 关注项的说明都用这一个。
	 */
	maskClipped(text: string, limit: number, options: { ellipsis?: boolean } = {}): string {
		return this.maskClippedTail(this.mask(text), limit, options);
	}

	/** `body` 的结尾是某个要打码的文本（不是整个）的前缀时，这个前缀开始的位置（最靠前的）；没有时 -1。 */
	#clippedTailStart(body: string): number {
		this.#firstUnits ??= new Set(this.texts.map((t) => t.charCodeAt(0)));
		const first = this.#firstUnits;
		const longest = this.texts[0]?.length ?? 0;
		for (let i = Math.max(0, body.length - longest + 1); i < body.length; i++) {
			if (!first.has(body.charCodeAt(i))) continue;
			const tail = body.slice(i);
			if (charCount(tail) < MIN_CLIPPED_PREFIX_CHARS) return -1;
			for (const text of this.texts) {
				if (text.length > tail.length && text.startsWith(tail)) return i;
			}
		}
		return -1;
	}
}

/** 对象里值不是 undefined 的键的个数（标准写法不写 undefined 的键）。 */
function definedKeys(value: object): number {
	let count = 0;
	for (const key of Object.keys(value)) {
		if ((value as Record<string, unknown>)[key] !== undefined) count += 1;
	}
	return count;
}

/** 没有 secret 值。 */
export const NO_SECRETS: SecretSet = new SecretSet();

/**
 * 值集合的缓存：键是这些值本身（JSON），所以运行里多了一个子流程实例带来的 secret 值，键就变了，另算一份；值一样就是同一份。
 * 写日志的每一批、读取运行的每一次都要问「这次运行此刻的 secret 值」，值没变时不用把每个值的各种写法再写一遍
 * （保密对象有几千个键时，一批要多花十几毫秒），编译好的匹配也跟着复用。
 */
const setCache = new Map<string, SecretSet>();
const SET_CACHE_LIMIT = 64;

/** 把若干 secret 参数的值汇总成一份要打码的东西（{@link SecretSet}）；值相同的是同一个对象（不可变，可以共用）。 */
export function secretSetOf(values: Iterable<unknown>): SecretSet {
	const list = [...values];
	let key: string | undefined;
	try {
		key = JSON.stringify(list);
	} catch {
		key = undefined;
	}
	if (key === undefined) return new SecretSet(list.map(secretPartsOf));
	let found = setCache.get(key);
	if (!found) {
		found = new SecretSet(list.map(secretPartsOf));
		setCache.set(key, found);
		if (setCache.size > SET_CACHE_LIMIT) {
			const oldest = setCache.keys().next().value;
			if (oldest !== undefined) setCache.delete(oldest);
		}
	}
	return found;
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
		if (secrets.equalsContainer(value)) return SECRET_MASK;
		if (Array.isArray(value)) return value.map((item) => mask(item, secrets));
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v, secrets)]));
	}
	return value;
}
