import {
	ACTION_LIMITS,
	type ActionDetailView,
	type ActionSummaryView,
	type CurrentAction,
	type EndedActionView,
	type RunningActionView,
} from "@sfly/schema";
import type { SecretSet } from "../logs/secrets.js";
import { indexAfterChars } from "../util/text.js";

/**
 * 动作的名称、字段和失败原因存下之前的处理（明细和摘要共用）：secret 值打码，并按 SDK 同一组上限（{@link ACTION_LIMITS}）截断。
 * 控制面是执行上限的一方：SDK 只在比上限多 `transportMargin` 个字符处截断（传输的保护，它不知道哪些值是 secret），所以收到的文字可以
 * 比上限长，这里按上限截。**上限说的是原文的位置，不是打码之后的长度**：打码会让文字变短，按打码之后的长度截的话，原文里排在
 * 上限之后的内容会被拉进上限以内。所以用 `SecretSet.maskClipped`：只取原文的前 N 个字符，起点在 N 之前的完整出现照常换成掩码，
 * 跨在 N 上的整个换成一个掩码，N 之后的一律不输出，再把输出截到 N 个字符。字符数按 Unicode 码点算，和 Python 的 `len` 一致。
 * 字段的键 SDK 也按名称的上限截（加同样的余量），这里按名称的上限兜底，免得被改过的 SDK 用超长的键写爆数据库。
 *
 * 只认完整的出现（见 docs/SEMANTICS.md §2.1）：值的某种写法比余量还长时，跨在传输上限处的这种写法只剩前半截，控制面认不出，
 * 留在边界里；后来才成为 secret 的值：写入时它还不是 secret，不论谁截断，已经存下的前半截一直读得出来（已知的边界）。
 * 读取时（下面的 `masked…`）再按此刻的 secret 值打一遍、不再截断：之后才创建的子流程带来的完整的值也算。
 */

const { nameChars, valueChars, reasonChars, fields: maxFields } = ACTION_LIMITS;

/** 动作或标记的名称：打码，取原文的前 `nameChars` 个字符。 */
export const actionName = (name: string, secrets: SecretSet): string =>
	secrets.maskClipped(name, nameChars);

/**
 * 失败原因：打码，原文超过上限时和 SDK 一样留前 `reasonChars - 1` 个字符、末尾加「…」。超不超过按原文算（和 SDK 一样），
 * 不按打码之后的长度算。
 */
export function actionReason(reason: string, secrets: SecretSet): string {
	return indexAfterChars(reason, reasonChars) < reason.length
		? `${secrets.maskClipped(reason, reasonChars - 1)}…`
		: secrets.maskClipped(reason, reasonChars);
}

/** 一个字段：键和值里的 secret 值都打码，键取原文的前名称上限个字符、值取原文的前字段值上限个字符。 */
export const actionField = (key: string, value: string, secrets: SecretSet): [string, string] => [
	secrets.maskClipped(key, nameChars),
	secrets.maskClipped(value, valueChars),
];

/** 读取时：存下的名称再按此刻的 secret 值打一遍码。 */
export const maskedName = (name: string, secrets: SecretSet): string => secrets.mask(name);

/** 读取时：存下的失败原因再按此刻的 secret 值打一遍码。 */
export const maskedReason = (reason: string | null, secrets: SecretSet): string | null =>
	reason === null ? null : secrets.mask(reason);

/** 读取时：存下的字段（键和值）再按此刻的 secret 值打一遍码。 */
export const maskedFields = (
	fields: Readonly<Record<string, string>>,
	secrets: SecretSet,
): Record<string, string> =>
	Object.fromEntries(
		Object.entries(fields).map(([key, value]) => [secrets.mask(key), secrets.mask(value)]),
	);

/** 读取时：一个动作（摘要里正在做的、最近结束的）或明细的名称、字段、失败原因再打一遍码；没有 secret 值时是同一个对象。 */
export function maskedAction<T extends RunningActionView | EndedActionView | ActionDetailView>(
	action: T,
	secrets: SecretSet,
): T {
	if (secrets.isEmpty) return action;
	const masked = {
		...action,
		name: maskedName(action.name, secrets),
		fields: maskedFields(action.fields, secrets),
	};
	return "reason" in action ? { ...masked, reason: maskedReason(action.reason, secrets) } : masked;
}

/** 读取时：动作摘要里的全部名称、字段、失败原因再打一遍码；没有 secret 值时是同一个对象。 */
export function maskedSummary(summary: ActionSummaryView, secrets: SecretSet): ActionSummaryView {
	if (secrets.isEmpty) return summary;
	return {
		...summary,
		names: summary.names.map((n) => ({ ...n, name: maskedName(n.name, secrets) })),
		running: summary.running.map((a) => maskedAction(a, secrets)),
		recent: summary.recent.map((a) => maskedAction(a, secrets)),
		recent_failed: summary.recent_failed.map((a) => maskedAction(a, secrets)),
	};
}

/** 读取时：此刻在做的动作（运行视图、Agent 列表）的名称再打一遍码。 */
export function maskedCurrentAction(
	current: CurrentAction | null,
	secrets: SecretSet,
): CurrentAction | null {
	return current && { ...current, name: maskedName(current.name, secrets) };
}

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
