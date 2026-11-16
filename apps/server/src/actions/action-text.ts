import { maskSecrets } from "../logs/secrets.js";
import { clipChars } from "../util/text.js";

/**
 * 动作的名称、字段和失败原因存下之前的处理（明细和摘要共用）：secret 值打码，再按 SDK 同一组上限截断
 * （sdk/python/src/sfly/actions.py 的 MAX_NAME_CHARS、MAX_VALUE_CHARS、MAX_REASON_CHARS）。同版本的 SDK 已经截断过，
 * 这里兜底的是被改过的 SDK（规格 #345 故事 49）。先打码再截断，截断不会留下半个 secret 值。字符数按 Unicode 码点算，
 * 和 Python 的 `len` 一致。
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

/** 一个字段：键和值里的 secret 值都打码，值截到 256 个字符。 */
export const actionField = (
	key: string,
	value: string,
	secrets: readonly string[],
): [string, string] => [
	maskSecrets(key, secrets),
	clipChars(maskSecrets(value, secrets), VALUE_CHARS),
];
