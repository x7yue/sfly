import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { OrchestrationDocument, toJsonSchema } from "../src/index.js";

// 便签（ADR 0026）：场景文档顶层的 sticky_notes；正文必填，标题、颜色、位置、大小可选；
// zod 与导出的场景文档 JSON Schema（sfly scenario push 的本地校验用它）判断一致。

const EMOJI = "😀";
const documentWith = (...notes: unknown[]) => ({
	nodes: [{ id: "entry", kind: "entry" }],
	sticky_notes: notes,
});
const validate = new Ajv2020({ strict: false }).compile(toJsonSchema(OrchestrationDocument));
const both = (doc: unknown) => [OrchestrationDocument.safeParse(doc).success, validate(doc)];

describe("便签 sticky_notes", () => {
	it("没写就是空数组；写全的便签原样保存，正文和标题去掉首尾空白", () => {
		expect(OrchestrationDocument.parse({ nodes: [] }).sticky_notes).toEqual([]);
		const parsed = OrchestrationDocument.parse(
			documentWith({
				id: "sticky_1",
				title: "  跑之前确认 ",
				text: "\n- Agent 都在线\n- 升级包已放好\n",
				color: "blue",
				position: { x: 0, y: -240 },
				size: { width: 320, height: 200 },
			}),
		);
		expect(parsed.sticky_notes).toEqual([
			{
				id: "sticky_1",
				title: "跑之前确认",
				text: "- Agent 都在线\n- 升级包已放好",
				color: "blue",
				position: { x: 0, y: -240 },
				size: { width: 320, height: 200 },
			},
		]);
	});

	it("只有正文必填：标题、颜色、位置、大小都可以不写，不写的字段不出现在保存下来的文档里", () => {
		const parsed = OrchestrationDocument.parse(documentWith({ id: "s", text: "待办", title: " " }));
		expect(parsed.sticky_notes).toEqual([{ id: "s", text: "待办" }]);
	});

	it("正文为空、只有空白、超过 2000 字不合法；标题超过 40 字或换行不合法；导出的 schema 判断相同", () => {
		const cases: [unknown, boolean][] = [
			[{ id: "s", text: "一" }, true],
			[{ id: "s" }, false],
			[{ id: "s", text: "" }, false],
			[{ id: "s", text: " \n\t" }, false],
			[{ id: "s", text: EMOJI.repeat(2000) }, true],
			[{ id: "s", text: EMOJI.repeat(2001) }, false],
			[{ id: "s", text: "x", title: "一".repeat(40) }, true],
			[{ id: "s", text: "x", title: "一".repeat(41) }, false],
			[{ id: "s", text: "x", title: "两\n行" }, false],
			[{ id: "s", text: "x", color: "red" }, false],
			[{ id: "s", text: "x", size: { width: 160, height: 96 } }, true],
			[{ id: "s", text: "x", size: { width: 159, height: 96 } }, false],
			[{ id: "s", text: "x", size: { width: 200 } }, false],
			[{ id: "s", text: "x", extra: 1 }, false],
		];
		for (const [note, ok] of cases) {
			expect(both(documentWith(note)), JSON.stringify(note).slice(0, 60)).toEqual([ok, ok]);
		}
	});

	it("便签 ID 重复：文档不合法，报出第二张的位置", () => {
		const result = OrchestrationDocument.safeParse(
			documentWith({ id: "s", text: "a" }, { id: "s", text: "b" }),
		);
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]).toMatchObject({
			path: ["sticky_notes", 1, "id"],
			message: "便签 ID s 重复",
		});
	});
});
