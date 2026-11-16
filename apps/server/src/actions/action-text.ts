import { maskSecrets } from "../logs/secrets.js";
import { clipChars } from "../util/text.js";

/**
 * 动作的名称、字段和失败原因存下之前的处理（明细和摘要共用）：secret 值打码，再按 SDK 同一组上限截断
 * （sdk/python/src/sfly/actions.py 的 MAX_NAME_CHARS、MAX_VALUE_CHARS、MAX_REASON_CHARS）。同版本的 SDK 已经截断过，
 * 这里兜底的是被改过的 SDK（规格 #345 故事 49）。先打码再截断，截断不会留下半个 secret 值。字符数按 Unicode 码点算，
 * 和 Python 的 `len` 一致。字段的键 SDK 不限长，这里按名称的上限兜底，免得被改过的 SDK 用超长的键写爆数据库。
 */

export const NAME_CHARS = 64;
export const VALUE_CHARS = 256;
export const REASON_CHARS = 4096;

/** 动作或标记的名称。 */
export const actionName = (name: string, secrets: readonly string[]): string =>
	clipChars(maskSecrets(name, secrets), NAME_CHARS);

/** 失败原因：超过上限时和 SDK 一样留前 4095 个字符、末尾加「…」。 */
export function actionReason(reason: string, secrets: readonly string[]): string {
	const chars = Array.from(maskSecrets(reason, secrets));
	return chars.length > REASON_CHARS
		? `${chars.slice(0, REASON_CHARS - 1).join("")}…`
		: chars.join("");
}

/** 一个动作或标记最多的字段数（开始时给的和 `note()` 补充的合计），多出的丢弃。 */
export const MAX_FIELDS = 8;

/** 一个字段：键和值里的 secret 值都打码，键截到 64、值截到 256 个字符。 */
export const actionField = (
	key: string,
	value: string,
	secrets: readonly string[],
): [string, string] => [
	clipChars(maskSecrets(key, secrets), NAME_CHARS),
	clipChars(maskSecrets(value, secrets), VALUE_CHARS),
];

/** 补充的字段覆盖同名的、新的接在后面，合计不超过 {@link MAX_FIELDS} 个。 */
export function mergeFields(
	fields: Record<string, string>,
	added: Iterable<readonly [string, string]>,
): Record<string, string> {
	// Map 而不是对象：`__proto__`、`toString` 这样的键也照常记下。
	const merged = new Map(Object.entries(fields));
	for (const [key, value] of added) {
		if (merged.has(key) || merged.size < MAX_FIELDS) merged.set(key, value);
	}
	return Object.fromEntries(merged);
}
