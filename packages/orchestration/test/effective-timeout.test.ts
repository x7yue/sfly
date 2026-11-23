import { NODE_TIMEOUT_MAX_SECONDS, QUEUE_TIMEOUT_MAX_SECONDS } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	effectiveQueueTimeout,
	effectiveTimeout,
	NODE_DEFAULTS,
	nodeTimeoutProblem,
	queueTimeoutProblem,
} from "../src/index.js";

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

	it.each([
		["超过 32 位", NODE_TIMEOUT_MAX_SECONDS + 1],
		["小数", 1.5],
		["零", 0],
		["负数", -1],
		["NaN", Number.NaN],
		["字符串", "900"],
	])("场景里这个节点写的超时是%s：不当成有效的值，也不会作为生效的值返回", (_, bad) => {
		const result = effectiveTimeout({ timeout: bad as number }, { timeout: 43_200 });

		// 返回的永远是能下发给 Agent 的值（uint32 范围内的正整数）：这里取节点类型声明的。
		expect(result).toEqual({ seconds: 43_200, source: "type" });
		expect(effectiveTimeout({ timeout: bad as number }, {})).toEqual({
			seconds: NODE_DEFAULTS.timeout,
			source: "platform",
		});
	});
});

// 场景里节点写的超时不合格时的说明：派发时以配置错误失败、保存时被拒绝、触发前的预检阻断，都用这一句。
describe("nodeTimeoutProblem", () => {
	it("没写、或写的是上限以内的正整数：没有问题", () => {
		expect(nodeTimeoutProblem("slow", undefined)).toBeUndefined();
		expect(nodeTimeoutProblem("slow", 1)).toBeUndefined();
		expect(nodeTimeoutProblem("slow", NODE_TIMEOUT_MAX_SECONDS)).toBeUndefined();
	});

	it.each([
		[NODE_TIMEOUT_MAX_SECONDS + 1, "4294967296"],
		[5_000_000_000, "5000000000"],
		[0, "0"],
		[-5, "-5"],
		[1.5, "1.5"],
	])("写的是 %s：说明写明是哪个节点、范围、实际是多少", (value, shown) => {
		expect(nodeTimeoutProblem("部署（deploy）", value)).toBe(
			`节点 部署（deploy）：timeout 必须是 1 到 4294967295 之间的正整数（秒），实际是 ${shown}`,
		);
	});
});

// 生效的排队超时（#559）：场景里这个节点写的，没写就是平台默认的 10 分钟；返回的永远是能算出有效截止时间的值。
describe("effectiveQueueTimeout", () => {
	it("写了用它，没写用平台默认的 10 分钟", () => {
		expect(effectiveQueueTimeout({ queue_timeout: 30 })).toBe(30);
		expect(effectiveQueueTimeout({})).toBe(NODE_DEFAULTS.queue_timeout);
		expect(NODE_DEFAULTS.queue_timeout).toBe(600);
	});

	it("上限本身可以，排队截止时间是有效的时间", () => {
		expect(effectiveQueueTimeout({ queue_timeout: QUEUE_TIMEOUT_MAX_SECONDS })).toBe(
			QUEUE_TIMEOUT_MAX_SECONDS,
		);
		const deadline = new Date(
			Date.now() + effectiveQueueTimeout({ queue_timeout: QUEUE_TIMEOUT_MAX_SECONDS }) * 1000,
		);
		expect(Number.isNaN(deadline.getTime())).toBe(false);
	});

	it.each([
		["超过上限", QUEUE_TIMEOUT_MAX_SECONDS + 1],
		["issue 里的量级", 8.64e12],
		["零", 0],
		["负数", -1],
		["小数", 1.5],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["字符串", "600"],
		["null", null],
	])("写的是%s：不采用，用平台默认，算出的截止时间仍然有效", (_, bad) => {
		const seconds = effectiveQueueTimeout({ queue_timeout: bad as number });

		expect(seconds).toBe(NODE_DEFAULTS.queue_timeout);
		expect(Number.isNaN(new Date(Date.now() + seconds * 1000).getTime())).toBe(false);
	});
});

describe("queueTimeoutProblem", () => {
	it("没写或合格：没有问题", () => {
		expect(queueTimeoutProblem("n", undefined)).toBeUndefined();
		expect(queueTimeoutProblem("n", null)).toBeUndefined();
		expect(queueTimeoutProblem("n", 1)).toBeUndefined();
		expect(queueTimeoutProblem("n", QUEUE_TIMEOUT_MAX_SECONDS)).toBeUndefined();
	});

	it("不合格：写明节点、字段、范围和实际的值", () => {
		expect(queueTimeoutProblem("等槽位（wait）", 8.64e12)).toBe(
			"节点 等槽位（wait）：queue_timeout 必须是 1 到 4294967295 之间的正整数（秒），实际是 8640000000000",
		);
		expect(queueTimeoutProblem("n", 0)).toContain("实际是 0");
		// 字符串带引号写（#576）：和写成数字的 `30` 看得出区别。
		expect(queueTimeoutProblem("n", "x")).toContain('实际是 "x"');
	});
});
