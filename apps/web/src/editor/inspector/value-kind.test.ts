import { describe, expect, it } from "vitest";
import type { ReferenceChoice } from "./reference-completion";
import { choicesFor, isNullableString, runStateShown, TYPE_NAMES, valueKind } from "./value-kind";

const choice = (expression: string, kind: ReferenceChoice["kind"]): ReferenceChoice => ({
	expression,
	text: `\${{ ${expression} }}`,
	kind,
	key: expression,
	detail: "",
});
const choices = [
	choice("params.url", "param"),
	choice("run.state", "run_state"),
	choice("nodes.a.outputs.x", "output"),
];

describe("输入的控件种类", () => {
	it("「运行状态」类型的输入（x-sfly-type: run_state）不是 JSON 编辑框，可选的（RunState | None）也一样", () => {
		expect(valueKind({ type: "object", "x-sfly-type": "run_state" })).toBe("run_state");
		expect(
			valueKind({
				anyOf: [{ type: "object", "x-sfly-type": "run_state" }, { type: "null" }],
				default: null,
			}),
		).toBe("run_state");
	});

	it("没有标记的 object 输入、Agent、飞书机器人、字符串等照旧", () => {
		expect(valueKind({ type: "object" })).toBe("json");
		expect(valueKind({ type: "string", "x-sfly-type": "agent" })).toBe("agent");
		expect(valueKind({ type: "string", "x-sfly-type": "feishu_bot" })).toBe("feishu_bot");
		expect(valueKind({ type: "string" })).toBe("string");
		expect(valueKind({ type: "string", enum: ["a", "b"] })).toBe("enum");
		expect(valueKind({ type: "integer" })).toBe("integer");
	});

	it("扩展类型的字段上写类型名：运行状态、Agent、飞书机器人", () => {
		expect(TYPE_NAMES.run_state).toBe("运行状态");
		expect(TYPE_NAMES.agent).toBe("Agent");
		expect(TYPE_NAMES.feishu_bot).toBe("飞书机器人");
		expect(TYPE_NAMES.json).toBeUndefined();
	});
});

describe("字段里「插入引用」能选的引用", () => {
	it("Agent、飞书机器人类型只能选入口参数（触发前就能检查名称）", () => {
		expect(choicesFor("agent", choices).map((c) => c.expression)).toEqual(["params.url"]);
		expect(choicesFor("feishu_bot", choices).map((c) => c.expression)).toEqual(["params.url"]);
	});

	it("运行状态类型只能选运行状态：它只接 ${{ run.state }}，别的值都是警告", () => {
		expect(choicesFor("run_state", choices).map((c) => c.expression)).toEqual(["run.state"]);
	});

	it("其余类型什么都能选", () => {
		for (const kind of ["string", "json", "integer", "boolean"] as const) {
			expect(choicesFor(kind, choices)).toHaveLength(3);
		}
	});
});

describe("「运行状态」类型的输入显示成什么", () => {
	it("值是整值引用：引用标签（点 × 清掉），包括 ${{ run.state }} 本身", () => {
		expect(runStateShown("${{ run.state }}")).toBe("reference");
		expect(runStateShown("${{run.state}}")).toBe("reference");
		expect(runStateShown("${{ params.state }}")).toBe("reference");
	});

	it("没填（或可选输入写的 null）：「接入运行状态」按钮", () => {
		expect(runStateShown(undefined)).toBe("empty");
		expect(runStateShown(null)).toBe("empty");
	});

	it("别的值（别处写进文档的常量、夹在文字里的引用）：照实显示，让人看见并改掉，不藏起来", () => {
		expect(runStateShown({ nodes: [] })).toBe("other");
		expect(runStateShown("abc")).toBe("other");
		expect(runStateShown("x ${{ run.state }}")).toBe("other");
		expect(runStateShown(0)).toBe("other");
	});
});

describe("「字符串或 null」按文本输入（#404 第 6 条）", () => {
	it("str | None（两种成员顺序）是字符串控件，不是 JSON 编辑框", () => {
		const optional = { anyOf: [{ type: "string" }, { type: "null" }], default: null };
		expect(valueKind(optional)).toBe("string");
		expect(isNullableString(optional)).toBe(true);
		expect(valueKind({ anyOf: [{ type: "null" }, { type: "string" }] })).toBe("string");
	});

	it("别的联合、带枚举或扩展类型的成员照旧", () => {
		expect(valueKind({ anyOf: [{ type: "integer" }, { type: "null" }] })).toBe("json");
		expect(valueKind({ anyOf: [{ type: "string" }, { type: "integer" }] })).toBe("json");
		expect(valueKind({ anyOf: [{ type: "string" }, { type: "null" }, { type: "integer" }] })).toBe(
			"json",
		);
		expect(valueKind({ anyOf: [{ enum: ["a", "b"] }, { type: "null" }] })).toBe("json");
		expect(
			valueKind({ anyOf: [{ type: "string", "x-sfly-type": "agent" }, { type: "null" }] }),
		).toBe("agent");
		expect(isNullableString({ anyOf: [{ type: "string", minLength: 1 }, { type: "null" }] })).toBe(
			false,
		);
	});
});
