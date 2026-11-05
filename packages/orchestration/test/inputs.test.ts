// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { OrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	documentWarnings,
	inputProblems,
	type NodeTypeIo,
	orderedInputs,
	type PackageCatalog,
	packageKey,
} from "../src/index.js";

/** fetch(url: str, retries: int = 3, mode: Literal["a","b"] = "a", tags: list[str] | None = None) */
const fetchType: NodeTypeIo = {
	name: "fetch",
	inputs: {
		type: "object",
		properties: {
			url: { type: "string" },
			retries: { type: "integer", default: 3 },
			mode: { enum: ["a", "b"], default: "a" },
			tags: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
		},
		required: ["url"],
	},
	outputs: { type: "object", properties: {} },
};

describe("输入校验（派发前）", () => {
	it("输入齐全且类型相符时没有问题", () => {
		expect(inputProblems(fetchType.inputs, { url: "x", retries: 2, tags: ["a"] })).toEqual([]);
		expect(inputProblems(fetchType.inputs, { url: "x", tags: null, mode: "b" })).toEqual([]);
	});

	it("缺少必填输入", () => {
		expect(inputProblems(fetchType.inputs, { retries: 1 })).toEqual(["缺少必填输入 url"]);
	});

	it("类型不符：整数、枚举、数组元素", () => {
		expect(inputProblems(fetchType.inputs, { url: 1 })).toEqual(["输入 url 应为 string，实际是 1"]);
		expect(inputProblems(fetchType.inputs, { url: "x", retries: 1.5 })).toEqual([
			"输入 retries 应为 integer，实际是 1.5",
		]);
		expect(inputProblems(fetchType.inputs, { url: "x", mode: "c" })).toEqual([
			'输入 mode 应为 "a" | "b" 之一，实际是 "c"',
		]);
		expect(inputProblems(fetchType.inputs, { url: "x", tags: [1] })).toHaveLength(1);
	});

	it("allowNull：always 节点引用缺失的输出得到 null，不算类型不符", () => {
		expect(inputProblems(fetchType.inputs, { url: null })).toEqual([
			"输入 url 应为 string，实际是 null",
		]);
		expect(inputProblems(fetchType.inputs, { url: null }, { allowNull: true })).toEqual([]);
	});
});

describe("输入的静态检查", () => {
	const catalog: PackageCatalog = new Map([[packageKey("demo", "1.0.0"), [fetchType]]]);
	const doc = (inputs: Record<string, unknown>) =>
		OrchestrationDocument.parse({
			default_agent: "a",
			packages: { demo: "1.0.0" },
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "n", type: "number" }] },
				{ id: "f", kind: "package", package: "demo", node: "fetch", inputs },
			],
			edges: [{ from: "entry", to: "f", kind: "chain" }],
		});
	const inputWarnings = (inputs: Record<string, unknown>) =>
		documentWarnings(doc(inputs), catalog).filter((w) => w.code.startsWith("input_"));

	it("必填输入未填", () => {
		expect(inputWarnings({})).toEqual([
			{
				code: "input_required",
				node_id: "f",
				input: "url",
				message: "节点 f 的必填输入 url 没有填写",
			},
		]);
	});

	it("常量类型不符；引用不检查类型", () => {
		expect(inputWarnings({ url: "x", retries: "3" })).toEqual([
			{
				code: "input_type_mismatch",
				node_id: "f",
				input: "retries",
				message: '节点 f 的输入 retries 应为 integer，实际是 "3"',
			},
		]);
		expect(inputWarnings({ url: "x", retries: "${{ params.n }}" })).toEqual([]);
	});
});

describe("参数表单字段顺序", () => {
	it("按 order（函数参数顺序），不受对象键顺序影响", () => {
		const io = {
			type: "object" as const,
			// JSONB 存储后对象键按长度、字母重新排列。
			properties: { b: {}, zz: {}, aaa: {} },
			order: ["zz", "aaa", "b"],
		};
		expect(orderedInputs(io).map(([name]) => name)).toEqual(["zz", "aaa", "b"]);
	});

	it("没有 order 时按 properties 的键顺序；order 里没有的键排在后面", () => {
		expect(
			orderedInputs({ type: "object", properties: { x: {}, y: {}, z: {} }, order: ["z"] }).map(
				([n]) => n,
			),
		).toEqual(["z", "x", "y"]);
	});
});
