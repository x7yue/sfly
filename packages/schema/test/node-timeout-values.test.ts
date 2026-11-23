import { describe, expect, it } from "vitest";
import cases from "../../../testdata/node-timeout-value-cases.json" with { type: "json" };
import { nodeTimeoutMessage, orchestrationsApi, queueTimeoutMessage } from "../src/index.js";

// 场景里节点的 timeout、queue_timeout 写了不合格的值（0、负数、小数、字符串、超限……，#576）：保存和检查返回的 400 说明
// 写明是哪个节点的哪个字段、允许的范围、实际的值，不再是笼统的「文档不符合 schema」；超限和别的不合格的值是同一种说明。
// 命令行 push 的本地检查（Python）说同一句话，两端共用 testdata/node-timeout-value-cases.json：
// 另一端在 sdk/python/tests/test_cli_document_problems.py。

interface ValueCase {
	name: string;
	value: unknown;
	actual: string;
}
const values = cases.values as ValueCase[];
const fields = cases.fields as Array<"timeout" | "queue_timeout">;
const labels = cases.labels as Array<{ node: Record<string, unknown>; label: string }>;

/** 期望的句子：字面写出来，不用实现里的函数拼（那样测的是实现自己）。 */
const sentence = (label: string, field: string, actual: string) =>
	`节点 ${label}：${field} 必须是 1 到 ${cases.max_seconds} 之间的正整数（秒），实际是 ${actual}`;

const document = (node: Record<string, unknown>) => ({
	default_agent: "a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ kind: "package", package: "p", node: "n", ...node },
	],
	edges: [{ from: "entry", to: node.id, kind: "chain" }],
	packages: { p: "1.0.0" },
});

const messageOf = (endpoint: "saveVersion" | "check", body: object) =>
	orchestrationsApi[endpoint].requestError?.({ params: {}, query: {}, body })?.message;

describe("保存和检查：节点的超时、排队超时不合格", () => {
	for (const endpoint of ["saveVersion", "check"] as const) {
		for (const field of fields) {
			it.each(
				values.map((v) => [v.name, v] as const),
			)(`${endpoint === "check" ? "检查" : "保存"} ${field}：%s`, (_, v) => {
				const body = {
					base_version: 0,
					document: document({ id: "a", [field]: v.value }),
				};

				expect(messageOf(endpoint, body)).toBe(sentence("a", field, v.actual));
			});
		}
	}

	it.each(
		labels.map((l) => [l.label, l] as const),
	)("节点写了显示名称时句子里是「显示名称（节点 ID）」：%s", (_, l) => {
		const body = { base_version: 0, document: document({ ...l.node, timeout: 0 }) };

		expect(messageOf("saveVersion", body)).toBe(sentence(l.label, "timeout", "0"));
	});

	it("两个字段都不合格：各一句，timeout 在前", () => {
		const body = {
			base_version: 0,
			document: document({ id: "a", timeout: "x", queue_timeout: 0 }),
		};

		expect(messageOf("saveVersion", body)).toBe(
			`${sentence("a", "timeout", '"x"')}。${sentence("a", "queue_timeout", "0")}`,
		);
	});

	it("合格的值（上限以内的正整数）不出现在说明里", () => {
		const body = {
			base_version: 0,
			document: document({ id: "a", timeout: 4294967295, queue_timeout: 1, retries: -1 }),
		};

		// retries 是别的问题：说明回到笼统的那一句，不把合格的 timeout、queue_timeout 当问题。
		expect(messageOf("saveVersion", body)).toBe("document does not match the orchestration schema");
	});

	it("不是包节点（别的种类写了 timeout）不按包节点的说明报", () => {
		const body = {
			base_version: 0,
			document: {
				default_agent: "a",
				nodes: [{ id: "entry", kind: "entry", timeout: 0 }],
				edges: [],
				packages: {},
			},
		};

		expect(messageOf("saveVersion", body)).toBe("document does not match the orchestration schema");
	});
});

describe("预检、派发时同一句话（库里已有的值）", () => {
	it.each(
		values.filter((v) => typeof v.value === "number").map((v) => [v.name, v] as const),
	)("nodeTimeoutMessage、queueTimeoutMessage：%s", (_, v) => {
		expect(nodeTimeoutMessage("a", v.value)).toBe(sentence("a", "timeout", v.actual));
		expect(queueTimeoutMessage("a", v.value)).toBe(sentence("a", "queue_timeout", v.actual));
	});
});
