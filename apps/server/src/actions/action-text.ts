import {
	ACTION_LIMITS,
	type ActionDetailView,
	type ActionSummaryView,
	type CurrentAction,
	type EndedActionView,
	type RunningActionView,
} from "@sfly/schema";
import type { SecretSet } from "../logs/secrets.js";
import { clipChars } from "../util/text.js";

/**
 * 动作的名称、字段和失败原因存下之前的处理（明细和摘要共用）：secret 值打码，再按 SDK 同一组上限截断
 * （{@link ACTION_LIMITS}）。同版本的 SDK 已经截断过，
 * 这里兜底的是被改过的 SDK（规格 #345 故事 49）。先打码再截断，截断不会留下半个 secret 值。字符数按 Unicode 码点算，
 * 和 Python 的 `len` 一致。字段的键 SDK 不限长，这里按名称的上限兜底，免得被改过的 SDK 用超长的键写爆数据库。
 *
 * SDK 是在控制面看到之前截断的：一个 secret 值跨在 SDK 的截断处时，控制面收到的只是它的前半截，按整个值打码认不出。
 * 所以截断之后再把结尾留下的半截 secret 值盖住（{@link SecretSet.maskClippedTail}）；读取时（下面的 `masked…`）
 * 用同一个函数再打一遍，之后才创建的子流程带来的 secret 值也算。
 */

const { nameChars, valueChars, reasonChars, fields: maxFields } = ACTION_LIMITS;

/** 动作或标记的名称。 */
export const actionName = (name: string, secrets: SecretSet): string =>
	secrets.maskClippedTail(clipChars(secrets.mask(name), nameChars), nameChars);

/** 失败原因：超过上限时和 SDK 一样留前 `reasonChars - 1` 个字符、末尾加「…」。 */
export function actionReason(reason: string, secrets: SecretSet): string {
	const chars = Array.from(secrets.mask(reason));
	const clipped =
		chars.length > reasonChars ? `${chars.slice(0, reasonChars - 1).join("")}…` : chars.join("");
	return secrets.maskClippedTail(clipped, reasonChars, { ellipsis: true });
}

/** 一个字段：键和值里的 secret 值都打码，键截到名称的上限、值截到字段值的上限。 */
export const actionField = (key: string, value: string, secrets: SecretSet): [string, string] => [
	secrets.maskClippedTail(clipChars(secrets.mask(key), nameChars), nameChars),
	secrets.maskClippedTail(clipChars(secrets.mask(value), valueChars), valueChars),
];

/** 读取时：存下的名称再按此刻的 secret 值打一遍码（含截断处留下的半截）。 */
export const maskedName = (name: string, secrets: SecretSet): string =>
	secrets.maskClipped(name, nameChars);

/** 读取时：存下的失败原因再按此刻的 secret 值打一遍码（含截断处留下的半截）。 */
export const maskedReason = (reason: string | null, secrets: SecretSet): string | null =>
	reason === null ? null : secrets.maskClipped(reason, reasonChars, { ellipsis: true });

/** 读取时：存下的字段（键和值）再按此刻的 secret 值打一遍码（含截断处留下的半截）。 */
export const maskedFields = (
	fields: Readonly<Record<string, string>>,
	secrets: SecretSet,
): Record<string, string> =>
	Object.fromEntries(
		Object.entries(fields).map(([key, value]) => [
			secrets.maskClipped(key, nameChars),
			secrets.maskClipped(value, valueChars),
		]),
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
