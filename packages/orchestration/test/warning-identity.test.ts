import type { StoredOrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	DOCUMENT_WARNING_CODES,
	documentWarnings,
	type OrchestrationWarning,
	type PackageCatalog,
	packageKey,
	warningIdentity,
} from "../src/index.js";

// 「同一条警告」的键（#424 的检查用它区分「这次改动带进来的」和「改动之前就有的」）：
// 每一种警告，同一个文档里指向两个不同对象的两条，键都要不同。新加一种警告而没有给够定位的字段时，这里会红。

const io = (properties: Record<string, Record<string, unknown>>, required: string[] = []) => ({
	type: "object" as const,
	properties,
	required,
});

const catalog: PackageCatalog = new Map([
	[
		packageKey("kit", "1.0.0"),
		[
			{
				name: "work",
				inputs: io(
					{
						a: { type: "integer" },
						b: { type: "integer" },
						ag1: { type: "string", "x-sfly-type": "agent" },
						ag2: { type: "string", "x-sfly-type": "agent" },
						bot1: { type: "string", "x-sfly-type": "feishu_bot" },
						bot2: { type: "string", "x-sfly-type": "feishu_bot" },
						s1: { type: "object", "x-sfly-type": "run_state" },
						s2: { type: "object", "x-sfly-type": "run_state" },
					},
					["a", "b", "s1", "s2"],
				),
				outputs: io({ out: {} }),
			},
		],
	],
	[packageKey("gone", "1.0.0"), null],
]);

const entry = (params: Array<Record<string, unknown>> = []) => ({
	id: "entry",
	kind: "entry",
	params,
});
const work = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	kind: "package",
	package: "kit",
	node: "work",
	agent: "agent-a",
	inputs: { a: 1, b: 2, s1: "${{ run.state }}", s2: "${{ run.state }}" },
	...extra,
});
const chain = (...ids: string[]) =>
	ids.slice(1).map((to, i) => ({ from: ids[i] as string, to, kind: "chain" }));

type Doc = Record<string, unknown> & { nodes: unknown[]; edges: unknown[] };
const doc = (nodes: unknown[], edges: unknown[], extra: Record<string, unknown> = {}): Doc => ({
	default_agent: "agent-a",
	nodes,
	edges,
	packages: { kit: "1.0.0" },
	...extra,
});

/** 两个子流程：异步任务 spawn → 子流程 sub1，spawn2 → sub2。 */
const subflows = [
	{ id: "spawn", kind: "async", params: {} },
	{ id: "sub1", kind: "subflow_entry", name: "s1", params: [] },
	{ id: "spawn2", kind: "async", params: {} },
	{ id: "sub2", kind: "subflow_entry", name: "s2", params: [] },
];
const dispatch = [
	{ from: "spawn", to: "sub1", kind: "dispatch" },
	{ from: "spawn2", to: "sub2", kind: "dispatch" },
];

/**
 * 每一种警告：一份文档，里面这种警告至少有两条、指向不同的对象；能指向同一个节点（或注释框）里的不同部分时就那样造，
 * 这是最容易配错的情况。`single`：这种警告一份文档里最多一条（写明为什么）。
 */
const FIXTURES: Record<OrchestrationWarning["code"], Doc | { single: string }> = {
	entry_count: { single: "说的是整个场景的入口节点数，一份文档最多一条" },
	// 同一个起点连到两个不存在的节点、两个起点连到同一个不存在的节点
	unknown_node: doc(
		[entry(), work("w1"), work("w2")],
		[
			...chain("entry", "w1"),
			{ from: "w1", to: "ghost", kind: "chain" },
			{ from: "w2", to: "ghost", kind: "chain" },
			{ from: "w1", to: "ghost2", kind: "dispatch" },
		],
	),
	// 同一个起点的两条不合法的调度连线
	invalid_dispatch: doc(
		[entry(), work("w1"), work("w2"), work("w3")],
		[
			...chain("entry", "w1"),
			{ from: "w1", to: "w2", kind: "dispatch" },
			{ from: "w1", to: "w3", kind: "dispatch" },
		],
	),
	multiple_outgoing: doc(
		[entry(), work("w1"), work("w2"), work("w3"), work("w4"), work("w5")],
		[
			...chain("entry", "w1", "w2"),
			...chain("w1", "w3"),
			...chain("w2", "w4"),
			...chain("w2", "w5"),
		],
	),
	multiple_incoming: doc(
		[entry(), work("w1"), work("w2"), work("w3"), work("w4"), work("w5")],
		[
			...chain("entry", "w1", "w3"),
			...chain("w2", "w3"),
			...chain("w4", "w5"),
			...chain("w1", "w5"),
		],
	),
	entry_incoming: doc(
		[entry(), work("w1"), ...subflows],
		[...chain("entry", "w1", "entry"), ...chain("spawn", "sub1"), ...dispatch],
	),
	cycle: doc(
		[entry(), work("w1"), work("w2"), work("w3"), work("w4")],
		[...chain("entry", "w1", "w2", "w1"), ...chain("w3", "w4", "w3")],
	),
	async_without_dispatch: doc(
		[entry(), { id: "x1", kind: "async", params: {} }, { id: "x2", kind: "async", params: {} }],
		chain("entry", "x1", "x2"),
	),
	async_multiple_dispatch: doc(
		[
			entry(),
			...subflows,
			{ id: "sub3", kind: "subflow_entry", name: "s3", params: [] },
			{ id: "sub4", kind: "subflow_entry", name: "s4", params: [] },
		],
		[
			...chain("entry", "spawn", "spawn2"),
			...dispatch,
			{ from: "spawn", to: "sub3", kind: "dispatch" },
			{ from: "spawn2", to: "sub4", kind: "dispatch" },
		],
	),
	subflow_not_triggered: doc([entry(), ...subflows], []),
	subflow_multiple_triggers: doc(
		[
			entry(),
			...subflows,
			{ id: "spawn3", kind: "async", params: {} },
			{ id: "spawn4", kind: "async", params: {} },
		],
		[
			...chain("entry", "spawn", "spawn2", "spawn3", "spawn4"),
			...dispatch,
			{ from: "spawn3", to: "sub1", kind: "dispatch" },
			{ from: "spawn4", to: "sub2", kind: "dispatch" },
		],
	),
	subflow_name_empty: doc(
		[
			entry(),
			{ id: "spawn", kind: "async", params: {} },
			{ id: "sub1", kind: "subflow_entry", name: " ", params: [] },
			{ id: "spawn2", kind: "async", params: {} },
			{ id: "sub2", kind: "subflow_entry", name: "", params: [] },
		],
		[...chain("entry", "spawn", "spawn2"), ...dispatch],
	),
	subflow_name_duplicate: doc(
		[
			entry(),
			{ id: "spawn", kind: "async", params: {} },
			{ id: "sub1", kind: "subflow_entry", name: "same", params: [] },
			{ id: "spawn2", kind: "async", params: {} },
			{ id: "sub2", kind: "subflow_entry", name: "same", params: [] },
		],
		[...chain("entry", "spawn", "spawn2"), ...dispatch],
	),
	stop_subflow_unset: doc(
		[entry(), { id: "stop1", kind: "stop_subflow" }, { id: "stop2", kind: "stop_subflow" }],
		chain("entry", "stop1", "stop2"),
	),
	stop_subflow_unknown: doc(
		[
			entry(),
			{ id: "stop1", kind: "stop_subflow", subflow: "ghost" },
			{ id: "stop2", kind: "stop_subflow", subflow: "ghost" },
		],
		chain("entry", "stop1", "stop2"),
	),
	stop_subflow_before_trigger: doc(
		[
			entry(),
			{ id: "stop1", kind: "stop_subflow", subflow: "sub1" },
			{ id: "stop2", kind: "stop_subflow", subflow: "sub2" },
			...subflows,
		],
		[...chain("entry", "stop1", "stop2", "spawn", "spawn2"), ...dispatch],
	),
	stop_subflow_out_of_scope: doc(
		[
			entry(),
			...subflows,
			{ id: "stop1", kind: "stop_subflow", subflow: "sub1" },
			{ id: "stop2", kind: "stop_subflow", subflow: "sub2" },
		],
		[
			...chain("entry", "spawn", "spawn2"),
			...dispatch,
			...chain("sub1", "stop1"),
			...chain("sub2", "stop2"),
		],
	),
	// 一层套一层：s4 在第 4 层、s5 在第 5 层
	nesting_too_deep: doc(
		[
			entry(),
			...[1, 2, 3, 4, 5].flatMap((i) => [
				{ id: `a${i}`, kind: "async", params: {} },
				{ id: `s${i}`, kind: "subflow_entry", name: `n${i}`, params: [] },
			]),
		],
		[
			...chain("entry", "a1"),
			...[1, 2, 3, 4, 5].map((i) => ({ from: `a${i}`, to: `s${i}`, kind: "dispatch" })),
			...[1, 2, 3, 4].map((i) => ({ from: `s${i}`, to: `a${i + 1}`, kind: "chain" })),
		],
	),
	orphan_node: doc([entry(), work("w1"), work("w2")], []),
	missing_agent: doc(
		[entry(), work("w1", { agent: undefined }), work("w2", { agent: undefined })],
		chain("entry", "w1", "w2"),
		{ default_agent: undefined },
	),
	package_not_locked: doc(
		[entry(), work("w1", { package: "nope" }), work("w2", { package: "nope2" })],
		chain("entry", "w1", "w2"),
	),
	package_version_missing: doc(
		[entry(), work("w1", { package: "gone" }), work("w2", { package: "gone" })],
		chain("entry", "w1", "w2"),
		{ packages: { kit: "1.0.0", gone: "1.0.0" } },
	),
	unknown_node_type: doc(
		[entry(), work("w1", { node: "x" }), work("w2", { node: "y" })],
		chain("entry", "w1", "w2"),
	),
	// 同一个输入里的两个引用
	reference_invalid: doc(
		[
			entry(),
			work("w1", {
				inputs: {
					a: "${{ bad.one }} ${{ bad.two }}",
					b: 2,
					s1: "${{ run.state }}",
					s2: "${{ run.state }}",
				},
			}),
		],
		chain("entry", "w1"),
	),
	reference_unknown_param: doc(
		[
			entry(),
			work("w1", {
				inputs: {
					a: "${{ params.x }}-${{ params.y }}",
					b: 2,
					s1: "${{ run.state }}",
					s2: "${{ run.state }}",
				},
			}),
		],
		chain("entry", "w1"),
	),
	reference_unknown_node: doc(
		[
			entry(),
			work("w1", {
				inputs: {
					a: "${{ nodes.x.outputs.out }}${{ nodes.y.outputs.out }}",
					b: 2,
					s1: "${{ run.state }}",
					s2: "${{ run.state }}",
				},
			}),
		],
		chain("entry", "w1"),
	),
	reference_not_earlier: doc(
		[
			entry(),
			work("w1", {
				inputs: {
					a: "${{ nodes.w2.outputs.out }}${{ nodes.w3.outputs.out }}",
					b: 2,
					s1: "${{ run.state }}",
					s2: "${{ run.state }}",
				},
			}),
			work("w2"),
			work("w3"),
		],
		chain("entry", "w1", "w2", "w3"),
	),
	reference_unknown_output: doc(
		[
			entry(),
			work("w1"),
			work("w2", {
				inputs: {
					a: "${{ nodes.w1.outputs.p }}${{ nodes.w1.outputs.q }}",
					b: 2,
					s1: "${{ run.state }}",
					s2: "${{ run.state }}",
				},
			}),
		],
		chain("entry", "w1", "w2"),
	),
	subflow_param_unknown: doc(
		[
			entry(),
			{ id: "spawn", kind: "async", params: { x: 1, y: 2 } },
			{ id: "sub1", kind: "subflow_entry", name: "s", params: [] },
		],
		[...chain("entry", "spawn"), { from: "spawn", to: "sub1", kind: "dispatch" }],
	),
	subflow_param_missing: doc(
		[
			entry(),
			{ id: "spawn", kind: "async", params: {} },
			{
				id: "sub1",
				kind: "subflow_entry",
				name: "s",
				params: [
					{ name: "x", type: "string", required: true },
					{ name: "y", type: "string", required: true },
				],
			},
		],
		[...chain("entry", "spawn"), { from: "spawn", to: "sub1", kind: "dispatch" }],
	),
	reference_run_state_embedded: doc(
		[
			entry(),
			work("w1", {
				inputs: {
					a: "x ${{ run.state }}",
					b: "y ${{ run.state }}",
					s1: "${{ run.state }}",
					s2: "${{ run.state }}",
				},
			}),
		],
		chain("entry", "w1"),
	),
	reference_run_state_misplaced: doc(
		[
			entry(),
			{ id: "spawn", kind: "async", params: { x: "${{ run.state }}", y: "${{ run.state }}" } },
			{
				id: "sub1",
				kind: "subflow_entry",
				name: "s",
				params: [
					{ name: "x", type: "json" },
					{ name: "y", type: "json" },
				],
			},
		],
		[...chain("entry", "spawn"), { from: "spawn", to: "sub1", kind: "dispatch" }],
	),
	input_run_state_missing: doc(
		[entry(), work("w1", { inputs: { a: 1, b: 2 } })],
		chain("entry", "w1"),
	),
	input_run_state_value: doc(
		[entry(), work("w1", { inputs: { a: 1, b: 2, s1: 3, s2: 4 } })],
		chain("entry", "w1"),
	),
	input_required: doc(
		[entry(), work("w1", { inputs: { s1: "${{ run.state }}", s2: "${{ run.state }}" } })],
		chain("entry", "w1"),
	),
	input_type_mismatch: doc(
		[
			entry(),
			work("w1", { inputs: { a: "x", b: "y", s1: "${{ run.state }}", s2: "${{ run.state }}" } }),
		],
		chain("entry", "w1"),
	),
	// 同一个节点上写了两个没声明的输入名：节点和种类都相同，靠 input 分开
	input_not_declared: doc(
		[
			entry(),
			work("w1", {
				inputs: { a: 1, b: 2, s1: "${{ run.state }}", s2: "${{ run.state }}", zz1: 1, zz2: 2 },
			}),
		],
		chain("entry", "w1"),
	),
	// 一个「Agent」（「飞书机器人」）类型的输入只有一个值：同一个节点上的两个输入
	agent_input_not_registered: doc(
		[
			entry(),
			work("w1", {
				inputs: {
					a: 1,
					b: 2,
					s1: "${{ run.state }}",
					s2: "${{ run.state }}",
					ag1: "ghost1",
					ag2: "ghost2",
				},
			}),
		],
		chain("entry", "w1"),
	),
	feishu_bot_not_registered: doc(
		[
			entry(),
			work("w1", {
				inputs: {
					a: 1,
					b: 2,
					s1: "${{ run.state }}",
					s2: "${{ run.state }}",
					bot1: "b1",
					bot2: "b2",
				},
			}),
		],
		chain("entry", "w1"),
	),
	node_kind_removed: doc(
		[entry(), { id: "t1", kind: "timer" }, { id: "t2", kind: "sleep" }],
		chain("entry", "t1", "t2"),
	),
	// 同一个注释框里的两个成员
	annotation_unknown_node: doc([entry()], [], {
		annotations: [{ id: "ann", title: "t", nodes: ["ghost1", "ghost2"], subflows: [] }],
	}),
	annotation_unknown_subflow: doc([entry()], [], {
		annotations: [{ id: "ann", title: "t", nodes: [], subflows: ["ghost1", "ghost2"] }],
	}),
	annotation_no_members: doc([entry()], [], {
		annotations: [
			{ id: "ann1", title: "t", nodes: [], subflows: [] },
			{ id: "ann2", title: "t", nodes: [], subflows: [] },
		],
	}),
	// 同一个注释框：两个节点成员各写两次，节点成员和子流程成员同一个 ID 各写两次
	annotation_duplicate_member: doc([entry(), work("w1"), work("w2"), ...subflows], [], {
		annotations: [
			{
				id: "ann",
				title: "t",
				nodes: ["w1", "w1", "w2", "w2", "sub1", "sub1"],
				subflows: ["sub1", "sub1"],
			},
		],
	}),
};

describe("「同一条警告」的键", () => {
	it("登记表里有每一种警告（种类来自 DOCUMENT_WARNING_CODES，不是这里手写的名单）", () => {
		expect(Object.keys(FIXTURES).sort()).toEqual([...DOCUMENT_WARNING_CODES].sort());
	});

	for (const code of DOCUMENT_WARNING_CODES) {
		const fixture = FIXTURES[code];
		if ("single" in fixture) continue;
		it(`${code}：指向不同对象的两条，键不同`, () => {
			const found = documentWarnings(fixture as unknown as StoredOrchestrationDocument, catalog, {
				agents: new Set(["agent-a"]),
				feishuBots: new Set(),
			}).filter((w) => w.code === code);
			expect(found.length, `${code} 的样例要造出至少两条`).toBeGreaterThanOrEqual(2);
			const keys = found.map(warningIdentity);
			expect(new Set(keys).size, `${code}：${keys.join(" / ")}`).toBe(keys.length);
		});
	}

	it("键只看种类和定位的字段，不看文字", () => {
		const a = { code: "input_required", message: "一", node_id: "n", input: "a" } as const;
		expect(warningIdentity(a)).toBe(warningIdentity({ ...a, message: "二" }));
		expect(warningIdentity(a)).not.toBe(warningIdentity({ ...a, input: "b" }));
		expect(warningIdentity(a)).not.toBe(warningIdentity({ ...a, target: "x" }));
	});
});
