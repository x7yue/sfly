import { SECRET_MASK, type StoredOrchestrationDocument, TOKEN_VALUE_PATTERN } from "@sfly/schema";
import {
	type Automaton,
	automatonBytes,
	buildAutomaton,
	MAX_AUTOMATON_CHARS,
	MAX_SPANS,
	maskedByAutomaton,
	maskedRegion,
	mergeSpans,
	scanSpans,
} from "./aho-corasick.js";

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
 * 把文本中的令牌原值（`sfly_pat_…`、`sfly_prj_…` 等，{@link TOKEN_VALUE_PATTERN}）换成掩码。令牌原值只在签发那一次的响应里
 * 出现，不该出现在任何日志和视图里；它不是某次运行的 secret 参数，没法按值打码，所以按前缀认：不用先知道是哪个令牌，
 * 没有 secret 参数的运行也一样（节点把环境里的令牌打印出来、把令牌写进输出，都是这条规则拦住）。宁可多盖，不能漏。
 * 它是 {@link SecretSet.mask} 的一部分，读取和写入走的是同一处，不另有一套。
 */
export function maskTokens(text: string): string {
	const tokens = tokenSpans(text);
	if (!tokens) return text;
	return maskedByAutomaton(text, mergeSpans(0, tokens.starts, tokens.ends), SECRET_MASK);
}

/**
 * 认令牌用的正则：自己的一份（从 {@link TOKEN_VALUE_PATTERN} 复制，不导出）。`TOKEN_VALUE_PATTERN` 是 `@sfly/schema` 导出的带 `g` 标志的
 * 共享对象，`matchAll` 从它当时的 `lastIndex` 开始找：别处只要对它调过一次 `test()`、`exec()`，打码就会漏掉文字开头的令牌。
 * 打码不能靠「别人不碰」，所以这里用不对外的一份，`lastIndex` 永远是 0。
 */
const TOKEN_SCAN = new RegExp(TOKEN_VALUE_PATTERN.source, TOKEN_VALUE_PATTERN.flags);

/** 文字里令牌原值的出现（{@link TOKEN_VALUE_PATTERN}）：起止位置，按开头排好、互相不重叠；没有时为 undefined。只在文字里有 `sfly_` 时才扫。 */
function tokenSpans(text: string): { starts: number[]; ends: number[] } | undefined {
	if (!text.includes("sfly_")) return undefined;
	const starts: number[] = [];
	const ends: number[] = [];
	for (const match of text.matchAll(TOKEN_SCAN)) {
		starts.push(match.index);
		ends.push(match.index + match[0].length);
	}
	return starts.length > 0 ? { starts, ends } : undefined;
}

/**
 * 值是对象或数组的 secret 参数，它里面的字符串、数字叶子按值打码的最短长度（字符数；数字按它的 JSON 文本算）。
 * 更短的叶子（`a`、`1`、`on`）多是配置里的标签和开关，不是凭据：按子串打码会把日志、错误、输出整片换掉，读不了
 * （#479 的决定）；它们只在整个对象被原样写出时随整段一起盖住，另给一条警告（`secret_short_leaf`）。
 * 值本身是字符串、数字、布尔的 secret 参数不受这个下限限制：使用者对这一个值明确说了保密，再短也打码。
 */
export const MIN_LEAF_CHARS = 4;

/**
 * 一次读取（一页、一个下载块、流上的一批、一次运行的读取）里所有打码共用的预算（{@link SecretSet.withBudget}）。
 * 预算只记一样东西：**完整的出现的次数**（`masks`，合并重叠之后的段数）。每段输出多一个掩码，限住它，输出才不会被撑大
 * （一个字符的保密值，文字里每个位置都是它，每个位置换成六个字符的掩码）；用完之后，这次读取里还有完整的出现的文字整段盖住
 * （宁可多盖，不漏），没有完整的出现的文字原样。它和保密值的内容无关（完整的出现本身除外），所以 docs/SEMANTICS.md §2.1 的规矩没有例外。
 *
 * 没有「扫过的字符数」的预算：扫描的耗时和读到的文字成正比，每个字符最坏是总长上限（{@link MAX_AUTOMATON_CHARS}）处最刁钻的形状下
 * 的耗时，每个读取出口读多少由它自己的上限管（一页日志的字节上限、单个输入输出的 1 MiB）；再设一个会把正常的内容整段盖住的数，
 * 比读得慢更糟。
 */
export const READ_MASKS = MAX_SPANS;

/**
 * 值集合的缓存（{@link secretSetOf}）最多占这么多字节：值集合的文本，加上建好的自动机（{@link automatonBytes}）。
 * 至少放得下 8 份总长到上限（{@link MAX_AUTOMATON_CHARS}）的值集合：实测最大的一份（一个 100 万字符的值）自动机 16 MiB、加文本 18 MiB，
 * 8 份 143 MiB；同时在读的运行最多几份大的，交替读不会每次都重建。自动机的数组在堆外。
 */
export const SET_CACHE_MAX_BYTES = 160 * 1024 * 1024;

/**
 * 这几个上限，是可以改的对象，只给测试用：测试把它们调小，用几十 KB 的文字就能让一次读取用完预算、让一份值集合大到建不了自动机，
 * 验证每个读取出口都取了预算、一个运行的值集合太大只盖住它自己（真实的上限要上百万个字符才碰得到）。改它之前要清掉值集合的缓存
 * （{@link clearSecretSetCache}）：缓存里的值集合是按旧的上限建的。
 */
export const secretLimits = {
	/** 一次读取（一次写入）里完整的出现最多多少段（{@link READ_MASKS}）。 */
	readMasks: READ_MASKS,
	/** 一份值集合所有写法的总长最多多少（{@link MAX_AUTOMATON_CHARS}）。 */
	automatonChars: MAX_AUTOMATON_CHARS,
	/** 值集合的缓存最多占多少字节（{@link SET_CACHE_MAX_BYTES}）。 */
	cacheBytes: SET_CACHE_MAX_BYTES,
};

/** 一份读取的预算：剩多少。一次读取里打码用到的这个运行的值集合的视图共用同一份（每个运行各一份）。 */
export class WorkBudget {
	/** 还能有多少段完整的出现（合并重叠之后）。 */
	masks: number;
	constructor(masks: number = secretLimits.readMasks) {
		this.masks = masks;
	}
}

/**
 * 值集合太大（所有写法的总长超过 {@link MAX_AUTOMATON_CHARS}）的运行，在它的任务日志里写的一行说明（平台写的，不含任何值）。
 * 这个运行里所有要打码的文字都整段盖住，这一行是用户知道为什么的地方：打码时只有它自己原样放行（{@link SecretSet.mask}）。
 */
export const OVERSIZE_NOTICE = `这次运行的 secret 参数的值太多或太长（所有写法合计超过 ${MAX_AUTOMATON_CHARS} 个字符），无法逐个认出，这次运行里日志、动作、运行视图里的文字全部显示为 ${SECRET_MASK}。缩短或减少 secret 参数的值之后重新运行。`;

/**
 * 被拆开的超长行的每一段带的上下文（`LogLine.before` / `after`）最多这么多个字符：Agent 一端最多 16 KiB 字节
 * （agent/src/logs.rs 的 `SPLIT_CONTEXT_BYTES`），字符数不会比字节数多。超过的（不是正常的 Agent 发的）按没带处理，不报错。
 */
export const SPLIT_CONTEXT_MAX_CHARS = 16 * 1024;

/** 值的 JSON 文本（`JSON.stringify` 返回不了文本的值，例如 undefined，退回 `String`）。 */
export const jsonText = (value: unknown): string => JSON.stringify(value) ?? String(value);

/**
 * 一个字符串的字符数（Unicode 码点，一个 emoji 算一个）：和 `Array.from(text).length`、Python 的 `len` 一致，孤立的代理项各算一个；
 * 不分配数组（读取时每段到了上限的文字都要数一遍）。
 */
export function charCount(text: string): number {
	let count = text.length;
	for (let i = 0; i + 1 < text.length; i++) {
		const unit = text.charCodeAt(i);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				count -= 1;
				i += 1;
			}
		}
	}
	return count;
}

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
 * （emoji）会排到 U+E000–U+FFFF 的字符前面。在**良构**的字符串（没有孤立的代理项）上，它和
 * `Buffer.compare(Buffer.from(a), Buffer.from(b))` 的符号一致，但排序时每次比较要分配两个 Buffer，这里在第一个不同的码元上比，
 * 不分配；test/secret-texts.test.ts 在良构的随机字符串上和 `Buffer.compare` 对比。**孤立的代理项上两者不同**
 * （`Buffer.from` 把它写成 U+FFFD 的三个字节，这里按码元比）：它们进不了 jsonb，也过不了 serde_json，对象的键里碰不到，
 * 所以这里不处理。
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

/**
 * Agent（`serde_json`）把一个数字写进 task.json 的写法：节点读 `SFLY_TASK` 指向的文件再原样打印它的文本时，看到的是这种写法。
 * Agent 把控制面写的数字文本解析成 `serde_json::Value` 再写出：
 * 64 位整数范围里的整数是整数，写法和控制面一样；超出范围的按浮点解析，写法和 Python 一样（{@link pythonNumber}）；
 * 带小数的，serde 的科学计数法**不补零**，只在绝对值小于 1e-5 时才用（和 JS 一样 1e-7 写成 `1e-7`，但 JS 到 1e-7 才换科学计数法）：
 * 绝对值在 [1e-6, 1e-5) 的数，控制面写 `0.000001`，serde 写 `1e-6`（Python 写 `1e-06`），是第三种写法；其余和控制面一样。
 *
 * **这条规则绑在 serde_json 的版本上**（用例表 `testdata/number-form-cases.json` 的 `serde` 列是真实 serde_json 的输出）：
 * serde_json 升级后写法变了，Agent 一端的断言（`agent/tests/number_forms.rs`）先红，红了就要改这里并更新表里的 `serde` 列。
 */
export function serdeNumber(n: number): string {
	const text = jsonText(n);
	if (!Number.isFinite(n)) return text;
	if (/^-?\d+$/.test(text)) {
		const whole = BigInt(text);
		if (whole >= I64_MIN && whole <= U64_MAX) return text;
		return pythonNumber(n);
	}
	const abs = Math.abs(n);
	if (abs >= 1e-6 && abs < 1e-5) return n.toExponential();
	return text;
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
		if (typeof value === "number") texts.add(pythonNumber(value)).add(serdeNumber(value));
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
				texts.add(serdeNumber(leaf));
				parts.scalars.push(jsonText(leaf));
			}
		}
		// 整个对象被原样写出的各种写法：紧凑和 Python 默认的分隔，键按节点收到的顺序（排好序）和参数里写的顺序，
		// 各自带或不带 `\uXXXX` 转义。节点收到的对象，键是 Agent 排过序的，所以排序的那几份才是节点原样写出来的样子。
		// 数字用控制面的写法、节点（Python）打印的写法、Agent 写进 task.json 的写法各写一遍（整个值一起换一种写数字的规则；
		// 同一个值里的两类数字在 task.json 里是两种写法混在一起的，那一份是「serde」那一遍）；
		// 没有哪个数字的写法不同时，只有 JS 的那一遍，Set 去重。写法个数是常数（3），不随数字的个数增长。
		const hasVaryingNumber = leaves.some(
			(l) =>
				typeof l === "number" &&
				(pythonNumber(l) !== jsonText(l) || serdeNumber(l) !== jsonText(l)),
		);
		const numberWriters = hasVaryingNumber ? [jsonText, pythonNumber, serdeNumber] : [jsonText];
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
 * 一次运行此刻的全部 secret 值要打码的东西（{@link secretPartsOf} 汇总）。不可变：运行里有了新的 secret 值（子流程实例创建）
 * 就是另一个值集合，匹配用的自动机（{@link buildAutomaton}）按值集合建一次、跟着这份集合缓存：一批日志、动作经过它时，每一段文字
 * 只是线性的一遍扫描。所有写法的总长超过 {@link MAX_AUTOMATON_CHARS} 的值集合建不了自动机（总长有上限，每一步的耗时才有上限），
 * 这个运行里要打码的文字（写入和读取）整段盖住，只影响它自己；这次运行的任务日志里有一行说明（{@link OVERSIZE_NOTICE}）。
 */
export class SecretSet {
	/** 在文字里按子串换成掩码的文本，长的在前（整段的 JSON 先于它里面的叶子）。 */
	readonly texts: readonly string[];
	/** 作为节点整个等于它就换成掩码的数字、布尔和数字叶子：JSON 文本。 */
	readonly scalars: ReadonlySet<string>;
	/** 作为节点整个等于它就换成掩码的对象和数组：标准写法（{@link canonicalJson}）。 */
	readonly containers: ReadonlySet<string>;
	/** 延迟建好的自动机：同一份值集合的各个视图（{@link withBudget}）共用。 */
	readonly #lazy: Lazy;
	/** 这个视图的预算；没有时只受单次的上限（{@link READ_MASKS}）约束（写入、测试）。 */
	readonly #budget: WorkBudget | undefined;
	/** 保密对象和数组的形状：数组的元素个数、对象的键个数、标准写法的长度。读取运行时每个对象和数组都要问「是不是等于它」，先用这些排除。 */
	readonly #arraySizes: Set<number>;
	readonly #objectSizes: Set<number>;
	readonly #containerLengths: Set<number>;
	#shapesKnown: boolean;

	/** `parts` 是另一份 {@link SecretSet} 时是它的另一个视图（带 `options.budget`），见 {@link withBudget}。 */
	constructor(
		parts: Iterable<SecretParts> | SecretSet = [],
		options: { budget?: WorkBudget } = {},
	) {
		this.#budget = options.budget;
		if (parts instanceof SecretSet) {
			this.texts = parts.texts;
			this.scalars = parts.scalars;
			this.containers = parts.containers;
			this.#lazy = parts.#lazy;
			this.#arraySizes = parts.#arraySizes;
			this.#objectSizes = parts.#objectSizes;
			this.#containerLengths = parts.#containerLengths;
			this.#shapesKnown = parts.#shapesKnown;
			return;
		}
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
		this.#lazy = {};
		this.#arraySizes = new Set();
		this.#objectSizes = new Set();
		this.#containerLengths = new Set();
		this.#shapesKnown = true;
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
	 * 同一份值集合的一个带预算的视图（{@link WorkBudget}）：一次读取（一页、一个下载块、流上的一批、一次运行的读取）
	 * 开始时取一个，这次读取里的所有打码经过它，共用一份预算；用完之后还有完整的出现的文字整段盖住。
	 * 值集合本身不可变、可以按值缓存和共用（{@link secretSetOf}），预算是每次读取自己的，所以放在视图上，不放在缓存的集合上。
	 * `budget` 给了就用它（一次读取涉及几个运行的值集合时，几个视图共用一份）。没有要打码的东西时返回自己。
	 */
	withBudget(budget: WorkBudget = new WorkBudget()): SecretSet {
		return this.isEmpty ? this : new SecretSet(this, { budget });
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

	/**
	 * 没有任何按值要打码的东西（不含令牌原值：那一条按前缀认，对每个集合都生效，见 {@link maskTokens}）。
	 * 为真时不用比对 secret 值，只剩令牌原值的前缀检查。
	 */
	get isEmpty(): boolean {
		return this.texts.length === 0 && this.scalars.size === 0 && this.containers.size === 0;
	}

	/**
	 * 这份值集合的自动机；所有写法的总长超过 {@link MAX_AUTOMATON_CHARS} 时没有（调用方把文字整段盖住）。
	 * 同一份值集合建一次，所有视图共用。
	 */
	#automaton(): Automaton | undefined {
		if (!this.#lazy.built) {
			this.#lazy.automaton = buildAutomaton(this.texts, secretLimits.automatonChars);
			this.#lazy.built = true;
			this.#lazy.watch?.(this.#lazy.automaton ? automatonBytes(this.#lazy.automaton) : 0);
		}
		return this.#lazy.automaton;
	}

	/** 自动机建好时通知一次（建好的字节数）：值集合的缓存按字节数限大小，只给 {@link secretSetOf} 用。已经建好的立刻通知。 */
	watchBuild(watch: (bytes: number) => void): void {
		this.#lazy.watch = watch;
		if (this.#lazy.built) watch(this.#lazy.automaton ? automatonBytes(this.#lazy.automaton) : 0);
	}

	/** 值集合的某个写法恰好就是 {@link OVERSIZE_NOTICE}：是的话那句话也是值，照样整段盖住。每份值集合只算一次。 */
	#noticeIsValue(): boolean {
		this.#lazy.noticeIsValue ??= this.texts.includes(OVERSIZE_NOTICE);
		return this.#lazy.noticeIsValue;
	}

	/** 这份值集合是不是大到建不了自动机（所有写法的总长超过 {@link MAX_AUTOMATON_CHARS}）：打码时每段文字都整段盖住（{@link OVERSIZE_NOTICE}）。 */
	get oversize(): boolean {
		return this.texts.length > 0 && this.#automaton() === undefined;
	}

	/**
	 * 把文本中出现的 secret 值和令牌原值（{@link maskTokens}）替换成掩码；里面没有时返回同一个字符串。**不抛错**：读取和写入
	 * （尤其是写日志）不能因为打码失败而整个失败，万一出了意外（不应该发生），宁可把这段文字整个盖住，也不放行原文；
	 * 错误本身不往外带，它的消息里可能有值。
	 *
	 * 输出是「所有完整的出现，重叠的合成一段，每段一个掩码（相邻但不重叠的各是一段）」。两种出现（secret 值的各种写法、令牌原值）
	 * 都在**原文**上找，合成一组、一次换掉：不分先后，一种的结果不会成为另一种的输入（先换一种再换另一种，前一遍留下的掩码
	 * 会让后一遍认不出挨着、重叠的那一半）。打不打码只取决于文字里有没有完整的出现；任何「部分匹配」（文字的结尾是某个值的前缀、
	 * 开头是某个值的后缀）都不影响输出，也不影响用掉的预算、走的步数：输出里有没有掩码不能成为猜 secret 值的依据
	 * （docs/SEMANTICS.md §2.1）。带预算的视图（{@link withBudget}）上，合并之后的段数（两种出现一起）计入预算，不够时整段盖住。
	 * 值集合太大（{@link oversize}）时每段文字整段盖住，只有一行平台写的说明（{@link OVERSIZE_NOTICE}，不含值）原样放行。
	 */
	mask(text: string): string {
		if (text === "") return text;
		if (this.texts.length === 0) return maskTokens(text);
		try {
			const automaton = this.#automaton();
			if (!automaton)
				return text === OVERSIZE_NOTICE && !this.#noticeIsValue() ? text : SECRET_MASK;
			const budget = this.#budget;
			let count = scanSpans(automaton, text, budget ? budget.masks : MAX_SPANS);
			if (count < 0) {
				if (budget) budget.masks = 0;
				return SECRET_MASK;
			}
			const tokens = tokenSpans(text);
			if (tokens) count = mergeSpans(count, tokens.starts, tokens.ends);
			if (count === 0) return text;
			if (budget) {
				if (count > budget.masks) {
					budget.masks = 0;
					return SECRET_MASK;
				}
				budget.masks -= count;
			}
			return maskedByAutomaton(text, count, SECRET_MASK);
		} catch {
			return SECRET_MASK;
		}
	}

	/**
	 * 被 Agent 拆开的超长行的一段（`LogLine.before` / `after`，docs/SEMANTICS.md §2.1）：`text` 是这一段，`before`、`after` 是同一行里
	 * 前一段的结尾和后一段的开头，只用来打码，不显示。在 `before + text + after` 上认完整的出现（secret 值和令牌原值，规则同 {@link mask}），
	 * 只输出 `text` 那一段：开头落在 `text` 里的出现整个换成一个掩码（超出 `text` 末尾的部分不输出），开头在 `before` 里的出现落在 `text`
	 * 里的部分去掉（前一段已经盖住了）。一个跨在拆分处的值因此只出现一个掩码，几段接起来和不拆时一样。结果只取决于这三段文字，
	 * 不取决于别的段有没有到、先后、重发。每种写法的长度都不超过上下文的值保证认得出；更长的不保证（不论跨几段：拆分处附近可能露出一部分，也可能只去掉而不留掩码），但不出错，每一段露出的位置不比不带上下文时多。
	 * 只用在写入（不带预算）；两段上下文都是空串时就是 {@link mask}。值集合太大时同 {@link mask}：整段盖住。
	 */
	maskInContext(text: string, before: string, after: string): string {
		if (before === "" && after === "") return this.mask(text);
		if (text === "") return text;
		try {
			const window = before + text + after;
			let count = 0;
			if (this.texts.length > 0) {
				const automaton = this.#automaton();
				if (!automaton) return this.mask(text);
				count = scanSpans(automaton, window, MAX_SPANS);
				if (count < 0) return SECRET_MASK;
			}
			const tokens = tokenSpans(window);
			if (tokens) count = mergeSpans(count, tokens.starts, tokens.ends);
			if (count === 0) return text;
			return maskedRegion(window, count, before.length, before.length + text.length, SECRET_MASK);
		} catch {
			return SECRET_MASK;
		}
	}

	/**
	 * {@link mask} 会不会改动这段文字（令牌原值也算），不看预算、不计入预算：只回答「有没有要盖的」，
	 * 用来在没有要盖的时候省掉后面的处理（日志下载的一行里没有要盖的就原样返回）。值集合太大时总是会（整段盖住）。
	 */
	wouldChange(text: string): boolean {
		if (tokenSpans(text) !== undefined) return true;
		if (this.texts.length === 0 || text === "") return false;
		try {
			const automaton = this.#automaton();
			if (!automaton) return text !== OVERSIZE_NOTICE || this.#noticeIsValue();
			return scanSpans(automaton, text, 1) !== 0;
		} catch {
			return true;
		}
	}
}

/** 一份值集合延迟建好的东西（自动机；`built` 为 true 而 `automaton` 没有，是太大建不了）。 */
interface Lazy {
	automaton?: Automaton | undefined;
	built?: boolean;
	/** 建好时通知（{@link SecretSet.watchBuild}）。 */
	watch?: (bytes: number) => void;
	/** 值集合的某个写法恰好就是 {@link OVERSIZE_NOTICE}（算一次：说明那一行每出现一次都要问，不能每次扫一遍所有的值）。 */
	noticeIsValue?: boolean;
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
 * （保密对象有几千个键时，一批要多花十几毫秒），建好的自动机也跟着复用。
 *
 * 按占用的字节数限大小（{@link SET_CACHE_MAX_BYTES}）：一份值集合占它的文本（每个字符按 2 字节算），加上建好的自动机
 * （{@link automatonBytes}，建好之后才计入）。自动机每个节点约 11 字节，另有最多 4 MB 的转移表和 256 KB 的字符类表，和总长无关，
 * 所以按文本总长限不住：64 份各 6 万个字符的小集合，自动机合计占堆外 340 MB。超过时从最早的开始丢（不做 LRU：一次运行用到的
 * 集合很快就被新的运行替换，丢掉的只是重算一次），最新的这一份总是留着；至多缓存 {@link SET_CACHE_LIMIT} 份。
 */
const setCache = new Map<string, { set: SecretSet; bytes: number }>();
/** 最多缓存这么多份。 */
const SET_CACHE_LIMIT = 64;
let setCacheBytes = 0;

function trimSetCache(): void {
	while (
		setCache.size > 1 &&
		(setCache.size > SET_CACHE_LIMIT || setCacheBytes > secretLimits.cacheBytes)
	) {
		const oldest = setCache.entries().next().value;
		if (!oldest) break;
		setCache.delete(oldest[0]);
		setCacheBytes -= oldest[1].bytes;
	}
}

/** 清掉值集合的缓存（只给测试用：改了 {@link secretLimits} 之后，缓存里按旧的上限建的值集合不能再用）。 */
export function clearSecretSetCache(): void {
	setCache.clear();
	setCacheBytes = 0;
}

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
	const found = setCache.get(key);
	if (found) return found.set;
	const set = new SecretSet(list.map(secretPartsOf));
	const entry = { set, bytes: 2 * set.texts.reduce((n, t) => n + t.length, 0) };
	setCache.set(key, entry);
	setCacheBytes += entry.bytes;
	// 自动机是用到的时候才建的：建好之后把它的字节数计入，再看要不要丢旧的（这份已经被丢了的就不计）。
	set.watchBuild((bytes) => {
		if (setCache.get(key) !== entry) return;
		entry.bytes += bytes;
		setCacheBytes += bytes;
		trimSetCache();
	});
	trimSetCache();
	return set;
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
	if (!record) return record;
	return unchangedOr(
		record,
		Object.entries(record).map(([key, value]) => [key, mask(value, secrets)] as const),
	);
}

function mask(value: unknown, secrets: SecretSet): unknown {
	if (typeof value === "string") return secrets.mask(value);
	if (typeof value === "number" || typeof value === "boolean") {
		return secrets.scalars.has(jsonText(value)) ? SECRET_MASK : value;
	}
	if (value !== null && typeof value === "object") {
		if (secrets.equalsContainer(value)) return SECRET_MASK;
		if (Array.isArray(value)) {
			const items = value.map((item) => mask(item, secrets));
			return items.every((item, i) => item === value[i]) ? value : items;
		}
		return unchangedOr(
			value,
			Object.entries(value).map(([k, v]) => [k, mask(v, secrets)] as const),
		);
	}
	return value;
}

/**
 * 逐个处理过的键值对：没有任何一个变化就返回原来的对象，不复制。令牌原值的前缀检查对每个运行都生效（没有 secret 参数的也是），
 * 读取时每个输出都要走一遍；绝大多数没有变化，不为它们每次都复制整份输出。
 */
function unchangedOr<T extends object>(
	original: T,
	masked: ReadonlyArray<readonly [string, unknown]>,
): T {
	const before = Object.values(original);
	if (masked.every(([, value], i) => value === before[i])) return original;
	return Object.fromEntries(masked) as T;
}
