import { decimalOf, isUnset } from "./decimal.js";

export const MB = 1024 * 1024;

/**
 * 以字节计的上限（单个任务的日志、产物合计、指标数据）的上限：2^53 − 1，JavaScript 能精确表示的最大整数
 * （产物的上限还随任务下发，uint64 装得下）。
 */
export const MAX_BYTE_LIMIT = Number.MAX_SAFE_INTEGER;

/** 上限（字节）合不合格：1 到 {@link MAX_BYTE_LIMIT} 之间的整数。 */
export const isByteLimit = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_BYTE_LIMIT;

/** 上限不合格的说明；`source` 是它的来源（环境变量名、选项名），`what` 是它限制什么，`actual` 是写的值。 */
export const byteLimitMessage = (source: string, what: string, actual: unknown): string =>
	`${source} 不合法：${what}换算成字节后必须是 1 到 ${MAX_BYTE_LIMIT} 之间的整数，实际是 ${String(actual)}`;

/**
 * 把以 MB 计的环境变量 `name` 的原文（可以带小数）换算成字节。没设置（或空串）时是 undefined（用默认值）；
 * 不是数、不是有限的数、换算后不到 1 字节或超过 {@link MAX_BYTE_LIMIT} 时抛出，写明变量名、原文和范围，控制面不启动。
 */
export function byteLimitBytesFromMb(
	name: string,
	what: string,
	raw: string | undefined,
): number | undefined {
	if (isUnset(raw)) return undefined;
	const mb = decimalOf(raw);
	if (!Number.isFinite(mb)) {
		// 不是（有限的）数：`10MB`、`Infinity`……说单位和怎么写，不写「换算后 NaN 字节」。
		throw new Error(
			`${name} 不合法：${what}要写成数字，单位是 MB（可以带小数，例如 512、0.5）。只写数字，不要带单位，也不要写 Infinity，实际是 ${JSON.stringify(raw)}。换算成字节后要是 1 到 ${MAX_BYTE_LIMIT} 之间的整数`,
		);
	}
	const bytes = Math.floor(mb * MB);
	if (!isByteLimit(bytes)) {
		throw new Error(`${byteLimitMessage(name, what, JSON.stringify(raw))}（换算后 ${bytes} 字节）`);
	}
	return bytes;
}
