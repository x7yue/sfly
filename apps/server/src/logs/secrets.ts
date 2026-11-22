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

/**
 * 找截断处留下的半截 secret 值时，比较的工作量上限（比较的字符数，每个候选文本另加一份）：超过就把这段文字整个盖住。
 * 正常的输入（几个、几十个值）远在它下面，一次几十到几百；病态的（几千个很长的值、周期性的文字）在 400 万处放弃，约几毫秒。
 */
export const MAX_CLIP_WORK = 4_000_000;

/**
 * 一次读取（一页、一个下载块、流上的一批、一次运行的读取）里所有打码共用的工作量预算（{@link SecretSet.withBudget}；单位同
 * {@link MAX_MASK_WORK} 和 {@link MAX_CLIP_WORK}：找出现位置的字符比较和找半截的字符比较）。单次调用的上限只管一次调用，
 * 一页有几百条动作、上千行日志，每条都用满单次的上限，同步执行的时间就是它们的总和，控制面期间不响应：
 * 所以一次读取共用一个预算，用完之后这次读取里剩下的、还要花工作量才能打码的文字整段盖住（宁可多盖，不漏）。
 * 取 800 万：最坏情况下（周期性的值和文字）大约 25 毫秒（见 PR 里的数字）；正常的读取（几十个值、每行出现几次）一次只用几万。
 */
export const READ_WORK_BUDGET = 8_000_000;

/** 一份工作量预算：剩多少。一次读取里打码用到的每个视图共用同一份。 */
export class WorkBudget {
	remaining: number;
	constructor(total: number = READ_WORK_BUDGET) {
		this.remaining = total;
	}
}

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
	/**
	 * 只有一个正则、没有字面量，并且任何两个要打码的文本都不可能「部分重叠」（一个的结尾是另一个的开头，包括自己和自己：
	 * 周期性的值）。这时一次 `replace` 的结果和「所有出现位置合并重叠」逐字相同，不用找全部位置、不分配：
	 * 部分重叠以外的重叠都是嵌套（一个文本是另一个的子串），正则按长的在前，在最靠前的出现位置上总是取到最长的那个，
	 * 嵌套在里面的随它一起被换掉。构建值集合的匹配时算一次（{@link mayPartiallyOverlap}）。
	 */
	plain: boolean;
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
	const literals = [...texts.filter((t) => t.length > MAX_REGEX_TEXT_CHARS), ...failed];
	return {
		regexes,
		literals,
		plain: regexes.length === 1 && literals.length === 0 && !mayPartiallyOverlap(texts),
	};
}

/** 判断「会不会部分重叠」最多做这么多步（字符比较）；超过时按「会」处理，走合并的路径，结果同样正确，只是慢一点。 */
const OVERLAP_CHECK_STEPS = 2_000_000;

/**
 * 有没有两个文本（可以是同一个）的出现位置会部分重叠：某个文本 X 的一个真后缀等于某个文本 Y 的真前缀。
 * 用所有文本建一棵前缀树，从 X 的每个后缀的开头往下走；走完整个后缀、而且停在还有下文的节点上，说明有更长的 Y 以它开头。
 * 停在没有下文的节点上是 Y 恰好等于这个后缀：Y 嵌套在 X 里，不算。步数超过 {@link OVERLAP_CHECK_STEPS}（很大的值集合、
 * 周期性很强的值）时放弃，按「会部分重叠」处理。
 */
function mayPartiallyOverlap(texts: readonly string[]): boolean {
	interface Node {
		next: Map<number, Node>;
	}
	const root: Node = { next: new Map() };
	let steps = 0;
	for (const text of texts) {
		let node = root;
		for (let i = 0; i < text.length; i++) {
			const unit = text.charCodeAt(i);
			let child = node.next.get(unit);
			if (!child) {
				child = { next: new Map() };
				node.next.set(unit, child);
			}
			node = child;
			if (++steps > OVERLAP_CHECK_STEPS) return true;
		}
	}
	for (const text of texts) {
		for (let from = 1; from < text.length; from++) {
			let node: Node | undefined = root;
			for (let i = from; i < text.length && node; i++) {
				node = node.next.get(text.charCodeAt(i));
				if (++steps > OVERLAP_CHECK_STEPS) return true;
			}
			// 走完了整个后缀（node 还在树里），并且有更长的文本以它开头
			if (node && node !== root && node.next.size > 0) return true;
		}
	}
	return false;
}

/**
 * 一次打码的工作量上限（字符比较的数量，每个出现位置按它的长度加 {@link MASK_WORK_PER_MATCH} 算）：超过就把这段文字整个盖住
 * （宁可多盖，不能让同步的代码卡住控制面）。正常的输入远在它下面：一段 400 万字的输出里出现 100 次 4 万字的值，工作量是 400 万；
 * 取 32 M，最坏情况下（周期性的值和文字）大约 10 毫秒（见 PR 里的数字）。
 */
export const MAX_MASK_WORK = 32_000_000;

/** 每个出现位置固定的一份工作量：它限制了 spans 最多有多少项（32 M / 64 = 50 万项）。 */
const MASK_WORK_PER_MATCH = 64;

/**
 * 打码：先找出每个正则和每个字面量在文字里的全部位置，重叠的合成一段，每段换成一个掩码（相邻但不重叠的各是一个掩码）。
 * 一个正则一次匹配就把匹配到的文字用掉了，从它后面接着找，会漏掉和它重叠的另一个值（`abcd` 和 `cdef` 在 `abcdef` 里重叠）：
 * 所以每找到一个匹配，下一次从它的开头的后一个字符再找。不论值是长是短、走正则还是字面量，重叠的结果都一样，
 * 不会留下一个值的尾巴。
 */
function maskSpans(
	text: string,
	matcher: Matcher,
	tailFrom?: number,
	budget?: WorkBudget,
): string | undefined {
	// 预算已经用完：这一段不再花工作量，调用方整段盖住。
	if (budget && budget.remaining <= 0) return undefined;
	// 单次的上限；给了预算时不超过预算剩下的（预算不大于单次的上限，所以超限就是预算用完）。
	const cap = budget ? Math.min(MAX_MASK_WORK, budget.remaining) : MAX_MASK_WORK;
	const spans: Array<[number, number]> = [];
	// 工作量：每找到一个出现位置，记它的长度加上固定的一份（固定的一份限制 spans 占的内存）。周期性的值在周期性的文字里，
	// 每个位置都是一个出现位置，一次打码的工作量是「文字长 × 值长」，值来自用户、文字来自节点，同步执行会让控制面卡住几秒：
	// 超过上限时放弃，返回 undefined，调用方把这段文字整个盖住。
	let work = 0;
	const spend = (): boolean => {
		if (!budget) return false;
		budget.remaining = work > cap ? 0 : Math.max(0, budget.remaining - work);
		return true;
	};
	for (const regex of matcher.regexes) {
		regex.lastIndex = 0;
		for (let m = regex.exec(text); m; m = regex.exec(text)) {
			// 要打码的文本都不是空的，所以不会有空匹配；以防万一，往前走一格，不让它死循环。
			if (m[0].length === 0) regex.lastIndex += 1;
			else {
				spans.push([m.index, m.index + m[0].length]);
				regex.lastIndex = m.index + 1;
				work += m[0].length + MASK_WORK_PER_MATCH;
				if (work > cap) {
					regex.lastIndex = 0;
					spend();
					return undefined;
				}
			}
		}
		regex.lastIndex = 0;
	}
	for (const literal of matcher.literals) {
		for (let at = text.indexOf(literal); at >= 0; at = text.indexOf(literal, at + 1)) {
			spans.push([at, at + literal.length]);
			work += literal.length + MASK_WORK_PER_MATCH;
			if (work > cap) {
				spend();
				return undefined;
			}
		}
	}
	spend();
	// 截断处留下的半截 secret 值也是一个要盖住的位置（到结尾），和找到的完整出现位置一起合并。
	if (tailFrom !== undefined) spans.push([tailFrom, text.length]);
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
	/** 延迟建好的匹配和按首字符的索引：同一份值集合的各个视图（{@link withBudget}）共用。 */
	readonly #lazy: Lazy;
	/** 这个视图的工作量预算；没有时只受单次调用的上限约束（写入、测试）。 */
	readonly #budget: WorkBudget | undefined;
	/** 保密对象和数组的形状：数组的元素个数、对象的键个数、标准写法的长度。读取运行时每个对象和数组都要问「是不是等于它」，先用这些排除。 */
	readonly #arraySizes: Set<number>;
	readonly #objectSizes: Set<number>;
	readonly #containerLengths: Set<number>;
	#shapesKnown: boolean;

	/**
	 * `options.compile` 只给测试用：换掉编译正则的函数，验证它失败时打码照样完成、不抛错。
	 * `parts` 是另一份 {@link SecretSet} 时是它的另一个视图（带 `options.budget`），见 {@link withBudget}。
	 */
	constructor(
		parts: Iterable<SecretParts> | SecretSet = [],
		options: { compile?: Compile; budget?: WorkBudget } = {},
	) {
		this.#budget = options.budget;
		if (parts instanceof SecretSet) {
			this.texts = parts.texts;
			this.scalars = parts.scalars;
			this.containers = parts.containers;
			this.#compile = parts.#compile;
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
		this.#compile = options.compile;
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
	 * 同一份值集合的一个带工作量预算的视图（{@link WorkBudget}）：一次读取（一页、一个下载块、流上的一批、一次运行的读取）
	 * 开始时取一个，这次读取里的所有打码经过它，共用一份预算；用完之后还要花工作量才能打码的文字整段盖住。
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

	/** 没有任何要打码的东西：读取和写入都可以跳过打码。 */
	get isEmpty(): boolean {
		return this.texts.length === 0 && this.scalars.size === 0 && this.containers.size === 0;
	}

	#matcher(): Matcher {
		this.#lazy.matcher ??= buildMatcher(this.texts, this.#compile);
		return this.#lazy.matcher;
	}

	/**
	 * 这份值集合是怎么匹配的（测试用：确认随机对比两条路径都走到了）：`plain` 是「一次 replace」的路径，否则是合并位置的路径。
	 */
	matching(): { regexes: number; literals: number; plain: boolean } {
		const { regexes, literals, plain } = this.#matcher();
		return { regexes: regexes.length, literals: literals.length, plain };
	}

	/**
	 * 把文本中出现的 secret 值替换成掩码；里面没有时返回同一个字符串。**不抛错**：读取和写入（尤其是写日志）不能因为打码
	 * 失败而整个失败，万一出了意外（不应该发生），宁可把这段文字整个盖住，也不放行原文；错误本身不往外带，它的消息里可能有值。
	 */
	mask(text: string): string {
		if (this.texts.length === 0) return text;
		try {
			const matcher = this.#matcher();
			// 不会部分重叠、只有一个正则：一次 replace，结果和合并的路径逐字相同（{@link Matcher.plain}）。
			if (matcher.plain) return text.replace(matcher.regexes[0] as RegExp, SECRET_MASK);
			return maskSpans(text, matcher, undefined, this.#budget) ?? SECRET_MASK;
		} catch {
			return SECRET_MASK;
		}
	}

	/**
	 * 打码一段存下来时可能被截断过的文字（日志类异常的说明、动作的名称、字段、失败原因，上限 `limit` 个字符（码点））：
	 * 先看这段文字有没有可能被截断过，有的话，结尾是某个要打码的文本的前缀（不短于 {@link MIN_CLIPPED_PREFIX_CHARS}，又不是整个文本；
	 * 整个文本是完整的出现，和其余的完整出现一样换掉）时，从这个前缀开头起到结尾也换成掩码，前面的部分照常打码。
	 *
	 * 「可能被截断过」和结尾的前缀都按**这段文字本身**（打码之前）判断：长度到了上限；或者里面已经有掩码（写入时打过码的文字比原文短，
	 * 看长度认不出它被截断过，后来才成为 secret 的另一个值的半截可能就在结尾）。按打码之后的长度判断是错的：同一段文字前面完整出现过
	 * 一次 secret 值，换成掩码后变短了，到不了上限，结尾那半截就没人管了。
	 *
	 * `ellipsis`：截断时末尾补了「…」（失败原因，SDK 和控制面都这样截），判断时不算它，盖住时连它一起换掉。长度没到上限的文字就是
	 * {@link mask}。任何意外同 {@link mask}：整段盖住。工作量超过 {@link MAX_CLIP_WORK}（或这个视图的预算）时也整段盖住，宁可多盖。
	 */
	maskClipped(text: string, limit: number, options: { ellipsis?: boolean } = {}): string {
		if (this.texts.length === 0) return text;
		try {
			// UTF-16 长度不小于码点数：长度不够上限的一定没被截断，不用数码点。
			const atLimit = text.length >= limit && charCount(text) >= limit;
			if (!atLimit && !text.includes(SECRET_MASK)) return this.mask(text);
			const body = options.ellipsis && text.endsWith("…") ? text.slice(0, -1) : text;
			const at = this.#clippedTailStart(body);
			// 工作量超过上限：把这段文字整个盖住，宁可多盖。
			if (at === undefined) return SECRET_MASK;
			if (at < 0) return this.mask(text);
			return maskSpans(body, this.#matcher(), at, this.#budget) ?? SECRET_MASK;
		} catch {
			return SECRET_MASK;
		}
	}

	/**
	 * `body` 的结尾是某个要打码的文本（不是整个）的前缀时，这个前缀开始的位置（最靠前的）；没有时 -1；
	 * 比较的工作量超过 {@link MAX_CLIP_WORK}（或这个视图的预算）时是 undefined（调用方把整段盖住）。
	 *
	 * 最坏的情形是每个位置都以某个文本的首字符开头、却永远对不上前缀，文本又长又多（值来自用户，文字来自节点）：
	 * 位置数 × 文本数 × 文本长，量过：3000 个各 3000 个字符的值、4096 个字符的文字，29–34 秒。所以按比较的字符数记工作量，
	 * 每看一个候选文本也记一份。
	 */
	#clippedTailStart(body: string): number | undefined {
		const budget = this.#budget;
		if (budget && budget.remaining <= 0) return undefined;
		const cap = budget ? Math.min(MAX_CLIP_WORK, budget.remaining) : MAX_CLIP_WORK;
		if (!this.#lazy.byFirstUnit) {
			const byFirst = new Map<number, string[]>();
			for (const text of this.texts) {
				const unit = text.charCodeAt(0);
				const list = byFirst.get(unit);
				if (list) list.push(text);
				else byFirst.set(unit, [text]);
			}
			this.#lazy.byFirstUnit = byFirst;
		}
		const byFirstUnit = this.#lazy.byFirstUnit;
		const longest = this.texts[0]?.length ?? 0;
		let work = 0;
		const done = (result: number | undefined): number | undefined => {
			if (budget)
				budget.remaining = result === undefined ? 0 : Math.max(0, budget.remaining - work);
			return result;
		};
		for (let i = Math.max(0, body.length - longest + 1); i < body.length; i++) {
			const candidates = byFirstUnit.get(body.charCodeAt(i));
			if (!candidates) continue;
			const tailLength = body.length - i;
			// 结尾不到 {@link MIN_CLIPPED_PREFIX_CHARS} 个字符（码点）时更靠后的位置也不够：不盖。不少于 8 个码元一定不少于 4 个码点。
			if (
				tailLength < MIN_CLIPPED_PREFIX_CHARS * 2 &&
				charCount(body.slice(i)) < MIN_CLIPPED_PREFIX_CHARS
			) {
				return done(-1);
			}
			for (const text of candidates) {
				work += 1;
				if (text.length <= tailLength) continue;
				let k = 1;
				// 第一个码元已经相同；逐个比较，不分配
				while (k < tailLength && text.charCodeAt(k) === body.charCodeAt(i + k)) k += 1;
				work += k;
				if (k === tailLength) return done(i);
				if (work > cap) return done(undefined);
			}
			if (work > cap) return done(undefined);
		}
		return done(-1);
	}
}

/** 一份值集合延迟建好的东西（匹配、按首字符的索引）。 */
interface Lazy {
	matcher?: Matcher;
	/** 每个要打码的文本，按它的第一个码元分组：找结尾的半截时，每个位置只和同一个码元开头的文本比。 */
	byFirstUnit?: ReadonlyMap<number, readonly string[]>;
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
const setCache = new Map<string, { set: SecretSet; chars: number }>();
/** 最多缓存这么多份。 */
const SET_CACHE_LIMIT = 64;
/**
 * 缓存里所有值集合的文本总长（字符数）的上限。一份集合的大小主要是它的文本的总长：保密对象有几千个键时一份约 0.3 M 个字符，
 * 40 KB 的字符串约 4 万个；只按条数限制的话，64 份大集合会占到几十 MB。V8 的字符串每个字符 1–2 个字节，8 M 个字符
 * 最多占 16 MB。这个数是按字符数推出来的（量堆内存受垃圾回收影响，数字不稳，没有当依据）；超过时从最早的开始丢（不做 LRU：
 * 一次运行用到的集合很快就被新的运行替换，丢掉的只是重算一次），最新的这一份总是留着。
 */
const SET_CACHE_MAX_CHARS = 8_000_000;
let setCacheChars = 0;

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
	const chars = set.texts.reduce((n, t) => n + t.length, 0);
	setCache.set(key, { set, chars });
	setCacheChars += chars;
	// 条数或总长超了，从最早的开始丢，最新的这一份留着。
	while (
		setCache.size > 1 &&
		(setCache.size > SET_CACHE_LIMIT || setCacheChars > SET_CACHE_MAX_CHARS)
	) {
		const oldest = setCache.entries().next().value;
		if (!oldest) break;
		setCache.delete(oldest[0]);
		setCacheChars -= oldest[1].chars;
	}
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
