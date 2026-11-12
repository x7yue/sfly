// 飞书请求体的组装规则：Markdown 卡片的共享用例（testdata/feishu-card-cases.json，SDK 的 sfly.feishu.card 跑同一组）
// 和原始消息的校验（ADR 0020、docs/SEMANTICS.md §4.2）。纯函数，不需要控制面。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markdownCard, rawMessage } from "../src/feishu/messages.js";

type Color = Parameters<typeof markdownCard>[2];

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

const file = JSON.parse(
	readFileSync(join(__dirname, "../../../testdata/feishu-card-cases.json"), "utf8"),
);
const cases = file.cases as Array<{ name: string; input: unknown; expected: unknown }>;

const bytes = (body: unknown) => Buffer.byteLength(JSON.stringify(body), "utf8");

describe("Markdown 卡片的组装规则（与 SDK 共用的用例）", () => {
	it("用例文件有内容，上限是 20 KB", () => {
		expect(cases.length).toBeGreaterThan(10);
		expect(file.limit_bytes).toBe(20 * 1024);
	});

	it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
		const input = expand(c.input) as { title: string; markdown: string; color: Color };
		const result = markdownCard(input.title, input.markdown, input.color);
		expect(result).toEqual(expand(c.expected));
		if ("body" in result) expect(bytes(result.body)).toBeLessThanOrEqual(file.limit_bytes);
	});
});

describe("Markdown 卡片：很长的正文", () => {
	it("几 MB 的正文也能截断，结果和刚好超限的正文一样", () => {
		const huge = markdownCard("T", "a".repeat(5_000_000), "blue");
		expect(huge).toEqual(markdownCard("T", "a".repeat(30_000), "blue"));
		expect(huge).toHaveProperty("body");
	});
});

describe("原始消息：只校验是对象、msg_type 合法、不超过 20 KB；原样返回，不截断", () => {
	it.each([
		"text",
		"post",
		"image",
		"share_chat",
		"interactive",
	])("msg_type %s 合法", (msg_type) => {
		const message = { msg_type, content: { anything: ["goes", 1, null, { nested: true }] } };
		expect(rawMessage(message)).toEqual({ body: message });
	});

	it.each([
		["不是对象：数组", [], "不是一个对象"],
		["不是对象：字符串", "text", "不是一个对象"],
		["不是对象：null", null, "不是一个对象"],
		["不是对象：数字", 5, "不是一个对象"],
		["缺 msg_type", { content: {} }, "msg_type"],
		["msg_type 不认识", { msg_type: "audio" }, "msg_type"],
		["msg_type 不是字符串", { msg_type: 1 }, "msg_type"],
	])("%s：不合格，说明原因", (_name, message, includes) => {
		const result = rawMessage(message);
		expect(result).toMatchObject({ problem: expect.stringContaining(includes) });
	});

	it("恰好 20 KB 可以发；多一个字节不发，也不截断", () => {
		const frame = { msg_type: "text", content: { text: "" } };
		const room = 20 * 1024 - bytes(frame);
		const exact = { msg_type: "text", content: { text: "a".repeat(room) } };
		expect(rawMessage(exact)).toEqual({ body: exact });
		const over = { msg_type: "text", content: { text: "a".repeat(room + 1) } };
		expect(rawMessage(over)).toMatchObject({ problem: expect.stringContaining("20 KB") });
	});

	it("大小按 UTF-8 字节算：中文每个字 3 字节", () => {
		const frame = { msg_type: "text", content: { text: "" } };
		const chars = Math.floor((20 * 1024 - bytes(frame)) / 3);
		expect(rawMessage({ ...frame, content: { text: "字".repeat(chars) } })).toHaveProperty("body");
		expect(rawMessage({ ...frame, content: { text: "字".repeat(chars + 1) } })).toHaveProperty(
			"problem",
		);
	});
});
