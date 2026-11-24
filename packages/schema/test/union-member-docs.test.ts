import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkMembers, harvestDocs } from "../src/client-docs.js";
import { ITEM, typeText } from "../src/client-emit.js";
import { buildClientExport } from "../src/client-export.js";
import { annotateSchema } from "../src/field-docs.js";
import * as contract from "../src/index.js";
import { Holder, Nested } from "./support/union-docs-contract.js";

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

	it("user_message 的 message_id 不带 notice 的说明", () => {
		const member = memberOf("user_message");
		expect(member).toContain("message_id: string;");
		expect(member).not.toContain("没有送到的那句话");
	});

	it("turn_end 的 error_class 不带 notice 的说明", () => {
		const member = memberOf("turn_end");
		expect(member).toContain("error_class?: ErrorClass;");
		expect(member).not.toContain("重试的原因");
	});

	it("notice 自己的 message_id、error_class 说明还在", () => {
		const member = memberOf("notice");
		expect(member).toMatch(/没有送到的那句话[\s\S]*\*\/\n\tmessage_id\?: string;/);
		expect(member).toContain(
			"/** 重试的原因按什么分；#548 起有值。 */\n\terror_class?: ErrorClass;",
		);
	});
}, 60_000);
