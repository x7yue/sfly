import type { NodeTypeIo } from "@sfly/orchestration";
import { describe, expect, it } from "vitest";
import { timeoutHelp, timeoutPlaceholder } from "./timeout-note";

const io = { type: "object", properties: {} } as const;
const type = (timeout?: number): NodeTypeIo => ({
	name: "job",
	inputs: io,
	outputs: io,
	...(timeout === undefined ? {} : { timeout }),
});

// 检查器的超时：写出生效的值和它从哪来（#476）。
describe("超时的占位和说明", () => {
	it("没填、节点类型声明了：占位写节点类型声明的值", () => {
		expect(timeoutPlaceholder(type(43_200))).toBe("43200（节点类型声明，秒）");
	});

	it("没填、节点类型没声明：占位写平台默认", () => {
		expect(timeoutPlaceholder(type())).toBe("3600（平台默认，秒）");
	});

	it("节点类型还没加载或找不到：占位照老样子写默认值，不说它从哪来", () => {
		expect(timeoutPlaceholder(undefined)).toBe("3600（默认，秒）");
		expect(timeoutPlaceholder(null)).toBe("3600（默认，秒）");
	});

	it("说明：没填时写生效的值和来源", () => {
		expect(timeoutHelp({}, type(43_200))).toBe("从任务开始运行时计时。生效 43200 秒：节点类型声明");
		expect(timeoutHelp({}, type())).toBe("从任务开始运行时计时。生效 3600 秒：平台默认");
	});

	it("说明：这个节点上设置了，节点类型也声明了：写明盖过了哪个值", () => {
		expect(timeoutHelp({ timeout: 120 }, type(43_200))).toBe(
			"从任务开始运行时计时。生效 120 秒：节点上设置，盖过节点类型声明的 43200 秒",
		);
	});

	it("说明：这个节点上设置了，节点类型没声明：只写来源", () => {
		expect(timeoutHelp({ timeout: 120 }, type())).toBe(
			"从任务开始运行时计时。生效 120 秒：节点上设置",
		);
	});

	it("说明：节点类型还没加载或找不到：只写计时的起点", () => {
		expect(timeoutHelp({ timeout: 120 }, undefined)).toBe("从任务开始运行时计时");
		expect(timeoutHelp({}, null)).toBe("从任务开始运行时计时");
	});
});
