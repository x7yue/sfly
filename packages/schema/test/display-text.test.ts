import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	codePointLength,
	httpContract,
	OrchestrationDocument,
	optionalLine,
	optionalMultiline,
	ParamDeclaration,
	requiredLine,
	toJsonSchema,
} from "../src/index.js";
import { buildRouteManifest } from "../src/route-manifest.js";

// 显示用的可选文字字段：长度按 Unicode 字符（码点）计，zod 与导出的 JSON Schema 判断一致，
// 去掉首尾空白后为空就不保存。

const EMOJI = "😀";
const FAMILY = "👨‍👩‍👧";
const COMPOSED_E = "é";
const DECOMPOSED_E = "é";

describe("codePointLength", () => {
	it.each([
		["", 0],
		["abc", 3],
		["中文", 2],
		[EMOJI, 1],
		[`a${EMOJI}b`, 3],
		[COMPOSED_E, 1],
		[DECOMPOSED_E, 2],
		[FAMILY, 5],
	])("%j 是 %i 个字符", (text, length) => {
		expect(codePointLength(text)).toBe(length);
	});
});

const parse = (schema: z.ZodType, value: unknown) =>
	z.strictObject({ v: schema }).safeParse(value === undefined ? {} : { v: value });

const issuesOf = (result: ReturnType<typeof parse>) =>
	result.success ? [] : result.error.issues.map((i) => [i.path, i.message]);

/** 保存下来的样子：没有这个字段时是 undefined。 */
const saved = (schema: z.ZodType, value: unknown): string | undefined => {
	const result = parse(schema, value);
	if (!result.success) throw new Error(result.error.message);
	const stored = JSON.parse(JSON.stringify(result.data)) as { v?: string };
	return stored.v;
};

describe("可选的一行 optionalLine", () => {
	const line = optionalLine(5);

	it("没写、空串、只有空白：都不保存", () => {
		expect(saved(line, undefined)).toBeUndefined();
		expect(saved(line, "")).toBeUndefined();
		expect(saved(line, " \t\u3000\u00a0\ufeff")).toBeUndefined();
	});

	it("去掉首尾空白后保存", () => {
		expect(saved(line, "  上线 ")).toBe("上线");
		expect(saved(line, "a b")).toBe("a b");
	});

	it("最长按字符计：5 个中文和 5 个 emoji 都放得下，6 个放不下", () => {
		expect(parse(line, "一二三四五").success).toBe(true);
		expect(parse(line, "一二三四五六").success).toBe(false);
		expect(parse(line, EMOJI.repeat(5)).success).toBe(true);
		expect(parse(line, EMOJI.repeat(6)).success).toBe(false);
		expect(parse(line, FAMILY).success).toBe(true);
		expect(parse(line, `${FAMILY}a`).success).toBe(false);
	});

	it("长度按提交的原文计，不是去掉空白之后", () => {
		expect(parse(line, "12345").success).toBe(true);
		expect(parse(line, " 12345").success).toBe(false);
	});

	it("不能换行，写了换行的值被拒绝，包括首尾的换行", () => {
		for (const value of ["a\nb", "a\r\nb", "a\rb", "a\n", "\nb"]) {
			expect(parse(line, value).success, JSON.stringify(value)).toBe(false);
		}
	});

	it("超长和换行的错误是给用户看的中文，指向这个字段", () => {
		expect(issuesOf(parse(line, "123456"))).toEqual([[["v"], "最多 5 个字符"]]);
		expect(issuesOf(parse(line, "a\nb"))).toEqual([[["v"], "只能写一行"]]);
	});

	it("保存下来的值再解析一遍不变", () => {
		const once = saved(line, "  上线 ");
		expect(saved(line, once)).toBe(once);
	});
});

describe("可选的多行 optionalMultiline", () => {
	const multiline = optionalMultiline(10);

	it("可以换行，去掉首尾空白，换行留在中间", () => {
		expect(saved(multiline, "\n a\nb \n")).toBe("a\nb");
		expect(saved(multiline, "a\r\nb")).toBe("a\r\nb");
	});

	it("没写、只有空白和换行：都不保存", () => {
		expect(saved(multiline, undefined)).toBeUndefined();
		expect(saved(multiline, " \n\t\r\n ")).toBeUndefined();
	});

	it("换行也计一个字符；最长按码点计", () => {
		const short = optionalMultiline(5);
		expect(parse(short, "ab\ncd").success).toBe(true);
		expect(parse(short, "ab\ncde").success).toBe(false);
		expect(parse(short, EMOJI.repeat(5)).success).toBe(true);
		expect(parse(short, EMOJI.repeat(6)).success).toBe(false);
	});
});

describe("必填的一行 requiredLine", () => {
	const title = requiredLine(5);

	it("去掉首尾空白后保存", () => {
		expect(saved(title, " 压测 ")).toBe("压测");
	});

	it("没写、空串、只有空白：都被拒绝，说不能为空", () => {
		for (const value of [undefined, "", "   ", " \ufeff"]) {
			expect(parse(title, value).success, JSON.stringify(value)).toBe(false);
		}
		expect(issuesOf(parse(title, "  ")).map(([, message]) => message)).toEqual(["不能为空"]);
	});

	it("和可选的一行一样：按码点限长，不能换行", () => {
		expect(parse(title, EMOJI.repeat(5)).success).toBe(true);
		expect(parse(title, EMOJI.repeat(6)).success).toBe(false);
		expect(parse(title, "a\nb").success).toBe(false);
	});
});

describe("zod 和导出的 JSON Schema 判断一致", () => {
	const MAX = 3;
	const shapes = {
		optionalLine: optionalLine(MAX),
		optionalMultiline: optionalMultiline(MAX),
		requiredLine: requiredLine(MAX),
	};

	// 码点数和 UTF-16 码元数不同的字符、两种换行、各种空白。U+FEFF 是 JS 的 trim 去掉而 Python 的 \s 不认的，
	// U+0085 反过来；两种判断在这两个字符上不能分歧。
	const tokens = ["a", EMOJI, COMPOSED_E, "\n", "\r", " ", "\u00a0", "\ufeff", "\u0085", "\u3000"];
	const corpus: string[] = [""];
	for (let length = 1, layer = [""]; length <= 4; length++) {
		layer = layer.flatMap((prefix) => tokens.map((token) => prefix + token));
		corpus.push(...layer);
	}

	const ajv = new Ajv2020({ strict: false });

	it.each(Object.entries(shapes))("%s：4 个字符以内的所有组合逐个对照", (_name, shape) => {
		const wrapper = z.strictObject({ v: shape });
		const validate = ajv.compile(toJsonSchema(wrapper));
		const disagreements = corpus.filter(
			(text) => wrapper.safeParse({ v: text }).success !== validate({ v: text }),
		);
		expect(disagreements.map((text) => JSON.stringify(text))).toEqual([]);
		expect(corpus.length).toBeGreaterThan(10_000);
	});

	it("没写这个字段时，可选的通过、必填的不通过，两边一致", () => {
		for (const [name, shape] of Object.entries(shapes)) {
			const wrapper = z.strictObject({ v: shape });
			const validate = ajv.compile(toJsonSchema(wrapper));
			expect(validate({}), name).toBe(wrapper.safeParse({}).success);
		}
	});

	it("导出的 maxLength 就是上限", () => {
		for (const shape of Object.values(shapes)) {
			const schema = toJsonSchema(z.strictObject({ v: shape })) as {
				properties: { v: unknown };
			};
			expect(schema.properties.v).toMatchObject({ type: "string", maxLength: MAX });
		}
	});
});

describe("入口参数的说明 description", () => {
	const declaration = { name: "host", type: "string" } as const;

	it("可以不写；写了就是一行，最长 200 个字符，去掉首尾空白", () => {
		expect(ParamDeclaration.parse(declaration)).not.toHaveProperty("description");
		expect(ParamDeclaration.parse({ ...declaration, description: " 目标主机 " }).description).toBe(
			"目标主机",
		);
		const long = (n: number) => ({ ...declaration, description: EMOJI.repeat(n) });
		expect(ParamDeclaration.safeParse(long(200)).success).toBe(true);
		expect(ParamDeclaration.safeParse(long(201)).success).toBe(false);
		expect(ParamDeclaration.safeParse({ ...declaration, description: "a\nb" }).success).toBe(false);
	});

	it("空说明不保存：保存下来的文档里没有这个字段", () => {
		const document = OrchestrationDocument.parse({
			nodes: [{ id: "entry", kind: "entry", params: [{ ...declaration, description: "  " }] }],
		});
		expect(JSON.stringify(document)).not.toContain("description");
	});

	it("入口节点和子流程入口节点的参数都认；导出的文档 schema 与 zod 一致", () => {
		const validate = new Ajv2020({ strict: false }).compile(toJsonSchema(OrchestrationDocument));
		const document = (description: string) => ({
			nodes: [
				{ id: "entry", kind: "entry", params: [{ ...declaration, description }] },
				{
					id: "sub",
					kind: "subflow_entry",
					name: "report",
					params: [{ ...declaration, description }],
				},
			],
		});
		for (const [description, ok] of [
			["目标主机", true],
			[EMOJI.repeat(200), true],
			[EMOJI.repeat(201), false],
			["a\nb", false],
		] as const) {
			expect(validate(document(description)), description.slice(0, 8)).toBe(ok);
			expect(OrchestrationDocument.safeParse(document(description)).success).toBe(ok);
		}
	});
});

describe("路由清单（sfly api 用）", () => {
	it("长度和换行的限制已经导出成 maxLength、pattern，不记成「JSON Schema 里没有」", () => {
		const notes = buildRouteManifest(httpContract)
			.routes.flatMap((route) => route.notes)
			.filter((note) => note.path.endsWith("params[].description"));
		expect(notes.length).toBeGreaterThan(0);
		expect(notes.filter((note) => note.reason.includes("refine"))).toEqual([]);
	});
});
