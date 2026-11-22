// secret 参数的值要打码的东西（#479）：一个 secret 参数的值，不论类型，打码时算哪些文本、哪些整个节点。
// 读取运行（运行视图、列表、事件流）、写日志和动作、触发时的报错用的都是这一份（logs/secrets.ts 的 SecretSet），
// 对象和数组、JSON 转义的写法、短叶子的取舍只在那里处理，这里直接测它。规则的编号见 docs/SEMANTICS.md §2.1。
// 值都是明显的假值。
import { ACTION_LIMITS } from "@sfly/schema";
import { describe, expect, it, vi } from "vitest";
import {
	actionField,
	actionName,
	actionReason,
	maskedAction,
	maskedSummary,
} from "../src/actions/action-text.js";
import {
	canonicalJson,
	charCount,
	compareUtf8,
	MAX_CLIP_WORK,
	MAX_MASK_WORK,
	MIN_CLIPPED_PREFIX_CHARS,
	MIN_LEAF_CHARS,
	maskParams,
	maskRecord,
	maskSecrets,
	maskValue,
	NO_SECRETS,
	READ_WORK_BUDGET,
	SECRET_MASK,
	SecretSet,
	secretPartsOf,
	secretSetOf,
	shortLeafCount,
	WorkBudget,
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

	it("互相重叠的值：重叠的位置合成一段，只换一个掩码，不留下任何一个值的尾巴；相邻但不重叠的各是一个掩码（正则的路径和字面量的路径一样）", () => {
		const cases: Array<[string[], string, string]> = [
			// abcd 和 cdef 在 abcdef 里重叠：合成一段
			[["abcd", "cdef"], "x abcdef y", `x ${MASK} y`],
			[["cdef", "abcd"], "x abcdef y", `x ${MASK} y`],
			// 三个连着重叠
			[["aaab", "abbb", "bbbc"], "..aaabbbc..", `..${MASK}..`],
			// 一个是另一个的一部分：只换一个
			[["abcd", "abcdefgh"], "x abcdefgh y", `x ${MASK} y`],
			// 相邻、不重叠：各是一个掩码
			[["abcd", "efgh"], "abcdefgh", `${MASK}${MASK}`],
			// 不相干的位置
			[["abcd", "wxyz"], "abcd-wxyz abcd", `${MASK}-${MASK} ${MASK}`],
		];
		for (const [texts, text, expected] of cases) {
			expect(setOf(...texts).mask(text), `${texts.join("+")} / ${text}`).toBe(expected);
		}
		// 超过 1024 个字符的值走字面量查找：和上面一样合并
		const long1 = `L1-${"x".repeat(1100)}-end`;
		const long2 = `${"x".repeat(1100)}-end-tail-${"y".repeat(10)}`;
		expect(setOf(long1, long2).mask(`a ${long1}-tail-${"y".repeat(10)} b`)).toBe(`a ${MASK} b`);
		// 一个长的、一个短的：字面量和正则两条路径之间的重叠同样合并
		expect(setOf(long1, "end-zzzz").mask(`a ${long1}-zzzz b`)).toBe(`a ${MASK} b`);
	});

	it("随机的值集合和文字，和「所有出现的位置，重叠的合成一段，每段一个掩码」的参照实现对比：结果一样，不留下任何一个值", () => {
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
		/** 参照实现：每个文本的每个出现位置都记下来，重叠的合成一段，每段换一个掩码。 */
		const mergedMask = (text: string, texts: readonly string[]): string => {
			const spans: Array<[number, number]> = [];
			for (const t of texts) {
				for (let at = text.indexOf(t); at >= 0; at = text.indexOf(t, at + 1))
					spans.push([at, at + t.length]);
			}
			spans.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
			let out = "";
			let cursor = 0;
			let current: [number, number] | undefined;
			for (const span of spans) {
				if (current && span[0] < current[1]) {
					current[1] = Math.max(current[1], span[1]);
					continue;
				}
				if (current) {
					out += text.slice(cursor, current[0]) + MASK;
					cursor = current[1];
				}
				current = [span[0], span[1]];
			}
			if (current) out += text.slice(cursor, current[0]) + MASK + text.slice(current[1]);
			else out = text;
			return out;
		};

		let overlapped = 0;
		for (let round = 0; round < 1500; round++) {
			const texts = [...new Set(Array.from({ length: 1 + random(8) }, () => word(1, 8)))];
			const set = setOf(...texts);
			// 文字：值、值的片段、噪声随机拼起来，一半的情况下让值之间首尾相接。
			const pieces = [
				...set.texts,
				...set.texts.map((t) => t.slice(1)),
				...set.texts.map((t) => t.slice(0, -1)),
				"a",
				"b",
				" ",
				"xyz",
			];
			const text = Array.from({ length: 1 + random(12) }, () => pieces[random(pieces.length)]).join(
				"",
			);
			const got = set.mask(text);
			const where = `${JSON.stringify(set.texts)} / ${JSON.stringify(text)}`;
			expect(got, where).toBe(mergedMask(text, set.texts));
			for (const t of set.texts) expect(got, where).not.toContain(t);
			if (got.split(MASK).length > 2 && got !== text) overlapped += 1;
		}
		// 确认随机的情形真的包含了有掩码的文字（不是几乎都没有匹配）。
		expect(overlapped).toBeGreaterThan(100);
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

describe("compareUtf8：键的排序不分配，和 UTF-8 字节序（Buffer.compare）一致", () => {
	it("良构的随机字符串（ASCII、中文、BMP 里码点很高的字符、emoji、代理对相邻）：符号和 Buffer.compare 一致", () => {
		let seed = 424242;
		const random = (n: number): number => {
			seed = (seed * 1664525 + 1013904223) % 4294967296;
			return Math.floor((seed / 4294967296) * n);
		};
		const alphabet = [
			"a",
			"B",
			"z",
			"0",
			"9",
			"",
			"好",
			"中",
			"￥",
			"\uffff",
			"\ue000",
			"\ud7ff",
			"😀",
			"𝒳",
			"\u{10ffff}",
			"é",
		];
		const word = () =>
			Array.from({ length: random(6) }, () => alphabet[random(alphabet.length)]).join("");
		const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);
		for (let i = 0; i < 20_000; i++) {
			const a = word();
			const b = word();
			expect(sign(compareUtf8(a, b)), JSON.stringify([a, b])).toBe(
				sign(Buffer.compare(Buffer.from(a), Buffer.from(b))),
			);
		}
	});

	it("孤立的代理项（不是良构的字符串）：和 Buffer.compare 不同，这是已知的、不处理的情况（它们进不了 jsonb，也过不了 serde_json）", () => {
		// Buffer.from 把孤立的高位代理项写成 U+FFFD 的三个字节，按字节排它和 U+FFFD 相等，在 U+FFFF 之前；
		// compareUtf8 按码元比，孤立的高位代理项（U+D800）排在 BMP 里 U+E000 以上的字符之后。两者不同，这里钉住这个事实。
		const lone = "\ud800";
		const high = "\uffff";
		expect(Math.sign(Buffer.compare(Buffer.from(lone), Buffer.from(high)))).toBe(-1);
		expect(Math.sign(compareUtf8(lone, high))).toBe(1);
	});

	it("用例表里的顺序：ASCII < 中文 < ￥ < emoji；空串最前；前缀在前", () => {
		const keys = ["😀", "￥", "中文", "a", "", "ab", "B"];
		expect([...keys].sort(compareUtf8)).toEqual(["", "B", "a", "ab", "中文", "￥", "😀"]);
	});
});

describe("读取运行时对对象和数组的比较：先排除，再算标准写法", () => {
	const secret = { env: "prod", user: "admin", nested: { b: 1, a: [true, "x"] } };

	it("键的顺序不同也是同一个对象；多一个键、少一个元素、值不同都不是", () => {
		const set = setOf(secret);
		expect(maskValue({ nested: { a: [true, "x"], b: 1 }, user: "admin", env: "prod" }, set)).toBe(
			MASK,
		);
		expect(maskValue({ ...secret, extra: 1 }, set)).not.toBe(MASK);
		expect(maskValue({ env: "prod", user: "admin" }, set)).not.toBe(MASK);
		expect(maskValue({ ...secret, nested: { b: 1, a: [true] } }, set)).not.toBe(MASK);
		expect(maskValue({ ...secret, env: "dev" }, set)).not.toBe(MASK);
	});

	it("值是 undefined 的键不算键（标准写法不写它）", () => {
		const set = setOf(secret);
		expect(maskValue({ ...secret, ghost: undefined }, set)).toBe(MASK);
	});

	it("数组：元素个数和内容都要一样", () => {
		const set = setOf(["alpha-secret", 1234, { k: "v" }]);
		expect(maskValue(["alpha-secret", 1234, { k: "v" }], set)).toBe(MASK);
		expect(maskValue(["alpha-secret", 1234], set)).not.toBe(MASK);
		expect(maskValue(["alpha-secret", 1234, { k: "w" }], set)).not.toBe(MASK);
	});

	it("没有对象或数组的 secret 时，不做任何比较（返回 false，不读对象）", () => {
		const set = setOf("alpha-secret");
		expect(set.equalsContainer({ a: 1 })).toBe(false);
		expect(set.equalsContainer([1])).toBe(false);
	});

	it("和不排除、直接比标准写法的结果一样（随机的对象，键序随机）", () => {
		let seed = 777;
		const random = (n: number): number => {
			seed = (seed * 1664525 + 1013904223) % 4294967296;
			return Math.floor((seed / 4294967296) * n);
		};
		const make = (depth: number): unknown => {
			const kind = random(depth > 1 ? 3 : 5);
			if (kind === 0) return `s${random(3)}`;
			if (kind === 1) return random(3);
			if (kind === 2) return random(2) === 0;
			if (kind === 3) return Array.from({ length: random(3) }, () => make(depth + 1));
			return Object.fromEntries(
				Array.from({ length: random(3) }, () => [`k${random(3)}`, make(depth + 1)]),
			);
		};
		const shuffle = (v: unknown): unknown => {
			if (Array.isArray(v)) return v.map(shuffle);
			if (v !== null && typeof v === "object") {
				return Object.fromEntries(
					Object.entries(v)
						.sort(() => random(3) - 1)
						.map(([k, x]) => [k, shuffle(x)]),
				);
			}
			return v;
		};
		for (let i = 0; i < 2000; i++) {
			const a = make(0);
			const b = random(2) === 0 ? shuffle(a) : make(0);
			if (a === null || typeof a !== "object" || b === null || typeof b !== "object") continue;
			if (Array.isArray(a) ? a.length === 0 : Object.keys(a).length === 0) continue;
			const set = setOf(a);
			// 里面没有任何可打码内容的对象（只有空容器、空串、null）不是 secret 值：集合是空的，什么都不等于它。
			const expected = !set.isEmpty && canonicalJson(a) === canonicalJson(b);
			expect(set.equalsContainer(b as object), JSON.stringify([a, b])).toBe(expected);
		}
	});
});

describe("值集合的缓存：值相同是同一个对象，值变了是另一份", () => {
	it("同样的值反复问是同一个集合（不重新写各种写法、不重新编译）；多一个值就是另一个", () => {
		const one = secretSetOf(["test-secret-value", { a: "bbbb" }]);
		expect(secretSetOf(["test-secret-value", { a: "bbbb" }])).toBe(one);
		const two = secretSetOf(["test-secret-value", { a: "bbbb" }, "later-secret-value"]);
		expect(two).not.toBe(one);
		expect(one.mask("later-secret-value")).toBe("later-secret-value");
		expect(two.mask("later-secret-value")).toBe(MASK);
		// 值相同、顺序不同：另一份，结果一样
		expect(secretSetOf([{ a: "bbbb" }, "test-secret-value"]).mask("test-secret-value")).toBe(MASK);
	});

	it("缓存里的集合不可变，共用不会互相影响；不能 JSON 化的值（BigInt）不进缓存，照样能用", () => {
		const a = secretSetOf(["shared-secret-value"]);
		const b = secretSetOf(["shared-secret-value"]);
		expect(a.mask("x shared-secret-value")).toBe(`x ${MASK}`);
		expect(b.mask("shared-secret-value y")).toBe(`${MASK} y`);
		expect(() => secretSetOf([{ n: 10n }])).not.toThrow();
	});
});

describe("两条匹配路径：一次 replace（不会部分重叠）和合并位置（会），结果逐字相同", () => {
	/** 参照实现：每个文本的每个出现位置都记下来，重叠的合成一段，每段换一个掩码。 */
	const mergedMask = (text: string, texts: readonly string[]): string => {
		const spans: Array<[number, number]> = [];
		for (const t of texts) {
			for (let at = text.indexOf(t); at >= 0; at = text.indexOf(t, at + 1))
				spans.push([at, at + t.length]);
		}
		spans.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
		let out = "";
		let cursor = 0;
		let current: [number, number] | undefined;
		for (const span of spans) {
			if (current && span[0] < current[1]) {
				current[1] = Math.max(current[1], span[1]);
				continue;
			}
			if (current) {
				out += text.slice(cursor, current[0]) + MASK;
				cursor = current[1];
			}
			current = [span[0], span[1]];
		}
		return current ? out + text.slice(cursor, current[0]) + MASK + text.slice(current[1]) : text;
	};
	/** 独立的判断：有没有两个文本（可以是同一个）X、Y 和 0 < k < min(长度)，使 X 的后 k 个字符等于 Y 的前 k 个字符。 */
	const partiallyOverlap = (texts: readonly string[]): boolean =>
		texts.some((x) =>
			texts.some((y) => {
				for (let k = 1; k < Math.min(x.length, y.length); k++) {
					if (x.slice(x.length - k) === y.slice(0, k)) return true;
				}
				return false;
			}),
		);

	it("随机的值集合（小字母表，长短不一，常有嵌套和重叠）和文字：plain 的判断和独立的判断一致，两条路径的结果都等于参照实现，两条路径都走到了", () => {
		let seed = 31337;
		const random = (n: number): number => {
			seed = (seed * 1664525 + 1013904223) % 4294967296;
			return Math.floor((seed / 4294967296) * n);
		};
		const alphabet = ["a", "b", "c", "d", "e"];
		const word = (min: number, max: number) =>
			Array.from(
				{ length: min + random(max - min + 1) },
				() => alphabet[random(alphabet.length)],
			).join("");
		let plainRuns = 0;
		let mergedRuns = 0;
		let nestedPlain = 0;
		for (let round = 0; round < 4000; round++) {
			const texts = [...new Set(Array.from({ length: 1 + random(5) }, () => word(2, 9)))];
			const set = setOf(...texts);
			const info = set.matching();
			// 这些文本都进正则（不超过 1024），所以只看 plain 的判断
			expect(info.plain, JSON.stringify(set.texts)).toBe(
				info.regexes === 1 && info.literals === 0 && !partiallyOverlap(set.texts),
			);
			const pieces = [
				...set.texts,
				...set.texts.map((t) => t.slice(1)),
				...set.texts.map((t) => t.slice(0, -1)),
				"a",
				"e",
				"x",
			];
			for (let k = 0; k < 3; k++) {
				const text = Array.from(
					{ length: 1 + random(10) },
					() => pieces[random(pieces.length)],
				).join("");
				const got = set.mask(text);
				const where = `${JSON.stringify(set.texts)} / ${JSON.stringify(text)} / plain=${info.plain}`;
				expect(got, where).toBe(mergedMask(text, set.texts));
				for (const t of set.texts) expect(got, where).not.toContain(t);
			}
			if (info.plain) {
				plainRuns += 1;
				// 嵌套（一个文本是另一个的子串）的集合也走 plain：确认这种情况被测到
				if (set.texts.some((x) => set.texts.some((y) => x !== y && y.includes(x))))
					nestedPlain += 1;
			} else mergedRuns += 1;
		}
		expect(plainRuns).toBeGreaterThan(300);
		expect(mergedRuns).toBeGreaterThan(300);
		expect(nestedPlain).toBeGreaterThan(30);
	});

	it("明确的几种：嵌套走 plain，部分重叠和自己的重叠（周期性的值）走合并，超过 1024 的值走合并", () => {
		expect(setOf("abcd", "bc").matching().plain).toBe(true);
		// abc 的结尾 c 是 cd 的开头：abc 和 cd 能在 abcd 里部分重叠，所以这一组不是 plain
		expect(setOf("abcdef", "cd", "abc").matching().plain).toBe(false);
		// 嵌套、没有部分重叠
		expect(setOf("abcdef", "bcd", "xyz").matching().plain).toBe(true);
		expect(setOf("abcd", "cdef").matching().plain).toBe(false);
		expect(setOf("abab-xyz").matching().plain).toBe(true);
		expect(setOf("abcabc").matching().plain).toBe(false);
		expect(setOf("0".repeat(8)).matching().plain).toBe(false);
		expect(setOf("x".repeat(1100)).matching().plain).toBe(false);
		// 嵌套时 plain 路径和合并路径的结果相同
		expect(setOf("abcd", "bc").mask("..abcd..bc..")).toBe(`..${MASK}..${MASK}..`);
	});

	it("一个短值加一个很长、不周期的值（又没有部分重叠）：只有一个正则、另有字面量，不能走一次 replace 的路径，长的值照样盖住", () => {
		// 每个字符都不一样（取自不同的汉字），所以没有部分重叠，判断「会不会部分重叠」本身不会因为步数上限而放弃
		const long = Array.from({ length: 2000 }, (_, i) =>
			String.fromCharCode(0x4e00 + ((i * 7919) % 20000)),
		).join("");
		const set = setOf("short-secret-value", long);
		const info = set.matching();
		expect(info.regexes).toBe(1);
		expect(info.literals).toBeGreaterThan(0);
		expect(info.plain).toBe(false);
		expect(set.mask(`a ${long} b short-secret-value c`)).toBe(`a ${MASK} b ${MASK} c`);
	});

	it("判断本身有步数上限：很大的、周期性很强的值集合按「会部分重叠」处理，走合并路径，结果照样对", () => {
		const big = setOf(
			...Array.from({ length: 3000 }, (_, i) => `${"a".repeat(600)}-${i}-${"b".repeat(600)}`),
		);
		expect(big.matching().plain).toBe(false);
		expect(big.mask(`x ${"a".repeat(600)}-7-${"b".repeat(600)} y`)).toBe(`x ${MASK} y`);
	});
});

describe("病态输入：周期性的值在周期性的文字里，打码的工作量有上限，超过就把整段文字盖住", () => {
	/** 在这个时限内返回（很宽，只防「卡几秒」这个数量级）。 */
	const FAST_MS = 1000;

	it("1024 个 0 的值在 1 MB 的 0 里：很快返回，结果里没有值", () => {
		const set = setOf("0".repeat(1024));
		const text = "0".repeat(1_000_000);
		const started = performance.now();
		const out = set.mask(text);
		expect(performance.now() - started).toBeLessThan(FAST_MS);
		expect(out).not.toContain("0000");
		expect(out).toBe(MASK);
	});

	it("20000 个 0 的值（走字面量查找）在 256 KB 的 0 里：很快返回，结果里没有值", () => {
		const set = setOf("0".repeat(20_000));
		const text = "0".repeat(262_144);
		const started = performance.now();
		const out = set.mask(text);
		expect(performance.now() - started).toBeLessThan(FAST_MS);
		expect(out).toBe(MASK);
	});

	it("超过上限时整段盖住，周围的文字也盖住（宁可多盖）；没超过时只盖值本身", () => {
		const set = setOf("0".repeat(1024));
		expect(set.mask(`before ${"0".repeat(1024)} after`)).toBe(`before ${MASK} after`);
		expect(set.mask(`before ${"0".repeat(200_000)} after`)).toBe(MASK);
	});

	it("正常的输入不受上限影响：400 万字的输出里出现 100 次 4 万字的值，每次都盖住，周围的文字原样", () => {
		const secret = `${"abcdefghij".repeat(4096)}-end`;
		const set = setOf(secret);
		const text = Array.from({ length: 100 }, (_, i) => `row ${i} ${secret} ok`).join("\n");
		const out = set.mask(text);
		expect(out.split(MASK).length - 1).toBe(100);
		expect(out).toContain("row 99 ****** ok");
		expect(out).not.toContain("abcdefghij");
	});

	it("值集合里有会部分重叠的几个值，文字里首尾相接地出现很多次：不超过上限时合并成一段", () => {
		const set = setOf("abcd-xyz", "xyz-efgh");
		const text = "abcd-xyz-efgh ".repeat(1000);
		expect(set.mask(text)).toBe(`${MASK} `.repeat(1000));
	});
});

describe("值集合缓存的大小上限（按条数和文本总长）", () => {
	it("条数超过 64：最早的被丢掉，最新的一份总是留着；被丢掉的再问是重新算的另一个对象，结果一样", () => {
		const first = secretSetOf([`cache-limit-value-${0}`]);
		for (let i = 1; i <= 70; i++) secretSetOf([`cache-limit-value-${i}`]);
		const last = secretSetOf(["cache-limit-value-70"]);
		expect(secretSetOf(["cache-limit-value-70"])).toBe(last);
		const again = secretSetOf(["cache-limit-value-0"]);
		expect(again).not.toBe(first);
		expect(again.mask("x cache-limit-value-0 y")).toBe(`x ${MASK} y`);
	});

	it("文本总长超过上限（8 M 个字符）：大的集合把最早的挤出去，最新的一份总是留着，哪怕它自己就超过上限", () => {
		const small = secretSetOf(["small-cache-value-xyz"]);
		const big = (tag: string) => `${tag}-${"q".repeat(3_000_000)}`;
		const one = secretSetOf([big("one")]);
		secretSetOf([big("two")]);
		secretSetOf([big("three")]);
		// 三份各 300 万个字符，合计超过 800 万：最早的两份（small 和 one）被挤出去
		expect(secretSetOf(["small-cache-value-xyz"])).not.toBe(small);
		expect(secretSetOf([big("one")])).not.toBe(one);
		const huge = secretSetOf([`huge-${"h".repeat(9_000_000)}`]);
		expect(secretSetOf([`huge-${"h".repeat(9_000_000)}`])).toBe(huge);
		expect(secretSetOf(["small-cache-value-xyz"]).mask("a small-cache-value-xyz b")).toBe(
			`a ${MASK} b`,
		);
	}, 60_000);
});

describe("被截断的文字结尾留下的半截 secret 值（读取时的补救，#517）", () => {
	const secret = "zebra-late-value";
	const set = setOf(secret);
	const LIMIT = 40;
	/** 一段已经截到上限的文字：`filler` 填充，结尾留下 secret 值的前 `kept` 个码点。 */
	const clipped = (kept: number, filler = "x") =>
		filler.repeat(LIMIT - kept) + Array.from(secret).slice(0, kept).join("");

	it("下限是一个有名字的常量：4", () => {
		expect(MIN_CLIPPED_PREFIX_CHARS).toBe(4);
	});

	it("文字到了上限、结尾是 secret 值的前缀（不短于下限）：从前缀开头起换成一个掩码，前面的文字原样", () => {
		for (const kept of [4, 5, 8, 15]) {
			const text = clipped(kept);
			expect(text.length, `kept=${kept}`).toBe(LIMIT);
			expect(set.maskClipped(text, LIMIT), `kept=${kept}`).toBe(
				`${"x".repeat(LIMIT - kept)}${MASK}`,
			);
		}
	});

	it("前缀短于下限：不盖（盖了会把正常的文字也换掉）", () => {
		for (const kept of [1, 2, 3]) {
			const text = clipped(kept);
			expect(set.maskClipped(text, LIMIT), `kept=${kept}`).toBe(text);
		}
	});

	it("文字没到上限（没被截断过）：不看结尾，原样", () => {
		const text = `short ${secret.slice(0, 8)}`;
		expect(set.maskClipped(text, LIMIT)).toBe(text);
		// 差一个字符到上限
		const almost = clipped(8).slice(1);
		expect(almost.length).toBe(LIMIT - 1);
		expect(set.maskClipped(almost, LIMIT)).toBe(almost);
	});

	it("结尾不是 secret 值的前缀：原样；整个值出现在结尾是完整的出现，和别处的一样换成一个掩码", () => {
		const text = `${"x".repeat(LIMIT - 8)}zebra-xx`;
		expect(set.maskClipped(text, LIMIT)).toBe(text);
		const whole = "x".repeat(LIMIT - secret.length) + secret;
		expect(set.maskClipped(whole, LIMIT)).toBe(`${"x".repeat(LIMIT - secret.length)}${MASK}`);
	});

	it("按码点算：上限是码点数，不是 UTF-16 码元数（emoji 占两个码元）", () => {
		const emoji = "😀".repeat(LIMIT - 8);
		const text = emoji + secret.slice(0, 8);
		expect(Array.from(text).length).toBe(LIMIT);
		expect(set.maskClipped(text, LIMIT)).toBe(`${emoji}${MASK}`);
		// 码点数没到上限（只是码元数到了）：原样
		const notClipped = "😀".repeat(LIMIT - 20) + secret.slice(0, 8);
		expect(set.maskClipped(notClipped, LIMIT)).toBe(notClipped);
	});

	it("失败原因：截断时末尾补了「…」，判断时不算它，盖住时连它一起换掉", () => {
		const text = `${clipped(8)
			.slice(0, -8)
			.slice(0, LIMIT - 9)}${secret.slice(0, 8)}…`;
		expect(Array.from(text).length).toBe(LIMIT);
		expect(set.maskClipped(text, LIMIT, { ellipsis: true })).toBe(
			`${"x".repeat(LIMIT - 9)}${MASK}`,
		);
		// 不带 ellipsis 选项时，结尾的「…」让它不是前缀：原样
		expect(set.maskClipped(text, LIMIT)).toBe(text);
	});

	it("有好几个 secret 值：任何一个的前缀都盖；最靠前的前缀开头起换", () => {
		const two = setOf(secret, "another-secret-token");
		expect(two.maskClipped(`${"y".repeat(LIMIT - 7)}another`, LIMIT)).toBe(
			`${"y".repeat(LIMIT - 7)}${MASK}`,
		);
		expect(two.maskClipped(`${"y".repeat(LIMIT - 8)}zebra-la`, LIMIT)).toBe(
			`${"y".repeat(LIMIT - 8)}${MASK}`,
		);
	});

	it("没有 secret 值时原样；多行的 secret 值按行的前缀也算（每一行都是一个要打码的文本）", () => {
		expect(setOf().maskClipped(clipped(8), LIMIT)).toBe(clipped(8));
		const pem = setOf("-----BEGIN TEST KEY-----\nabcdef123456\n-----END TEST KEY-----");
		expect(pem.maskClipped(`${"z".repeat(LIMIT - 9)}abcdef123`, LIMIT)).toBe(
			`${"z".repeat(LIMIT - 9)}${MASK}`,
		);
	});

	it("病态输入：几千个很长的值，文字的每个位置都以值的首字符开头、却永远对不上前缀：工作量有上限，很快返回，整段盖住，结果里没有值", () => {
		// 位置数 × 文本数 × 文本长：没有上限时 4096 个字符的失败原因要 29–34 秒（3000 个各 3000 个 0 的值）
		const values = Array.from({ length: 3000 }, (_, i) => `${"0".repeat(3000)}-${i}`);
		const many = setOf(...values);
		const reason = `${"0".repeat(4094)}1…`;
		const started = performance.now();
		const out = many.maskClipped(reason, 4096, { ellipsis: true });
		expect(performance.now() - started).toBeLessThan(1000);
		expect(out).toBe(MASK);
		// 字段值的上限（256）：同样
		expect(many.maskClipped(`${"0".repeat(255)}1`, 256)).toBe(MASK);
		// 200 个各 1 万个 0 的值
		const long = setOf(...Array.from({ length: 200 }, (_, i) => `${"0".repeat(10_000)}-${i}`));
		const started2 = performance.now();
		expect(long.maskClipped(reason, 4096, { ellipsis: true })).toBe(MASK);
		expect(performance.now() - started2).toBeLessThan(1000);
		expect(MAX_CLIP_WORK).toBeLessThanOrEqual(10_000_000);
	});

	it("工作量没超过上限的正常输入不受影响：几十个值、截断到上限的文字，该盖的盖、不该盖的不动", () => {
		const values = Array.from({ length: 50 }, (_, i) => `test-secret-value-${i}-end`);
		const many = setOf(...values);
		// 结尾是 `test-secr`（9 个字符，是 `test-secret-value-N-end` 的前缀）
		expect(many.maskClipped(`${"x".repeat(256 - 9)}test-secr`, 256)).toBe(
			`${"x".repeat(256 - 9)}${MASK}`,
		);
		const plain = "x".repeat(256);
		expect(many.maskClipped(plain, 256)).toBe(plain);
		// 文字里到处是首字符 t 但对不上前缀：不盖
		const noisy = "t".repeat(256);
		expect(many.maskClipped(noisy, 256)).toBe(noisy);
	});

	it("随机的对比：和直接检查「结尾是不是某个文本的前缀」的参照实现一致", () => {
		let seed = 99;
		const random = (n: number): number => {
			seed = (seed * 1664525 + 1013904223) % 4294967296;
			return Math.floor((seed / 4294967296) * n);
		};
		const alphabet = ["a", "b", "c", "d"];
		const word = (min: number, max: number) =>
			Array.from(
				{ length: min + random(max - min + 1) },
				() => alphabet[random(alphabet.length)],
			).join("");
		for (let i = 0; i < 3000; i++) {
			const secrets = [...new Set(Array.from({ length: 1 + random(3) }, () => word(5, 12)))];
			const texts = setOf(...secrets);
			const text = word(LIMIT, LIMIT + 2).slice(0, LIMIT) + "";
			const body = text;
			// 参照实现：要盖住的位置是每个文本的每个出现位置（一个一个找），加上最靠前的位置 at——body.slice(at) 是某个 secret 文本的
			// 真前缀且不短于下限——到结尾；重叠的合成一段，每段一个掩码。
			const spans: Array<[number, number]> = [];
			for (const t of texts.texts) {
				for (let from = body.indexOf(t); from >= 0; from = body.indexOf(t, from + 1)) {
					spans.push([from, from + t.length]);
				}
			}
			for (let at = 0; at < body.length; at++) {
				const tail = body.slice(at);
				if (tail.length < MIN_CLIPPED_PREFIX_CHARS) break;
				if (texts.texts.some((t) => t.length > tail.length && t.startsWith(tail))) {
					spans.push([at, body.length]);
					break;
				}
			}
			spans.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
			let expected = "";
			let cursor = 0;
			for (let k = 0; k < spans.length; ) {
				const from = (spans[k] as [number, number])[0];
				let to = (spans[k] as [number, number])[1];
				k += 1;
				while (k < spans.length && (spans[k] as [number, number])[0] < to) {
					to = Math.max(to, (spans[k] as [number, number])[1]);
					k += 1;
				}
				expected += body.slice(cursor, from) + MASK;
				cursor = to;
			}
			expected += body.slice(cursor);
			expect(texts.maskClipped(text, LIMIT), JSON.stringify([secrets, text])).toBe(expected);
		}
	});
});

describe("动作的文字：写入时和读取时的打码（action-text.ts）", () => {
	const secret = "zebra-late-value";
	const set = setOf(secret);
	const { nameChars, valueChars, reasonChars } = ACTION_LIMITS;
	/** SDK 已经截断过的文字：secret 值的前 8 个字符留在上限以内。 */
	const straddle = (limit: number, filler: string) => filler.repeat(limit - 8) + secret.slice(0, 8);

	it("写入时：secret 值已知，但 SDK 在值中间截断了（控制面只收到前半截）：名称、字段的键和值、失败原因都把半截盖住", () => {
		expect(actionName(straddle(nameChars, "n"), set)).toBe(`${"n".repeat(nameChars - 8)}${MASK}`);
		expect(actionField(straddle(nameChars, "k"), straddle(valueChars, "v"), set)).toEqual([
			`${"k".repeat(nameChars - 8)}${MASK}`,
			`${"v".repeat(valueChars - 8)}${MASK}`,
		]);
		// 失败原因：SDK 留前 reasonChars - 1 个字符、末尾加「…」
		const reason = `${"r".repeat(reasonChars - 1 - 8)}${secret.slice(0, 8)}…`;
		expect(actionReason(reason, set)).toBe(`${"r".repeat(reasonChars - 1 - 8)}${MASK}`);
	});

	it("没有被截断（没到上限）的文字、没有 secret 值：和以前一样", () => {
		expect(actionName("short name", set)).toBe("short name");
		expect(actionName(`load ${secret}`, set)).toBe(`load ${MASK}`);
		expect(actionReason("plain", set)).toBe("plain");
		expect(actionName(straddle(nameChars, "n"), setOf())).toBe(straddle(nameChars, "n"));
	});

	it("读取时：明细、摘要里的名称、字段（键和值）、失败原因再打一遍；没有 secret 值时是同一个对象", () => {
		const running = {
			id: 1,
			parent: null,
			depth: 0,
			name: `load ${secret}`,
			fields: { [`k-${secret}`]: `/x/${secret}` },
			started_at: "2026-01-01T00:00:01.000Z",
			agent_started_at: "2026-01-01T00:00:01.000Z",
		};
		const ended = {
			...running,
			id: 2,
			ended_at: "2026-01-01T00:00:02.000Z",
			agent_ended_at: "2026-01-01T00:00:02.000Z",
			duration_ms: 1000,
			result: "failed" as const,
			reason: `bad ${secret}`,
		};
		const masked = maskedAction(ended, set);
		expect(masked.name).toBe(`load ${MASK}`);
		expect(masked.fields).toEqual({ [`k-${MASK}`]: `/x/${MASK}` });
		expect(masked.reason).toBe(`bad ${MASK}`);
		expect(masked.id).toBe(2);
		expect(maskedAction(ended, setOf())).toBe(ended);
		const summary = {
			total: 2,
			marks: 0,
			reported: 2,
			capped: false,
			control_plane_capped: false,
			capped_at: null,
			agent_capped_at: null,
			names: [
				{
					name: `load ${secret}`,
					total: 1,
					failed: 0,
					reported: 1,
					capped_at: null,
					agent_capped_at: null,
				},
			],
			running: [running],
			running_complete: true,
			recent: [ended],
			recent_failed: [ended],
		};
		const out = maskedSummary(summary, set);
		expect(JSON.stringify(out)).not.toContain(secret);
		expect(out.names[0]?.name).toBe(`load ${MASK}`);
		expect(out.running[0]?.fields).toEqual({ [`k-${MASK}`]: `/x/${MASK}` });
		expect(out.recent_failed[0]?.reason).toBe(`bad ${MASK}`);
		expect(maskedSummary(summary, setOf())).toBe(summary);
	});
});

describe("被截断的文字：是不是被截断过、结尾的半截，按打码之前的文字判断（#517）", () => {
	const secret = "FAKE-tok-0123456789abcdef";
	const late = setOf(secret);
	const { nameChars, valueChars, reasonChars } = ACTION_LIMITS;
	/** 前面完整出现一次 secret 值，结尾被截在值的中间（留下前 `kept` 个字符），整段正好 `limit` 个字符。 */
	const fullThenClipped = (filler: string, limit: number, kept = 8) =>
		`${filler}${secret}${filler.repeat(limit - filler.length - secret.length - kept)}${secret.slice(0, kept)}`;

	it("前面完整出现过一次、结尾被截在值中间：读取时两处都盖住（前面的完整出现换成掩码后文字变短，不影响结尾的判断）", () => {
		for (const [limit, filler] of [
			[nameChars, "n"],
			[valueChars, "v"],
			[reasonChars, "r"],
		] as const) {
			const text = fullThenClipped(filler, limit);
			expect(Array.from(text).length).toBe(limit);
			const out = late.maskClipped(text, limit);
			expect(out, `limit=${limit}`).not.toContain(secret.slice(0, 4));
			expect(out.endsWith(MASK), `limit=${limit}`).toBe(true);
			expect(out.startsWith(`${filler}${MASK}${filler}`), `limit=${limit}`).toBe(true);
		}
		// 对照：前面没有完整出现过，同样盖住（原来就是这样）
		const control = `${"c".repeat(nameChars - 8)}${secret.slice(0, 8)}`;
		expect(late.maskClipped(control, nameChars)).toBe(`${"c".repeat(nameChars - 8)}${MASK}`);
	});

	it("失败原因：带「…」的同样：判断时不算它，结尾的半截连「…」一起盖住", () => {
		const reason = `${fullThenClipped("r", reasonChars - 1)}…`;
		expect(Array.from(reason).length).toBe(reasonChars);
		const out = late.maskClipped(reason, reasonChars, { ellipsis: true });
		expect(out).not.toContain(secret.slice(0, 4));
		expect(out.endsWith(MASK)).toBe(true);
	});

	it("写入时：名称、字段的键和值、失败原因，同样的输入也盖住结尾的半截", () => {
		const name = fullThenClipped("n", nameChars);
		const key = fullThenClipped("k", nameChars);
		const value = fullThenClipped("v", valueChars);
		const reason = `${fullThenClipped("r", reasonChars - 1)}…`;
		for (const stored of [
			actionName(name, late),
			...actionField(key, value, late),
			actionReason(reason, late),
		]) {
			expect(stored).not.toContain(secret.slice(0, 4));
			expect(stored.endsWith(MASK)).toBe(true);
		}
		expect(actionName(name, late)).toBe(
			`n${MASK}${"n".repeat(nameChars - 1 - secret.length - 8)}${MASK}`,
		);
	});

	it("写入时已经打过码的文字（里面有掩码，比原文短，看长度认不出被截断过）：后来才成为 secret 的另一个值留在结尾的半截也盖住", () => {
		const stored = `load ${MASK} then ${secret.slice(0, 8)}`;
		expect(stored.length).toBeLessThan(nameChars);
		expect(late.maskClipped(stored, nameChars)).toBe(`load ${MASK} then ${MASK}`);
		// 没有掩码、也没到上限的文字：不看结尾，原样
		const plain = `load then ${secret.slice(0, 8)}`;
		expect(late.maskClipped(plain, nameChars)).toBe(plain);
	});

	it("完整出现的值和结尾的半截连在一起（完整出现的结尾落在半截里）：合成一个掩码，不留下前缀", () => {
		// `ab-zebr` 的结尾 `zebr` 同时是 `zebra-late-value` 的开头：文字结尾是 `…ab-zebra-la`
		const both = setOf("zebra-late-value", "ab-zebr");
		const text = `${"x".repeat(40 - 11)}ab-zebra-la`;
		expect(Array.from(text).length).toBe(40);
		expect(both.maskClipped(text, 40)).toBe(`${"x".repeat(40 - 11)}${MASK}`);
	});

	it("整段是掩码的文字、结尾没有半截：原样（掩码本身不会被当成值的前缀）", () => {
		const text = `${MASK} and ${MASK}`;
		expect(late.maskClipped(text, nameChars)).toBe(text);
	});
});

describe("读取的工作量预算：一次读取共用一份，用完之后剩下的整段盖住（#517）", () => {
	const { nameChars, valueChars, reasonChars } = ACTION_LIMITS;
	/** 确定的伪随机，不用 Math.random：失败了能重现。 */
	let seed = 7;
	const random = (n: number): number => {
		seed = (seed * 1664525 + 1013904223) % 4294967296;
		return Math.floor((seed / 4294967296) * n);
	};
	const word = (n: number) =>
		Array.from({ length: n }, () => "bcdefghijklmnopqrstuvwxyz"[random(25)]).join("");
	/** 病态的值集合：`count` 个值，各 `length` 个字符，首字符都是 a。 */
	const pathological = (count: number, length: number) =>
		setOf(...Array.from({ length: count }, (_, i) => `a${word(length - 1)}${i}`));
	/** 一条动作明细：名称、8 个字段（键和值）、失败原因，每一处都是首字符 a、正好到上限的文字。 */
	const detail = () => {
		const value = "a".repeat(valueChars);
		const fields = Object.fromEntries(
			Array.from({ length: 8 }, (_, f) => [`${"a".repeat(nameChars - 1)}${f}`, value]),
		);
		return {
			id: 1,
			parent: null,
			depth: 0,
			name: "a".repeat(nameChars),
			fields,
			reason: `${"a".repeat(reasonChars - 1)}…`,
			started_at: "2026-01-01T00:00:01.000Z",
			agent_started_at: "2026-01-01T00:00:01.000Z",
			ended_at: "2026-01-01T00:00:02.000Z",
			agent_ended_at: "2026-01-01T00:00:02.000Z",
			duration_ms: 1000,
			result: "failed" as const,
		};
	};

	it("字符数不分配数组：和 Array.from 的码点数一致（emoji、孤立的代理项、空串）", () => {
		const units = ["a", "😀", "\ud83d", "\ude00", "中", "\u0000", "é"];
		for (let i = 0; i < 2000; i++) {
			const text = Array.from({ length: random(12) }, () => units[random(units.length)]).join("");
			expect(charCount(text), JSON.stringify(text)).toBe(Array.from(text).length);
		}
		expect(charCount("")).toBe(0);
	});

	it("没用完预算时：带预算的视图和原来的集合打码结果逐条相同（普通文字、结尾的半截、完整的出现）", () => {
		const set = setOf("zebra-late-value", { env: "fake-env-value", user: "fake-user" }, 8260413);
		const view = set.withBudget();
		expect(view).not.toBe(set);
		expect(view.texts).toBe(set.texts);
		for (const text of [
			"nothing here",
			"load zebra-late-value ok",
			`${"x".repeat(30)}zebra-late`,
			'cfg={"env":"fake-env-value","user":"fake-user"}',
			"pin 8260413",
		]) {
			expect(view.mask(text), text).toBe(set.mask(text));
			expect(view.maskClipped(text, 40), text).toBe(set.maskClipped(text, 40));
		}
		// 没有要打码的东西时就是它自己
		expect(NO_SECRETS.withBudget()).toBe(NO_SECRETS);
		expect(setOf().withBudget()).toBe(setOf());
	});

	it("一页 500 条动作、病态的值集合：共用一份预算，一页很快读完，用完之后剩下的整段盖住；没有预算要几秒", () => {
		// 3000 个各 300 个字符的值：每处文字都花满单次的上限，500 条动作的总和是几十秒量级
		const set = pathological(300, 300);
		const one = detail();
		const budget = new WorkBudget();
		const view = set.withBudget(budget);
		const started = performance.now();
		let whole = 0;
		for (let i = 0; i < 500; i++) {
			const masked = maskedAction(one, view);
			if (masked.name === MASK && masked.reason === MASK) whole += 1;
		}
		const elapsed = performance.now() - started;
		expect(elapsed, "一页的同步耗时").toBeLessThan(1000);
		expect(budget.remaining, "预算用完了").toBe(0);
		// 前面的几条用预算打码，后面的整段盖住；不会有任何一条漏出原文（文字不是值的前缀，原样也不算漏，这里只看上面的耗时和预算）
		expect(whole).toBeGreaterThan(400);
		// 对照：同一条动作不带预算，一条就是单次上限的若干倍（几毫秒）；上限仍然有效
		const single = performance.now();
		maskedAction(one, set);
		expect(performance.now() - single, "单条动作不带预算").toBeLessThan(1000);
	});

	it("预算用完之后：要花工作量才能打码的文字整段盖住，不花工作量的照常打码", () => {
		// 周期性的值（`00`）：合并位置的路径，每次打码都要花工作量
		const periodic = setOf("00");
		expect(periodic.matching().plain).toBe(false);
		const spent = periodic.withBudget(new WorkBudget(0));
		expect(spent.mask("hello")).toBe(MASK);
		expect(spent.maskClipped("hello", 40)).toBe(MASK);
		// 新的预算：照常
		expect(periodic.withBudget().mask("hello")).toBe("hello");
		expect(periodic.withBudget().mask("a 00 b")).toBe(`a ${MASK} b`);
		// 不会部分重叠的值：一次 replace，不花工作量，预算用完了也照常
		const plain = setOf("abcdefgh");
		expect(plain.matching().plain).toBe(true);
		const plainSpent = plain.withBudget(new WorkBudget(0));
		expect(plainSpent.mask("hello abcdefgh")).toBe(`hello ${MASK}`);
		expect(plainSpent.maskClipped("short abcdefgh", 40)).toBe(`short ${MASK}`);
		// 要找结尾的半截（到了上限的文字）要花工作量：用完了整段盖住
		expect(plainSpent.maskClipped("x".repeat(40), 40)).toBe(MASK);
	});

	it("预算由几个视图共用（一次读取涉及几个运行的值集合）：一个用掉的，另一个看得到", () => {
		const shared = new WorkBudget(300);
		const first = setOf("00").withBudget(shared);
		const second = setOf("11").withBudget(shared);
		// `0000` 里 `00` 的三个出现位置，每个按它的长度加固定的一份算：198
		expect(first.mask("0000")).toBe(MASK);
		expect(shared.remaining).toBe(102);
		// 另一个视图的 `1111` 同样要 198，剩下的不够：整段盖住，预算归零
		expect(second.mask("1111")).toBe(MASK);
		expect(shared.remaining).toBe(0);
		// 对照：各自一份预算时都照常算完
		expect(setOf("00").withBudget(new WorkBudget(300)).mask("a0000")).toBe(`a${MASK}`);
	});

	it("没有出现的文字不花预算：预算只被真正的出现位置和找半截的比较用掉（读一页日志，行里没有 secret 值时不会把预算用光）", () => {
		const budget = new WorkBudget();
		const view = setOf("zz").withBudget(budget);
		for (let i = 0; i < 1000; i++)
			expect(view.mask(`line ${i} nothing here`)).toBe(`line ${i} nothing here`);
		expect(budget.remaining).toBe(READ_WORK_BUDGET);
		// 一个出现位置：它的长度（2）加固定的一份（64）
		expect(view.mask("a zz b")).toBe(`a ${MASK} b`);
		expect(budget.remaining).toBe(READ_WORK_BUDGET - 66);
		expect(READ_WORK_BUDGET).toBeLessThanOrEqual(MAX_MASK_WORK);
	});
});
