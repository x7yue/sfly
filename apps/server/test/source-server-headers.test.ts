// 测试工具 `source-server.ts` 的 `fetch` 怎么合并请求头（#687）：调用方的头是普通对象、`Headers` 实例、键值对数组都不能丢。
import { describe, expect, it } from "vitest";
import { mergeHeaders } from "./support/source-server.js";

const AUTH = { cookie: "sfly_login=abc", "sec-fetch-site": "same-origin" };

describe("mergeHeaders", () => {
	it.each([
		["普通对象", { "content-type": "application/json" }],
		["Headers 实例", new Headers({ "content-type": "application/json" })],
		["键值对数组", [["content-type", "application/json"]] as Array<[string, string]>],
	])("调用方给的头是%s：登录的头和调用方的头都在", (_, extra) => {
		const merged = mergeHeaders(AUTH, extra);

		expect(merged.get("cookie")).toBe("sfly_login=abc");
		expect(merged.get("sec-fetch-site")).toBe("same-origin");
		expect(merged.get("content-type")).toBe("application/json");
	});

	it("没给头：只有登录的头", () => {
		expect([...mergeHeaders(AUTH, undefined)]).toEqual([
			["cookie", "sfly_login=abc"],
			["sec-fetch-site", "same-origin"],
		]);
	});

	it("调用方的同名头覆盖登录的头（名字不分大小写）", () => {
		const merged = mergeHeaders(AUTH, new Headers({ Cookie: "sfly_login=other" }));

		expect(merged.get("cookie")).toBe("sfly_login=other");
	});

	it("没有登录的头（auth 是空的）：只有调用方的", () => {
		expect([...mergeHeaders({}, { "x-a": "1" })]).toEqual([["x-a", "1"]]);
	});
});
