// 保密值里的数字，节点打印出来的写法（#479）：控制面把数字 JSON.stringify 写给 Agent，Agent 的 serde_json 解析再写成 task.json，
// Python 的 SDK 用 json.loads 读进来，节点用 json.dumps 或 repr 打印。三端写数字的规则不一样（绝对值在 1e-9 到 1e-4 之间的小数、
// 超出 64 位整数范围又小于 1e21 的整数），控制面认的写法要和节点打印出来的一致。
// 用例表 testdata/number-form-cases.json 三端共用，每一列都由真实的实现产生：Agent 一端 agent/tests/number_forms.rs 断言 serde_json，
// Python 一端 sdk/python/tests/test_number_forms.py 断言 json.dumps，这里断言控制面的 JSON.stringify 和 pythonNumber。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SECRET_MASK as MASK, pythonNumber, secretSetOf } from "../src/logs/secrets.js";
import { pythonNumberText } from "./support/secret-forms.js";

interface Case {
	name: string;
	json: string;
	sent: string;
	serde: string;
	python: string;
}
const table = (
	JSON.parse(
		readFileSync(new URL("../../../testdata/number-form-cases.json", import.meta.url), "utf8"),
	) as { cases: Case[] }
).cases;

/** 两端写法不一样的数字（控制面写的和节点打印的不同）。 */
const differing = table.filter((c) => c.python !== c.sent);

describe("数字的写法（共用用例表 testdata/number-form-cases.json）", () => {
	it("表没有被删空，两类写法不一样的数字都在", () => {
		expect(table.length).toBeGreaterThanOrEqual(30);
		// 小数一类：指数在 -5 以下的小数；整数一类：超出 64 位又小于 1e21 的整数
		expect(
			differing.filter((c) => /^-?0\.0000/.test(c.sent) || /^-?\d(\.\d+)?e-\d+$/.test(c.sent))
				.length,
		).toBeGreaterThanOrEqual(5);
		expect(differing.filter((c) => /^-?\d{20,21}$/.test(c.sent)).length).toBeGreaterThanOrEqual(4);
	});

	for (const c of table) {
		it(`控制面写出的数字和 pythonNumber：${c.name}`, () => {
			// 控制面这一段：用户给的数字原文，经 JS 解析再 JSON.stringify，就是发给 Agent 的 sent
			expect(JSON.stringify(JSON.parse(c.json))).toBe(c.sent);
			// 节点那一端：控制面的 pythonNumber 给出和 Python 的 json.dumps 同样的文本
			expect(pythonNumber(JSON.parse(c.sent))).toBe(c.python);
			// 测试用的写法函数读的就是这张表，不借用控制面的代码
			expect(pythonNumberText(JSON.parse(c.sent))).toBe(c.python);
		});
	}

	it("表里两端写法不一样的数字，作为保密对象里的叶子：两种写法出现在日志里都盖住；整段的两种写法也都盖住", () => {
		for (const c of differing) {
			const value = JSON.parse(c.sent) as number;
			const set = secretSetOf([{ pin: "12", rate: value, region: "a" }]);
			// 叶子：控制面的写法和节点打印的写法
			expect(set.mask(`rate=${c.sent}`), `${c.sent} 的 sent 写法`).toBe(`rate=${MASK}`);
			expect(set.mask(`rate=${c.python}`), `${c.sent} 的 python 写法`).toBe(`rate=${MASK}`);
			// 整段：Python 默认写法、紧凑写法，数字都用节点打印的写法；短叶子 "12"、"a" 一并盖住
			const python = `{"pin": "12", "rate": ${c.python}, "region": "a"}`;
			expect(set.mask(`cfg=${python}`), python).toBe(`cfg=${MASK}`);
			const compact = `{"pin":"12","rate":${c.python},"region":"a"}`;
			expect(set.mask(`cfg=${compact}`), compact).toBe(`cfg=${MASK}`);
		}
	});

	it("顶层是数字的保密参数：两种写法都盖住", () => {
		for (const c of differing) {
			const set = secretSetOf([JSON.parse(c.sent)]);
			expect(set.mask(`pin ${c.sent} / ${c.python}`), c.sent).toBe(`pin ${MASK} / ${MASK}`);
		}
	});

	it("两端写法一样的数字没有多出的文本（不重复，也不凭空多出写法）", () => {
		for (const c of table.filter((x) => x.python === x.sent && !x.sent.includes("e"))) {
			const set = secretSetOf([JSON.parse(c.sent)]);
			expect(
				set.texts.filter((t) => t === c.sent),
				c.sent,
			).toHaveLength(1);
		}
	});
});
