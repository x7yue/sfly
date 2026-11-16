import { ACTION_LIMITS } from "@sfly/schema";
import { maskSecrets } from "../logs/secrets.js";
import { clipChars } from "../util/text.js";

/**
 * 动作的名称、字段和失败原因存下之前的处理（明细和摘要共用）：secret 值打码，再按 SDK 同一组上限截断
 * （{@link ACTION_LIMITS}）。同版本的 SDK 已经截断过，
 * 这里兜底的是被改过的 SDK（规格 #345 故事 49）。先打码再截断，截断不会留下半个 secret 值。字符数按 Unicode 码点算，
 * 和 Python 的 `len` 一致。字段的键 SDK 不限长，这里按名称的上限兜底，免得被改过的 SDK 用超长的键写爆数据库。
 */

const { nameChars, valueChars, reasonChars, fields: maxFields } = ACTION_LIMITS;

/** 动作或标记的名称。 */
export const actionName = (name: string, secrets: readonly string[]): string =>
	clipChars(maskSecrets(name, secrets), nameChars);

/** 失败原因：超过上限时和 SDK 一样留前 `reasonChars - 1` 个字符、末尾加「…」。 */
export function actionReason(reason: string, secrets: readonly string[]): string {
	const chars = Array.from(maskSecrets(reason, secrets));
	return chars.length > reasonChars
		? `${chars.slice(0, reasonChars - 1).join("")}…`
		: chars.join("");
}

/** 一个字段：键和值里的 secret 值都打码，键截到名称的上限、值截到字段值的上限。 */
export const actionField = (
	key: string,
	value: string,
	secrets: readonly string[],
): [string, string] => [
	clipChars(maskSecrets(key, secrets), nameChars),
	clipChars(maskSecrets(value, secrets), valueChars),
];

/** 补充的字段覆盖同名的、新的接在后面，合计不超过 `ACTION_LIMITS.fields` 个，多出的丢弃。 */
export function mergeFields(
	fields: Record<string, string>,
	added: Iterable<readonly [string, string]>,
): Record<string, string> {
	// Map 而不是对象：`__proto__`、`toString` 这样的键也照常记下。
	const merged = new Map(Object.entries(fields));
	for (const [key, value] of added) {
		if (merged.has(key) || merged.size < maxFields) merged.set(key, value);
	}
	return Object.fromEntries(merged);
}
