// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import { OrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	documentWarnings,
	InvalidReferenceError,
	type NodeTypeIo,
	type PackageCatalog,
	packageKey,
	referenceOptions,
	referencesRunState,
	resolveInputs,
	runStateInputs,
	runStateUses,
} from "../src/index.js";

// 运行状态的引用（`${{ run.state }}`，docs/SEMANTICS.md §2.2、§2.7，ADR 0031）：只能整值引用、只能写在包节点的输入里；
// 节点类型里用 `sfly.RunState` 声明的输入（`x-sfly-type: run_state`）必须接它。

const RUN = { type: "object", "x-sfly-type": "run_state" };

/** demo@1.0.0：run_summary 有一个必填的 RunState 输入 run 和一个可选的 RunState | None 输入 maybe；fetch 是普通节点。 */
const catalog: PackageCatalog = new Map<string, NodeTypeIo[]>([
	[
		packageKey("demo", "1.0.0"),
		[
			{
				name: "run_summary",
				inputs: {
					type: "object",
					properties: {
						bot: { type: "string" },
						run: RUN,
						maybe: { anyOf: [RUN, { type: "null" }] },
					},
					required: ["bot", "run"],
					order: ["bot", "run", "maybe"],
				},
				outputs: { type: "object", properties: {} },
			},
			{
				name: "fetch",
				inputs: { type: "object", properties: { url: { type: "string" }, data: {} } },
				outputs: { type: "object", properties: { body: {} } },
			},
		],
	],
]);

const doc = (nodes: Record<string, unknown>[], edges: Array<[string, string]>) =>
	OrchestrationDocument.parse({
		default_agent: "a",
		packages: { demo: "1.0.0" },
		nodes: [{ id: "entry", kind: "entry", params: [{ name: "bot", type: "string" }] }, ...nodes],
		edges: edges.map(([from, to]) => ({ from, to, kind: "chain" })),
	});

const summary = (id: string, inputs: Record<string, unknown>) => ({
	id,
	kind: "package",
	package: "demo",
	node: "run_summary",
	always: true,
	inputs,
});
const fetch = (id: string, inputs: Record<string, unknown>) => ({
	id,
	kind: "package",
	package: "demo",
	node: "fetch",
	inputs,
});

const warningsOf = (document: ReturnType<typeof doc>, code?: string) =>
	documentWarnings(document, catalog)
		.filter((w) => code === undefined || w.code === code)
		.map((w) => [w.code, w.node_id, "input" in w ? w.input : undefined, w.message]);

describe("run.state 引用的写法", () => {
	it("runStateUses 找出值里的 run.state：整值引用和夹在文字里的分开，对象和数组里的字符串也找", () => {
		expect(runStateUses("${{ run.state }}")).toEqual([{ whole: true }]);
		expect(runStateUses("${{run.state}}")).toEqual([{ whole: true }]);
		expect(runStateUses("状态：${{ run.state }}")).toEqual([{ whole: false }]);
		expect(runStateUses({ a: ["${{ run.state }}", "x ${{ run.state }} y"], b: 1 })).toEqual([
			{ whole: true },
			{ whole: false },
		]);
		expect(runStateUses("${{ params.a }}")).toEqual([]);
		expect(runStateUses("${{ run.states }}")).toEqual([]);
		expect(runStateUses(1)).toEqual([]);
		expect(referencesRunState({ run: "${{ run.state }}" })).toBe(true);
		expect(referencesRunState({ run: "${{ params.a }}" })).toBe(false);
	});

	it("节点类型里 x-sfly-type 是 run_state 的输入：RunState 和 RunState | None 都认", () => {
		const type = catalog.get(packageKey("demo", "1.0.0"))?.[0];
		expect(runStateInputs(type?.inputs ?? { type: "object", properties: {} })).toEqual([
			"run",
			"maybe",
		]);
	});
});

describe("解析：整值引用保持原类型，运行状态只在包节点的输入里有", () => {
	const state = { run_id: "r", chains: [{ nodes: [] }], failures: ["a"] };

	it("整值引用解析成运行状态本身（对象），对象和数组里的字符串引用同样解析", () => {
		const scope = { params: {}, earlierOutputs: new Map(), runState: state };
		expect(resolveInputs({ run: "${{ run.state }}", n: 1 }, scope)).toEqual({ run: state, n: 1 });
		expect(resolveInputs({ list: ["${{ run.state }}"] }, scope)).toEqual({ list: [state] });
	});

	it("夹在文字里：运行状态是对象，不能拼进字符串", () => {
		const scope = { params: {}, earlierOutputs: new Map(), runState: state };
		expect(() => resolveInputs({ text: "状态 ${{ run.state }}" }, scope)).toThrow(
			InvalidReferenceError,
		);
	});

	it("作用域里没有运行状态（异步任务节点的参数映射、等待节点）：报错，写明只能写在包节点的输入里", () => {
		const scope = { params: {}, earlierOutputs: new Map() };
		expect(() => resolveInputs({ run: "${{ run.state }}" }, scope)).toThrow(
			/run\.state.*package node/,
		);
	});
});

describe("静态检查：run.state 的位置", () => {
	it("包节点的输入里整值引用：没有警告；run.state 不是「格式不对的引用」", () => {
		const document = doc([fetch("f", { data: "${{ run.state }}" })], [["entry", "f"]]);
		expect(warningsOf(document)).toEqual([]);
	});

	it("夹在文字里：警告，写明只能整值引用", () => {
		const document = doc([fetch("f", { url: "状态 ${{ run.state }}" })], [["entry", "f"]]);
		expect(warningsOf(document)).toEqual([
			[
				"reference_run_state_embedded",
				"f",
				"url",
				"节点 f 的输入 url 把 ${{ run.state }} 写在了文字里：运行状态是一个对象，只能整值引用，把这个输入的值整个写成 ${{ run.state }}",
			],
		]);
	});

	it("写在异步任务节点的参数映射里：警告，写明为什么（按值复制成过时的状态）和怎么改", () => {
		const document = doc(
			[
				{ id: "x", kind: "async", params: { run: "${{ run.state }}" } },
				{
					id: "sub",
					kind: "subflow_entry",
					name: "子流程",
					params: [{ name: "run", type: "json" }],
				},
			],
			[["entry", "x"]],
		);
		document.edges.push({ from: "x", to: "sub", kind: "dispatch" });
		const found = warningsOf(document, "reference_run_state_misplaced");
		expect(found).toHaveLength(1);
		expect(found[0]?.slice(0, 3)).toEqual(["reference_run_state_misplaced", "x", "run"]);
		expect(found[0]?.[3]).toBe(
			"节点 x 的参数 run 里不能引用 ${{ run.state }}：参数映射在子流程创建时解析并按值复制，子流程里的节点拿到的会是一份过时的状态；" +
				"需要运行状态的节点（子流程里的也一样）在自己的输入里引用它",
		);
	});

	it("写在 Sleep 节点的 duration 里：同样警告", () => {
		const document = doc(
			[{ id: "s", kind: "sleep", duration: "${{ run.state }}" }],
			[["entry", "s"]],
		);
		expect(warningsOf(document, "reference_run_state_misplaced")).toHaveLength(1);
	});
});

describe("静态检查：用 RunState 类型声明的输入必须接运行状态", () => {
	const run = (inputs: Record<string, unknown>) =>
		doc([summary("s", { bot: "${{ params.bot }}", ...inputs })], [["entry", "s"]]);

	it("接了 ${{ run.state }}：没有警告", () => {
		expect(warningsOf(run({ run: "${{ run.state }}" }))).toEqual([]);
		expect(warningsOf(run({ run: "${{ run.state }}", maybe: "${{ run.state }}" }))).toEqual([]);
	});

	it("没接必填的 RunState 输入：警告直接写出该填 ${{ run.state }}，不再是泛泛的「必填输入没有填写」", () => {
		expect(warningsOf(run({}))).toEqual([
			[
				"input_run_state_missing",
				"s",
				"run",
				"节点 s 的输入 run 要接这次运行的状态，填 ${{ run.state }}",
			],
		]);
	});

	it("可选的 RunState | None 输入不接没有警告；接了就必须接对", () => {
		expect(warningsOf(run({ run: "${{ run.state }}" }))).toEqual([]);
		expect(warningsOf(run({ run: "${{ run.state }}", maybe: null }))).toEqual([]);
		expect(
			warningsOf(run({ run: "${{ run.state }}", maybe: "别的" }), "input_run_state_value"),
		).toHaveLength(1);
	});

	it("写了别的值（字面值、别的引用、夹在文字里）：警告，写明只能接运行状态", () => {
		for (const value of ["字面值", 42, "${{ params.bot }}", "x ${{ run.state }}", { a: 1 }]) {
			expect(warningsOf(run({ run: value }))).toEqual([
				[
					"input_run_state_value",
					"s",
					"run",
					"节点 s 的输入 run 要接这次运行的状态，只能写 ${{ run.state }}，不能是别的值",
				],
			]);
		}
	});

	it("节点类型未知（目录里没有这个版本）时不检查", () => {
		const document = doc([summary("s", { bot: "x", run: "字面值" })], [["entry", "s"]]);
		expect(
			documentWarnings(document, new Map()).filter((w) => w.code.startsWith("input_run_state")),
		).toEqual([]);
	});

	it("接到不带标记的普通输入（json 或没有类型限制）也允许", () => {
		const document = doc([fetch("f", { data: "${{ run.state }}" })], [["entry", "f"]]);
		expect(warningsOf(document)).toEqual([]);
	});
});

describe("引用补全：包节点可以引用 run.state", () => {
	const document = doc(
		[fetch("f", {}), { id: "w", kind: "sleep", duration: "1s" }],
		[
			["entry", "f"],
			["f", "w"],
		],
	);

	it("包节点的补全里有 run.state；别的节点没有", () => {
		expect(referenceOptions(document, "f", catalog).filter((o) => o.kind === "run_state")).toEqual([
			{
				expression: "run.state",
				text: "${{ run.state }}",
				kind: "run_state",
				key: "state",
			},
		]);
		expect(referenceOptions(document, "w", catalog).some((o) => o.kind === "run_state")).toBe(
			false,
		);
	});
});
