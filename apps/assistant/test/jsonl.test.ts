// pi 的标准输出只按 LF 切行（pi docs/rpc.md「Framing」）。
import { describe, expect, it } from "vitest";
import { LineSplitter } from "../src/jsonl.js";

describe("按 LF 切 JSONL", () => {
	it("字符串里的 U+2028、U+2029 不切开", () => {
		const line = JSON.stringify({ text: "a\u2028b\u2029c" });
		expect(line).toContain("\u2028");
		expect(new LineSplitter().push(Buffer.from(`${line}\n`))).toEqual([line]);
	});

	it("CRLF 去掉 CR", () => {
		expect(new LineSplitter().push(Buffer.from('{"a":1}\r\n{"b":2}\n'))).toEqual([
			'{"a":1}',
			'{"b":2}',
		]);
	});

	it("一行跨两次读到也拼得对，多字节字符被拆开也不坏", () => {
		const bytes = Buffer.from('{"t":"中文"}\n');
		const splitter = new LineSplitter();
		const cut = bytes.indexOf(Buffer.from("文")) + 1;
		expect(splitter.push(bytes.subarray(0, cut))).toEqual([]);
		expect(splitter.push(bytes.subarray(cut))).toEqual(['{"t":"中文"}']);
	});

	it("流结束时没有 LF 的最后一行", () => {
		const splitter = new LineSplitter();
		expect(splitter.push(Buffer.from('{"a":1}\n{"b"'))).toEqual(['{"a":1}']);
		expect(splitter.push(Buffer.from(":2}\r"))).toEqual([]);
		expect(splitter.end()).toBe('{"b":2}');
		expect(splitter.end()).toBeUndefined();
	});
});
