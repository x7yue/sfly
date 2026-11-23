// secret 参数的值要打码的东西（#479）：一个 secret 参数的值，不论类型，打码时算哪些文本、哪些整个节点。
// 读取运行（运行视图、列表、事件流）、写日志和动作、触发时的报错用的都是这一份（logs/secrets.ts 的 SecretSet），
// 对象和数组、JSON 转义的写法、短叶子的取舍只在那里处理，这里直接测它。规则的编号见 docs/SEMANTICS.md §2.1。
// 值都是明显的假值。
import { ACTION_LIMITS, TOKEN_VALUE_PATTERN } from "@sfly/schema";
import { describe, expect, it, vi } from "vitest";
import {
	actionField,
	actionName,
	actionReason,
	maskedAction,
	maskedSummary,
} from "../src/actions/action-text.js";
import {
	automatonBytes,
	buildAutomaton,
	MAX_AUTOMATON_CHARS,
	MAX_SPANS,
	maskedByAutomaton,
	mergeSpans,
	scanSpans,
	scanSteps,
} from "../src/logs/aho-corasick.js";
import {
	canonicalJson,
	charCount,
	clearSecretSetCache,
	compareUtf8,
	MIN_LEAF_CHARS,
	maskParams,
	maskRecord,
	maskSecrets,
	maskTokens,
	maskValue,
	NO_SECRETS,
	OVERSIZE_NOTICE,
	READ_MASKS,
	SECRET_MASK,
	SET_CACHE_MAX_BYTES,
	SecretSet,
	secretLimits,
	secretPartsOf,
	secretSetOf,
	shortLeafCount,
	WorkBudget,
} from "../src/logs/secrets.js";
import { regexMask } from "./support/regex-mask-oracle.js";
import { pythonJson, sortKeysDeep } from "./support/secret-forms.js";
import { withSecretLimitsSync } from "./support/secret-limits.js";

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

describe("匹配是一个按值集合建、缓存的自动机（线性时间的多模式匹配）", () => {
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

	it("值集合变了就是另一份：同一段文字按各自的集合打码，互不影响（自动机按值集合缓存）", () => {
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
		// 很长的值（超过 1024 个字符）：和上面一样合并
		const long1 = `L1-${"x".repeat(1100)}-end`;
		const long2 = `${"x".repeat(1100)}-end-tail-${"y".repeat(10)}`;
		expect(setOf(long1, long2).mask(`a ${long1}-tail-${"y".repeat(10)} b`)).toBe(`a ${MASK} b`);
		// 一个长的、一个短的：重叠同样合并
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

	it("一万行日志、一百个值的集合：批量打码只建一次自动机（不随行数变慢）", () => {
		const set = setOf(...Array.from({ length: 100 }, (_, i) => `test-secret-value-${i}-end`));
		const lines = Array.from(
			{ length: 10_000 },
			(_, i) => `line ${i}: value test-secret-value-${i % 100}-end done`,
		);
		const started = performance.now();
		const masked = lines.map((line) => set.mask(line));
		const elapsed = performance.now() - started;
		expect(masked[7]).toBe(`line 7: value ${MASK} done`);
		// 很宽的上限，只防「每行重新建自动机」这种数量级的退化。
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

	it("所有写法的总长超过上限（建不了自动机）：不抛错，每段文字整段盖住（写入和读取一样，带不带预算一样），只影响这一份集合，错误里没有值", () => {
		const secret = `oversize-${"s".repeat(MAX_AUTOMATON_CHARS)}`;
		const set = setOf(secret);
		const other = setOf("another-secret-4567");
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(set.oversize).toBe(true);
			expect(other.oversize).toBe(false);
			expect(set.mask("nothing secret in here")).toBe(MASK);
			expect(set.withBudget().mask("nothing secret in here")).toBe(MASK);
			expect(set.mask("")).toBe("");
			// 别的集合不受影响
			expect(other.mask("login another-secret-4567 ok")).toBe(`login ${MASK} ok`);
			expect(JSON.stringify(spy.mock.calls)).not.toContain("oversize-");
		} finally {
			spy.mockRestore();
		}
	});

	it("值集合太大时，平台写的那一行说明（OVERSIZE_NOTICE）原样放行，别的文字（包括只差一个字的）整段盖住；说明里没有值，别的运行里它不特殊", () => {
		const set = setOf(`oversize-${"s".repeat(MAX_AUTOMATON_CHARS)}`);
		expect(set.oversize).toBe(true);
		expect(set.mask(OVERSIZE_NOTICE)).toBe(OVERSIZE_NOTICE);
		expect(set.withBudget().mask(OVERSIZE_NOTICE)).toBe(OVERSIZE_NOTICE);
		expect(set.mask(`${OVERSIZE_NOTICE}!`)).toBe(MASK);
		expect(set.mask(OVERSIZE_NOTICE.slice(1))).toBe(MASK);
		expect(set.mask(`prefix ${OVERSIZE_NOTICE}`)).toBe(MASK);
		// 说明里没有任何值，也没有令牌
		expect(OVERSIZE_NOTICE).not.toContain("oversize-");
		expect(OVERSIZE_NOTICE).not.toContain("sfly_");
		// 值本身恰好就是这句话时，它是值，照样整段盖住
		const same = withSecretLimitsSync({ automatonChars: 50 }, () => {
			const made = setOf(OVERSIZE_NOTICE);
			expect(made.oversize).toBe(true);
			return made;
		});
		expect(same.mask(OVERSIZE_NOTICE)).toBe(MASK);
		// 不是太大的值集合：说明就是普通的文字；值就是这句话时，整段是值
		expect(setOf("another-secret-4567").mask(OVERSIZE_NOTICE)).toBe(OVERSIZE_NOTICE);
		expect(setOf(OVERSIZE_NOTICE).mask(OVERSIZE_NOTICE)).toBe(MASK);
	});

	it("说明那一行出现多少次都不用再扫一遍所有的值：「说明是不是恰好是某个值」每份值集合只算一次（节点可以写任意多行一样的）", () => {
		const set = setOf(
			`oversize-${"s".repeat(MAX_AUTOMATON_CHARS)}`,
			...Array.from({ length: 200 }, (_, i) => `v-${i}`),
		);
		expect(set.oversize).toBe(true);
		const includes = vi.spyOn(Array.prototype, "includes");
		try {
			for (let i = 0; i < 50; i++) {
				expect(set.mask(OVERSIZE_NOTICE)).toBe(OVERSIZE_NOTICE);
				expect(set.withBudget().mask(OVERSIZE_NOTICE)).toBe(OVERSIZE_NOTICE);
				expect(set.wouldChange(OVERSIZE_NOTICE)).toBe(false);
			}
			// 别的文字不用问
			for (let i = 0; i < 50; i++) expect(set.mask(`line ${i}`)).toBe(MASK);
			expect(includes.mock.contexts.filter((c) => c === set.texts).length).toBeLessThanOrEqual(1);
		} finally {
			includes.mockRestore();
		}
	});

	it("总长刚好在上限以内：照常建、照常打码；多一个字符就整段盖住", () => {
		const secret = "t".repeat(MAX_AUTOMATON_CHARS - 10);
		const set = setOf(secret);
		expect(set.oversize).toBe(false);
		expect(set.mask(`a ${secret} b`)).toBe(`a ${MASK} b`);
		const exact = setOf("e".repeat(MAX_AUTOMATON_CHARS));
		expect(exact.oversize).toBe(false);
		expect(exact.mask("x clean y")).toBe("x clean y");
		const over = setOf("o".repeat(MAX_AUTOMATON_CHARS + 1));
		expect(over.oversize).toBe(true);
		expect(over.mask("x clean y")).toBe(MASK);
	});

	it("上限是 2^20 个字符：自动机放得进缓存，每一步的耗时才有上限", () => {
		expect(MAX_AUTOMATON_CHARS).toBe(1 << 20);
		expect(secretLimits.automatonChars).toBe(MAX_AUTOMATON_CHARS);
	});

	it("一份值集合很大（几千个值）：结果和只有几个值时一样", () => {
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

describe("自动机的输出和参照实现逐字相同：重叠、嵌套、开头相同、重复出现、各种写法", () => {
	/** 独立的参照：每个文本的每个出现位置（indexOf）都记下来，重叠的合成一段，每段换一个掩码。 */
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
	let seed = 31337;
	const random = (n: number): number => {
		seed = (seed * 1664525 + 1013904223) % 4294967296;
		return Math.floor((seed / 4294967296) * n);
	};
	const pick = <T>(items: readonly T[]): T => items[random(items.length)] as T;

	it("随机的值集合（小字母表，长短不一，常有嵌套、重叠、开头相同）和文字：自动机、indexOf 参照、原来的正则做法三个结果相同，不留下任何一个值", () => {
		const alphabet = ["a", "b", "c", "d", "e"];
		const word = (min: number, max: number) =>
			Array.from({ length: min + random(max - min + 1) }, () => pick(alphabet)).join("");
		let masked = 0;
		let nested = 0;
		let overlapped = 0;
		for (let round = 0; round < 4000; round++) {
			const texts = [...new Set(Array.from({ length: 1 + random(6) }, () => word(1, 9)))];
			const set = setOf(...texts);
			const pieces = [
				...set.texts,
				...set.texts.map((t) => t.slice(1)),
				...set.texts.map((t) => t.slice(0, -1)),
				"a",
				"e",
				"x",
			];
			for (let k = 0; k < 3; k++) {
				const text = Array.from({ length: 1 + random(10) }, () => pick(pieces)).join("");
				const got = set.mask(text);
				const where = `${JSON.stringify(set.texts)} / ${JSON.stringify(text)}`;
				expect(got, where).toBe(mergedMask(text, set.texts));
				expect(got, where).toBe(regexMask(set.texts, text, MASK));
				for (const t of set.texts) expect(got, where).not.toContain(t);
				if (got !== text) masked += 1;
				if (got.split(MASK).length > 2) overlapped += 1;
			}
			if (set.texts.some((x) => set.texts.some((y) => x !== y && y.includes(x)))) nested += 1;
		}
		// 确认随机的情形真的包含了有掩码、有多段、有嵌套的（不是几乎都没有匹配）
		expect(masked).toBeGreaterThan(3000);
		expect(overlapped).toBeGreaterThan(300);
		expect(nested).toBeGreaterThan(300);
	});

	it("正则元字符、中文、emoji、各种转义：随机的值（和它的各种写法）拼成的文字，和参照实现的结果相同", () => {
		const alphabet = [
			"a",
			".",
			"+",
			"(",
			"\\",
			"/",
			"-",
			"[",
			"$",
			"|",
			"口",
			"令",
			"😀",
			'"',
			"\n",
			" ",
			"é",
		];
		const word = (min: number, max: number) =>
			Array.from({ length: min + random(max - min + 1) }, () => pick(alphabet)).join("");
		for (let round = 0; round < 1500; round++) {
			const values: unknown[] = Array.from({ length: 1 + random(4) }, () => {
				const kind = random(5);
				if (kind === 0) return word(1, 8);
				if (kind === 1) return random(100000);
				if (kind === 2)
					return { a: word(4, 8), b: [word(4, 8), random(5000)], c: { d: word(1, 6) } };
				if (kind === 3) return [word(4, 9), word(4, 9)];
				return `${word(3, 6)}\n${word(4, 6)}\n${word(4, 6)}`;
			});
			const set = setOf(...values);
			const pieces = [
				...set.texts,
				...set.texts.map((t) => t.slice(1)),
				...set.texts.map((t) => t.slice(0, -1)),
				"a",
				" ",
				"xyz",
			];
			for (let k = 0; k < 3; k++) {
				const text = Array.from({ length: 1 + random(10) }, () => pick(pieces)).join("");
				const where = `${JSON.stringify(set.texts)} / ${JSON.stringify(text)}`;
				const got = set.mask(text);
				expect(got, where).toBe(mergedMask(text, set.texts));
				expect(got, where).toBe(regexMask(set.texts, text, MASK));
			}
		}
	});

	it("很长的值（超过 1024 个字符）：互相部分重叠、开头相同、嵌套、周期性、一段里出现好几次，和 indexOf 参照一致", () => {
		const junk = (n: number, alphabet = "abcdefgh") =>
			Array.from({ length: n }, () => pick([...alphabet])).join("");
		for (let round = 0; round < 60; round++) {
			const head = junk(40, "xyz");
			const a = head + junk(1030 + random(100));
			// b 的开头是 a 的结尾（部分重叠）；c 和 a 开头相同；d 嵌套在 a 里；e 是周期性的
			const b = a.slice(-60) + junk(1030 + random(100));
			const c = head + junk(1030 + random(100));
			const d = a.slice(5, 5 + 1030);
			const e = "xyzx".repeat(300);
			const texts = [a, b, c, d, e];
			const set = setOf(...texts);
			const pieces = [
				junk(random(50)),
				a,
				junk(random(30)),
				a + b.slice(60),
				c,
				junk(7),
				d,
				b,
				e,
				e.slice(2),
			];
			for (let k = 0; k < 4; k++) {
				const text = Array.from({ length: 1 + random(6) }, () => pick(pieces)).join("");
				expect(set.mask(text), `round ${round}`).toBe(mergedMask(text, texts));
			}
		}
	});

	it("稠密区的大小不改变结果：转移表只放最浅的几层，其余走链上的孩子、哈希表、失败链，两种节点混在一起，结果和参照实现相同（含 NUL 字符）", () => {
		const alphabet = ["a", "b", "c", "\u0000", "d"];
		const word = (min: number, max: number) =>
			Array.from({ length: min + random(max - min + 1) }, () => pick(alphabet)).join("");
		let sparse = 0;
		for (let round = 0; round < 1500; round++) {
			const texts = [...new Set(Array.from({ length: 1 + random(12) }, () => word(1, 14)))];
			const pieces = [
				...texts,
				...texts.map((t) => t.slice(1)),
				...texts.map((t) => t.slice(0, -1)),
				"a",
				"\u0000",
			];
			const text = Array.from({ length: 1 + random(14) }, () => pick(pieces)).join("");
			for (const denseEntries of [1, 7, 40, 200, 1 << 20]) {
				const automaton = buildAutomaton(texts, MAX_AUTOMATON_CHARS, denseEntries);
				expect(automaton).toBeDefined();
				const a = automaton as NonNullable<typeof automaton>;
				if (a.dense < a.ch.length - a.dense - 1) sparse += 1; // 有稀疏节点
				const count = scanSpans(a, text, MAX_SPANS);
				const got = count === 0 ? text : maskedByAutomaton(text, count, MASK);
				expect(
					got,
					`dense=${denseEntries} ${JSON.stringify(texts)} / ${JSON.stringify(text)}`,
				).toBe(mergedMask(text, texts));
			}
		}
		expect(sparse).toBeGreaterThan(1000);
	});

	it("字符种类很多（几百个不同的汉字，字符类的个数远超 64，也超过 256）：随机的值和文字，和参照实现逐字相同", () => {
		for (const kinds of [90, 400, 3000]) {
			const alphabet = Array.from({ length: kinds }, (_, i) =>
				String.fromCharCode(0x4e00 + ((i * 7) % 20000)),
			);
			const word = (min: number, max: number) =>
				Array.from({ length: min + random(max - min + 1) }, () => pick(alphabet)).join("");
			let masked = 0;
			for (let round = 0; round < 300; round++) {
				const texts = [...new Set(Array.from({ length: 1 + random(8) }, () => word(2, 6)))];
				const set = setOf(...texts);
				const pieces = [
					...set.texts,
					...set.texts.map((t) => t.slice(1)),
					...set.texts.map((t) => t.slice(0, -1)),
					...alphabet.slice(0, 40),
				];
				for (let k = 0; k < 3; k++) {
					const text = Array.from({ length: 1 + random(12) }, () =>
						random(3) === 0 ? word(1, 3) : pick(pieces),
					).join("");
					const where = `${kinds} 种字符 / ${JSON.stringify(set.texts)} / ${JSON.stringify(text)}`;
					const got = set.mask(text);
					expect(got, where).toBe(mergedMask(text, set.texts));
					if (got !== text) masked += 1;
				}
			}
			expect(masked, `${kinds} 种字符`).toBeGreaterThan(300);
		}
	});

	it("字符种类很多的值集合：值里用到的每一种字符都认得出，认出的位置和段数和参照实现一样（一个值里几百种字符，后面出现的字符类号大）", () => {
		const alphabet = Array.from({ length: 700 }, (_, i) => String.fromCharCode(0x4e00 + i));
		const values = Array.from({ length: 60 }, (_, v) =>
			Array.from({ length: 20 }, (_, i) => alphabet[(v * 11 + i * 37) % 700]).join(""),
		);
		const set = setOf(...values);
		for (const value of values) {
			expect(set.mask(`a${value}b`), value).toBe(`a${MASK}b`);
			// 值的最后一个字符换成别的：不是完整的出现
			const broken = `${value.slice(0, -1)}${alphabet[(alphabet.indexOf(value.at(-1) as string) + 1) % 700]}`;
			expect(set.mask(`a${broken}b`), broken).toBe(`a${broken}b`);
		}
	});

	it("全部 65536 个码元都出现在值里：字符类表没有回绕，每个码元（含孤立的代理项、NUL）都认得出，最后出现的码元在稠密区里也是", () => {
		const units = Array.from({ length: 65536 }, (_, i) => String.fromCharCode(i));
		const chunks = [0, 1, 2, 3].map((k) => units.slice(k * 16384, (k + 1) * 16384).join(""));
		// 最后一块的最后一个码元（65535）是第 65536 种字符；后面的文本又用到它和第一个码元，它们在最浅的几层里（走转移表，用字符类）
		const texts = [...chunks, "\uffffAB", "\uffffCD", "\u0000EF"];
		const automaton = buildAutomaton(texts) as NonNullable<ReturnType<typeof buildAutomaton>>;
		expect(automaton.width).toBe(65537);
		// 每一块都认得出；相邻的块各是一段
		const text = `x${chunks[0]}y${chunks[1]}${chunks[2]}z${chunks[3]}w\uffffAB q\u0000EF r\uffffCD s\uffffAC`;
		const count = scanSpans(automaton, text, MAX_SPANS);
		expect(count).toBe(7);
		expect(maskedByAutomaton(text, count, MASK)).toBe(mergedMask(text, texts));
		// 差最后一个码元的不是完整的出现
		const short = `x${(chunks[3] as string).slice(0, -1)}`;
		expect(scanSpans(automaton, short, MAX_SPANS)).toBe(0);
		// 经值集合：整个值（没有换行，不然每一行还要再算一份），加上它在 JSON 里的各种写法，总长在上限以内
		const all = units.filter((u) => u !== "\n" && u !== "\r").join("");
		const set = setOf(all);
		expect(set.oversize).toBe(false);
		expect(set.mask(`a${all}b`)).toBe(`a${MASK}b`);
	});

	it("明确的几种：嵌套、部分重叠、自己和自己重叠（周期性的值）、相邻、很长的和很短的混在一起", () => {
		const cases: Array<[string[], string, string]> = [
			[["abcd", "bc"], "..abcd..bc..", `..${MASK}..${MASK}..`],
			[["abcdef", "cd", "abc"], "x abcdef y abc cd z", `x ${MASK} y ${MASK} ${MASK} z`],
			[["abcd", "cdef"], "abcdef", MASK],
			[["abab"], "ababab", MASK],
			[["abab"], "abab-abab", `${MASK}-${MASK}`],
			[["abcabc"], "abcabcabc", MASK],
			[["0".repeat(8)], `x${"0".repeat(30)}y`, `x${MASK}y`],
		];
		for (const [texts, text, expected] of cases) {
			expect(setOf(...texts).mask(text), `${texts.join("+")} / ${text}`).toBe(expected);
		}
		const long = `L-${"x".repeat(1100)}-end`;
		expect(setOf(long, "end").mask(`a ${long} b end`)).toBe(`a ${MASK} b ${MASK}`);
		expect(setOf("x".repeat(1100)).mask(`1${"x".repeat(2200)}2`)).toBe(`1${MASK}2`);
	});
});

describe("线性时间：每个字符的步数由构造保证，和值的个数、形状无关（数步数，不看耗时）", () => {
	/** 步数不超过 2 × 长度：前进一步，退回的步数合计不超过前进的步数（深度每前进一步最多加一）。 */
	const expectLinear = (texts: string[], text: string, label: string) => {
		const automaton = buildAutomaton(texts);
		expect(automaton, label).toBeDefined();
		const { advances, fails } = scanSteps(automaton as NonNullable<typeof automaton>, text);
		expect(advances, label).toBe(text.length);
		expect(fails, label).toBeLessThanOrEqual(advances);
	};
	const rep = (c: string, n: number) => c.repeat(n);
	let seed = 5;
	const random = (n: number): number => {
		seed = (seed * 1664525 + 1013904223) % 4294967296;
		return Math.floor((seed / 4294967296) * n);
	};
	const word = (n: number, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789") =>
		Array.from({ length: n }, () => alphabet[random(alphabet.length)]).join("");

	/** b 次幂的 Zimin 结构：S(k+1) = (S(k) x)^(b−1) S(k)，开头一层套一层的循环。 */
	const zimin = (b: number, letters: string[]): string => {
		let s = letters[0] as string;
		for (let k = 1; k < letters.length; k++) s = `${(s + letters[k]).repeat(b - 1)}${s}`;
		return s;
	};

	it("开头相同的很多个长值、周期性的值、Zimin 结构的值：在同样结构的文字里，步数不超过 2 × 长度", () => {
		const low = "abcdefghijklmnop";
		for (const b of [2, 3, 4, 8]) {
			const levels = Math.floor(Math.log(1000) / Math.log(b));
			const values = Array.from({ length: 200 }, (_, i) =>
				zimin(b, [...low.slice(0, levels - 1), String.fromCharCode(65 + (i % 26))]).slice(0, 1023),
			);
			const text = zimin(b, [...low.slice(0, levels + 3)]).slice(0, 60_000);
			expectLinear(values, text, `zimin b=${b}`);
		}
		expectLinear(
			Array.from({ length: 650 }, (_, i) => `${rep("a", 1490)}${i.toString(36).padStart(10, "0")}`),
			rep("a", 60_000),
			"650 个开头相同的长值 / 全是 a",
		);
		expectLinear(
			Array.from({ length: 1000 }, () => rep("a", 290) + word(10)),
			rep("a", 60_000),
			"1000 个 290 个 a 开头的值 / 全是 a",
		);
		expectLinear([rep("ab", 500), rep("ab", 700), rep("ba", 600)], rep("ab", 30_000), "周期性");
		expectLinear(
			Array.from({ length: 2000 }, () => word(60, "ab")),
			word(60_000, "ab"),
			"小字母表上的随机值",
		);
	});

	it("值集合的大小不改变每个字符的步数：一个值和五千个值，同样的文字，前进的步数都是文字的长度", () => {
		const text = word(50_000);
		for (const count of [1, 100, 5000]) {
			expectLinear(
				Array.from({ length: count }, () => word(24)),
				text,
				`${count} 个随机值`,
			);
		}
	});

	it("总长上限：超过 MAX_AUTOMATON_CHARS 建不了；上限以内的几十万个字符，建的时间和总长成正比（不看耗时，数节点）", () => {
		expect(buildAutomaton(["z".repeat(MAX_AUTOMATON_CHARS + 1)])).toBeUndefined();
		const total = 300_000;
		const values = Array.from({ length: 3000 }, () => word(total / 3000));
		const automaton = buildAutomaton(values);
		expect(automaton).toBeDefined();
		// 节点数不超过总长加上稠密区的空位：存储和总长成正比
		const a = automaton as NonNullable<typeof automaton>;
		expect(a.ch.length).toBeLessThanOrEqual(2 * total + 16);
	});
});

describe("完整的出现的段数有上限：输出不会被撑大", () => {
	it("一个字符的 secret 值，文字里每个位置都是它：段数超过上限时整段盖住，输出就是一个掩码", () => {
		const set = setOf("x");
		const many = "x ".repeat(MAX_SPANS + 10); // 每个 x 一段，段数超过上限
		expect(set.mask(many)).toBe(MASK);
		// 上限以内：每段一个掩码
		const some = "x ".repeat(1000);
		expect(set.mask(some)).toBe(`${MASK} `.repeat(1000));
	}, 30_000);

	it("相邻的出现各是一段，重叠的合成一段：段数按合并之后算（周期性的值在周期性的文字里只有一段）", () => {
		const set = setOf("0".repeat(8));
		expect(set.mask("0".repeat(1_000_000))).toBe(MASK);
		const single = setOf("x");
		expect(single.mask("xxxx")).toBe(MASK.repeat(4));
	});
});

describe("病态输入：周期性的值在周期性的文字里，也是线性的一遍扫描，只盖住出现的部分", () => {
	/** 在这个时限内返回（很宽，只防「卡几秒」这个数量级）。 */
	const FAST_MS = 1000;

	it("1024 个 0 的值在 1 MB 的 0 里：很快返回，所有出现合成一段", () => {
		const set = setOf("0".repeat(1024));
		const text = "0".repeat(1_000_000);
		const started = performance.now();
		const out = set.mask(text);
		expect(performance.now() - started).toBeLessThan(FAST_MS);
		expect(out).toBe(MASK);
	});

	it("20000 个 0 的值在 256 KB 的 0 里、周围有别的文字：只盖住出现的那一段，周围的文字原样", () => {
		const set = setOf("0".repeat(20_000));
		const text = `before ${"0".repeat(262_144)} after`;
		const started = performance.now();
		const out = set.mask(text);
		expect(performance.now() - started).toBeLessThan(FAST_MS);
		expect(out).toBe(`before ${MASK} after`);
		// 没有达到值的长度的 0：不是 secret 值，原样
		expect(set.mask(`before ${"0".repeat(19_999)} after`)).toBe(
			`before ${"0".repeat(19_999)} after`,
		);
	});

	it("正常的输入：400 万字的输出里出现 100 次 4 万字的值，每次都盖住，周围的文字原样", () => {
		const secret = `${"abcdefghij".repeat(4096)}-end`;
		const set = setOf(secret);
		const text = Array.from({ length: 100 }, (_, i) => `row ${i} ${secret} ok`).join("\n");
		const out = set.mask(text);
		expect(out.split(MASK).length - 1).toBe(100);
		expect(out).toContain("row 99 ****** ok");
		expect(out).not.toContain("abcdefghij");
	});

	it("值集合里有会部分重叠的几个值，文字里首尾相接地出现很多次：合并成一段", () => {
		const set = setOf("abcd-xyz", "xyz-efgh");
		const text = "abcd-xyz-efgh ".repeat(1000);
		expect(set.mask(text)).toBe(`${MASK} `.repeat(1000));
	});
});

describe("值集合缓存的大小上限（按条数和占用的字节数：文本加上建好的自动机）", () => {
	let seed = 99;
	const random = (n: number): number => {
		seed = (seed * 1664525 + 1013904223) % 4294967296;
		return Math.floor((seed / 4294967296) * n);
	};
	const word = (n: number, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789") =>
		Array.from({ length: n }, () => alphabet[random(alphabet.length)]).join("");
	/** 一份约 12 万个字符的值集合（互不相干的随机串，`tag` 让每份不一样）。 */
	const medium = (tag: string) => Array.from({ length: 2000 }, (_, i) => `${tag}-${i}-${word(52)}`);
	const bytesOf = (values: string[]): number => {
		const set = secretSetOf(values);
		const automaton = buildAutomaton(set.texts) as NonNullable<ReturnType<typeof buildAutomaton>>;
		return 2 * set.texts.reduce((n, t) => n + t.length, 0) + automatonBytes(automaton);
	};

	it("条数超过 64：最早的被丢掉，最新的一份总是留着；被丢掉的再问是重新算的另一个对象，结果一样", () => {
		const first = secretSetOf([`cache-limit-value-${0}`]);
		for (let i = 1; i <= 70; i++) secretSetOf([`cache-limit-value-${i}`]);
		const last = secretSetOf(["cache-limit-value-70"]);
		expect(secretSetOf(["cache-limit-value-70"])).toBe(last);
		const again = secretSetOf(["cache-limit-value-0"]);
		expect(again).not.toBe(first);
		expect(again.mask("x cache-limit-value-0 y")).toBe(`x ${MASK} y`);
	});

	it("字节数超过上限：自动机建好之后才计入，大的集合把最早的挤出去，最新的一份总是留着，哪怕它自己就超过上限", () => {
		const [v1, v2, v3] = [medium("one"), medium("two"), medium("three")] as [
			string[],
			string[],
			string[],
		];
		const one = bytesOf(v1);
		withSecretLimitsSync({ cacheBytes: Math.floor(2.5 * one) }, () => {
			const a = secretSetOf(v1);
			const b = secretSetOf(v2);
			const c = secretSetOf(v3);
			// 还没建自动机：只有文本的字节数，三份都在
			expect(secretSetOf(v1)).toBe(a);
			expect(secretSetOf(v2)).toBe(b);
			expect(secretSetOf(v3)).toBe(c);
			// 建好之后计入：三份合计 3 × one > 2.5 × one，最早的一份被挤出去
			a.mask("warm");
			b.mask("warm");
			expect(secretSetOf(v1)).toBe(a);
			c.mask("warm");
			expect(secretSetOf(v1)).not.toBe(a);
			expect(secretSetOf(v2)).toBe(b);
			expect(secretSetOf(v3)).toBe(c);
			expect(secretSetOf(v1).mask(`x ${v1[7]} y`)).toBe(`x ${MASK} y`);
		});
		withSecretLimitsSync({ cacheBytes: 1 }, () => {
			const only = secretSetOf(v1);
			only.mask("warm");
			expect(secretSetOf(v1)).toBe(only);
			const next = secretSetOf(v2);
			next.mask("warm");
			expect(secretSetOf(v2)).toBe(next);
			expect(secretSetOf(v1)).not.toBe(only);
		});
	});

	/** 一份值集合的文本占的字节数（每个字符按 2 字节）和建好的自动机占的字节数，和缓存记的一致。 */
	const sizesOf = (values: string[]) => {
		const set = secretSetOf(values);
		const automaton = buildAutomaton(set.texts) as NonNullable<ReturnType<typeof buildAutomaton>>;
		return {
			text: 2 * set.texts.reduce((n, t) => n + t.length, 0),
			automaton: automatonBytes(automaton),
		};
	};

	it("一份集合被挤出去之后才建好自动机：它的字节数不再计入缓存的总数（计入的话总数只增不减，缓存越来越小）", () => {
		const [a, b, c, d] = ["fa", "fb", "fc", "fd"].map(medium) as [
			string[],
			string[],
			string[],
			string[],
		];
		const sizes = [a, b, c, d].map(sizesOf);
		const auto = (i: number) => (sizes[i] as { automaton: number }).automaton;
		const text = (i: number) => (sizes[i] as { text: number }).text;
		// 上限：b、c、d 的自动机和文本放得下，再加上 a 的自动机就放不下
		const limit =
			auto(1) + auto(2) + auto(3) + text(0) + text(1) + text(2) + text(3) + Math.floor(auto(0) / 2);
		withSecretLimitsSync({ cacheBytes: limit }, () => {
			const sa = secretSetOf(a);
			const sb = secretSetOf(b);
			const sc = secretSetOf(c);
			const sd = secretSetOf(d);
			// 依次建 b、c、d 的自动机：合计在上限以内，a 还在缓存里（只有文本）
			sb.mask("warm");
			sc.mask("warm");
			sd.mask("warm");
			// 再放一份新的、建好自动机：超过上限，最早的 a、b 被挤出去，留下 c、d、e
			const e = medium("fe");
			const se = secretSetOf(e);
			se.mask("warm");
			// a（已经不在缓存里）这时才建自动机：不计入；计入的话总数超过上限，c 也被挤出去
			sa.mask("warm");
			expect(secretSetOf(c), "c 还在缓存里").toBe(sc);
			expect(secretSetOf(d)).toBe(sd);
			expect(secretSetOf(e)).toBe(se);
		});
	});

	it("文本的字节数计入缓存（只算自动机的话上限就放宽了一圈）：自动机合计刚好放得下、加上文本就放不下", () => {
		const [a, b, c] = ["ga", "gb", "gc"].map(medium) as [string[], string[], string[]];
		const sizes = [a, b, c].map(sizesOf);
		const autos = sizes.reduce((n, x) => n + x.automaton, 0);
		const texts = sizes.reduce((n, x) => n + x.text, 0);
		withSecretLimitsSync({ cacheBytes: autos + Math.floor(texts / 2) }, () => {
			const sa = secretSetOf(a);
			for (const values of [a, b, c]) secretSetOf(values).mask("warm");
			// 三份的自动机合计放得下，加上文本放不下：最早的一份被挤出去
			expect(secretSetOf(a)).not.toBe(sa);
			expect(secretSetOf(c)).toBe(secretSetOf(c));
		});
	});

	it("两份都放得下就不会交替重建：缓存里的集合，再问是同一个对象，自动机也是同一个", () => {
		const [v1, v2] = [medium("alt-a"), medium("alt-b")] as [string[], string[]];
		withSecretLimitsSync({}, () => {
			const a = secretSetOf(v1);
			const b = secretSetOf(v2);
			a.mask("warm");
			b.mask("warm");
			for (let i = 0; i < 6; i++) {
				expect(secretSetOf(v1)).toBe(a);
				expect(secretSetOf(v2)).toBe(b);
			}
		});
	});

	it("默认的上限（SET_CACHE_MAX_BYTES）放得下 8 份总长到上限的自动机：几种形状（随机串、一个很长的值、窗口、两个字符的值）取最大的", () => {
		const hex = "0123456789abcdef";
		const windows = (total: number, length: number) => {
			const count = Math.floor(total / length);
			const t = word(count + length, hex);
			return Array.from({ length: count }, (_, i) => `${t.slice(i, i + length - 1)}Z`);
		};
		const shapes: Array<[string, string[]]> = [
			["随机十六进制串", Array.from({ length: 16_000 }, () => word(64, hex))],
			["一个很长的值", [word(MAX_AUTOMATON_CHARS, hex)]],
			["窗口", windows(MAX_AUTOMATON_CHARS - 1000, 64)],
			["很短的窗口", windows(MAX_AUTOMATON_CHARS - 1000, 8)],
			[
				"两个字符的值（700 种字符的所有组合）",
				Array.from({ length: 490_000 }, (_, i) =>
					String.fromCharCode(0x4e00 + Math.floor(i / 700), 0x4e00 + (i % 700)),
				),
			],
		];
		let largest = 0;
		for (const [name, values] of shapes) {
			const total = values.reduce((n, v) => n + v.length, 0);
			expect(total, name).toBeLessThanOrEqual(MAX_AUTOMATON_CHARS);
			const automaton = buildAutomaton(values);
			expect(automaton, name).toBeDefined();
			largest = Math.max(
				largest,
				2 * total + automatonBytes(automaton as NonNullable<typeof automaton>),
			);
		}
		expect(8 * largest).toBeLessThanOrEqual(SET_CACHE_MAX_BYTES);
	}, 60_000);
});

describe("动作的文字：写入时和读取时的打码（action-text.ts）", () => {
	const secret = "zebra-late-value";
	const set = setOf(secret);
	const { nameChars } = ACTION_LIMITS;

	it("写入时：完整出现的值打码、再截断；没有 secret 值时原样", () => {
		expect(actionName("short name", set)).toBe("short name");
		expect(actionName(`load ${secret}`, set)).toBe(`load ${MASK}`);
		expect(actionReason("plain", set)).toBe("plain");
		expect(actionName("n".repeat(nameChars + 10), setOf())).toBe("n".repeat(nameChars));
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

describe("打不打码只看完整的出现：部分匹配不影响输出（输出里有没有掩码不能成为猜 secret 值的依据）", () => {
	const { nameChars, valueChars, reasonChars } = ACTION_LIMITS;
	/** 两组长度、形状相同、内容不同的 secret 值（都是假值）：对不含任何完整出现的文字，输出必须逐字相同。 */
	const sets = {
		first: [
			"FAKE-tok-0123456789abcdef",
			"mnpqrs",
			"p4ss",
			{ password: "FAKE-obj-pass-value", user: "fake-user" },
			8260413,
		],
		second: [
			"GONE-tok-9876543210fedcba",
			"uvwxyz",
			"q7tt",
			{ password: "GONE-obj-pass-value", user: "gone-user" },
			5984062,
		],
	};
	/** 每个值的每种写法：作为文字里的「半截」的来源。 */
	// 对象整段写法的半截只取到叶子的值写完之前（写完了就是完整的出现）
	const sources = [
		"FAKE-tok-0123456789abcdef",
		"mnpqrs",
		"p4ss",
		'{"password":"FAKE-obj-pass-va',
		"8260413",
	];

	/** 文字：各种半截的结尾、带掩码的、正好到上限的、半截在开头的。没有任何一个含有完整的值。 */
	const texts = (limit: number): string[] => {
		const out: string[] = [];
		for (const source of sources) {
			for (let kept = 1; kept < source.length; kept++) {
				const part = source.slice(0, kept);
				out.push(
					`${"x".repeat(limit - kept)}${part}`, // 正好到上限，结尾是值的前缀
					`${MASK} ${part}`, // 带掩码、没到上限
					`${"y".repeat(limit - kept - 1)}${MASK}${part}`.slice(0, limit), // 带掩码、到上限
					`${part}${"z".repeat(limit - kept)}`, // 值的前缀在开头
					`${"w".repeat(10)}${part}…`, // 带「…」
				);
			}
			out.push(`${"x".repeat(limit)}`, source.slice(1), source.slice(0, -1));
		}
		return out;
	};

	const setsOf = () => [secretSetOf(sets.first), secretSetOf(sets.second)] as const;

	it("mask：对不含完整出现的文字，两组不同的值给出同样的输出，而且就是原文", () => {
		const [a, b] = setsOf();
		for (const limit of [nameChars, valueChars, 500, reasonChars]) {
			for (const text of texts(limit)) {
				const out = a.mask(text);
				expect(out, JSON.stringify(text.slice(-30))).toBe(b.mask(text));
				expect(out, JSON.stringify(text.slice(-30))).toBe(text);
			}
		}
	});

	it("写入时的名称、字段、失败原因和读取时再打一遍的名称、字段、失败原因：同样，输出只取决于完整的出现和长度上限", () => {
		const [a, b] = setsOf();
		const cut = (text: string, limit: number) => Array.from(text).slice(0, limit).join("");
		for (const text of texts(nameChars)) {
			expect(actionName(text, a)).toBe(actionName(text, b));
			expect(actionName(text, a)).toBe(cut(text, nameChars));
		}
		for (const text of texts(valueChars)) {
			expect(actionField(text, text, a)).toEqual(actionField(text, text, b));
			expect(actionField(text, text, a)[1]).toBe(cut(text, valueChars));
		}
		for (const text of texts(reasonChars)) {
			const out = actionReason(text, a);
			expect(out).toBe(actionReason(text, b));
			expect(out).toBe(
				Array.from(text).length > reasonChars ? `${cut(text, reasonChars - 1)}…` : text,
			);
		}
		for (const text of texts(nameChars)) {
			const action = {
				id: 1,
				parent: null,
				depth: 0,
				name: text,
				fields: { [text]: text },
				reason: text,
				started_at: "2026-01-01T00:00:01.000Z",
				agent_started_at: "2026-01-01T00:00:01.000Z",
				ended_at: "2026-01-01T00:00:02.000Z",
				agent_ended_at: "2026-01-01T00:00:02.000Z",
				duration_ms: 1000,
				result: "failed" as const,
			};
			expect(maskedAction(action, a)).toEqual(maskedAction(action, b));
			expect(maskedAction(action, a)).toEqual(action);
		}
	});

	it("完整出现的值照常换掉；值的一部分挨着完整的出现也只换完整的那一段", () => {
		const [a] = setsOf();
		const full = "FAKE-tok-0123456789abcdef";
		expect(a.mask(`${"x".repeat(nameChars - full.length)}${full}`)).toBe(
			`${"x".repeat(nameChars - full.length)}${MASK}`,
		);
		expect(a.mask(`${full} then FAKE-to`)).toBe(`${MASK} then FAKE-to`);
		expect(a.mask(`GONE-tok- ${full}`)).toBe(`GONE-tok- ${MASK}`);
	});
});

describe("读取的预算：一次读取共用一份，只记完整的出现的段数，用完之后有完整出现的文字整段盖住，没有的原样（#517）", () => {
	let seed = 7;
	const random = (n: number): number => {
		seed = (seed * 1664525 + 1013904223) % 4294967296;
		return Math.floor((seed / 4294967296) * n);
	};
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	const word = (n: number) =>
		Array.from({ length: n }, () => alphabet[random(alphabet.length)]).join("");
	const rep = (c: string, n: number) => c.repeat(n);
	/** 几千个键的保密对象：一个值 20 个字符（假值）；`prefix` 是共同的开头（空串是互不相干的随机串）。 */
	const bigObject = (keys: number, prefix: string) =>
		Object.fromEntries(
			Array.from({ length: keys }, (_, i) => [`key_${i}`, `${prefix}${word(20)}`]),
		);
	const detail = (reason: string) => ({
		id: 1,
		parent: null,
		depth: 0,
		name: rep("n", 64),
		fields: Object.fromEntries(
			Array.from({ length: 8 }, (_, f) => [`${rep("k", 60)}${f}`, word(256)]),
		),
		reason,
		started_at: "2026-01-01T00:00:01.000Z",
		agent_started_at: "2026-01-01T00:00:01.000Z",
		ended_at: "2026-01-01T00:00:02.000Z",
		agent_ended_at: "2026-01-01T00:00:02.000Z",
		duration_ms: 1000,
		result: "failed" as const,
	});

	it("字符数不分配数组：和 Array.from 的码点数一致（emoji、孤立的代理项、空串）", () => {
		const units = ["a", "😀", "\ud83d", "\ude00", "中", "\u0000", "é"];
		for (let i = 0; i < 2000; i++) {
			const text = Array.from({ length: random(12) }, () => units[random(units.length)]).join("");
			expect(charCount(text), JSON.stringify(text)).toBe(Array.from(text).length);
		}
		expect(charCount("")).toBe(0);
	});

	it("没用完预算时：带预算的视图和原来的集合打码结果逐条相同", () => {
		const set = setOf("zebra-late-value", { env: "fake-env-value", user: "fake-user" }, 8260413);
		const view = set.withBudget();
		expect(view).not.toBe(set);
		expect(view.texts).toBe(set.texts);
		for (const text of [
			"nothing here",
			"load zebra-late-value ok",
			'cfg={"env":"fake-env-value","user":"fake-user"}',
			"pin 8260413",
			"",
		]) {
			expect(view.mask(text), text).toBe(set.mask(text));
		}
		// 没有要打码的东西时返回自己
		expect(NO_SECRETS.withBudget()).toBe(NO_SECRETS);
	});

	it("默认的预算取读取预算的上限：2^20 段；每个视图默认有自己的一份，也可以几个视图共用", () => {
		expect(new WorkBudget().masks).toBe(READ_MASKS);
		expect(READ_MASKS).toBe(1 << 20);
		const a = setOf("alpha-secret-aaa");
		const b = setOf("bravo-secret-bbb");
		const one = a.withBudget();
		one.mask("x alpha-secret-aaa y alpha-secret-aaa");
		// 另一个视图有自己的预算
		const other = new WorkBudget(1);
		expect(a.withBudget(other).mask("p alpha-secret-aaa q")).toBe(`p ${MASK} q`);
		expect(other.masks).toBe(0);
		expect(a.withBudget().mask("p alpha-secret-aaa q alpha-secret-aaa r")).toBe(
			`p ${MASK} q ${MASK} r`,
		);
		// 共用一份：两个集合的视图记在同一份上
		const shared = new WorkBudget(3);
		const viewA = a.withBudget(shared);
		const viewB = b.withBudget(shared);
		viewA.mask("p alpha-secret-aaa q alpha-secret-aaa");
		expect(shared.masks).toBe(1);
		expect(viewB.mask("bravo-secret-bbb x bravo-secret-bbb")).toBe(MASK);
		expect(shared.masks).toBe(0);
		expect(viewA.mask("alpha-secret-aaa")).toBe(MASK);
		// 用完之后没有完整出现的文字照常
		expect(viewA.mask("clean")).toBe("clean");
		expect(viewB.mask("")).toBe("");
	});

	it("没有扫过的字符数的预算：文字再长、再多，没有完整出现的都原样，也不用掉预算（运行视图里 40 个任务各输出 1 MiB 也一个不盖）", () => {
		const budget = new WorkBudget(5);
		const view = setOf("alpha-secret-aaa", { k: "v".repeat(500) }).withBudget(budget);
		for (const length of [1, 10, 4096, 100_000, 5_000_000]) {
			expect(view.mask(rep("z", length))).toBe(rep("z", length));
		}
		expect(view.mask("")).toBe("");
		expect(budget.masks).toBe(5);
		const MiB = 1024 * 1024;
		const run = secretSetOf(["fake-secret-value-123"]).withBudget();
		for (let i = 0; i < 40; i++) {
			const out = maskRecord({ report: `report ${i} ${rep("y", MiB - 20)}` }, run);
			expect(out.report === MASK, `第 ${i} 个任务`).toBe(false);
		}
	});

	it("预算刚好够和差一段：刚好够的照常，差一段的整段盖住，预算归零；用完之后没有完整出现的文字原样", () => {
		const set = setOf("alpha-secret-aaa");
		const text = "a alpha-secret-aaa b alpha-secret-aaa c alpha-secret-aaa d";
		const enough = new WorkBudget(3);
		expect(set.withBudget(enough).mask(text)).toBe(`a ${MASK} b ${MASK} c ${MASK} d`);
		expect(enough.masks).toBe(0);
		const short = new WorkBudget(2);
		const view = set.withBudget(short);
		expect(view.mask(text)).toBe(MASK);
		expect(short.masks).toBe(0);
		// 用完之后：有完整出现的整段盖住，没有的原样（不论多长）
		expect(view.mask("one alpha-secret-aaa and more")).toBe(MASK);
		expect(view.mask(`clean ${rep("z", 100_000)}`)).toBe(`clean ${rep("z", 100_000)}`);
		// 差一段的预算没有因为这次失败而被扣掉一部分之后又放行：再来一段完整的出现也不行
		const two = new WorkBudget(2);
		const twoView = set.withBudget(two);
		expect(twoView.mask("x alpha-secret-aaa y")).toBe(`x ${MASK} y`);
		expect(two.masks).toBe(1);
		expect(twoView.mask("p alpha-secret-aaa q alpha-secret-aaa")).toBe(MASK);
	});

	it("scanSpans 的上限是闭区间：段数等于上限时照常，多一段就放弃（返回 -1）", () => {
		const automaton = buildAutomaton(["abc"]) as NonNullable<ReturnType<typeof buildAutomaton>>;
		const text = "abc.abc.abc";
		expect(scanSpans(automaton, text, 3)).toBe(3);
		expect(scanSpans(automaton, text, 4)).toBe(3);
		expect(scanSpans(automaton, text, 2)).toBe(-1);
		expect(scanSpans(automaton, text, 0)).toBe(-1);
		expect(scanSpans(automaton, "no match", 0)).toBe(0);
		// 重叠的合成一段：只算一段
		const periodic = buildAutomaton(["abab"]) as NonNullable<ReturnType<typeof buildAutomaton>>;
		expect(scanSpans(periodic, "ababababab", 1)).toBe(1);
	});

	it("完整的出现按段数计入：段数超过剩下的，这段文字整段盖住；没有完整出现的文字不受影响", () => {
		const set = setOf("alpha-secret-aaa");
		const budget = new WorkBudget(3);
		const view = set.withBudget(budget);
		expect(view.mask("a alpha-secret-aaa b alpha-secret-aaa")).toBe(`a ${MASK} b ${MASK}`);
		expect(budget.masks).toBe(1);
		// 重叠的合成一段：只算一段
		expect(view.mask("alpha-secret-aaa")).toBe(MASK);
		expect(budget.masks).toBe(0);
		// 没有完整出现的照常，有完整出现的整段盖住
		expect(view.mask("nothing here")).toBe("nothing here");
		expect(view.mask("one alpha-secret-aaa and more")).toBe(MASK);
		expect(view.mask("nothing here either")).toBe("nothing here either");
	});

	it("一页日志：每行出现一个 secret 值，预算只够前 40 行，前面的行照常，后面的整行盖住；整页没有完整的出现时一行不盖", () => {
		const set = setOf("alpha-secret-aaa");
		const lines = Array.from(
			{ length: 100 },
			(_, i) => `line ${i} alpha-secret-aaa ${rep("z", 90)}`,
		);
		const view = set.withBudget(new WorkBudget(40));
		const masked = lines.map((line) => view.mask(line) === MASK);
		expect(masked.slice(0, 40).every((m) => !m)).toBe(true);
		expect(masked.slice(40).every((m) => m)).toBe(true);
		const clean = set.withBudget(new WorkBudget(1));
		for (let i = 0; i < 1000; i++) expect(clean.mask(`line ${i} ${rep("z", 4000)}`)).not.toBe(MASK);
	});

	describe("正常但大的值集合：读取一页不整段盖住（用默认的预算）", () => {
		const secretKinds = [
			["fake- 开头", "fake-"],
			["互不相干的随机串", ""],
		] as const;

		for (const [kind, prefix] of secretKinds) {
			const object = bigObject(5000, prefix);

			it(`${kind}的 5000 个键的保密对象：不超过总长上限；日志一页 300 行各 4000 个字符、一页 1000 行各 2000 个字符、一页 1000 行各 4000 个字符，一行不盖`, () => {
				const set = secretSetOf([object]);
				expect(set.oversize).toBe(false);
				expect(set.texts.reduce((n, t) => n + t.length, 0)).toBeLessThanOrEqual(
					MAX_AUTOMATON_CHARS,
				);
				for (const [lines, chars] of [
					[300, 4000],
					[1000, 2000],
					[1000, 4000],
				] as const) {
					const budget = new WorkBudget();
					const view = set.withBudget(budget);
					const text = word(chars);
					let masked = 0;
					for (let i = 0; i < lines; i++) if (view.mask(text) === MASK) masked += 1;
					expect(masked, `${lines} 行 × ${chars} 个字符`).toBe(0);
					expect(budget.masks, `${lines} 行 × ${chars} 个字符`).toBe(READ_MASKS);
				}
			});

			it(`${kind}的 5000 个键的保密对象：动作一页 500 条、失败原因各 4000 个字符（名称、字段也都在），一条不盖`, () => {
				const view = secretSetOf([object]).withBudget();
				const reason = word(4000);
				let masked = 0;
				for (let i = 0; i < 500; i++) {
					const out = maskedAction(detail(reason), view);
					if (out.reason === MASK || out.name === MASK) masked += 1;
				}
				expect(masked).toBe(0);
			});

			it(`${kind}的 5000 个键的保密对象：一个运行 200 个任务、每个输出一段 5000 个字符的报告，一个不盖；24 个任务各输出 1 MiB 也一个不盖`, () => {
				const view = secretSetOf([object]).withBudget();
				let masked = 0;
				for (let i = 0; i < 200; i++) {
					const out = maskRecord({ report: word(5000) }, view);
					if (out.report === MASK) masked += 1;
				}
				expect(masked).toBe(0);
				const big = rep("y", 1024 * 1024 - 20);
				for (let i = 0; i < 24; i++) {
					expect(maskRecord({ report: `report ${i} ${big}` }, view).report).not.toBe(MASK);
				}
			}, 30_000);
		}

		it("证书量级：50 个各 4 KB 的 PEM 证书加 100 个字符串，不超过总长上限，一页 1000 行各 4000 个字符也一行不盖", () => {
			const pem = () => {
				const body = Array.from({ length: 64 }, () => word(64)).join("\n");
				return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
			};
			const certs = Array.from({ length: 50 }, pem);
			const tokens = Array.from({ length: 100 }, (_, i) => `fake-token-${i}-${word(20)}`);
			const set = setOf(...certs, ...tokens);
			expect(set.oversize).toBe(false);
			expect(set.mask(`x ${certs[7]} y`)).toBe(`x ${MASK} y`);
			expect(set.mask(`x ${tokens[3]} y`)).toBe(`x ${MASK} y`);
			const budget = new WorkBudget();
			const view = set.withBudget(budget);
			const text = word(4000);
			for (let i = 0; i < 1000; i++) expect(view.mask(text)).toBe(text);
			expect(budget.masks).toBe(READ_MASKS);
		});

		it("病态的值集合一样便宜：1000 个各 1000 个字符、开头都是 a，一页 1000 行各 4096 个 a，一行不多盖，记的预算和别的集合一样", () => {
			const pathological = Array.from({ length: 1000 }, () => `${rep("a", 990)}${word(10)}`);
			const budget = new WorkBudget();
			const view = setOf(...pathological).withBudget(budget);
			const line = rep("a", 4096);
			let masked = 0;
			const started = performance.now();
			for (let i = 0; i < 1000; i++) if (view.mask(line) === MASK) masked += 1;
			// 耗时只是兜底的检查；确定的断言是下面两条
			expect(performance.now() - started, "一页").toBeLessThan(5000);
			expect(masked).toBe(0);
			expect(budget.masks).toBe(READ_MASKS);
		});
	});

	it("读取预算的上限可以调小（只给测试用）：新建的预算取调小之后的数，真实读取出口因此用几十条文字就能用完预算", () => {
		withSecretLimitsSync({ readMasks: 5 }, () => {
			const budget = new WorkBudget();
			expect(budget.masks).toBe(5);
			const view = setOf("alpha-secret-aaa").withBudget(budget);
			expect(view.mask(`${rep("alpha-secret-aaa ", 5)}`)).toBe(`${rep(`${MASK} `, 5)}`);
			expect(view.mask("alpha-secret-aaa")).toBe(MASK);
		});
		expect(new WorkBudget().masks).toBe(READ_MASKS);
		expect(secretLimits.readMasks).toBe(READ_MASKS);
		expect(secretLimits.cacheBytes).toBe(SET_CACHE_MAX_BYTES);
	});

	it("清掉值集合的缓存（只给测试用）：之后问同样的值是新建的另一个对象", () => {
		const before = secretSetOf(["clear-cache-value-1"]);
		expect(secretSetOf(["clear-cache-value-1"])).toBe(before);
		clearSecretSetCache();
		const after = secretSetOf(["clear-cache-value-1"]);
		expect(after).not.toBe(before);
		expect(after.mask("x clear-cache-value-1")).toBe(`x ${MASK}`);
	});
});

describe("预算只取决于完整的出现：部分匹配不改变输出，也不改变用掉的预算，值集合的形状也不改变", () => {
	let seed = 21;
	const random = (n: number): number => {
		seed = (seed * 1664525 + 1013904223) % 4294967296;
		return Math.floor((seed / 4294967296) * n);
	};
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	const word = (n: number) =>
		Array.from({ length: n }, () => alphabet[random(alphabet.length)]).join("");
	const rep = (c: string, n: number) => c.repeat(n);

	/** 两组形状、长度都不同的保密值（都是假值）：一组有很长的值和周期性的值，一组都是随机串。 */
	const first = [
		`FAKE-${word(30)}`,
		rep("a", 1500) + word(10),
		`${rep("ab", 600)}FAKE-periodic`,
		"mnpqrs",
		{ password: `FAKE-${word(20)}`, user: "fake-user" },
		8260413,
	];
	const second = Array.from({ length: 40 }, () => `GONE-${word(24)}`);
	/** 一个值被「半截」的各种写法：前缀（结尾留下的）、后缀、中间。 */
	const partials = (value: string): string[] => [
		value.slice(0, 1),
		value.slice(0, 5),
		value.slice(0, 32),
		value.slice(0, Math.floor(value.length / 2)),
		value.slice(0, -1),
		value.slice(1),
		value.slice(3, -3),
	];
	const stringsOf = (values: unknown[]) => secretSetOf(values).texts.filter((t) => t.length > 4);
	const pieces = [...stringsOf(first), ...stringsOf(second)].flatMap(partials);
	const all = [...stringsOf(first), ...stringsOf(second)];
	/** 没有任何一个值的完整出现的文字：值的半截各种拼法。 */
	const lines = pieces
		.flatMap((piece) => [
			`${word(40)}${piece}${word(40)}`,
			`${piece}${rep(piece.slice(0, 32), 40)}x`,
			`${rep(piece.slice(0, 32), 60)}${word(5)}`,
			rep("a", 1800) + piece.slice(0, 32),
		])
		.filter((text) => !all.some((value) => text.includes(value)));

	it("对没有完整出现的文字，换一组值（形状也不同）：输出相同，就是原文，用掉的预算相同，就是一点没用", () => {
		const a = secretSetOf(first);
		const b = secretSetOf(second);
		const budgetA = new WorkBudget(7);
		const budgetB = new WorkBudget(7);
		const viewA = a.withBudget(budgetA);
		const viewB = b.withBudget(budgetB);
		for (const text of lines) {
			expect(viewA.mask(text), text.slice(0, 40)).toBe(text);
			expect(viewB.mask(text), text.slice(0, 40)).toBe(text);
			expect(budgetA.masks).toBe(budgetB.masks);
		}
		expect(lines.length).toBeGreaterThan(100);
		expect(budgetA.masks).toBe(7);
	});

	it("预算在哪里用完和部分匹配、值集合的形状无关：每行有一处完整的出现、周围是别的值的半截，预算只够前 7 行时，哪些行被盖住两组一样", () => {
		const own = (values: unknown[], value: string) => {
			const view = secretSetOf(values).withBudget(new WorkBudget(7));
			return lines
				.slice(0, 60)
				.map((text, i) => view.mask(`${text} ${value} ${lines[i + 1]}`) === MASK);
		};
		const maskedA = own(first, first[0] as string);
		const maskedB = own(second, second[0] as string);
		expect(maskedA).toEqual(maskedB);
		expect(maskedA.slice(0, 7).every((m) => !m)).toBe(true);
		expect(maskedA.slice(7).every((m) => m)).toBe(true);
	});

	it("有完整出现的文字：用掉的段数就是合并之后的段数，别的什么都不影响", () => {
		const value = `FAKE-${word(30)}`;
		for (const set of [setOf(value), setOf(value, ...second)]) {
			const budget = new WorkBudget(100);
			const view = set.withBudget(budget);
			expect(view.mask(`${value} x ${partials(value)[1]} ${value}${value}`)).toBe(
				`${MASK} x ${partials(value)[1]} ${MASK}${MASK}`,
			);
			expect(budget.masks).toBe(100 - 3);
		}
	});
});

describe("保密值和令牌原值一次打码：两种出现都在原文上找，合成一组，一次换掉，不分先后（#631）", () => {
	const TOKEN = "sfly_pat_0123456789abcdef0123456789abcdef";
	const TOKEN_B = "sfly_prj_fedcba9876543210fedcba9876543210";
	/** 独立的参照：保密值每个写法的每个出现位置（indexOf）加上令牌的出现位置（正则），重叠的合成一段，每段一个掩码。 */
	const unionMask = (text: string, values: readonly string[]): string => {
		const spans: Array<[number, number]> = [];
		for (const v of values) {
			for (let at = text.indexOf(v); at >= 0; at = text.indexOf(v, at + 1))
				spans.push([at, at + v.length]);
		}
		for (const m of text.matchAll(new RegExp(TOKEN_VALUE_PATTERN.source, "g")))
			spans.push([m.index, m.index + m[0].length]);
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

	it("保密值落在令牌里面：整个令牌和那个值是一段、一个掩码（先换值的话令牌认不出，前缀和一半留着）", () => {
		const set = setOf("hunter2-secret-xyz");
		const text = `x sfly_pat_aaaaaaaa${"hunter2-secret-xyz"}bbbbbbbb y`;
		expect(set.mask(text)).toBe(`x ${MASK} y`);
		expect(set.mask(text)).toBe(unionMask(text, set.texts));
	});

	it("令牌落在保密值里面（值本身带着一个令牌）：一段、一个掩码", () => {
		const value = `Authorization: Bearer ${TOKEN} end`;
		const set = setOf(value);
		expect(set.mask(`log: ${value}.`)).toBe(`log: ${MASK}.`);
	});

	it("互相重叠（保密值的开头在令牌里、结尾在令牌外，反过来也一样）：合成一段，并集", () => {
		const tail = "tail-abcdefgh";
		const set = setOf(`${tail} and more`, "zz-head and more");
		// 令牌一直到空格；值从令牌的尾巴开始、延伸到令牌外
		expect(set.mask(`a sfly_pat_aaaaaaaaaaaaaaaa${tail} and more z`)).toBe(`a ${MASK} z`);
		// 值的结尾落在令牌的开头：值 `zz-head and more` 的后半段和令牌的前缀不会重叠（空格隔开），各是一段
		expect(set.mask(`${tail} and more ${TOKEN}`)).toBe(`${MASK} ${MASK}`);
		const overlap = setOf("key=sfly_pat_0123");
		const text = `k key=${TOKEN} z`;
		expect(overlap.mask(text)).toBe(`k ${MASK} z`);
		expect(overlap.mask(text)).toBe(unionMask(text, overlap.texts));
	});

	it("相邻但不重叠：各是一个掩码（令牌后面紧跟值、值后面紧跟令牌）", () => {
		const set = setOf(" secret-after", "key=");
		expect(set.mask(`${TOKEN} secret-after`)).toBe(`${MASK}${MASK}`);
		expect(set.mask(`key=${TOKEN}`)).toBe(`${MASK}${MASK}`);
		// 两边都挨着：三段、三个掩码
		expect(set.mask(`a key=${TOKEN} secret-after b`)).toBe(`a ${MASK}${MASK}${MASK} b`);
	});

	it("没有保密值时只认令牌；令牌的前缀、后面太短的、别的以 sfly_ 开头的名字不动；多个令牌各是一段", () => {
		expect(NO_SECRETS.mask(`a ${TOKEN} b ${TOKEN_B} c`)).toBe(`a ${MASK} b ${MASK} c`);
		expect(maskTokens(`a ${TOKEN} b ${TOKEN_B} c`)).toBe(`a ${MASK} b ${MASK} c`);
		const set = setOf("hunter2-secret-xyz");
		for (const text of ["sfly_pat_", "sfly_pat_abc hunter2", "sfly_stub.nodes", "plain"]) {
			expect(set.mask(text)).toBe(unionMask(text, set.texts));
			expect(NO_SECRETS.mask(text)).toBe(text);
		}
		expect(set.mask("sfly_pat_abc hunter2-secret-xyz")).toBe(`sfly_pat_abc ${MASK}`);
	});

	it("随机的组合（值、令牌、带尾巴的令牌、值的半截、令牌的前缀、各种分隔）：和独立的参照实现逐字相同；令牌和值各自的出现都不留下", () => {
		let seed = 631;
		const random = (n: number): number => {
			seed = (seed * 1664525 + 1013904223) % 4294967296;
			return Math.floor((seed / 4294967296) * n);
		};
		const pick = <T>(items: readonly T[]): T => items[random(items.length)] as T;
		const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789_-";
		const word = (n: number) => Array.from({ length: n }, () => pick([...alphabet])).join("");
		let touched = 0;
		let both = 0;
		for (let round = 0; round < 4000; round++) {
			const values = Array.from({ length: 1 + random(3) }, () =>
				pick([
					`hunter2-${word(6)}`,
					word(4 + random(10)),
					`${word(3)}=`,
					` ${word(5)}`,
					`tok ${TOKEN}`,
					`sfly_pat_${word(5 + random(8))}`,
					`${word(8)} and ${word(8)}`,
				]),
			);
			const set = setOf(...values);
			const pieces = [
				...set.texts,
				...set.texts.map((t) => t.slice(1)),
				...set.texts.map((t) => t.slice(0, -1)),
				TOKEN,
				TOKEN_B,
				`sfly_pat_${word(16 + random(8))}`,
				`sfly_prj_${word(4)}`,
				"sfly_pat_",
				" ",
				"=",
				'"',
				word(3),
				word(20),
			];
			for (let k = 0; k < 3; k++) {
				const text = Array.from({ length: 1 + random(8) }, () => pick(pieces)).join("");
				const got = set.mask(text);
				const where = `${JSON.stringify(set.texts)} / ${JSON.stringify(text)}`;
				expect(got, where).toBe(unionMask(text, set.texts));
				// 令牌原值（完整的）、保密值（完整的）都不留下：原文里的每个完整的出现，输出里没有它的任何一个完整的样子
				for (const m of text.matchAll(new RegExp(TOKEN_VALUE_PATTERN.source, "g")))
					expect(got, where).not.toContain(m[0]);
				for (const v of set.texts) {
					if (text.includes(v)) expect(got, where).not.toContain(v);
				}
				if (got !== text) touched += 1;
				if (got !== text && text.includes("sfly_") && set.texts.some((v) => text.includes(v)))
					both += 1;
			}
		}
		expect(touched).toBeGreaterThan(3000);
		expect(both).toBeGreaterThan(300);
	});

	it("段数预算：令牌和保密值的段一起计入（合并之后的段数）；超过剩下的整段盖住，预算归零", () => {
		const set = setOf("hunter2-secret-xyz");
		const budget = new WorkBudget(3);
		const view = set.withBudget(budget);
		// 一个值、两个令牌：3 段
		expect(view.mask(`a hunter2-secret-xyz b ${TOKEN} c ${TOKEN_B}`)).toBe(
			`a ${MASK} b ${MASK} c ${MASK}`,
		);
		expect(budget.masks).toBe(0);
		// 用完之后：有令牌的整段盖住，没有任何出现的原样
		expect(view.mask(`t ${TOKEN}`)).toBe(MASK);
		expect(view.mask("clean")).toBe("clean");
		// 值在令牌里面：合并成一段，只记一段
		const merged = new WorkBudget(1);
		const text = `sfly_pat_aaaaaaaa${"hunter2-secret-xyz"}bbbbbbbb`;
		expect(set.withBudget(merged).mask(text)).toBe(MASK);
		expect(merged.masks).toBe(0);
		// 两段、预算一段：整段盖住
		const short = new WorkBudget(1);
		expect(set.withBudget(short).mask(`a hunter2-secret-xyz b ${TOKEN}`)).toBe(MASK);
		expect(short.masks).toBe(0);
	});

	it("wouldChange：有令牌或有完整的值出现就是真，什么都没有是假；不计预算", () => {
		const budget = new WorkBudget(1);
		const view = setOf("hunter2-secret-xyz").withBudget(budget);
		expect(view.wouldChange(`t ${TOKEN}`)).toBe(true);
		expect(view.wouldChange("a hunter2-secret-xyz b")).toBe(true);
		expect(view.wouldChange("sfly_pat_abc hunter2")).toBe(false);
		expect(budget.masks).toBe(1);
		expect(NO_SECRETS.wouldChange(`t ${TOKEN}`)).toBe(true);
		expect(NO_SECRETS.wouldChange("plain")).toBe(false);
	});

	it("mergeSpans：只有令牌那一组（没有扫描）、两组交错、重叠合并、相邻各自一段、一组包含另一组", () => {
		const automaton = buildAutomaton(["bb", "dddd"]) as NonNullable<
			ReturnType<typeof buildAutomaton>
		>;
		const text = "aabbccddddee";
		const count = scanSpans(automaton, text, MAX_SPANS); // [2,4) [6,10)
		expect(count).toBe(2);
		// 令牌 [4,6)：和两边都相邻、不重叠，三段
		let n = mergeSpans(count, [4], [6]);
		expect(maskedByAutomaton(text, n, "#")).toBe("aa###ee".replace("###", "###"));
		expect(n).toBe(3);
		// 令牌 [3,7)：和两边都重叠，合成一段
		scanSpans(automaton, text, MAX_SPANS);
		n = mergeSpans(2, [3], [7]);
		expect(n).toBe(1);
		expect(maskedByAutomaton(text, n, "#")).toBe("aa#ee");
		// 只有令牌
		n = mergeSpans(0, [1, 8], [3, 9]);
		expect(n).toBe(2);
		expect(maskedByAutomaton(text, n, "#")).toBe("a#bccdd#dee");
	});
});
