// 触发时请求体里的 JSON 值过 `asStoredJson`，和写进 jsonb 再读回来的是同一个值（键序一样）：运行里从库里读，触发时的检查要算同一份（#632）。
// 和真的库对拍：固定的几种形状（长度不同、同长度、多字节、整数样的键、嵌套、数组里的对象）加随机的。
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asStoredJson } from "../src/util/jsonb.js";
import { createTestDatabase, type TestDatabase } from "./support/test-database.js";

describe("asStoredJson：和 PostgreSQL 的 jsonb 读回来的一致", () => {
	let database: TestDatabase;
	let client: pg.Client;

	beforeAll(async () => {
		database = await createTestDatabase();
		client = new pg.Client({ connectionString: database.url });
		await client.connect();
	});
	afterAll(async () => {
		await client.end();
		await database.drop();
	});

	/** 写进 jsonb 再读回来（和控制面存运行参数、读运行参数是同一条路：JSON 文本进去，pg 驱动 JSON.parse 出来）。 */
	const roundTrip = async (value: unknown): Promise<unknown> => {
		const { rows } = await client.query<{ v: unknown }>("SELECT $1::jsonb AS v", [
			JSON.stringify(value),
		]);
		return rows[0]?.v;
	};
	/** 键序也要一样，所以比 JSON 文本（toEqual 不比键序）。 */
	const same = async (value: unknown) => {
		const stored = await roundTrip(value);
		expect(JSON.stringify(asStoredJson(value))).toBe(JSON.stringify(stored));
		expect(asStoredJson(value)).toEqual(stored);
	};

	it("先按键的字节数、再按字节排：长的在后，同长的按字节，多字节的键按 UTF-8 的字节数", async () => {
		await same({ bbb: 1, a: 2, cc: 3, aa: 4, b: 5, aaa: 6 });
		await same({ zz: 1, éé: 2, a1: 3, 𝒳: 4, 你: 5, ab: 6, é: 7 });
		await same({ b: "zzzz", aa: "x".repeat(50) });
	});

	it("整数样的键：JS 的对象总把它们排在前面，读回来的和过 asStoredJson 的一样", async () => {
		await same({ b: 1, "10": 2, "2": 3, a: 4, "1": 5 });
	});

	it("嵌套的对象、数组里的对象；数组的顺序不变", async () => {
		await same({
			list: [
				{ b: 1, a: 2 },
				{ zzz: [{ y: 1, x: 2 }], a: 1 },
			],
			z: { yy: 1, x: { c: 1, bb: 2, a: 3 } },
		});
		await same([3, 1, 2, { b: 1, a: 2 }]);
	});

	it("字符串、数字、布尔、空值照旧；-0 读回来是 0", async () => {
		await same({
			s: "字符串 é \n",
			n: 1.5,
			big: 2 ** 70,
			t: true,
			f: false,
			z: null,
			neg: -0,
		});
		expect(asStoredJson(-0)).toBe(0);
		expect(asStoredJson("x")).toBe("x");
		expect(asStoredJson(null)).toBeNull();
	});

	it("键是 __proto__ 时是对象自己的属性，读回来也一样", async () => {
		const value = JSON.parse('{"__proto__": {"b": 1, "a": 2}, "c": 3}');
		const stored = asStoredJson(value) as Record<string, unknown>;
		expect(Object.keys(stored)).toEqual(Object.keys((await roundTrip(value)) as object));
	});

	it("随机的对象 300 个：键的长度、多字节、整数样、嵌套都混着来", async () => {
		let seed = 20261124;
		const rnd = (n: number) => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed % n;
		};
		const alphabet = ["a", "b", "Z", "é", "你", "𝒳", "1", "_", "-"];
		const key = () =>
			Array.from({ length: 1 + rnd(4) }, () => alphabet[rnd(alphabet.length)]).join("");
		const make = (depth: number): unknown => {
			if (depth === 0 || rnd(3) === 0) return [`s${rnd(100)}`, rnd(1000), true, null][rnd(4)];
			if (rnd(4) === 0) return Array.from({ length: rnd(4) }, () => make(depth - 1));
			return Object.fromEntries(Array.from({ length: 1 + rnd(6) }, () => [key(), make(depth - 1)]));
		};
		for (let i = 0; i < 300; i++) await same(make(3));
	});
});
