import { describe, expect, it } from "vitest";
import {
	NODE_TIMEOUT_MAX_SECONDS,
	OrchestrationDocument,
	StoredOrchestrationDocument,
} from "../src/index.js";

// 场景里节点的超时上限（#476）：和节点类型声明的超时同一个常量。派发给 Agent 的 `timeout_seconds` 是 uint32，
// 更大的值序列化会失败；保存时拦下，读库时不拦（升级前保存的版本里可能已经有这样的值，读出来要能处理）。
const document = (timeout: unknown) => ({
	default_agent: "a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "slow", kind: "package", package: "p", node: "n", timeout },
	],
	edges: [{ from: "entry", to: "slow", kind: "chain" }],
	packages: { p: "1.0.0" },
});

describe("场景里节点的超时上限", () => {
	it("保存：上限本身可以", () => {
		expect(OrchestrationDocument.safeParse(document(NODE_TIMEOUT_MAX_SECONDS)).success).toBe(true);
	});

	it("保存：超过上限被拒绝，错误信息写明是哪个节点、上限多少、实际是多少，位置指到这个节点的 timeout", () => {
		const parsed = OrchestrationDocument.safeParse(document(NODE_TIMEOUT_MAX_SECONDS + 1));

		expect(parsed.success).toBe(false);
		const issues = parsed.error?.issues ?? [];
		expect(issues).toHaveLength(1);
		expect(issues[0]?.path).toEqual(["nodes", 1, "timeout"]);
		expect(issues[0]?.message).toBe(
			"节点 slow：timeout 必须是 1 到 4294967295 之间的正整数（秒），实际是 4294967296",
		);
	});

	it("保存：原来的限制照旧（0、负数、小数）", () => {
		for (const bad of [0, -5, 1.5]) {
			expect(OrchestrationDocument.safeParse(document(bad)).success, String(bad)).toBe(false);
		}
	});

	it("读库：超过上限的值照常读出来（旧版本里可能有），文档里其余的字段照常补默认值", () => {
		const parsed = StoredOrchestrationDocument.safeParse(document(5_000_000_000));

		expect(parsed.success).toBe(true);
		const node = parsed.data?.nodes[1];
		expect(node).toMatchObject({ timeout: 5_000_000_000, always: false, inputs: {} });
	});
});
