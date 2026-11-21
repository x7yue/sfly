import { NODE_TIMEOUT_MAX_SECONDS } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { effectiveTimeout, NODE_DEFAULTS } from "../src/index.js";

// 生效的超时（#476）：场景里这个节点写的 → 节点类型声明的 → 平台默认的 1 小时；同时给出它从哪来。
describe("effectiveTimeout", () => {
	it("场景里这个节点写了：用它，来源是节点", () => {
		expect(effectiveTimeout({ timeout: 120 }, { timeout: 43_200 })).toEqual({
			seconds: 120,
			source: "node",
		});
		expect(effectiveTimeout({ timeout: 120 }, undefined)).toEqual({ seconds: 120, source: "node" });
	});

	it("场景里没写、节点类型声明了：用节点类型的，来源是节点类型", () => {
		expect(effectiveTimeout({}, { timeout: 43_200 })).toEqual({ seconds: 43_200, source: "type" });
	});

	it("都没有：平台默认，来源是平台", () => {
		expect(effectiveTimeout({}, {})).toEqual({
			seconds: NODE_DEFAULTS.timeout,
			source: "platform",
		});
		expect(effectiveTimeout({}, undefined)).toEqual({
			seconds: NODE_DEFAULTS.timeout,
			source: "platform",
		});
		expect(NODE_DEFAULTS.timeout).toBe(3600);
	});

	it("写成和平台默认一样的数，来源仍是它写的地方", () => {
		expect(effectiveTimeout({ timeout: 3600 }, {})).toEqual({ seconds: 3600, source: "node" });
		expect(effectiveTimeout({}, { timeout: 3600 })).toEqual({ seconds: 3600, source: "type" });
	});

	it.each([
		["字符串", "900"],
		["小数", 1.5],
		["零", 0],
		["负数", -1],
		["超过 32 位", NODE_TIMEOUT_MAX_SECONDS + 1],
		["NaN", Number.NaN],
		["null", null],
		["对象", {}],
	])("节点类型的超时是%s（开发版本的元信息没经过发布校验）：忽略，用平台默认", (_, bad) => {
		expect(effectiveTimeout({}, { timeout: bad })).toEqual({
			seconds: NODE_DEFAULTS.timeout,
			source: "platform",
		});
	});

	it("32 位无符号整数的上限本身可以", () => {
		expect(effectiveTimeout({}, { timeout: NODE_TIMEOUT_MAX_SECONDS })).toEqual({
			seconds: NODE_TIMEOUT_MAX_SECONDS,
			source: "type",
		});
	});
});
