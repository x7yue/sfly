// 测试支持：响应 schema 里的数组字段有没有被真实数据对照过（support/array-coverage.ts）。
import { describe, expect, it } from "vitest";
import { ArrayCoverage, arrayPaths, nonEmptyArrayPaths } from "./support/array-coverage.js";

const schema = {
	type: "object",
	properties: {
		id: { type: "string" },
		rows: {
			type: "array",
			items: {
				type: "object",
				properties: { tags: { type: "array", items: { type: "string" } }, n: { type: "integer" } },
			},
		},
		owner: {
			anyOf: [
				{ type: "object", properties: { groups: { type: "array", items: { type: "string" } } } },
				{ type: "null" },
			],
		},
		labels: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
		tree: { $ref: "#/$defs/node" },
	},
	$defs: {
		node: {
			type: "object",
			properties: { children: { type: "array", items: { $ref: "#/$defs/node" } } },
		},
	},
};

describe("响应 schema 里的数组字段", () => {
	it("列出全部数组字段：嵌套的、几选一里的、字典的值、递归的只列一次", () => {
		expect(arrayPaths(schema).sort()).toEqual([
			"labels.*[]",
			"owner.groups[]",
			"rows[]",
			"rows[].tags[]",
			"tree.children[]",
		]);
	});

	it("只记下这份数据里非空的", () => {
		expect(
			nonEmptyArrayPaths(schema, { id: "a", rows: [], owner: null, labels: {} }).sort(),
		).toEqual([]);
		expect(
			nonEmptyArrayPaths(schema, {
				id: "a",
				rows: [{ tags: [], n: 1 }, { tags: ["x"] }],
				owner: { groups: ["g"] },
				labels: { a: [], b: ["z"] },
				tree: { children: [{ children: [] }] },
			}).sort(),
		).toEqual(["labels.*[]", "owner.groups[]", "rows[]", "rows[].tags[]", "tree.children[]"]);
	});

	it("覆盖：登记几份数据，最后列出一次都没有非空过的", () => {
		const coverage = new ArrayCoverage();
		coverage.record("GET /a response", schema, { rows: [{ tags: [] }], owner: null });
		coverage.record("GET /a response", schema, { rows: [], owner: { groups: ["g"] } });
		expect(coverage.unseen()).toEqual([
			"GET /a response labels.*[]",
			"GET /a response rows[].tags[]",
			"GET /a response tree.children[]",
		]);
		coverage.record("GET /a response", schema, { rows: [{ tags: ["t"] }], labels: { k: ["v"] } });
		expect(coverage.unseen()).toEqual(["GET /a response tree.children[]"]);
	});
});
