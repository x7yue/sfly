/** 环境变量的原文是不是一个十进制数（可以带小数和指数；不认 `0x10`、`Infinity`、`NaN`）。 */
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** 没设置、空串、只有空白：用默认值。 */
export const isUnset = (raw: string | undefined): raw is undefined =>
	raw === undefined || raw.trim() === "";

/** 原文里的数（前后的空白不算）；不是十进制数时是 NaN。 */
export const decimalOf = (raw: string): number =>
	DECIMAL.test(raw.trim()) ? Number(raw) : Number.NaN;
