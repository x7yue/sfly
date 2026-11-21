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

/** 值的 JSON 文本（`JSON.stringify` 返回不了文本的值，例如 undefined，退回 `String`）。 */
export const jsonText = (value: unknown): string => JSON.stringify(value) ?? String(value);

/** 非 ASCII 字符写成 `\uXXXX`（Python 的 `json.dumps` 默认这样写，小写十六进制）。 */
const asciiEscaped = (text: string): string =>
	text.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/**
 * 一个字符串在文字里可能出现的写法：原文；放进 JSON 之后引号、反斜杠、换行是转义的，所以再加上转义后的写法；
 * 有非 ASCII 字符时再加上 `\uXXXX` 的写法。没有要转义的字符时只有一份。
 */
function writtenForms(text: string, into: Set<string>): void {
	into.add(text);
	const inner = JSON.stringify(text).slice(1, -1);
	into.add(inner);
	into.add(asciiEscaped(inner));
}

/** 对象和数组里的每个字符串叶子（嵌套的也算）；键是结构，不是值，不算。 */
function stringLeaves(value: unknown, into: string[]): void {
	if (typeof value === "string") into.push(value);
	else if (Array.isArray(value)) for (const item of value) stringLeaves(item, into);
	else if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) stringLeaves(item, into);
	}
}

/**
 * 一个 secret 参数的值，打码时要换掉的全部文本（不论值是什么类型，这是 secret 值进入「要打码的值」的唯一一处，
 * 读取运行、写日志和动作、触发时的报错用的是同一份）：
 *
 * - 字符串：值本身，加上它在 JSON 里的转义写法（{@link writtenForms}）；空串不算。
 * - 数字、布尔：JSON 文本（`4242`、`true`）。
 * - 对象、数组：整段 JSON 文本，加上每个字符串叶子（嵌套的也算，同样带转义写法）。数字、布尔、null 的叶子不单独算：
 *   `5432`、`true` 这样的值拿来按子串打码，会把不相干的文字也换掉；它们只在整段 JSON 文本里被盖住。
 *   字符串叶子不论多短都算，和字符串类型的 secret 参数一致（短不是不打码的理由，漏掉才是问题）。
 * - null、undefined：没有。
 */
export function secretTextsOf(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	const texts = new Set<string>();
	if (typeof value === "string") {
		if (value !== "") writtenForms(value, texts);
	} else if (typeof value === "object") {
		texts.add(jsonText(value));
		const leaves: string[] = [];
		stringLeaves(value, leaves);
		for (const leaf of leaves) if (leaf !== "") writtenForms(leaf, texts);
	} else {
		texts.add(jsonText(value));
	}
	return [...texts];
}

/** 把若干 secret 参数的值汇总成一份要打码的文本：去重，按长度从长到短排列，替换时先换长的（整段 JSON 先于里面的叶子）。 */
export function secretTextSet(values: Iterable<unknown>): string[] {
	const texts = new Set<string>();
	for (const value of values) for (const text of secretTextsOf(value)) texts.add(text);
	return [...texts].sort((a, b) => b.length - a.length);
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

/**
 * 一次运行中所有 secret 参数的值要打码的文本（{@link secretTextSet}）：每个链实例起点（入口 / 子流程入口节点）声明为 secret 的参数。
 */
export function secretValues(
	document: StoredOrchestrationDocument,
	chains: ReadonlyArray<{ chainId: string; params: Record<string, unknown> }>,
): string[] {
	const values: unknown[] = [];
	for (const chain of chains) {
		const start = document.nodes.find((n) => n.id === chain.chainId);
		if (!start || (start.kind !== "entry" && start.kind !== "subflow_entry")) continue;
		values.push(...secretParamValues(start.params, chain.params));
	}
	return secretTextSet(values);
}

/** 把文本中出现的 secret 值替换成掩码。 */
export function maskSecrets(text: string, secrets: readonly string[]): string {
	let masked = text;
	for (const secret of secrets) {
		if (masked.includes(secret)) masked = masked.split(secret).join(SECRET_MASK);
	}
	return masked;
}

/** 这份文本里有没有整段的对象或数组（`{…}`、`[…]`）：有才需要在递归时比较整个子结构。 */
const hasStructured = (secrets: readonly string[]): boolean =>
	secrets.some(
		(s) => (s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]")),
	);

/**
 * 递归打码 JSON 值：字符串里出现的 secret 值替换成掩码；数字、布尔值等整个等于 secret 值（JSON 文本）时换成掩码；
 * 对象和数组整个等于某个 secret 值（JSON 文本相同，例如 secret 参数本身，或者原样传给节点的输入、输出）时整个换成掩码，
 * 不等于时递归里面的字符串叶子。键不打码。
 */
export function maskDeep<T>(value: T, secrets: readonly string[]): T {
	if (secrets.length === 0) return value;
	return mask(value, secrets, hasStructured(secrets)) as T;
}

function mask(value: unknown, secrets: readonly string[], structured: boolean): unknown {
	if (typeof value === "string") return maskSecrets(value, secrets);
	if (value !== null && typeof value === "object") {
		if (structured && secrets.includes(jsonText(value))) return SECRET_MASK;
		if (Array.isArray(value)) return value.map((item) => mask(item, secrets, structured));
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [k, mask(v, secrets, structured)]),
		);
	}
	if (value !== null && value !== undefined && secrets.includes(JSON.stringify(value))) {
		return SECRET_MASK;
	}
	return value;
}
