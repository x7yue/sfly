import { describe, expect, it } from "vitest";
import {
	isQueueTimeout,
	NODE_TIMEOUT_MAX_SECONDS,
	OrchestrationDocument,
	QUEUE_TIMEOUT_MAX_SECONDS,
	queueTimeoutMessage,
	StoredOrchestrationDocument,
} from "../src/index.js";

// 场景里节点的排队超时上限（#559）：排队截止时间 = 进入排队的时刻 + 排队超时，要是一个有效的时间；
// 填一个很大的数（多打了几位）算出的是 Invalid Date，触发返回 500 或者把成功的节点记成失败。
// 保存时拦下，读库时不拦（升级前保存的版本里可能已经有这样的值，读出来要能处理）。
const document = (queueTimeout: unknown, extra: Record<string, unknown> = {}) => ({
	default_agent: "a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "wait", kind: "package", package: "p", node: "n", queue_timeout: queueTimeout, ...extra },
	],
	edges: [{ from: "entry", to: "wait", kind: "chain" }],
	packages: { p: "1.0.0" },
});

describe("场景里节点的排队超时上限", () => {
	it("保存：上限本身可以", () => {
		expect(OrchestrationDocument.safeParse(document(QUEUE_TIMEOUT_MAX_SECONDS)).success).toBe(true);
	});

	it("保存：超过上限被拒绝，错误信息写明是哪个节点、字段、上限多少、实际是多少，位置指到这个节点的 queue_timeout", () => {
		const parsed = OrchestrationDocument.safeParse(document(QUEUE_TIMEOUT_MAX_SECONDS + 1));

		expect(parsed.success).toBe(false);
		const issues = parsed.error?.issues ?? [];
		expect(issues).toHaveLength(1);
		expect(issues[0]?.path).toEqual(["nodes", 1, "queue_timeout"]);
		expect(issues[0]?.message).toBe(
			"节点 wait：queue_timeout 必须是 1 到 4294967295 之间的正整数（秒），实际是 4294967296",
		);
	});

	it("保存：节点有显示名称时，错误信息里写「显示名称（节点 ID）」", () => {
		const parsed = OrchestrationDocument.safeParse(
			document(9e15, { display_name: "等一个空闲槽位" }),
		);

		expect(parsed.error?.issues[0]?.message).toBe(
			"节点 等一个空闲槽位（wait）：queue_timeout 必须是 1 到 4294967295 之间的正整数（秒），实际是 9000000000000000",
		);
	});

	it("保存：超时和排队超时都超过上限时各报一条，互不影响", () => {
		const parsed = OrchestrationDocument.safeParse(
			document(5_000_000_000, { timeout: NODE_TIMEOUT_MAX_SECONDS + 1 }),
		);

		expect((parsed.error?.issues ?? []).map((i) => i.path)).toEqual([
			["nodes", 1, "timeout"],
			["nodes", 1, "queue_timeout"],
		]);
	});

	it("保存：原来的限制照旧（0、负数、小数）", () => {
		for (const bad of [0, -5, 1.5]) {
			expect(OrchestrationDocument.safeParse(document(bad)).success, String(bad)).toBe(false);
		}
	});

	it("读库：超过上限的值照常读出来（旧版本里可能有），文档里其余的字段照常补默认值", () => {
		const parsed = StoredOrchestrationDocument.safeParse(document(5_000_000_000));

		expect(parsed.success).toBe(true);
		expect(parsed.data?.nodes[1]).toMatchObject({
			queue_timeout: 5_000_000_000,
			always: false,
			inputs: {},
		});
	});

	it("isQueueTimeout：上限以内的正整数合格，其余（0、负数、小数、超限、不是数字）不合格", () => {
		for (const ok of [1, 600, QUEUE_TIMEOUT_MAX_SECONDS])
			expect(isQueueTimeout(ok), String(ok)).toBe(true);
		for (const bad of [
			0,
			-1,
			1.5,
			QUEUE_TIMEOUT_MAX_SECONDS + 1,
			8.64e12,
			"600",
			true,
			null,
			undefined,
		]) {
			expect(isQueueTimeout(bad), String(bad)).toBe(false);
		}
	});

	it("说明写明字段名 queue_timeout，不是 timeout", () => {
		expect(queueTimeoutMessage("n", 0)).toBe(
			"节点 n：queue_timeout 必须是 1 到 4294967295 之间的正整数（秒），实际是 0",
		);
	});

	it("上限以内的任何值算出的排队截止时间都是有效的时间：到公元 9999 年的任意「现在」都成立，数据库的 timestamptz 也装得下", () => {
		for (const now of [Date.UTC(2026, 10, 22), Date.UTC(5000, 0, 1), Date.UTC(9999, 11, 31)]) {
			const deadline = new Date(now + QUEUE_TIMEOUT_MAX_SECONDS * 1000);
			expect(Number.isNaN(deadline.getTime()), `now=${now}`).toBe(false);
			expect(() => deadline.toISOString()).not.toThrow();
			// PostgreSQL 的 timestamptz 到公元 294276 年。
			expect(deadline.getUTCFullYear()).toBeLessThan(294_276);
		}
	});

	it("没有上限时的后果：issue 里的那个量级（8.64e12 秒）算出的截止时间是无效的时间", () => {
		const deadline = new Date(Date.UTC(2026, 10, 22) + 8.64e12 * 1000);
		expect(Number.isNaN(deadline.getTime())).toBe(true);
	});
});
