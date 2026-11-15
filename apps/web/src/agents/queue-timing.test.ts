import { describe, expect, it } from "vitest";
import { queueTiming } from "./queue-timing";

const queued_at = "2026-01-01T00:00:00.000Z";
const at = (seconds: number) => Date.parse(queued_at) + seconds * 1000;

describe("排队任务的时间说明", () => {
	it("写排队了多久和多久后排队超时", () => {
		const task = { queued_at, queue_expires_at: "2026-01-01T00:10:00.000Z" };
		expect(queueTiming(task, at(90))).toBe("排队 1m 30s · 8m 30s 后超时");
		expect(queueTiming(task, at(5))).toBe("排队 5.0s · 9m 55s 后超时");
	});

	it("过了排队超时、控制面还没扫到时写「即将超时」", () => {
		const task = { queued_at, queue_expires_at: "2026-01-01T00:00:30.000Z" };
		expect(queueTiming(task, at(30))).toBe("排队 30.0s · 即将超时");
		expect(queueTiming(task, at(33))).toBe("排队 33.0s · 即将超时");
	});

	it("没有设置排队超时的任务只写排队了多久", () => {
		expect(queueTiming({ queued_at, queue_expires_at: null }, at(125))).toBe("排队 2m 05s");
	});
});
