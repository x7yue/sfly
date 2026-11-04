// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { OrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	documentWarnings,
	type NodeTypeIo,
	type PackageCatalog,
	packageKey,
	referenceOptions,
	referenceWarnings,
} from "../src/index.js";

/** 节点包 demo@1.0.0：fetch 输出 body/status，check 输出 ok。 */
const catalog: PackageCatalog = new Map<string, NodeTypeIo[]>([
	[
		packageKey("demo", "1.0.0"),
		[
			{
				name: "fetch",
				inputs: {
					type: "object",
					properties: { url: { type: "string" }, retries: { type: "integer" } },
					required: ["url"],
				},
				outputs: { type: "object", properties: { body: {}, status: { type: "integer" } } },
			},
			{
				name: "check",
				inputs: { type: "object", properties: { value: {} } },
				outputs: { type: "object", properties: { ok: { type: "boolean" } } },
			},
		],
	],
]);

const pkg = (id: string, node = "fetch", inputs: Record<string, unknown> = {}) => ({
	id,
	kind: "package",
	package: "demo",
	node,
	inputs,
});
const chain = (...ids: string[]) =>
	ids.slice(1).map((to, i) => ({ from: ids[i] as string, to, kind: "chain" }));

const doc = (input: Record<string, unknown>) =>
	OrchestrationDocument.parse({ default_agent: "a", packages: { demo: "1.0.0" }, ...input });

/** 主链 entry(url, token) → a → b → c；子流程 sub(item) → s1，由主链上的异步任务节点 x 触发。 */
const twoChains = doc({
	nodes: [
		{
			id: "entry",
			kind: "entry",
			params: [
				{ name: "url", type: "string" },
				{ name: "token", type: "string", secret: true },
			],
		},
		pkg("a"),
		{ id: "x", kind: "async" },
		pkg("b", "check"),
		{ id: "t", kind: "timer", at: "09:00:00" },
		pkg("c"),
		{ id: "sub", kind: "subflow_entry", params: [{ name: "item", type: "json" }] },
		pkg("s1"),
	],
	edges: [
		...chain("entry", "a", "x", "b", "t", "c"),
		{ from: "x", to: "sub", kind: "dispatch" },
		...chain("sub", "s1"),
	],
});

const expressions = (d: OrchestrationDocument, nodeId: string) =>
	referenceOptions(d, nodeId, catalog).map((o) => o.expression);

describe("引用补全", () => {
	it("提供本链的入口参数，以及本链上前面节点已声明的输出键（按链上顺序）", () => {
		expect(expressions(twoChains, "c")).toEqual([
			"params.url",
			"params.token",
			"nodes.a.outputs.body",
			"nodes.a.outputs.status",
			"nodes.x.outputs.chain_instance_id",
			"nodes.b.outputs.ok",
			"nodes.t.outputs.triggered_at",
			"nodes.t.outputs.late",
		]);
	});

	it("不提供当前节点自己和后面节点的输出", () => {
		expect(expressions(twoChains, "a")).toEqual(["params.url", "params.token"]);
	});

	it("子流程只看到子流程入口的参数和子流程上前面的节点，看不到主链", () => {
		expect(expressions(twoChains, "s1")).toEqual(["params.item"]);
	});

	it("补全项带上可直接写进输入的引用文本", () => {
		const [first] = referenceOptions(twoChains, "a", catalog);
		expect(first).toMatchObject({
			expression: "params.url",
			text: "${{ params.url }}",
			kind: "param",
		});
	});

	it("还没加载到元信息的节点类型不提供输出键；不在任何链上的节点没有可引用的值", () => {
		const d = doc({
			nodes: [{ id: "entry", kind: "entry" }, pkg("a"), pkg("b"), pkg("lost")],
			edges: chain("entry", "a", "b"),
		});
		expect(referenceOptions(d, "b", new Map())).toEqual([]);
		expect(referenceOptions(d, "lost", catalog)).toEqual([]);
	});
});

/** 主链 entry(url) → a(fetch) → b(check, 待测输入) → c(fetch)。 */
const withInputs = (inputs: Record<string, unknown>) =>
	doc({
		nodes: [
			{ id: "entry", kind: "entry", params: [{ name: "url", type: "string" }] },
			pkg("a"),
			pkg("b", "check", inputs),
			pkg("c"),
			{ id: "sub", kind: "subflow_entry", params: [{ name: "item", type: "json" }] },
		],
		edges: chain("entry", "a", "b", "c"),
	});

const refCodes = (d: OrchestrationDocument) =>
	referenceWarnings(d, catalog).map((w) => [w.code, w.node_id, w.input]);

describe("引用检查", () => {
	it("引用本链入口参数和前面节点已声明的输出，没有警告（整值、内嵌、嵌套在对象和数组里）", () => {
		const d = withInputs({
			value: {
				url: "${{ params.url }}",
				list: ["${{nodes.a.outputs.status}}", "status=${{ nodes.a.outputs.status }}"],
			},
		});
		expect(referenceWarnings(d, catalog)).toEqual([]);
	});

	it("引用不存在的节点", () => {
		expect(referenceWarnings(withInputs({ value: "${{ nodes.zzz.outputs.x }}" }), catalog)).toEqual(
			[
				{
					code: "reference_unknown_node",
					node_id: "b",
					input: "value",
					message: "节点 b 的输入 value 引用了不存在的节点 zzz",
				},
			],
		);
	});

	it("引用不在前面的节点：后面的节点、自己、别的链上的节点", () => {
		for (const target of ["c", "b", "sub"]) {
			expect(refCodes(withInputs({ value: `\${{ nodes.${target}.outputs.ok }}` }))).toEqual([
				["reference_not_earlier", "b", "value"],
			]);
		}
		expect(
			referenceWarnings(withInputs({ value: "${{ nodes.c.outputs.body }}" }), catalog)[0]?.message,
		).toBe("节点 b 的输入 value 引用的节点 c 不在本链上它的前面");
	});

	it("引用未声明的输出键", () => {
		expect(
			referenceWarnings(withInputs({ value: "x ${{ nodes.a.outputs.bdoy }}" }), catalog),
		).toEqual([
			{
				code: "reference_unknown_output",
				node_id: "b",
				input: "value",
				message: "节点 b 的输入 value 引用的输出键 bdoy 没有在节点 a 的节点类型中声明",
			},
		]);
	});

	it("引用本链入口没有声明的参数", () => {
		expect(
			referenceWarnings(withInputs({ value: "${{ params.item }}" }), catalog)[0],
		).toMatchObject({
			code: "reference_unknown_param",
			message: "节点 b 的输入 value 引用的参数 item 不是本链入口声明的参数",
		});
	});

	it("引用格式不对或没有闭合", () => {
		expect(refCodes(withInputs({ value: "${{ env.HOME }}", other: ["${{ params.url"] }))).toEqual([
			["reference_invalid", "b", "value"],
			["reference_invalid", "b", "other"],
		]);
	});

	it("被引用节点的类型还不知道时不检查输出键", () => {
		const d = withInputs({ value: "${{ nodes.a.outputs.anything }}" });
		expect(referenceWarnings(d, new Map())).toEqual([]);
	});

	it("异步任务节点的参数映射和 Sleep 节点的时长也检查引用", () => {
		const d = doc({
			nodes: [
				{ id: "entry", kind: "entry", params: [{ name: "wait", type: "string" }] },
				{ id: "x", kind: "async", params: { item: "${{ nodes.nope.outputs.v }}" } },
				{ id: "z", kind: "sleep", duration: "${{ params.wiat }}" },
			],
			edges: chain("entry", "x", "z"),
		});
		expect(refCodes(d)).toEqual([
			["reference_unknown_node", "x", "item"],
			["reference_unknown_param", "z", "duration"],
		]);
	});
});

describe("节点包版本锁定", () => {
	const lockDoc = (packages: Record<string, string>, node = "fetch") =>
		doc({
			packages,
			nodes: [{ id: "entry", kind: "entry" }, pkg("a", node)],
			edges: chain("entry", "a"),
		});
	const codesOf = (d: OrchestrationDocument, c: PackageCatalog = catalog) =>
		documentWarnings(d, c).map((w) => [w.code, w.node_id]);

	it("包节点锁定到存在的版本，且版本里有这个节点类型时没有警告", () => {
		expect(documentWarnings(lockDoc({ demo: "1.0.0" }), catalog)).toEqual([]);
	});

	it("包节点所在的包没有锁定版本", () => {
		expect(documentWarnings(lockDoc({}), catalog)).toEqual([
			{ code: "package_not_locked", node_id: "a", message: "节点 a 的节点包 demo 没有锁定版本" },
		]);
	});

	it("锁定的版本不存在，或版本里没有这个节点类型", () => {
		expect(codesOf(lockDoc({ demo: "9.9.9" }), new Map([["demo@9.9.9", null]]))).toEqual([
			["package_version_missing", "a"],
		]);
		expect(documentWarnings(lockDoc({ demo: "1.0.0" }, "gone"), catalog)[0]?.message).toBe(
			"节点包 demo@1.0.0 中没有节点类型 gone",
		);
	});

	it("结构警告排在前面，然后是包版本和引用的警告", () => {
		const d = doc({
			packages: {},
			nodes: [{ id: "entry", kind: "entry" }, pkg("a", "fetch", { url: "${{ params.x }}" })],
			edges: [],
		});
		expect(codesOf(d)).toEqual([
			["orphan_node", "a"],
			["package_not_locked", "a"],
			["reference_unknown_param", "a"],
		]);
	});
});
