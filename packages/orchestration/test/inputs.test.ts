import { OrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	documentWarnings,
	inputProblems,
	type NodeTypeIo,
	orderedInputs,
	type PackageCatalog,
	packageKey,
	similarInput,
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

describe("输入名的静态检查：写了节点没有声明的输入", () => {
	const typeWith = (
		properties: Record<string, Record<string, unknown>>,
		extra: object = {},
	): NodeTypeIo => ({
		name: "fetch",
		inputs: { type: "object", properties, order: Object.keys(properties), ...extra },
		outputs: { type: "object", properties: {} },
	});
	const warningsFor = (type: NodeTypeIo, inputs: Record<string, unknown>) =>
		documentWarnings(
			OrchestrationDocument.parse({
				default_agent: "a",
				packages: { demo: "1.0.0" },
				nodes: [
					{ id: "entry", kind: "entry", params: [{ name: "n", type: "number" }] },
					{ id: "f", kind: "package", package: "demo", node: "fetch", inputs },
				],
				edges: [{ from: "entry", to: "f", kind: "chain" }],
			}),
			new Map([[packageKey("demo", "1.0.0"), [type]]]),
		).filter((w) => w.code === "input_not_declared");

	it("写明节点、写错的名字、节点类型声明了哪些输入（按参数顺序）", () => {
		expect(warningsFor(fetchType, { url: "x", wat: 1 })).toEqual([
			{
				code: "input_not_declared",
				node_id: "f",
				input: "wat",
				message:
					"节点 f 的输入 wat 没有声明：节点类型 fetch 声明的输入有 url、retries、mode、tags；改成其中一个，或者删掉这个输入",
			},
		]);
	});

	it("名字和某个声明的输入只差一两个字符（含相邻字符颠倒、大小写）时，问是不是想写它", () => {
		const message = (input: string) => warningsFor(fetchType, { [input]: 1 })[0]?.message;
		expect(message("retires")).toBe(
			"节点 f 的输入 retires 没有声明：节点类型 fetch 声明的输入有 url、retries、mode、tags；是不是想写 retries？",
		);
		expect(message("urls")).toContain("是不是想写 url？");
		expect(message("URL")).toContain("是不是想写 url？");
		expect(message("modee")).toContain("是不是想写 mode？");
		expect(message("tag")).toContain("是不是想写 tags？");
		// 差得远的、太短的名字不瞎猜。
		expect(message("timeout")).not.toContain("是不是想写");
		expect(message("x")).not.toContain("是不是想写");
	});

	it("建议的输入已经写了的不再建议；名字够长时可以差两个字符", () => {
		const type = typeWith({ concurrency: { type: "integer" }, host: { type: "string" } });
		expect(warningsFor(type, { host: "h", concurency: 2 })[0]?.message).toContain(
			"是不是想写 concurrency？",
		);
		expect(warningsFor(type, { concurrency: 1, concurency: 2 })[0]?.message).not.toContain(
			"是不是想写",
		);
		expect(warningsFor(type, { host: "h", conccurrency_: 2 })[0]?.message).toContain(
			"是不是想写 concurrency？",
		);
	});

	it("一个字符的名字不猜：差一个字符也是整个名字都不一样（a 对声明的 b）", () => {
		const type = typeWith({ b: { type: "string" }, host: { type: "string" } });
		expect(warningsFor(type, { host: "h", a: 1 })[0]?.message).toBe(
			"节点 f 的输入 a 没有声明：节点类型 fetch 声明的输入有 b、host；改成其中一个，或者删掉这个输入",
		);
		// 两个字符的名字差一个字符可以猜。
		const two = typeWith({ ab: { type: "string" } });
		expect(warningsFor(two, { cb: 1 })[0]?.message).toContain("是不是想写 ab？");
		expect(similarInput("a", ["b"])).toBeUndefined();
		expect(similarInput("cb", ["ab"])).toBe("ab");
	});

	it("声明的输入都已经写在节点上了：没有可以改成的，只说删掉这个输入", () => {
		const type = typeWith({ url: { type: "string" }, retries: { type: "integer" } });
		expect(warningsFor(type, { url: "x", retries: 1, urll: 2 })[0]?.message).toBe(
			"节点 f 的输入 urll 没有声明：节点类型 fetch 声明的输入有 url、retries；声明的输入都已经写在这个节点上了；删掉这个输入",
		);
		// 还有没写的声明的输入时照旧：改成其中一个。
		expect(warningsFor(type, { url: "x", wat: 2 })[0]?.message).toContain(
			"改成其中一个，或者删掉这个输入",
		);
	});

	it("开发版本（包名@dev）的节点：说明里提醒声明是 Agent 上次 sfly dev 时上报的，改了参数要重新运行；已发布的版本没有这句", () => {
		const warn = (version: string) =>
			documentWarnings(
				OrchestrationDocument.parse({
					default_agent: "a",
					packages: { demo: version },
					nodes: [
						{ id: "entry", kind: "entry" },
						{
							id: "f",
							kind: "package",
							package: "demo",
							node: "fetch",
							inputs: { url: "x", wat: 1 },
						},
					],
					edges: [{ from: "entry", to: "f", kind: "chain" }],
				}),
				new Map([[packageKey("demo", version), [fetchType]]]),
			).filter((w) => w.code === "input_not_declared")[0]?.message;
		const hint =
			"（开发版本的声明是 Agent 上次运行 sfly dev 时上报的，刚改过节点的参数的话，在那台机器上重新运行 sfly dev）";
		expect(warn("dev")).toBe(
			`节点 f 的输入 wat 没有声明：节点类型 fetch 声明的输入有 url、retries、mode、tags；改成其中一个，或者删掉这个输入${hint}`,
		);
		expect(warn("1.0.0")).not.toContain("sfly dev");
	});

	it("引用也要检查名字；每个没有声明的输入一条", () => {
		const found = warningsFor(fetchType, { url: "x", a: "${{ params.n }}", b: 1 });
		expect(found.map((w) => (w as { input?: string }).input)).toEqual(["a", "b"]);
	});

	it("节点类型没有声明任何输入：写「不接收任何输入」", () => {
		expect(warningsFor(typeWith({}), { x: 1 })[0]?.message).toBe(
			"节点 f 的输入 x 没有声明：节点类型 fetch 不接收任何输入；删掉这个输入",
		);
	});

	it("没有声明的输入不再另外查类型", () => {
		const all = documentWarnings(
			OrchestrationDocument.parse({
				default_agent: "a",
				packages: { demo: "1.0.0" },
				nodes: [
					{ id: "entry", kind: "entry" },
					{
						id: "f",
						kind: "package",
						package: "demo",
						node: "fetch",
						inputs: { url: "x", wat: 1 },
					},
				],
				edges: [{ from: "entry", to: "f", kind: "chain" }],
			}),
			new Map([[packageKey("demo", "1.0.0"), [fetchType]]]),
		);
		expect(all.map((w) => w.code)).toEqual(["input_not_declared"]);
	});

	it("写对的、必填的缺失照旧；节点类型未知（目录里没有）时不检查", () => {
		expect(warningsFor(fetchType, { url: "x", retries: 2 })).toEqual([]);
		const unknown = documentWarnings(
			OrchestrationDocument.parse({
				default_agent: "a",
				packages: { demo: "1.0.0" },
				nodes: [
					{ id: "entry", kind: "entry" },
					{ id: "f", kind: "package", package: "demo", node: "fetch", inputs: { wat: 1 } },
				],
				edges: [{ from: "entry", to: "f", kind: "chain" }],
			}),
			new Map(),
		);
		expect(unknown.filter((w) => w.code === "input_not_declared")).toEqual([]);
	});

	it("输入 schema 声明接收任意输入（additionalProperties 为 true 或一个 schema）时不检查名字", () => {
		for (const additional of [true, { type: "integer" }]) {
			const type = typeWith({ url: { type: "string" } }, { additionalProperties: additional });
			expect(warningsFor(type, { url: "x", anything: 1 })).toEqual([]);
		}
		// false 和没写一样：不接收没有声明的输入。
		const closed = typeWith({ url: { type: "string" } }, { additionalProperties: false });
		expect(warningsFor(closed, { url: "x", anything: 1 })).toHaveLength(1);
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
