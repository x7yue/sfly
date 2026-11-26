import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkMembers, harvestDocs } from "../src/client-docs.js";
import { ITEM, typeText } from "../src/client-emit.js";
import { buildClientExport } from "../src/client-export.js";
import { annotateSchema } from "../src/field-docs.js";
import * as contract from "../src/index.js";
import {
	Branded,
	EnumKeyed,
	Holder,
	Nested,
	Rooted,
	UsesRooted,
} from "./support/union-docs-contract.js";

// 联合里同名的字段说明各是各的（#636、#662）：生成的类型、导出的 JSON Schema 里，联合每个成员的字段用自己的说明；
// 一个成员有说明、另一个没有时，没有的不借；认不出是哪个成员的（说明不一样）就生成失败，不悄悄选一个。

const FIXTURE = "./test/support/union-docs-contract.js";
const A = '|type="a"';
const B = '|type="b"';
const C = '|type="c"';
const D = '|kind="x",type="d"';
const E = '|type="e"';
const COMMIT = '|kind="commit",type="platform"';
const VERSION = '|kind="version",type="platform"';

const harvest = (name: string, maxDepth?: number, named: readonly string[] = []) =>
	harvestDocs({
		contract: FIXTURE,
		roots: new Map([name, ...named].map((root) => [root, `z.output<typeof C.${root}>`])),
		stopAt: new Set(named),
		...(maxDepth === undefined ? {} : { maxDepth: () => maxDepth }),
	});

describe("读契约的注释：联合的每个成员各读各的", () => {
	const docs = harvest("Holder");
	const field = (...path: string[]) => docs.field("Holder", path);

	it("同名的字段在不同成员里说明不同：各取各的", () => {
		expect(field("events", ITEM, A, "ref")).toBe("A 的 ref。");
		expect(field("events", ITEM, B, "ref")).toBe("B 的 ref。");
		expect(field("events", ITEM, D, "ref")).toBe(
			"D 的 ref（可选的字面量成员也认得：`kind` 只是可选）。",
		);
		expect(field("events", ITEM, E, "ref")).toBe("E 的 ref（`z.enum` 只有一项的也是取值固定的）。");
		// 靠 `kind` 区分的几个成员（`type` 一样）
		expect(field("platform", COMMIT, "hash")).toBe("提交的 hash。");
		expect(field("platform", VERSION, "hash")).toBe("版本的 hash（和提交的不同）。");
	});

	it("一个成员有说明、另一个同名字段没有：没有的不借", () => {
		expect(field("events", ITEM, C, "ref")).toBeUndefined();
		expect(field("events", ITEM, C, "note")).toBeUndefined();
		expect(field("events", ITEM, B, "extra")).toBe("B 独有的。");
		expect(field("events", ITEM, A, "note")).toBe("A 的 note。");
		expect(field("events", ITEM, A, "shared")).toBeUndefined();
	});

	it("联合里只有一个内联的对象（可空的对象）：路径不加一段", () => {
		expect(field("maybe", "x")).toBe("x 的说明。");
		expect([...docs.members("Holder")].sort()).toEqual(
			[A, B, C, D, E]
				.map((m) => `events.${ITEM}.${m}`)
				.concat([COMMIT, VERSION].map((m) => `platform.${m}`))
				.sort(),
		);
	});

	it("字段的层数不算联合成员的那一段：最多读到第三层时，数组里联合成员的字段还在", () => {
		const shallow = harvest("Holder", 3);
		expect(shallow.field("Holder", ["events", ITEM, A, "ref"])).toBe("A 的 ref。");
		// 第四层不读（`events.[].成员.ref` 是第三层的字段，再深的不读）
		const tiny = harvest("Holder", 2);
		expect(tiny.field("Holder", ["events", ITEM, A, "ref"])).toBeUndefined();
	});

	it("联合里别的成员不是内联的对象（有自己的 root 的类型、数组）：内联的只有一个，路径不加一段", () => {
		const named = harvest("WithNamed", undefined, ["Named"]);
		expect(named.field("WithNamed", ["item", "id"])).toBe("内联的 id。");
		expect(named.members("WithNamed").size).toBe(0);
		const array = harvest("ObjOrArray");
		expect(array.field("ObjOrArray", ["v", "a"])).toBe("v 的 a。");
		expect(array.members("ObjOrArray").size).toBe(0);
	});

	it("认不出成员、同名的字段说明又不一样：生成失败，说明怎么改", () => {
		expect(() => harvest("Ambiguous")).toThrow(/认不出是哪个成员的.*取值固定的字段/s);
	});

	it("认不出成员，但同名的字段说明一样：不冲突", () => {
		expect(harvest("AmbiguousSame").field("AmbiguousSame", ["|", "id"])).toBe("一样的说明。");
	});
}, 60_000);

describe("生成类型和导出的 JSON Schema：每个成员的字段用自己的说明，生成的一边认出的成员和读注释的一边一致", () => {
	const docs = harvest("Holder");
	const json = z.toJSONSchema(Holder, { io: "output", target: "draft-2020-12" });
	const seen = new Set<string>();
	const text = typeText(json, {
		refName: (id) => id,
		doc: (path) => docs.field("Holder", path),
		member: (path) => seen.add(path.join(".")),
	});
	/** 生成的类型里 `type: "<kind>"` 的那个成员（到下一个成员之前）。 */
	const member = (type: string) => {
		const at = text.indexOf(`type: "${type}";`);
		const start = text.lastIndexOf("{", at);
		return text.slice(start, text.indexOf("\n\t}", at));
	};

	it("生成的类型：同名字段各带自己的说明，没有说明的不借", () => {
		const a = member("a");
		const b = member("b");
		const c = member("c");
		expect(a).toContain("/** A 的 ref。 */\n\t\tref: string;");
		expect(b).toContain("/** B 的 ref。 */\n\t\tref?: string;");
		expect(a).not.toContain("B 的");
		expect(b).not.toContain("A 的");
		expect(c).not.toContain("/**");
		expect(member("d")).toContain("D 的 ref");
		expect(text).toContain("/** x 的说明。 */");
	});

	it("生成的一边也一样：有 $ref 的联合里内联的只有一个，不加一段；两边认出的成员一致", () => {
		const named = harvest("WithNamed", undefined, ["Named"]);
		const seenNamed = new Set<string>();
		const withRef = typeText(
			{
				type: "object",
				properties: {
					item: {
						anyOf: [
							{ $ref: "#/$defs/Named" },
							{ type: "object", properties: { id: { type: "string" } }, required: ["id"] },
						],
					},
				},
				required: ["item"],
			},
			{
				refName: (id) => id,
				doc: (path) => named.field("WithNamed", path),
				member: (path) => seenNamed.add(path.join(".")),
			},
		);
		expect(withRef).toContain("/** 内联的 id。 */");
		expect([...seenNamed]).toEqual([...named.members("WithNamed")]);
	});

	it("联合套联合：摊平之后每个成员各带自己的一段，两边认出的成员一致", () => {
		const nested = harvest("Nested");
		const seenNested = new Set<string>();
		const nestedText = typeText(z.toJSONSchema(Nested, { io: "output", target: "draft-2020-12" }), {
			refName: (id) => id,
			doc: (path) => nested.field("Nested", path),
			member: (path) => seenNested.add(path.join(".")),
		});
		for (const id of ["P", "Q", "R"]) expect(nestedText).toContain(`/** ${id} 的 id。 */`);
		expect([...seenNested].sort()).toEqual(['n.|type="p"', 'n.|type="q"', 'n.|type="r"']);
		expect([...nested.members("Nested")].sort()).toEqual([...seenNested].sort());
	});

	it("两边认出的联合成员一致", () => {
		expect([...seen].sort()).toEqual([...docs.members("Holder")].sort());
	});

	it("两边认出的成员不一样时生成失败（字段的说明会按错的路径查）", () => {
		expect(() => checkMembers("R", [A, B], [A, B])).not.toThrow();
		expect(() => checkMembers("R", [A, B], [A])).toThrow(/R：联合的成员.*不一致/);
		expect(() => checkMembers("R", [A], [A, B])).toThrow(/不一致/);
		expect(() => checkMembers("R", [], [A])).toThrow(/不一致/);
	});

	it("导出的 JSON Schema：每个分支里的字段写自己的说明，字段自己的 description 优先", () => {
		const schema = z.toJSONSchema(Holder, { io: "output", target: "draft-2020-12" }) as Record<
			string,
			unknown
		>;
		annotateSchema(schema, (path) => docs.field("Holder", path));
		type Branch = { properties: Record<string, { description?: string }> };
		const events = (schema.properties as Record<string, { items: Record<string, Branch[]> }>)
			.events as { items: Record<string, Branch[]> };
		const branches = (events.items.oneOf ?? events.items.anyOf) as Array<
			Branch & { properties: { type: { const: string } } }
		>;
		const refOf = (type: string) =>
			branches.find((b) => (b.properties.type as { const?: string }).const === type)?.properties.ref
				?.description;
		expect(refOf("a")).toBe("A 的 ref。");
		expect(refOf("b")).toBe("B 的 ref。");
		expect(refOf("c")).toBeUndefined();
	});
}, 60_000);

describe("有自己的 root 的联合被引用：加了 nullable、optional、并成联合、放进数组，也能生成（`$ref` 不是内联的成员）", () => {
	const registry = z.registry<{ id: string }>();
	registry.add(Rooted, { id: "Rooted" });
	/** 两个 root：`UsesRooted` 引用 `Rooted`（生成的类型里是 `$ref`），`Rooted` 自己的成员在它自己的 root 里读。 */
	const docs = harvestDocs({
		contract: FIXTURE,
		roots: new Map([
			["UsesRooted", "z.output<typeof C.UsesRooted>"],
			["Rooted", "z.output<typeof C.Rooted>"],
		]),
		stopAt: new Set(["Rooted"]),
	});

	for (const io of ["output", "input"] as const) {
		it(`${io}：五种写法两边认出的成员一致（都没有），内联的那一个对象的字段说明照常读到`, () => {
			// `$defs` 里是 `Rooted` 自己的定义（它自己的 root 生成），这里只生成引用它的那个
			const { $defs: _defs, ...json } = z.toJSONSchema(UsesRooted, {
				io,
				target: "draft-2020-12",
				metadata: registry,
			}) as Record<string, unknown>;
			const seen = new Set<string>();
			const text = typeText(json, {
				refName: (id) => id,
				doc: (path) => docs.field("UsesRooted", path),
				member: (path) => seen.add(path.join(".")),
			});
			// 五个字段里引用 `Rooted` 的写成 `Rooted`（`$ref`），不是内联的对象
			expect(text).toContain("nullable: Rooted | null;");
			expect(text).toContain("list?: Rooted[];");
			expect([...seen]).toEqual([]);
			expect([...docs.members("UsesRooted")]).toEqual([]);
			checkMembers("UsesRooted", docs.members("UsesRooted"), seen);
			// 并成联合的另一个对象是联合里唯一内联的对象：路径不加一段，说明读得到
			expect(text).toContain("/** 另一个对象的 id。 */");
		});
	}

	it("`Rooted` 自己的成员在它自己的 root 里：各取各的", () => {
		expect(docs.field("Rooted", ['|type="r1"', "id"])).toBe("R1 的 id。");
		expect(docs.field("Rooted", ['|type="r2"', "id"])).toBe("R2 的 id。");
	});
});

describe("生成器不支持的写法：生成失败，说清是生成器不支持，不让人以为是字段说明写冲突了", () => {
	const reads = (name: string) => harvest(name);
	const emits = (schema: z.ZodType) => {
		const seen = new Set<string>();
		typeText(z.toJSONSchema(schema, { io: "output", target: "draft-2020-12" }), {
			refName: (id) => id,
			member: (path) => seen.add(path.join(".")),
		});
		return seen;
	};

	it("用枚举做键的 record 里放联合", () => {
		expect(() =>
			checkMembers("EnumKeyed", reads("EnumKeyed").members("EnumKeyed"), emits(EnumKeyed)),
		).toThrow(/生成器不支持这种写法/);
	});

	it("联合里有带品牌的对象成员", () => {
		expect(() =>
			checkMembers("Branded", reads("Branded").members("Branded"), emits(Branded)),
		).toThrow(/生成器不支持这种写法.*不是契约里字段说明写冲突了/s);
	});

	it("报错只列两边不一样的成员，并说怎么办", () => {
		const message = (() => {
			try {
				checkMembers("R", [A, B], [A]);
			} catch (error) {
				return (error as Error).message;
			}
			return "";
		})();
		expect(message).toContain(`只有读契约注释的一边认出：${B}`);
		expect(message).not.toContain(`type="a"`);
		expect(message).not.toContain("只有生成类型的一边认出");
		expect(message).toContain("改契约的写法，或者让生成器");
	});

	it("取值固定的字段完全相同的成员、同名字段说明不同：提示让取值不同，不再叫人加取值固定的字段", () => {
		const attempt = () => harvest("SameFixed");
		expect(attempt).toThrow(/取值固定的字段（type="s"）完全相同/);
		expect(attempt).not.toThrow(/给每个成员一个取值固定的字段/);
	});
}, 60_000);

/** 契约源码里 `const <object> = { … }` 里属性 `property` 上方的注释（去掉注释符号，行之间用换行连）；没有注释时是 undefined。 */
function sourceDoc(file: string, object: string, property: string): string | undefined {
	const path = fileURLToPath(new URL(`../src/${file}`, import.meta.url));
	const text = readFileSync(path, "utf8");
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
	let found: ts.PropertyAssignment | undefined;
	const visit = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			node.name.getText() === object &&
			node.initializer !== undefined &&
			ts.isObjectLiteralExpression(node.initializer)
		) {
			found = node.initializer.properties.find(
				(p): p is ts.PropertyAssignment =>
					ts.isPropertyAssignment(p) && p.name.getText() === property,
			);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	if (found === undefined) throw new Error(`${file} 里没有 ${object}.${property}`);
	const ranges = ts.getLeadingCommentRanges(text, found.getFullStart()) ?? [];
	const last = ranges[ranges.length - 1];
	if (last === undefined) return undefined;
	return text
		.slice(last.pos, last.end)
		.replace(/^\/\*\*?|\*\/$/g, "")
		.split("\n")
		.map((line) => line.replace(/^\s*\*? ?/, "").trimEnd())
		.join("\n")
		.trim();
}

/** 比较文字时不看空白、注释符号和反引号（生成的注释把 `{@link X}` 写成 `X`，换行和 ` * ` 的写法也不同）。 */
const squash = (text: string) => text.replace(/[\s*/`]+/g, "");

describe("真正的契约：会话事件里联合成员各自的说明（#636 里 `user_message.message_id`、`turn_end.error_class` 挂着 `notice` 的说明）", () => {
	const types = buildClientExport(contract.httpApis, contract)["src/generated/types.ts"];
	/** 生成的 `PersistedSessionEvent` 里 `type: "<type>"` 的成员的文字。 */
	const memberOf = (type: string) => {
		const head = types.indexOf("export type PersistedSessionEvent = ");
		const body = types.slice(head, types.indexOf("\n};\n", head));
		const found = body.split("\n} | {\n").find((m) => m.includes(`type: "${type}";`));
		if (found === undefined) throw new Error(`没有 ${type} 这个成员`);
		return found;
	};
	// `notice` 成员的两个字段在契约源码里自己有注释（`noticeFields`）；`user_message` 的 `message_id`、`turn_end` 的 `error_class`
	// 在源码里没有自己的注释：生成的类型里就不该有注释，更不该是 `notice` 的。断言都从源码读，不写死文字。
	const noticeMessageId = sourceDoc("sessions.ts", "noticeFields", "message_id");
	const noticeErrorClass = sourceDoc("sessions.ts", "noticeFields", "error_class");

	it("notice 的两个字段在源码里有注释（下面的断言靠它）", () => {
		expect(noticeMessageId).toBeTruthy();
		expect(noticeErrorClass).toBeTruthy();
	});

	it("user_message 的 message_id 不带 notice 的说明", () => {
		const member = memberOf("user_message");
		expect(member).toContain("message_id: string;");
		expect(squash(member)).not.toContain(squash(noticeMessageId as string));
		expect(member).not.toContain("/**");
	});

	it("turn_end 的 error_class 不带 notice 的说明", () => {
		const member = memberOf("turn_end");
		expect(member).toContain("error_class?: ErrorClass;");
		expect(squash(member)).not.toContain(squash(noticeErrorClass as string));
		expect(member).not.toContain("/**");
	});

	it("notice 自己的 message_id、error_class 的说明就是源码里它们自己的注释", () => {
		const member = memberOf("notice");
		const lines = member.split("\n");
		/** 字段 `name` 上方的注释（生成的类型里紧挨着字段的那一段）。 */
		const docAbove = (name: string) => {
			const at = lines.findIndex((l) => new RegExp(`^\\t${name}\\??:`).test(l));
			if (!(lines[at - 1] ?? "").trimEnd().endsWith("*/")) return "";
			let start = at - 1;
			while (start > 0 && !(lines[start] ?? "").trimStart().startsWith("/**")) start--;
			return lines.slice(start, at).join("\n");
		};
		expect(squash(docAbove("message_id"))).toBe(squash(noticeMessageId as string));
		expect(squash(docAbove("error_class"))).toBe(squash(noticeErrorClass as string));
	});
}, 60_000);
