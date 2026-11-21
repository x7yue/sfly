// 节点收到的任务输入的键顺序（#479）：真实的 Agent 把输入的键按 UTF-8 字节序排好交给节点，节点原样写出它收到的对象时
// 就是这个顺序，所以控制面认整段写法用的排序必须和它一致。用例表 testdata/key-order-cases.json 两端共用：
// agent/tests/key_order.rs 断言真实的 serde_json 给出表里的 sorted，这里断言控制面的排序函数和测试里的假 Agent 给出同样的结果。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/logs/secrets.js";
import { sortKeysDeep } from "./support/secret-forms.js";

interface Case {
	name: string;
	input: string;
	sorted: string;
}
const table = JSON.parse(
	readFileSync(new URL("../../../testdata/key-order-cases.json", import.meta.url), "utf8"),
) as { cases: Case[] };

describe("键顺序（共用用例表 testdata/key-order-cases.json）", () => {
	it("表没有被删空", () => {
		expect(table.cases.length).toBeGreaterThanOrEqual(6);
	});

	for (const { name, input, sorted } of table.cases) {
		it(`控制面的 canonicalJson：${name}`, () => {
			expect(canonicalJson(JSON.parse(input))).toBe(sorted);
		});
	}

	// 假 Agent 的排序靠 JS 对象的键顺序，整数样子的键排不对，用例表里这一条它不适用（见 sortKeysDeep 的注释）。
	for (const { name, input, sorted } of table.cases.filter((c) => !/整数样子/.test(c.name))) {
		it(`测试里的 sortKeysDeep（假 Agent 用）：${name}`, () => {
			expect(JSON.stringify(sortKeysDeep(JSON.parse(input)))).toBe(sorted);
		});
	}
});
