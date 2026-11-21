import { z } from "zod";
import { MIRRORED_IN_JSON_SCHEMA } from "./route-manifest.js";

/**
 * 显示用的文字字段（显示名称、备注、注释框标题、参数说明……）：只用于显示，不参与执行，属于场景版本的内容。
 * 三种写法，场景文档里按需选用：
 *
 * - {@link optionalLine}：可选的一行，例如显示名称、参数说明；
 * - {@link optionalMultiline}：可选的多行，例如备注；
 * - {@link requiredLine}：必填的一行，例如注释框标题。
 *
 * 共同的规则：
 *
 * - 保存的是去掉首尾空白后的文字；可选的字段去掉后为空就不保存（字段不出现在保存下来的文档里）。
 * - 长度按 Unicode 字符（码点）计。zod 的 `.max()` 按 UTF-16 码元计、JSON Schema 的 `maxLength` 按码点计，
 *   两者对 emoji 不一致，所以长度由这里自己数，并把同一个上限导出为 `maxLength`：`sfly scenario push`
 *   用导出的 JSON Schema 做本地校验，不会出现本地通过、控制面拒绝（或反过来）。
 * - 长度、换行、是否为空都按提交的原文判断，不是去掉空白之后：JSON Schema 描述不了「先去掉空白」，
 *   这样两边才不会在带首尾空白的值上分歧。
 * - 一行的字段不能含换行（CR、LF）。
 */

/** 按 Unicode 字符（码点）计的长度。 */
export const codePointLength = (text: string): number => [...text].length;

/**
 * JS 的 `trim()` 去掉的字符，逐个写出来：正则里的 `\s` 在 JS 和 Python 里包含的字符不同
 * （例如 U+FEFF、U+0085），JSON Schema 的 `pattern` 两边都要用，只能不用 `\s`。
 */
const WHITESPACE = String.raw`\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff`;
/** 字符串结尾。不用 `$`：Python 的 `$` 还会匹配结尾换行之前，JS 不会。 */
const END = String.raw`(?![\s\S])`;
const NO_LINE_BREAK = String.raw`[^\r\n]*${END}`;
const HAS_CONTENT = String.raw`(?=[\s\S]*[^${WHITESPACE}])`;

const noLineBreak = new RegExp(`^${NO_LINE_BREAK}`);
const hasContent = new RegExp(`^${HAS_CONTENT}`);

/** 导出的 JSON Schema 只能有一个 `pattern`：必填的一行把「有内容」和「没有换行」写在一起。 */
const ONE_LINE_PATTERN = `^${NO_LINE_BREAK}`;
const REQUIRED_LINE_PATTERN = `^${HAS_CONTENT}${NO_LINE_BREAK}`;

/** 按码点限长。下面三个字段在所有检查之后才 `.meta()`：加检查会复制出新的 schema，元信息不跟过去。 */
const limited = (max: number) =>
	z.string().refine((text) => codePointLength(text) <= max, {
		message: `最多 ${max} 个字符`,
		params: MIRRORED_IN_JSON_SCHEMA,
	});

const rule = (message: string) => ({ message, params: MIRRORED_IN_JSON_SCHEMA });

/** 可选的一行文字，最长 `max` 个字符；去掉首尾空白后为空就不保存。 */
export const optionalLine = (max: number) =>
	z
		.codec(
			limited(max)
				.refine((text) => noLineBreak.test(text), rule("只能写一行"))
				.meta({ maxLength: max, pattern: ONE_LINE_PATTERN }),
			z.string().optional(),
			{ decode: (text) => text.trim() || undefined, encode: (text) => text ?? "" },
		)
		.optional();

/** 可选的多行文字，最长 `max` 个字符（换行也算一个）；去掉首尾空白后为空就不保存。 */
export const optionalMultiline = (max: number) =>
	z
		.codec(limited(max).meta({ maxLength: max }), z.string().optional(), {
			decode: (text) => text.trim() || undefined,
			encode: (text) => text ?? "",
		})
		.optional();

/** 必填的一行文字，去掉首尾空白后 1 到 `max` 个字符。 */
export const requiredLine = (max: number) =>
	z.codec(
		limited(max)
			.refine((text) => hasContent.test(text), rule("不能为空"))
			.refine((text) => noLineBreak.test(text), rule("只能写一行"))
			.meta({ maxLength: max, pattern: REQUIRED_LINE_PATTERN }),
		z.string(),
		{ decode: (text) => text.trim(), encode: (text) => text },
	);
