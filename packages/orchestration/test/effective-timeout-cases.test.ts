import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { effectiveTimeout, NODE_DEFAULTS, nodeTimeoutProblem } from "../src/index.js";

// 生效的超时的两份实现（这里的 TypeScript、`sfly scenario show` 用的 Python）共用一张用例表（#476）：
// testdata/effective-timeout-cases.json。Python 一端在 sdk/python/tests/test_node_timeouts.py。
interface Cases {
	platform_seconds: number;
	max_seconds: number;
	effective_cases: Array<{
		name: string;
		node?: unknown;
		type?: unknown;
		expect: { seconds: number; source: string };
	}>;
	problem_cases: Array<{ name: string; label: string; written?: number; problem: string | null }>;
}

const file = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../testdata/effective-timeout-cases.json",
);
const cases = JSON.parse(readFileSync(file, "utf8")) as Cases;

describe("生效的超时的共用用例表", () => {
	it("表里的常量和实现一致", () => {
		expect(cases.platform_seconds).toBe(NODE_DEFAULTS.timeout);
		expect(cases.max_seconds).toBe(4_294_967_295);
	});

	it.each(cases.effective_cases.map((c) => [c.name, c] as const))("%s", (_, c) => {
		const node = "node" in c ? { timeout: c.node as number } : {};
		const type = "type" in c ? { timeout: c.type } : {};
		expect(effectiveTimeout(node, type)).toEqual(c.expect);
	});

	it.each(cases.problem_cases.map((c) => [c.name, c] as const))("不合格时的说明：%s", (_, c) => {
		expect(nodeTimeoutProblem(c.label, c.written)).toBe(c.problem ?? undefined);
	});
});
