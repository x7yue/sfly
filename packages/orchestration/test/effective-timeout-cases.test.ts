import { describe, expect, it } from "vitest";
import cases from "../../../testdata/effective-timeout-cases.json" with { type: "json" };
import { effectiveTimeout, NODE_DEFAULTS, nodeTimeoutProblem } from "../src/index.js";

// 生效的超时的两份实现（这里的 TypeScript、`sfly scenario show` 用的 Python）共用一张用例表（#476）：
// testdata/effective-timeout-cases.json。Python 一端在 sdk/python/tests/test_node_timeouts.py。
interface EffectiveCase {
	name: string;
	node?: unknown;
	type?: unknown;
	expect: { seconds: number; source: string };
}
interface ProblemCase {
	name: string;
	label: string;
	written?: unknown;
	problem: string | null;
}
const effectiveCases = cases.effective_cases as EffectiveCase[];
const problemCases = cases.problem_cases as ProblemCase[];

describe("生效的超时的共用用例表", () => {
	it("表里的常量和实现一致", () => {
		expect(cases.platform_seconds).toBe(NODE_DEFAULTS.timeout);
		expect(cases.max_seconds).toBe(4_294_967_295);
	});

	it.each(effectiveCases.map((c) => [c.name, c] as const))("%s", (_, c) => {
		const node = "node" in c ? { timeout: c.node as number } : {};
		const type = "type" in c ? { timeout: c.type } : {};
		expect(effectiveTimeout(node, type)).toEqual(c.expect);
	});

	it.each(problemCases.map((c) => [c.name, c] as const))("不合格时的说明：%s", (_, c) => {
		// 没有 `written` 这个键是没写（undefined）；写了 null 不是没写。
		expect(nodeTimeoutProblem(c.label, "written" in c ? c.written : undefined)).toBe(
			c.problem ?? undefined,
		);
	});
});
