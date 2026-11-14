// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import { type PackageCatalog, packageKey } from "@sfly/orchestration";
import type { OrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	completionGroups,
	initialActive,
	inlineTrigger,
	moveActive,
	referenceChoices,
	referenceRanges,
	wholeReference,
} from "./reference-completion";

/** 主链 entry → fetch（http_check）→ wait（Sleep）→ ping；ping 可以引用入口参数与前面节点的输出。 */
const doc: OrchestrationDocument = {
	nodes: [
		{
			id: "entry",
			kind: "entry",
			params: [
				{ name: "url", type: "string", required: true, secret: false },
				{ name: "token", type: "string", required: false, secret: true },
			],
		},
		{
			id: "fetch",
			kind: "package",
			package: "demo",
			node: "http_check",
			inputs: {},
			always: false,
		},
		{ id: "wait", kind: "sleep", always: false, duration: "5s" },
		{ id: "ping", kind: "package", package: "demo", node: "ping", inputs: {}, always: false },
	],
	edges: [
		{ from: "entry", to: "fetch", kind: "chain" },
		{ from: "fetch", to: "wait", kind: "chain" },
		{ from: "wait", to: "ping", kind: "chain" },
	],
	packages: { demo: "1.0.0" },
} as OrchestrationDocument;

const io = (outputs: Record<string, { type: string }>) => ({
	type: "object" as const,
	properties: outputs,
});
const catalog: PackageCatalog = new Map([
	[
		packageKey("demo", "1.0.0"),
		[
			{
				name: "http_check",
				inputs: io({}),
				outputs: io({ status: { type: "integer" }, body: { type: "string" } }),
			},
			{ name: "ping", inputs: io({}), outputs: io({}) },
		],
	],
]) as PackageCatalog;

describe("引用补全", () => {
	const choices = referenceChoices(doc, "ping", catalog);

	it("列出本链的入口参数与前序节点的输出，带上类型与来源（敏感参数标出）", () => {
		expect(choices.map((c) => [c.expression, c.kind, c.detail])).toEqual([
			["params.url", "param", "string"],
			["params.token", "param", "string · 敏感"],
			["nodes.fetch.outputs.status", "output", "integer · fetch"],
			["nodes.fetch.outputs.body", "output", "string · fetch"],
			["nodes.wait.outputs.triggered_at", "output", "wait"],
		]);
		expect(choices[0]?.text).toBe("${{ params.url }}");
		// 链上第一个节点只能引用入口参数。
		expect(referenceChoices(doc, "fetch", catalog).map((c) => c.kind)).toEqual(["param", "param"]);
	});

	it("前序节点有显示名称时，来源写成「显示名称（节点 ID）」；引用本身仍以节点 ID 为键", () => {
		const named: OrchestrationDocument = {
			...doc,
			nodes: doc.nodes.map((n) =>
				n.id === "fetch" || n.id === "wait" ? { ...n, display_name: "探测站点" } : n,
			),
		};
		expect(referenceChoices(named, "ping", catalog).map((c) => [c.expression, c.detail])).toEqual([
			["params.url", "string"],
			["params.token", "string · 敏感"],
			["nodes.fetch.outputs.status", "integer · 探测站点（fetch）"],
			["nodes.fetch.outputs.body", "string · 探测站点（fetch）"],
			["nodes.wait.outputs.triggered_at", "探测站点（wait）"],
		]);
		expect(referenceChoices(named, "ping", catalog)[2]?.text).toBe(
			"${{ nodes.fetch.outputs.status }}",
		);
	});

	it("按「入口参数」「前序节点」分组，按表达式子串过滤（不区分大小写）", () => {
		const all = completionGroups(choices, "");
		expect(all.groups.map((g) => [g.title, g.choices.length])).toEqual([
			["入口参数", 2],
			["前序节点", 3],
		]);
		expect(all.ordered.map((c) => c.expression)[0]).toBe("params.url");

		const filtered = completionGroups(choices, "STAT");
		expect(filtered.groups.map((g) => g.choices.map((c) => c.expression))).toEqual([
			[],
			["nodes.fetch.outputs.status"],
		]);
		expect(completionGroups(choices, "nope").ordered).toEqual([]);
	});

	it("合并后的输入框：输入 $ 就弹出补全，$、${、${{ 后面已经输入的部分是查询", () => {
		expect(inlineTrigger("http://")).toBeNull();
		expect(inlineTrigger("http://$")).toEqual({ start: 7, query: "", braced: false });
		expect(inlineTrigger("http://$par")).toEqual({ start: 7, query: "par", braced: false });
		expect(inlineTrigger("http://${")).toEqual({ start: 7, query: "", braced: true });
		expect(inlineTrigger("http://${{ nodes.f")).toEqual({
			start: 7,
			query: "nodes.f",
			braced: true,
		});
		// 已经闭合的引用后面不弹出；$ 后面隔了空格的文字不算查询。
		expect(inlineTrigger("${{ params.url }} x")).toBeNull();
		expect(inlineTrigger("cost $ per")).toBeNull();
	});

	it("找出文本里每个引用的范围（高亮与整块删除用）", () => {
		expect(referenceRanges("plain $ text ${{ open")).toEqual([]);
		expect(referenceRanges("${{ params.url }}")).toEqual([{ from: 0, to: 17 }]);
		expect(referenceRanges("a ${{params.a}}/${{ nodes.f.outputs.s }}\nb")).toEqual([
			{ from: 2, to: 15 },
			{ from: 16, to: 40 },
		]);
	});

	it("输入 $ 触发的补全不预选：按过方向键才有选中项；「插入引用」触发的预选第一项", () => {
		expect(initialActive({ manual: false })).toBe(-1);
		expect(initialActive({ manual: true })).toBe(0);
		// 没有选中项时，向下到第一项，向上到最后一项；之后循环。
		expect(moveActive(-1, 1, 3)).toBe(0);
		expect(moveActive(-1, -1, 3)).toBe(2);
		expect(moveActive(2, 1, 3)).toBe(0);
		expect(moveActive(0, -1, 3)).toBe(2);
		expect(moveActive(1, 1, 3)).toBe(2);
	});

	it("整个值恰好是一个引用时取出表达式（非字符串参数据此显示引用标签）", () => {
		expect(wholeReference("${{ params.url }}")).toBe("params.url");
		expect(wholeReference("${{nodes.fetch.outputs.status}}")).toBe("nodes.fetch.outputs.status");
		expect(wholeReference("x ${{ params.url }}")).toBeUndefined();
		expect(wholeReference(200)).toBeUndefined();
		expect(wholeReference(undefined)).toBeUndefined();
	});
});
