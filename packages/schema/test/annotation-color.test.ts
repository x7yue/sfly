import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { ANNOTATION_COLORS, OrchestrationDocument, toJsonSchema } from "../src/index.js";

// 注释框的颜色（ADR 0025）：可选，六种之一，不写就是灰色；zod 与导出的场景文档 JSON Schema
// （sfly scenario push 的本地校验用它）判断一致。

const documentWith = (color: unknown) => ({
	nodes: [{ id: "entry", kind: "entry" }],
	annotations: [
		{ id: "a1", title: "准备", nodes: ["entry"], ...(color === undefined ? {} : { color }) },
	],
});

const validate = new Ajv2020({ strict: false }).compile(toJsonSchema(OrchestrationDocument));

describe("注释框的颜色 color", () => {
	it("六种颜色原样保存，不写就没有这一项", () => {
		expect(ANNOTATION_COLORS).toEqual(["gray", "blue", "green", "yellow", "orange", "pink"]);
		for (const color of ANNOTATION_COLORS) {
			expect(OrchestrationDocument.parse(documentWith(color)).annotations[0]?.color).toBe(color);
		}
		expect(JSON.stringify(OrchestrationDocument.parse(documentWith(undefined)))).not.toContain(
			"color",
		);
	});

	it("色板以外的颜色（包括状态色和子流程的紫色）不合法，导出的 schema 判断相同", () => {
		const cases: [unknown, boolean][] = [
			...ANNOTATION_COLORS.map((c): [unknown, boolean] => [c, true]),
			["red", false],
			["cyan", false],
			["purple", false],
			["Blue", false],
			["#3b82f6", false],
			["", false],
			[null, false],
		];
		for (const [color, ok] of cases) {
			const doc = documentWith(color);
			expect(OrchestrationDocument.safeParse(doc).success, String(color)).toBe(ok);
			expect(validate(doc), String(color)).toBe(ok);
		}
	});
});
