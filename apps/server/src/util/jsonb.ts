/**
 * 一个 JSON 值写进 PostgreSQL 的 `jsonb` 列、再读回来的样子：对象的键被重新排过（先按 UTF-8 的字节数，字节数相同的再按字节比），
 * 数组、字符串、布尔、空值照旧，`-0` 读回来是 `0`。触发时请求体里的值要先过它，才和运行里（从库里读回来的值）是同一个值：
 * 运行里要打码的东西里有「对象按参数里写的键序整段写出」的几种写法，键序不同，写出来的文字就不同，总长也不同
 * （`runs/secret-size.ts` 比的就是总长，触发时放行、运行里却整段盖住，或者反过来，都是错的）。
 *
 * 和真的库对拍的用例：`test/jsonb-order.test.ts`。
 */
export function asStoredJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(asStoredJson);
	if (typeof value === "number") return Object.is(value, -0) ? 0 : value;
	if (value === null || typeof value !== "object") return value;
	const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => ({
		key,
		bytes: Buffer.from(key, "utf8"),
		item,
	}));
	entries.sort((a, b) => a.bytes.length - b.bytes.length || Buffer.compare(a.bytes, b.bytes));
	const stored: Record<string, unknown> = {};
	for (const { key, item } of entries) {
		// 和 JSON.parse 一样用数据属性写入：键是 `__proto__` 时也是自己的属性。
		Object.defineProperty(stored, key, {
			value: asStoredJson(item),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return stored;
}
