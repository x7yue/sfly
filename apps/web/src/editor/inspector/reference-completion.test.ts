// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 引用语法就是 ${{ ... }}，不是模板字符串
import { type PackageCatalog, packageKey } from "@sfly/orchestration";
import type { OrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	applyCompletion,
	completionGroups,
	completionTrigger,
	referenceChoices,
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

	it("常量文本里输入 ${{ 时弹出补全，选中后替换成完整的引用、光标停在后面", () => {
		expect(completionTrigger("http://", 7, false)).toBeNull();
		const raw = "http://${{ par";
		const trigger = completionTrigger(raw, raw.length, false);
		expect(trigger).toEqual({ start: 7, query: "par" });
		expect(completionTrigger("${{ params.url }} x", 19, false)).toBeNull();

		const next = applyCompletion(
			`${raw}/path`,
			trigger,
			raw.length,
			{ text: "${{ params.url }}" },
			false,
		);
		expect(next).toEqual({ value: "http://${{ params.url }}/path", caret: 24 });
	});

	it("引用模式下整个输入就是表达式，总是弹出；选中后整个值换成引用", () => {
		expect(completionTrigger("nodes.f", 3, true)).toEqual({ start: 0, query: "nodes.f" });
		expect(
			applyCompletion(
				"nodes.f",
				{ start: 0, query: "nodes.f" },
				7,
				{ text: "${{ nodes.fetch.outputs.status }}" },
				true,
			),
		).toEqual({ value: "${{ nodes.fetch.outputs.status }}", caret: 33 });
	});
});
