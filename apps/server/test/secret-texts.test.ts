// secret 参数的值要打码的全部文本（#479）：一个 secret 参数的值，不论类型，打码时算哪些文本。
// 读取运行（运行视图、列表、事件流）、写日志和动作、触发时的报错用的都是这一份（logs/secrets.ts 的 secretTextSet），
// 对象和数组、JSON 转义的写法只在那里处理，这里直接测它。
import { describe, expect, it } from "vitest";
import {
	maskDeep,
	maskSecrets,
	SECRET_MASK,
	secretTextSet,
	secretTextsOf,
} from "../src/logs/secrets.js";

const MASK = SECRET_MASK;

describe("一个 secret 参数的值要打码的文本", () => {
	it("字符串：值本身；空串、null、undefined 没有", () => {
		expect(secretTextsOf("test-secret-value")).toEqual(["test-secret-value"]);
		expect(secretTextsOf("")).toEqual([]);
		expect(secretTextsOf(null)).toEqual([]);
		expect(secretTextsOf(undefined)).toEqual([]);
	});

	it("数字和布尔：JSON 文本（行为和以前一样）", () => {
		expect(secretTextsOf(4242)).toEqual(["4242"]);
		expect(secretTextsOf(8.5)).toEqual(["8.5"]);
		expect(secretTextsOf(true)).toEqual(["true"]);
	});

	it("对象：整段 JSON 文本，加每个字符串叶子（嵌套的对象和数组里的也算）；数字、布尔、null 的叶子不单独算", () => {
		const value = {
			key: "test-leaf-one",
			port: 5432,
			tls: true,
			none: null,
			nested: { deep: "test-leaf-two", list: ["test-leaf-three", 7, { more: "test-leaf-four" }] },
		};
		const texts = secretTextsOf(value);
		expect(texts).toContain(JSON.stringify(value));
		for (const leaf of ["one", "two", "three", "four"])
			expect(texts).toContain(`test-leaf-${leaf}`);
		// 数字、布尔的叶子单独拿来按值打码会误伤：5432、true、7 出现在不相干的文字里也会被换掉。
		for (const short of ["5432", "true", "7", "null"]) expect(texts).not.toContain(short);
		expect(texts).toHaveLength(5);
	});

	it("数组：整段 JSON 文本，加每个字符串叶子；空串叶子不算", () => {
		const value = ["test-leaf-one", "", 3, ["test-leaf-two"]];
		expect(secretTextsOf(value).sort()).toEqual(
			[JSON.stringify(value), "test-leaf-one", "test-leaf-two"].sort(),
		);
	});

	it("键不算：对象的键是结构，不是值", () => {
		expect(secretTextsOf({ "test-key-name": "test-leaf" })).not.toContain("test-key-name");
	});

	it("叶子里有引号、反斜杠、换行时，再加上 JSON 转义后的写法；非 ASCII 再加上 \\uXXXX 的写法（Python 的 json.dumps 默认这样写）", () => {
		const quoted = 'test-"q"\\n-end';
		const texts = secretTextsOf({ k: quoted });
		expect(texts).toContain(quoted);
		expect(texts).toContain(JSON.stringify(quoted).slice(1, -1));
		const chinese = secretTextsOf("口令一二三");
		expect(chinese).toContain("口令一二三");
		expect(chinese).toContain("\\u53e3\\u4ee4\\u4e00\\u4e8c\\u4e09");
		// 没有要转义的字符时只有一份。
		expect(secretTextsOf("plain-ascii")).toEqual(["plain-ascii"]);
	});
});

describe("汇总：多个值合成一份，长的在前", () => {
	it("去重，按长度从长到短：先换整段，再换里面的叶子", () => {
		const object = { key: "test-leaf-one" };
		const set = secretTextSet([object, "test-leaf-one", "pw", 4242]);
		expect(set[0]).toBe(JSON.stringify(object));
		expect(set).toEqual([...set].sort((a, b) => b.length - a.length));
		expect(new Set(set).size).toBe(set.length);
		expect(set).toContain("4242");
		expect(set).toContain("pw");
	});

	it("没有 secret 值时是空的", () => {
		expect(secretTextSet([])).toEqual([]);
		expect(secretTextSet([null, "", undefined])).toEqual([]);
	});
});

describe("按这份文本打码", () => {
	const object = { key: "test-leaf-one", nested: { deep: "test-leaf-two" }, port: 5432 };
	const set = secretTextSet([object]);

	it("文字里出现整段 JSON 文本：整段换成一个掩码；只出现叶子：叶子换成掩码", () => {
		expect(maskSecrets(`opts=${JSON.stringify(object)} done`, set)).toBe(`opts=${MASK} done`);
		expect(maskSecrets("user test-leaf-one and test-leaf-two", set)).toBe(
			`user ${MASK} and ${MASK}`,
		);
	});

	it("JSON 转义后的写法也换掉", () => {
		const tricky = secretTextSet([{ k: 'a"b\\c' }]);
		expect(maskSecrets(`line: ${JSON.stringify('a"b\\c')}`, tricky)).not.toContain("a");
		expect(maskSecrets(`line: ${JSON.stringify('a"b\\c')}`, tricky)).toContain(MASK);
	});

	it("maskDeep：和 secret 值相等的对象或数组整个换成掩码；数字、布尔和 secret 值相等时也是；其他递归打码字符串", () => {
		const pin = secretTextSet([object, 4242]);
		expect(maskDeep({ opts: object, pin: 4242, other: 17 }, pin)).toEqual({
			opts: MASK,
			pin: MASK,
			other: 17,
		});
		// 对象整个出现在更大的结构里：只换它。
		expect(maskDeep({ wrapper: [{ opts: object }] }, pin)).toEqual({ wrapper: [{ opts: MASK }] });
		// 不相等（少了一个字段）：不整个替换，但里面的字符串叶子照样换掉，数字不动。
		expect(maskDeep({ key: "test-leaf-one", port: 5432 }, pin)).toEqual({ key: MASK, port: 5432 });
		// 数组里的 secret 字符串。
		expect(maskDeep(["x", "has test-leaf-two inside"], pin)).toEqual(["x", `has ${MASK} inside`]);
	});

	it("maskDeep：没有 secret 值时原样返回同一个对象（不拷贝）", () => {
		const input = { a: [1, 2, { b: "c" }] };
		expect(maskDeep(input, [])).toBe(input);
	});

	it("maskDeep：键不打码，null 和 undefined 不动", () => {
		expect(maskDeep({ "test-leaf-one": null, v: undefined }, secretTextSet([object]))).toEqual({
			"test-leaf-one": null,
			v: undefined,
		});
	});
});
