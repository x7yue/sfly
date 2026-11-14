import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { OrchestrationDocument, toJsonSchema } from "../src/index.js";

// 节点的备注（#308）：所有节点种类都可以写，多行，最长 2000 个 Unicode 字符，去掉首尾空白后为空就不保存；
// zod 与导出的场景文档 JSON Schema（sfly scenario push 的本地校验用它）判断一致。

const EMOJI = "😀";

const KINDS = [
	{ id: "entry", kind: "entry" },
	{ id: "sub", kind: "subflow_entry", name: "report" },
	{ id: "spawn", kind: "async" },
	{ id: "at", kind: "timer", at: "10:00:00" },
	{ id: "pause", kind: "sleep", duration: "5s" },
	{ id: "stop", kind: "stop_subflow", subflow: "sub" },
	{ id: "notify", kind: "feishu_notify" },
	{ id: "work", kind: "package", package: "stub", node: "echo" },
] as const;

const documentWith = (note: unknown) => ({
	nodes: KINDS.map((node) => ({ ...node, note })),
});

const validate = new Ajv2020({ strict: false }).compile(toJsonSchema(OrchestrationDocument));

describe("节点的备注 note", () => {
	it("每种节点都认，去掉首尾空白后保存，多行原样保留", () => {
		const parsed = OrchestrationDocument.parse(documentWith("\n  先建用户\n再查订单  \n"));
		expect(parsed.nodes.map((node) => node.note)).toEqual(KINDS.map(() => "先建用户\n再查订单"));
	});

	it("没写、空串、只有空白：保存下来的文档里没有这个字段", () => {
		const plain = OrchestrationDocument.parse({ nodes: KINDS });
		expect(JSON.stringify(plain)).not.toContain("note");
		for (const blank of ["", "  \n\t　"]) {
			const parsed = OrchestrationDocument.parse(documentWith(blank));
			expect(JSON.stringify(parsed), JSON.stringify(blank)).not.toContain("note");
		}
	});

	it("最长 2000 个字符：按码点计，换行也算一个", () => {
		const notes: [string, boolean][] = [
			[EMOJI.repeat(2000), true],
			[EMOJI.repeat(2001), false],
			[`${"一".repeat(1999)}\n`, true],
			[`${"一".repeat(2000)}\n`, false],
			// 按提交的原文计，不是去掉空白之后。
			[` ${"一".repeat(2000)}`, false],
		];
		for (const [note, ok] of notes) {
			expect(OrchestrationDocument.safeParse(documentWith(note)).success, note.slice(0, 4)).toBe(
				ok,
			);
		}
	});

	it("导出的场景文档 schema 与 zod 一致：每种节点的 note 都限长 2000，带 emoji 的边界值判断相同", () => {
		for (const [note, ok] of [
			["先建用户\n再查订单", true],
			[EMOJI.repeat(2000), true],
			[EMOJI.repeat(2001), false],
		] as const) {
			expect(validate(documentWith(note)), note.slice(0, 8)).toBe(ok);
			expect(OrchestrationDocument.safeParse(documentWith(note)).success).toBe(ok);
		}
		// 出错的位置落在出错的节点的 note 上。
		validate(documentWith(EMOJI.repeat(2001)));
		expect(validate.errors?.map((error) => error.instancePath)).toContain("/nodes/0/note");
	});
});
