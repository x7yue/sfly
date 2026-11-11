// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import { wholeReference } from "./reference-completion";

/**
 * 参数输入框里的文本与文档里的值之间的换算（纯逻辑，单测覆盖）：数字、JSON 字段，以及异步任务节点的参数映射。
 * 解析结果 `{ value }` 写进文档（undefined 表示不填），`{ error }` 只记为字段草稿（field-drafts.tsx）。
 */
export type Parsed<T> = { value: T } | { error: string };

export const parseNumber =
	(integer: boolean) =>
	(raw: string): Parsed<number | undefined> => {
		if (raw.trim() === "") return { value: undefined };
		const n = Number(raw);
		if (Number.isNaN(n) || (integer && !Number.isInteger(n))) {
			return { error: integer ? "需要整数" : "需要数字" };
		}
		return { value: n };
	};

/** JSON 字段的文本：整个文本恰好是一个引用时保存为整值引用（字符串），否则必须是合法的 JSON。 */
export const parseJson = (raw: string): Parsed<unknown> => {
	const text = raw.trim();
	if (text === "") return { value: undefined };
	if (wholeReference(text) !== undefined) return { value: text };
	try {
		return { value: JSON.parse(text) };
	} catch {
		return { error: "不是合法的 JSON" };
	}
};

export const formatJson = (value: unknown): string =>
	value === undefined ? "" : JSON.stringify(value, null, 2);

/** 参数映射输入框的文本 → 映射值：目标参数不是 string 时，不含引用的 JSON 字面量按常量保存；空文本是不映射。 */
export function mappedValue(text: string, type: string): unknown {
	if (text === "") return undefined;
	if (type === "string" || text.includes("${{")) return text;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** 映射值在输入框里的文本。 */
export const mappedText = (value: unknown): string =>
	value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
