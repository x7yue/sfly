// 飞书请求体的组装规则：文本消息的截断和原始消息的校验，都逐条跑 testdata/ 下与实现无关的共享用例
// （feishu-text-cases.json、feishu-raw-cases.json；SDK 的测试跑同一组，ADR 0020）。
// 纯函数，不需要控制面。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FEISHU_BODY_LIMIT_BYTES, FEISHU_MSG_TYPES } from "@sfly/orchestration";
import { describe, expect, it } from "vitest";
import { rawMessage, textMessage } from "../src/feishu/messages.js";

/** 用例里的字符串可以写成 {"$repeat": 单元, "times": 次数, "suffix": 末尾}；先展开。 */
function expand(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(expand);
	if (value !== null && typeof value === "object") {
		const o = value as Record<string, unknown>;
		if ("$repeat" in o) {
			return (o.$repeat as string).repeat(o.times as number) + ((o.suffix as string) ?? "");
		}
		return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, expand(v)]));
	}
	return value;
}

interface CaseFile {
	limit_bytes: number;
	msg_types?: string[];
	cases: Array<{ name: string; input: unknown; expected: unknown }>;
}

const load = (name: string): CaseFile =>
	JSON.parse(readFileSync(join(__dirname, "../../../testdata", name), "utf8"));

const bytes = (body: unknown) => Buffer.byteLength(JSON.stringify(body), "utf8");

describe("文本消息的组装与截断（与 SDK 共用的用例）", () => {
	const text = load("feishu-text-cases.json");

	it("用例文件有内容，上限是 20 KB", () => {
		expect(text.cases.length).toBeGreaterThan(10);
		expect(text.limit_bytes).toBe(FEISHU_BODY_LIMIT_BYTES);
	});

	it.each(text.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
		const input = expand(c.input) as { text: string; at_all: boolean };
		const body = textMessage(input.text, input.at_all);
		expect(body).toEqual((expand(c.expected) as { body: unknown }).body);
		expect(bytes(body)).toBeLessThanOrEqual(text.limit_bytes);
	});
});

describe("原始消息的校验（与 SDK 共用的用例）：只校验是对象、msg_type 合法、不超过 20 KB；原样返回，不截断", () => {
	const raw = load("feishu-raw-cases.json");

	it("用例文件有内容，上限是 20 KB", () => {
		expect(raw.cases.length).toBeGreaterThan(20);
		expect(raw.limit_bytes).toBe(FEISHU_BODY_LIMIT_BYTES);
		expect(raw.msg_types).toEqual([...FEISHU_MSG_TYPES]);
	});

	it.each(raw.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
		const { value } = expand(c.input) as { value: unknown };
		const expected = expand(c.expected) as { body: unknown } | { problem: string };
		expect(rawMessage(value)).toEqual(expected);
	});
});
