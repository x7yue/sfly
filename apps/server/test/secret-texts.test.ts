// secret 参数的值要打码的东西（#479）：一个 secret 参数的值，不论类型，打码时算哪些文本、哪些整个节点。
// 读取运行（运行视图、列表、事件流）、写日志和动作、触发时的报错用的都是这一份（logs/secrets.ts 的 SecretSet），
// 对象和数组、JSON 转义的写法、短叶子的取舍只在那里处理，这里直接测它。规则的编号见 docs/SEMANTICS.md §2.1。
// 值都是明显的假值。
import { describe, expect, it, vi } from "vitest";
import {
	MIN_LEAF_CHARS,
	maskParams,
	maskRecord,
	maskSecrets,
	maskValue,
	NO_SECRETS,
	SECRET_MASK,
	SecretSet,
	secretPartsOf,
	secretSetOf,
	shortLeafCount,
} from "../src/logs/secrets.js";
import { pythonJson, sortKeysDeep } from "./support/secret-forms.js";

const MASK = SECRET_MASK;

/** 一个值要在文字里按子串打码的文本。 */
const textsOf = (value: unknown): string[] => secretPartsOf(value).texts;
/** 一个值（单独作为 secret 参数）的打码器。 */
const setOf = (...values: unknown[]): SecretSet => secretSetOf(values);

describe("规则 2：字符串、数字、布尔类型的 secret 参数，按值打码，不论多短", () => {
	it("字符串：值本身；空串、null、undefined 没有", () => {
		expect(textsOf("test-secret-value")).toEqual(["test-secret-value"]);
		expect(textsOf("ab")).toEqual(["ab"]);
		expect(textsOf("")).toEqual([]);
		expect(textsOf(null)).toEqual([]);
		expect(textsOf(undefined)).toEqual([]);
	});

	it("数字和布尔：JSON 文本，不论多短；作为整个节点等于它时也算（scalars）", () => {
		expect(secretPartsOf(4242)).toEqual({ texts: ["4242"], scalars: ["4242"], containers: [] });
		expect(secretPartsOf(8.5)).toEqual({ texts: ["8.5"], scalars: ["8.5"], containers: [] });
		expect(secretPartsOf(7)).toEqual({ texts: ["7"], scalars: ["7"], containers: [] });
		expect(secretPartsOf(true)).toEqual({ texts: ["true"], scalars: ["true"], containers: [] });
		expect(secretPartsOf(false)).toEqual({ texts: ["false"], scalars: ["false"], containers: [] });
	});

	it("字符串里有引号、反斜杠、换行时，再加上 JSON 转义后的写法；非 ASCII 再加上 \\uXXXX 的写法", () => {
		const quoted = 'test-"q"\\n-end';
		const texts = textsOf(quoted);
		expect(texts).toContain(quoted);
		expect(texts).toContain(JSON.stringify(quoted).slice(1, -1));
		const chinese = textsOf("口令一二三");
		expect(chinese).toContain("口令一二三");
		expect(chinese).toContain("\\u53e3\\u4ee4\\u4e00\\u4e8c\\u4e09");
		// 非 BMP 字符写成一对代理，和 Python 的 json.dumps 一样（小写十六进制）。
		expect(textsOf("a😀bc")).toContain("a\\ud83d\\ude00bc");
		// 没有要转义的字符时只有一份。
		expect(textsOf("plain-ascii")).toEqual(["plain-ascii"]);
	});

	it("DEL（U+007F）写成 \\u007f，和 Python 一样（范围从 U+007F 起，比 JSON.stringify 多一个 DEL）", () => {
		const secret = "test-del\u007f-end";
		expect(textsOf(secret)).toContain("test-del\\u007f-end");
		expect(maskSecrets('{"k": "test-del\\u007f-end"}', setOf(secret))).toBe(`{"k": "${MASK}"}`);
	});

	it("按值打码：任何位置、任何长度的 secret 字符串都换成掩码", () => {
		expect(maskSecrets("pw=ab ok", setOf("ab"))).toBe(`pw=${MASK} ok`);
		expect(maskSecrets("pin 4242 and 4242", setOf(4242))).toBe(`pin ${MASK} and ${MASK}`);
		expect(maskSecrets("flag is true", setOf(true))).toBe(`flag is ${MASK}`);
	});
});

describe("规则 4：多行的 secret 值（例如 PEM），整段加上不少于 4 个字符的每一行", () => {
	const pem = "-----BEGIN KEY-----\nabcDEF123456\nxy\n-----END KEY-----";

	it("整段、每一行（去掉两头空白后）不少于 4 个字符的都算；太短的行不算", () => {
		const texts = textsOf(pem);
		expect(texts).toContain(pem);
		expect(texts).toContain("-----BEGIN KEY-----");
		expect(texts).toContain("abcDEF123456");
		expect(texts).toContain("-----END KEY-----");
		expect(texts).not.toContain("xy");
		// 整段 JSON 转义（换行写成 \n）之后也能认出来。
		expect(texts).toContain(JSON.stringify(pem).slice(1, -1));
	});

	it("日志按行写：一行一行出现也打码；短的行不单独打码", () => {
		const set = setOf(pem);
		expect(maskSecrets("line: abcDEF123456", set)).toBe(`line: ${MASK}`);
		expect(maskSecrets("line: -----BEGIN KEY-----", set)).toBe(`line: ${MASK}`);
		expect(maskSecrets("line: xy", set)).toBe("line: xy");
		// 整段原样写出（带换行）：一个掩码。
		expect(maskSecrets(`dump:\n${pem}`, set)).toBe(`dump:\n${MASK}`);
	});

	it("两头的空白不算（CRLF 的行尾、缩进）", () => {
		const set = setOf("first-line-secret\r\n   second-line-secret   ");
		expect(maskSecrets("a first-line-secret b", set)).toBe(`a ${MASK} b`);
		expect(maskSecrets("a second-line-secret b", set)).toBe(`a ${MASK} b`);
	});
});

describe("规则 3：对象、数组类型的 secret 参数，不少于 4 个字符的字符串、数字叶子按值打码，更短的叶子只随整段盖住", () => {
	it("下限是一个有名字的常量：4", () => {
		expect(MIN_LEAF_CHARS).toBe(4);
	});

	it("字符串叶子：不少于 4 个字符的按值打码（嵌套的对象和数组里的也算）；键不算", () => {
		const value = {
			"test-key-name": "abcd",
			nested: { deep: "test-leaf-two", list: ["test-leaf-three", { more: "test-leaf-four" }] },
		};
		const texts = textsOf(value);
		for (const leaf of ["abcd", "test-leaf-two", "test-leaf-three", "test-leaf-four"]) {
			expect(texts, leaf).toContain(leaf);
		}
		expect(texts).not.toContain("test-key-name");
	});

	it("字符串叶子：不到 4 个字符的不单独打码，单独出现时原样", () => {
		const set = setOf({ env: "prod", region: "a", enabled: "1", on: "on" });
		const texts = set.texts;
		expect(texts).toContain("prod");
		for (const short of ["a", "1", "on"]) expect(texts, short).not.toContain(short);
		expect(maskSecrets("region a, enabled 1, on, prod", set)).toBe(
			`region a, enabled 1, on, ${MASK}`,
		);
	});

	it("按字符数算，不按字节数：三个汉字不够，四个够", () => {
		const set = setOf({ a: "口令一", b: "口令一二" });
		expect(set.texts).toContain("口令一二");
		expect(set.texts).not.toContain("口令一");
		expect(set.mask("口令一 口令一二")).toBe(`口令一 ${MASK}`);
	});

	it("数字叶子：按 JSON 文本算，不少于 4 个字符的按值打码；更短的不单独打码", () => {
		const set = setOf({ pin: 123456, port: 5432, small: 80, ratio: 1.5, wide: 12.5 });
		for (const long of ["123456", "5432", "12.5"]) expect(set.texts, long).toContain(long);
		for (const short of ["80", "1.5"]) expect(set.texts, short).not.toContain(short);
		expect(set.mask("pin 123456 port 5432 80 1.5 12.5")).toBe(
			`pin ${MASK} port ${MASK} 80 1.5 ${MASK}`,
		);
	});

	it("布尔和空值（null、空串）的叶子没有可以被认出来的内容，不单独打码", () => {
		const texts = textsOf({ tls: true, off: false, none: null, blank: "", name: "test-leaf" });
		for (const never of ["true", "false", "null", ""]) expect(texts, never).not.toContain(never);
		expect(texts).toContain("test-leaf");
	});

	it("整段被原样写出时，短叶子、布尔、空值随整段盖住：控制面的紧凑写法和 Python json.dumps 默认的写法都是", () => {
		const value = { env: "prod", region: "a", user: "admin", enabled: "1" };
		const set = setOf(value);
		const compact = JSON.stringify(value);
		const pythonDefault = '{"env": "prod", "region": "a", "user": "admin", "enabled": "1"}';
		expect(set.mask(`cfg=${compact} ok`)).toBe(`cfg=${MASK} ok`);
		expect(set.mask(`cfg=${pythonDefault} ok`)).toBe(`cfg=${MASK} ok`);
		// 只有短叶子的对象也一样：整段盖住。
		const onlyShort = { a: "x", n: 1, flag: true };
		expect(setOf(onlyShort).mask(`cfg=${JSON.stringify(onlyShort)}`)).toBe(`cfg=${MASK}`);
		expect(setOf(onlyShort).mask('cfg={"a": "x", "n": 1, "flag": true}')).toBe(`cfg=${MASK}`);
	});

	it("Python json.dumps 默认的写法：`, `、`: ` 分隔，嵌套、数组、数字、布尔、null、转义、非 ASCII 和 DEL 都和 Python 的输出一致", () => {
		// 下面的字符串都是 Python 3 `json.dumps` 默认参数的实际输出。
		const cases: Array<[unknown, string]> = [
			[
				{ pin: 123456, user: "admin-ops", ok: true, n: null },
				'{"pin": 123456, "user": "admin-ops", "ok": true, "n": null}',
			],
			[{ a: [1, 2], b: { c: "x" } }, '{"a": [1, 2], "b": {"c": "x"}}'],
			[
				{ name: "口令一二三", e: "😀", del: "\u007f", q: 'a"b\\c\nd' },
				'{"name": "\\u53e3\\u4ee4\\u4e00\\u4e8c\\u4e09", "e": "\\ud83d\\ude00", "del": "\\u007f", "q": "a\\"b\\\\c\\nd"}',
			],
		];
		for (const [value, python] of cases) {
			const set = setOf(value);
			expect(set.mask(`out=${python}`), python).toBe(`out=${MASK}`);
		}
		// ensure_ascii=False：非 ASCII 原样，DEL 原样。
		const wide = { name: "口令一二三", del: "\u007f" };
		expect(setOf(wide).mask('out={"name": "口令一二三", "del": "\u007f"}')).toBe(`out=${MASK}`);
	});

	it("缩进、排序、repr 的写法里，每个不少于 4 个字符的叶子各自在场：按值打码盖住它们", () => {
		const value = { port: 5432, pin: 123456, user: "admin-ops" };
		const set = setOf(value);
		// indent=2（整段对不上）
		expect(set.mask('{\n  "port": 5432,\n  "pin": 123456,\n  "user": "admin-ops"\n}')).toBe(
			`{\n  "port": ${MASK},\n  "pin": ${MASK},\n  "user": "${MASK}"\n}`,
		);
		// Python 的 repr（单引号）
		expect(set.mask("{'port': 5432, 'pin': 123456, 'user': 'admin-ops'}")).toBe(
			`{'port': ${MASK}, 'pin': ${MASK}, 'user': '${MASK}'}`,
		);
	});

	it('规则 3 的例外：没有任何内容的容器什么都不算（`{}`、`[]`、`[[]]`、`{"k": ""}`、`{"n": null}`）', () => {
		for (const empty of [{}, [], [[]], { k: "" }, { n: null }, { a: { b: [] } }, [null, ""]]) {
			expect(secretPartsOf(empty), JSON.stringify(empty)).toEqual({
				texts: [],
				scalars: [],
				containers: [],
			});
			expect(setOf(empty).isEmpty, JSON.stringify(empty)).toBe(true);
		}
		// 有内容的就有：哪怕只有一个短叶子，整段算（只随整段盖住）。
		expect(secretPartsOf({ a: "x" }).containers).toEqual(['{"a":"x"}']);
		expect(secretPartsOf([false]).containers).toEqual(["[false]"]);
	});

	it("没有任何内容的容器放进集合：不打码任何东西，`{}`、`[]` 照常出现在输出、日志里", () => {
		const set = setOf({}, [], { k: "" }, "test-secret-value");
		expect(maskValue({ a: {}, b: [], c: { k: "" } }, set)).toEqual({ a: {}, b: [], c: { k: "" } });
		expect(set.mask("empty {} and [] and []")).toBe("empty {} and [] and []");
	});
});

describe("shortLeafCount：预检警告用的，对象和数组里不单独打码的短叶子有几个", () => {
	it("字符串（去掉两头空白后）和数字，字符数不到 4 个的；布尔和空值不算", () => {
		expect(shortLeafCount({ env: "prod", region: "a", user: "admin", enabled: "1" })).toBe(2);
		expect(shortLeafCount({ port: 80, pin: 123456, ratio: 1.5 })).toBe(2);
		expect(shortLeafCount({ tls: true, none: null, blank: "", space: "   " })).toBe(0);
		expect(shortLeafCount(["a", ["bb", { c: "ccc" }, "dddd"]])).toBe(3);
		expect(shortLeafCount({ a: " x " })).toBe(1);
	});

	it("不是对象或数组的值没有「叶子」：字符串、数字、布尔、null 都是 0", () => {
		for (const value of ["a", 1, true, null, undefined]) expect(shortLeafCount(value)).toBe(0);
	});
});

describe("规则 6：打码不改变类型", () => {
	const object = { key: "test-leaf-one", nested: { deep: "test-leaf-two" }, port: 5432, tls: true };

	it('字符串叶子不让数字、布尔被换成掩码：`"1234"` 是叶子时，数字 1234 和布尔 true 原样', () => {
		const set = setOf({ k: "1234", t: "true", f: "false" });
		expect(maskValue(1234, set)).toBe(1234);
		expect(maskValue(true, set)).toBe(true);
		expect(maskValue(false, set)).toBe(false);
		expect(maskValue({ n: 1234, b: true, s: "has 1234 inside" }, set)).toEqual({
			n: 1234,
			b: true,
			s: `has ${MASK} inside`,
		});
	});

	it("数字、布尔整个等于顶层是数字、布尔的 secret 参数，或者 secret 对象里不短的数字叶子，才换成掩码", () => {
		const top = setOf(4242, true);
		expect(maskValue({ pin: 4242, flag: true, other: 17, f: false }, top)).toEqual({
			pin: MASK,
			flag: MASK,
			other: 17,
			f: false,
		});
		const leaf = setOf(object);
		expect(maskValue([5432, 80, true], leaf)).toEqual([MASK, 80, true]);
	});

	it("字符串里的 secret 值：数字不受影响（`pin 4242` 是字符串，打码后仍是字符串）", () => {
		const set = setOf(4242);
		expect(maskValue("pin 4242", set)).toBe(`pin ${MASK}`);
		expect(typeof maskValue("4242", set)).toBe("string");
	});

	it("整个换成掩码只发生在节点本身就是 secret 参数的值：和 secret 对象相等的对象或数组、相等的数字、布尔", () => {
		const set = setOf(object, 4242);
		expect(maskValue({ opts: object, pin: 4242, other: 17 }, set)).toEqual({
			opts: MASK,
			pin: MASK,
			other: 17,
		});
		// 对象整个出现在更大的结构里：只换它。
		expect(maskValue({ wrapper: [{ opts: object }] }, set)).toEqual({ wrapper: [{ opts: MASK }] });
		// 不相等（少了一个字段）：不整个替换，里面的叶子按值打码，不短的数字叶子也换，布尔不动。
		expect(maskValue({ key: "test-leaf-one", port: 5432, tls: true }, set)).toEqual({
			key: MASK,
			port: MASK,
			tls: true,
		});
		expect(maskValue(["x", "has test-leaf-two inside"], set)).toEqual(["x", `has ${MASK} inside`]);
	});

	it("没有 secret 值时原样返回同一个对象（不拷贝）；键不打码，null 和 undefined 不动", () => {
		const input = { a: [1, 2, { b: "c" }] };
		expect(maskValue(input, NO_SECRETS)).toBe(input);
		expect(maskRecord(input, NO_SECRETS)).toBe(input);
		expect(maskValue({ "test-leaf-one": null, v: undefined }, setOf(object))).toEqual({
			"test-leaf-one": null,
			v: undefined,
		});
	});
});

describe("maskRecord：「名字到值」的映射本身不会被换成掩码", () => {
	const object = { key: "test-leaf-one", nested: { deep: "test-leaf-two" } };
	const set = setOf(object);

	it("映射整个等于 secret 对象（节点把收到的对象原样作为整个输出）：对每个值逐个处理，映射仍是映射", () => {
		const masked = maskRecord({ ...object }, set);
		expect(masked).toEqual({ key: MASK, nested: { deep: MASK } });
		expect(typeof masked).toBe("object");
		// maskValue 对同一个值的结果是整个换掉；这正是 maskRecord 要避开的。
		expect(maskValue({ ...object }, set)).toBe(MASK);
	});

	it("映射里的某个值整个等于 secret 对象：换的是那个值", () => {
		expect(maskRecord({ echoed: object, n: 1 }, set)).toEqual({ echoed: MASK, n: 1 });
	});

	it("`{}`、null、undefined：原样", () => {
		expect(maskRecord({}, set)).toEqual({});
		expect(maskRecord(null, set)).toBeNull();
		expect(maskRecord(undefined, set)).toBeUndefined();
	});
});

describe("汇总：多个值合成一份，长的在前", () => {
	it("去重，按长度从长到短：先换整段，再换里面的叶子", () => {
		const object = { key: "test-leaf-one" };
		const set = setOf(object, "test-leaf-one", "pw", 4242);
		expect([...set.texts]).toEqual([...set.texts].sort((a, b) => b.length - a.length));
		expect(new Set(set.texts).size).toBe(set.texts.length);
		for (const text of ["test-leaf-one", "pw", "4242", JSON.stringify(object)]) {
			expect(set.texts).toContain(text);
		}
		// 整段先于叶子：整段 JSON 换成一个掩码，不是 `{"key":"******"}`。
		expect(set.mask(`opts=${JSON.stringify(object)}`)).toBe(`opts=${MASK}`);
	});

	it("没有 secret 值时是空的", () => {
		expect(setOf().isEmpty).toBe(true);
		expect(setOf(null, "", undefined).isEmpty).toBe(true);
		expect(NO_SECRETS.isEmpty).toBe(true);
		expect(NO_SECRETS.mask("anything")).toBe("anything");
	});
});

describe("匹配是一个按值集合编译、缓存的正则（性能，#479 评审里的数字）", () => {
	/** 参照实现：每个文本一次 `split/join`，长的在前（改成正则之前的写法）。 */
	const sequentialMask = (text: string, texts: readonly string[]): string =>
		[...texts].sort((a, b) => b.length - a.length).reduce((t, s) => t.split(s).join(MASK), text);

	it("正则元字符按字面匹配，不当成正则：点、加号、括号、反斜杠、斜杠、连字符、方括号、花括号", () => {
		const secrets = ["a.c", "x+y", "(p|q)", "back\\slash", "a/b-c", "[0-9]", "{1,2}", "^$", "a?b*"];
		const set = setOf(...secrets);
		expect(set.mask("abc xy p q backslash a-b-c 0 1 12 ab")).toBe(
			"abc xy p q backslash a-b-c 0 1 12 ab",
		);
		for (const secret of secrets) expect(set.mask(`<${secret}>`), secret).toBe(`<${MASK}>`);
	});

	it("长的在前：短的是长的一部分时，整段换成一个掩码", () => {
		const set = setOf("abcd", "abcdefgh");
		expect(set.mask("x abcdefgh y abcd z")).toBe(`x ${MASK} y ${MASK} z`);
	});

	it("值集合变了就是另一份：同一段文字按各自的集合打码，互不影响（编译结果按值集合缓存）", () => {
		const one = setOf("alpha-secret");
		const two = setOf("alpha-secret", "bravo-secret");
		for (let i = 0; i < 3; i++) {
			expect(one.mask("alpha-secret bravo-secret")).toBe(`${MASK} bravo-secret`);
			expect(two.mask("alpha-secret bravo-secret")).toBe(`${MASK} ${MASK}`);
		}
		// 内容一样的另一个集合（另一次读取时重新算出来的）结果一样。
		expect(setOf("alpha-secret").mask("alpha-secret")).toBe(`${MASK}`);
	});

	it("和逐个 split/join 的参照实现对比：随机的值集合和文字，结果一样（没有两个值首尾相接地重叠的时候）", () => {
		// 固定种子的伪随机，失败时可以复现。
		let seed = 20261121;
		const random = (n: number): number => {
			seed = (seed * 1664525 + 1013904223) % 4294967296;
			return Math.floor((seed / 4294967296) * n);
		};
		const alphabet = [
			"a",
			"b",
			"c",
			".",
			"+",
			"(",
			")",
			"\\",
			"/",
			"-",
			"[",
			"]",
			"$",
			"|",
			"?",
			"{",
			"}",
			"^",
		];
		const word = (min: number, max: number): string =>
			Array.from(
				{ length: min + random(max - min + 1) },
				() => alphabet[random(alphabet.length)],
			).join("");
		/** 有没有两个不同的文本，一个的结尾等于另一个的开头（而且不是整个）：这时从左到右一次匹配和逐个替换会盖住不同的部分。 */
		const overlapping = (texts: string[]): boolean =>
			texts.some((x) =>
				texts.some((y) => {
					if (x === y) return false;
					for (let k = 1; k < Math.min(x.length, y.length); k++) {
						if (x.endsWith(y.slice(0, k))) return true;
					}
					return false;
				}),
			);

		let compared = 0;
		let skipped = 0;
		for (let round = 0; round < 800; round++) {
			const texts = [...new Set(Array.from({ length: 1 + random(8) }, () => word(1, 8)))];
			const set = setOf(...texts);
			// 文字：值、值的片段、噪声随机拼起来。
			const pieces = [...set.texts, ...set.texts.map((t) => t.slice(1)), "a", "b", " ", "xyz"];
			const text = Array.from({ length: 1 + random(12) }, () => pieces[random(pieces.length)]).join(
				"",
			);
			const got = set.mask(text);
			// 不论哪种写法，打码之后文字里不能留下任何一个值。
			for (const t of set.texts)
				expect(got, `${JSON.stringify(set.texts)} / ${JSON.stringify(text)}`).not.toContain(t);
			if (overlapping([...set.texts])) {
				skipped += 1;
				continue;
			}
			compared += 1;
			expect(got, `${JSON.stringify(set.texts)} / ${JSON.stringify(text)}`).toBe(
				sequentialMask(text, set.texts),
			);
		}
		// 确认对比真的做了（不是几乎都被跳过）。
		expect(compared).toBeGreaterThan(200);
		expect(skipped).toBeLessThan(800 - compared + 1);
	});

	it("真实的值：对象、数组、多行、各种写法，和参照实现的结果一样", () => {
		const values = [
			{
				env: "prod",
				pin: 123456,
				user: "admin-ops",
				nested: { deep: "口令一二三", list: ["a.b+c", "x"] },
			},
			["test-leaf-one", ["test-leaf-two"], 4242],
			"-----BEGIN KEY-----\nabcDEF123456\n-----END KEY-----",
			"test-secret-value",
			8080,
		];
		const set = setOf(...values);
		const lines = [
			...set.texts,
			`cfg=${JSON.stringify(values[0])} then ${JSON.stringify(values[1])}`,
			'{"env": "prod", "pin": 123456} user admin-ops 口令一二三',
			"unrelated line with nothing secret, port 80 and a.b",
			"abcDEF123456 -----END KEY----- 8080 test-secret-value",
		];
		for (const line of lines) expect(set.mask(line), line).toBe(sequentialMask(line, set.texts));
	});

	it("一万行日志、一百个值的集合：批量打码只编译一次正则（不随行数变慢）", () => {
		const set = setOf(...Array.from({ length: 100 }, (_, i) => `test-secret-value-${i}-end`));
		const lines = Array.from(
			{ length: 10_000 },
			(_, i) => `line ${i}: value test-secret-value-${i % 100}-end done`,
		);
		const started = performance.now();
		const masked = lines.map((line) => set.mask(line));
		const elapsed = performance.now() - started;
		expect(masked[7]).toBe(`line 7: value ${MASK} done`);
		// 很宽的上限，只防「每行重新编译」这种数量级的退化。
		expect(elapsed).toBeLessThan(2_000);
	});
});

describe("SecretSet 构造", () => {
	it("多个 SecretParts 合并：去重，scalars、containers 各自合并", () => {
		const set = new SecretSet([
			secretPartsOf(4242),
			secretPartsOf(4242),
			secretPartsOf({ a: "abcd" }),
		]);
		expect(set.texts.filter((t) => t === "4242")).toHaveLength(1);
		expect([...set.scalars]).toEqual(["4242"]);
		expect([...set.containers]).toEqual(['{"a":"abcd"}']);
		expect(set.isEmpty).toBe(false);
	});
});

describe("规则 1：secret 参数本身读出来是掩码，不论类型（maskParams）", () => {
	const declared = new Set(["opts", "list", "pin", "flag", "token", "empty", "blank", "none"]);

	it("声明为 secret 的参数整个读成掩码：字符串、数字、布尔、对象、数组；没有可以按值打码的内容的对象、数组也是", () => {
		const params = {
			token: "ab",
			pin: 7,
			flag: false,
			opts: { env: "prod", region: "a" },
			list: ["x"],
			empty: {},
			plain: "kept",
		};
		const set = setOf(params.token, params.pin, params.flag, params.opts, params.list);
		expect(maskParams(params, declared, set)).toEqual({
			token: MASK,
			pin: MASK,
			flag: MASK,
			opts: MASK,
			list: MASK,
			empty: MASK,
			plain: "kept",
		});
	});

	it("没有值（null、缺省）和空串没有什么可隐藏的，原样；没有声明为 secret 的参数按 maskRecord 处理（值里的 secret 值照常按值打码）", () => {
		const set = setOf("test-secret-value");
		expect(
			maskParams({ blank: "", none: null, plain: "has test-secret-value" }, declared, set),
		).toEqual({ blank: "", none: null, plain: `has ${MASK}` });
	});

	it("没有声明 secret 参数：和 maskRecord 一样", () => {
		const set = setOf("test-secret-value");
		expect(maskParams({ a: "test-secret-value", b: {} }, new Set(), set)).toEqual({
			a: MASK,
			b: {},
		});
	});
});

describe("规则 3：整个对象被原样写出，节点收到的键顺序（Agent 把输入的键按字节序排好）和参数里写的顺序两种都盖住", () => {
	const config = {
		env: "prod",
		user: "admin",
		region: "a",
		enabled: "1",
		zh: "好",
		nested: { z: "x", b: 1, a: [true, { y: "k", c: null }] },
	};
	const received = sortKeysDeep(config);

	it("节点收到的是键排好序的对象：json.dumps 默认、紧凑、ensure_ascii=False、sort_keys 的整段都是一个掩码，短叶子不留明文", () => {
		const set = setOf(config);
		for (const text of [
			pythonJson(received),
			pythonJson(received, false),
			JSON.stringify(received),
			// sort_keys=True 之后写出的就是排好序的顺序，和收到的相同
			pythonJson(sortKeysDeep(config), false),
		]) {
			expect(set.mask(`cfg=${text} ok`), text).toBe(`cfg=${MASK} ok`);
		}
		// 评审用的那份配置：读出来不能剩下 `1`、`a` 这样的明文
		const review = { env: "prod", region: "a", user: "admin", enabled: "1" };
		expect(
			setOf(review).mask('{"enabled": "1", "env": "prod", "region": "a", "user": "admin"}'),
		).toBe(MASK);
	});

	it("参数里写的顺序（库里 jsonb 的顺序）也盖住", () => {
		const set = setOf(config);
		expect(set.mask(`cfg=${JSON.stringify(config)}`)).toBe(`cfg=${MASK}`);
		expect(set.mask(`cfg=${pythonJson(config)}`)).toBe(`cfg=${MASK}`);
	});

	it('整数样子的键：按字节序（"10" 在 "9" 之前），不是 JS 对象的数值序', () => {
		const set = setOf({ "9": "y", "10": "x", a: "z" });
		// 多了一个键就是另一个对象，叶子又都很短：不盖
		expect(set.mask('{"10":"x","2":"w","9":"y","a":"z"}')).toBe(
			'{"10":"x","2":"w","9":"y","a":"z"}',
		);
		// JS 对象的数值序（"9" 在 "10" 之前）不是节点收到的顺序，但参数里写的顺序就是 JS 给出的这个
		expect(set.mask('{"9":"y","10":"x","a":"z"}')).toBe(MASK);
		expect(set.mask('{"10": "x", "9": "y", "a": "z"}')).toBe(MASK);
		expect(set.mask('{"10":"x","9":"y","a":"z"}')).toBe(MASK);
	});

	it("BMP 之外的字符和中文的键：字节序是 ASCII < 中文 < ￥ < emoji（UTF-16 码元序里 emoji 在 ￥ 之前）", () => {
		const set = setOf({ "😀": "x", "￥": "y", 中文: "z", a: "w" });
		expect(set.mask('{"a":"w","中文":"z","￥":"y","😀":"x"}')).toBe(MASK);
		expect(set.mask('{"a": "w", "中文": "z", "￥": "y", "😀": "x"}')).toBe(MASK);
		// ensure_ascii（默认）：非 ASCII 写成 \uXXXX，顺序不变
		expect(set.mask(pythonJson({ a: "w", 中文: "z", "￥": "y", "😀": "x" }))).toBe(MASK);
	});

	it("作为节点整个等于它：键的顺序不同也算同一个对象", () => {
		const set = setOf(config);
		expect(maskValue(received, set)).toBe(MASK);
		expect(maskValue(config, set)).toBe(MASK);
		expect(maskValue({ ...received, extra: 1 }, set)).not.toBe(MASK);
	});
});

describe("很长的值：不能让打码本身失败，也不能把值带进错误里", () => {
	const longString = `${"abcdefghij".repeat(4096)}-tail-marker`; // 40 KB
	const longObject = { blob: "k".repeat(40_000), n: { deep: "d".repeat(500) } };
	const cjk = "口令".repeat(3000); // 6000 个汉字，\uXXXX 写法是 36000 个字符

	it("40 KB 的字符串、40 KB 的对象、6000 个汉字的值：不抛错，值和它的各种写法都换成掩码，周围的文字不变", () => {
		for (const [name, value, hits] of [
			["字符串", longString, [longString]],
			["对象", longObject, [JSON.stringify(longObject), "k".repeat(40_000)]],
			["汉字", cjk, [cjk, pythonJson(cjk).slice(1, -1)]],
		] as const) {
			const set = setOf(value);
			for (const hit of hits) {
				expect(set.mask(`before ${hit} after`), name).toBe(`before ${MASK} after`);
			}
			// 值里的片段不够整个值，不是 secret 值本身；没有 secret 值的文字原样
			expect(set.mask("nothing to see here"), name).toBe("nothing to see here");
		}
	});

	it("长的值和短的值同时在：两类都盖住，互相重叠的部分只留一个掩码", () => {
		const set = setOf(longString, "short-secret-value");
		expect(set.mask(`a ${longString} b short-secret-value c`)).toBe(`a ${MASK} b ${MASK} c`);
		expect(set.mask(`x short-secret-value${longString}y`)).toBe(`x ${MASK}${MASK}y`);
	});

	it("编译正则失败时（注入一个一定失败的编译器）：不抛错，值照样换成掩码，错误里没有值", () => {
		const secret = "super-secret-token-value-123";
		const attempts: string[] = [];
		const failing = (source: string): RegExp => {
			attempts.push(source);
			// V8 的报错会把整个正则的源码带出来：这里模拟同样的行为。
			throw new SyntaxError(
				`Invalid regular expression: /${source}/: Regular expression too large`,
			);
		};
		const set = new SecretSet([secretPartsOf(secret), secretPartsOf("another-secret-4567")], {
			compile: failing,
		});
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			let masked = "";
			expect(() => {
				masked = set.mask(`login ${secret} and another-secret-4567 ok`);
			}).not.toThrow();
			expect(masked).toBe(`login ${MASK} and ${MASK} ok`);
			// 同一份集合反复用也一样；不放行原文，也不输出值
			expect(set.mask(`${secret}`)).toBe(MASK);
			expect(attempts.length).toBeGreaterThan(0);
			expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
		} finally {
			spy.mockRestore();
		}
	});

	it("一份值集合很大（几千个值）：按块编译，结果和只有几个值时一样", () => {
		const values = Array.from({ length: 3000 }, (_, i) => `test-secret-value-${i}-end-padding`);
		const set = setOf(...values);
		expect(set.mask(`a ${values[0]} b ${values[2999]} c ${values[1500]}`)).toBe(
			`a ${MASK} b ${MASK} c ${MASK}`,
		);
		expect(set.mask("test-secret-value-3000-end-padding")).toBe(
			"test-secret-value-3000-end-padding",
		);
	});
});
