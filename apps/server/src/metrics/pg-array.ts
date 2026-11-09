/**
 * 解码 PostgreSQL 一维数组的二进制格式（`array_send` 的输出，以 bytea 读出）。
 *
 * 指标段的数组列（ADR 0009）如果按默认的文本格式读出，node-pg 逐个字符解析，带标签的降采样查询有约八成时间
 * 花在这里（#153）；以二进制读出、按固定宽度解码，结果与文本格式逐位相同。node-pg 的二进制结果模式
 * 不可用：pg-protocol 会把二进制字段按 utf8 解码，数据被破坏。
 *
 * 格式（src/backend/utils/adt/arrayfuncs.c 的 array_send）：维数、是否含 NULL、元素类型 OID，
 * 每一维的长度与下界，然后每个元素「4 字节长度 + 数据」，全部大端序。
 */

const FLOAT8_OID = 701;
const INT4_OID = 23;

function decode<T extends Float64Array | Int32Array>(
	buf: Uint8Array,
	oid: number,
	width: number,
	make: (n: number) => T,
	read: (view: DataView, at: number) => number,
): T {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const ndim = view.getInt32(0);
	if (view.getInt32(8) !== oid) throw new Error(`array element type is not oid ${oid}`);
	if (ndim === 0) return make(0);
	if (ndim !== 1) throw new Error(`expected a one-dimensional array, got ${ndim} dimensions`);
	if (view.getInt32(4) !== 0) throw new Error("array contains NULL elements");
	const n = view.getInt32(12);
	const out = make(n);
	let at = 20;
	for (let i = 0; i < n; i++) {
		if (view.getInt32(at) !== width) throw new Error(`array element ${i} is not ${width} bytes`);
		out[i] = read(view, at + 4);
		at += 4 + width;
	}
	return out;
}

/** `array_send(x::float8[])` 的输出 → 数组。 */
export const decodeFloat8Array = (buf: Uint8Array): Float64Array =>
	decode(
		buf,
		FLOAT8_OID,
		8,
		(n) => new Float64Array(n),
		(v, at) => v.getFloat64(at),
	);

/** `array_send(x::int4[])` 的输出 → 数组。 */
export const decodeInt4Array = (buf: Uint8Array): Int32Array =>
	decode(
		buf,
		INT4_OID,
		4,
		(n) => new Int32Array(n),
		(v, at) => v.getInt32(at),
	);
