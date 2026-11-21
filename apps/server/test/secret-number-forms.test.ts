// 保密值里的数字，节点打印出来的写法（#479）：控制面把数字 JSON.stringify 写给 Agent，Agent 的 serde_json 解析再写成 task.json，
// Python 的 SDK 用 json.loads 读进来，节点用 json.dumps 或 repr 打印。三端写数字的规则各不相同，控制面认的写法要和节点里能看到的
// 一致：直接打印拿到的值是 Python 的写法，原样打印 task.json 里的文本是 serde 的写法。
// 用例表 testdata/number-form-cases.json 三端共用，每一列都由真实的实现产生：Agent 一端 agent/tests/number_forms.rs 断言 serde_json，
// Python 一端 sdk/python/tests/test_number_forms.py 断言 json.dumps，这里断言控制面的 JSON.stringify、pythonNumber 和 serdeNumber。
// serdeNumber 的规则绑在 serde_json 的版本上：serde_json 升级后写法变了，Agent 一端先红，红了就要改 serdeNumber。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	SECRET_MASK as MASK,
	pythonNumber,
	secretSetOf,
	serdeNumber,
} from "../src/logs/secrets.js";
import { pythonNumberText } from "./support/secret-forms.js";

interface Case {
	name: string;
	json: string;
	sent: string;
	serde: string;
	python: string;
}
interface WholeCase {
	name: string;
	sent: string;
	serde: string;
	python: string;
}
const data = JSON.parse(
	readFileSync(new URL("../../../testdata/number-form-cases.json", import.meta.url), "utf8"),
) as { cases: Case[]; whole: WholeCase[] };
const table = data.cases;
const whole = data.whole;

/** 控制面写的、Python 打印的、任务文件里的：这个数字在节点里可能出现的写法（去重）。 */
const formsOf = (c: Case): string[] => [...new Set([c.sent, c.python, c.serde])];

/** 超出 64 位整数范围又小于 1e21 的整数（控制面写成一长串数字）。 */
const BEYOND = Number("98765432109876543210");

describe("数字的写法（共用用例表 testdata/number-form-cases.json）", () => {
	it("表没有被删空，三类写法不一样的数字都在", () => {
		expect(table.length).toBeGreaterThanOrEqual(38);
		expect(whole.length).toBeGreaterThanOrEqual(4);
		// 控制面写的和 Python 打印的不同：小数一类、超出 64 位的整数一类
		const differing = table.filter((c) => c.python !== c.sent);
		expect(differing.filter((c) => /^-?\d{20,21}$/.test(c.sent)).length).toBeGreaterThanOrEqual(4);
		expect(
			differing.filter((c) => /^-?0\.0000/.test(c.sent) || /e-\d+$/.test(c.sent)).length,
		).toBeGreaterThanOrEqual(5);
		// 第三类：serde 的写法既不是控制面写的、也不是 Python 打印的（区间 [1e-6, 1e-5)）
		expect(
			table.filter((c) => c.serde !== c.sent && c.serde !== c.python).length,
		).toBeGreaterThanOrEqual(6);
	});

	for (const c of table) {
		it(`控制面写出的数字、pythonNumber、serdeNumber：${c.name}`, () => {
			// 控制面这一段：用户给的数字原文，经 JS 解析再 JSON.stringify，就是发给 Agent 的 sent
			expect(JSON.stringify(JSON.parse(c.json))).toBe(c.sent);
			// 节点那一端：控制面的 pythonNumber 给出和 Python 的 json.dumps 同样的文本
			expect(pythonNumber(JSON.parse(c.sent))).toBe(c.python);
			// Agent 写 task.json 的那一端：serdeNumber 给出和真实 serde_json 同样的文本
			expect(serdeNumber(JSON.parse(c.sent))).toBe(c.serde);
			// 测试用的写法函数读的就是这张表，不借用控制面的代码
			expect(pythonNumberText(JSON.parse(c.sent))).toBe(c.python);
		});
	}

	it("表里每个数字作为叶子：控制面写的、Python 打印的、任务文件里的写法出现在日志里都盖住", () => {
		for (const c of table.filter((x) => x.sent.length >= 4)) {
			const set = secretSetOf([{ pin: "12", rate: JSON.parse(c.sent), region: "a" }]);
			for (const form of formsOf(c)) {
				expect(set.mask(`rate=${form}`), `${c.sent} 的叶子 ${form}`).toBe(`rate=${MASK}`);
			}
		}
	});

	it("顶层是数字的保密参数（不论多短）：三种写法都盖住", () => {
		for (const c of table) {
			const set = secretSetOf([JSON.parse(c.sent)]);
			for (const form of formsOf(c)) {
				expect(set.mask(`pin ${form}`), `${c.sent} 的 ${form}`).toBe(`pin ${MASK}`);
			}
		}
	});

	it("整个对象带着这个数字被原样写出：控制面写的、Python 打印的、任务文件里的（短叶子一起盖住）", () => {
		for (const c of table) {
			const value = JSON.parse(c.sent) as number;
			const set = secretSetOf([{ pin: "12", rate: value, region: "a" }]);
			const forms = new Set([
				`{"pin":"12","rate":${c.sent},"region":"a"}`,
				`{"pin": "12", "rate": ${c.python}, "region": "a"}`,
				`{"pin":"12","rate":${c.serde},"region":"a"}`,
			]);
			for (const form of forms) {
				expect(set.mask(`cfg=${form}`), `${c.sent}：${form}`).toBe(`cfg=${MASK}`);
			}
		}
	});

	it("整个值（对象、数组、嵌套）的表：控制面写的、Python 打印的、任务文件里（serde 写的，同一个值里的两类数字各按各的规则，写法混在一起）的文本都整段盖住", () => {
		for (const c of whole) {
			const set = secretSetOf([JSON.parse(c.sent) as unknown]);
			for (const form of new Set([c.sent, c.python, c.serde])) {
				expect(set.mask(`cfg=${form}`), `${c.name}：${form}`).toBe(`cfg=${MASK}`);
			}
		}
	});

	it("两类数字混在一个值里（评审的例子）：任务文件里的文本整段盖住，短叶子一个不留", () => {
		const array = ["ab", 0.000025, 7, BEYOND, "x"];
		expect(secretSetOf([array]).mask('task=["ab",0.000025,7,9.876543210987654e+19,"x"]')).toBe(
			`task=${MASK}`,
		);
		const object = { id: BEYOND, pin: "12", rate: 0.000025 };
		expect(
			secretSetOf([object]).mask('{"id":9.876543210987654e+19,"pin":"12","rate":0.000025}'),
		).toBe(MASK);
	});

	it("没有哪个数字三种写法不同时，整段的写法不多：纯整数的对象只有 JS 的那几份", () => {
		const plain = secretSetOf([{ a: 1, b: [2, 3], c: "text" }]);
		const withSmall = secretSetOf([{ a: 1, b: 0.000001, c: "text" }]);
		expect(withSmall.texts.length).toBeGreaterThan(plain.texts.length);
		// 整段的写法个数是常数倍，不随数字的个数成倍增长
		const many = secretSetOf([
			Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 0.000001 * (i + 1)])),
		]);
		expect(many.texts.length).toBeLessThan(200);
	});
});
