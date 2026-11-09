// 指标段的数组列以二进制（array_send）读出、在 JS 里解码（#153）：用真实 PostgreSQL 的输出对照。
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFloat8Array, decodeInt4Array } from "../src/metrics/pg-array.js";
import { ADMIN_DATABASE_URL } from "./support/test-database.js";

describe("二进制数组解码", () => {
	let client: pg.Client;
	beforeAll(async () => {
		client = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
		await client.connect();
	});
	afterAll(() => client.end());

	const send = async (values: number[], type: "float8" | "int4"): Promise<Buffer> => {
		const r = await client.query<{ b: Buffer }>(`select array_send($1::${type}[]) as b`, [values]);
		return (r.rows[0] as { b: Buffer }).b;
	};

	it("float8[] 解码后与原值逐个相同，包括负数和极小极大值", async () => {
		const values = [0, 1.5, -2.25, 1e-300, 1.7976931348623157e308, 123456.789, -987654321.5];
		expect(Array.from(decodeFloat8Array(await send(values, "float8")))).toEqual(values);
	});

	it("int4[] 解码后与原值逐个相同", async () => {
		const values = [0, 1, 119, -5, 2147483647, -2147483648];
		expect(Array.from(decodeInt4Array(await send(values, "int4")))).toEqual(values);
	});

	it("空数组解码为空", async () => {
		expect(decodeFloat8Array(await send([], "float8"))).toHaveLength(0);
		expect(decodeInt4Array(await send([], "int4"))).toHaveLength(0);
	});

	it("一段 120 个点的数组与文本格式读出的结果一致", async () => {
		const values = Array.from({ length: 120 }, (_, i) => Math.sin(i) * 1000 + i / 7);
		const text = await client.query<{ a: number[] }>("select $1::float8[] as a", [values]);
		expect(Array.from(decodeFloat8Array(await send(values, "float8")))).toEqual(
			(text.rows[0] as { a: number[] }).a,
		);
	});

	it("类型不符或带 NULL 元素时报错，不返回错位的数据", async () => {
		const ints = await send([1, 2], "int4");
		expect(() => decodeFloat8Array(ints)).toThrow();
		const withNull = (
			await client.query<{ b: Buffer }>("select array_send(array[1.0, null]::float8[]) as b")
		).rows[0] as { b: Buffer };
		expect(() => decodeFloat8Array(withNull.b)).toThrow();
	});
});
