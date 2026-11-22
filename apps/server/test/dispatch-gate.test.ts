// 派发的闸门（agents/dispatch-gate.ts）：派发和「排队的任务在等什么」共用的纯函数。
import { describe, expect, it } from "vitest";
import { connectionBlock, dispatchBlock, freeSlots } from "../src/agents/dispatch-gate.js";

const ready = { ready: true, info: { slots: 2 } };
const preparing = { ready: false, info: { slots: 2 } };

describe("这台 Agent 现在能不能接新任务", () => {
	it("按顺序看：不在线 → 准备环境中 → 版本不一致 → 槽位用满 → 可以派发", () => {
		expect(dispatchBlock(undefined, false, 0)).toBe("offline");
		expect(dispatchBlock(undefined, true, 9)).toBe("offline"); // 不在线时别的都不看
		expect(dispatchBlock(preparing, false, 0)).toBe("preparing");
		expect(dispatchBlock(preparing, true, 2)).toBe("preparing");
		expect(dispatchBlock(ready, true, 0)).toBe("version_mismatch");
		expect(dispatchBlock(ready, true, 2)).toBe("version_mismatch");
		expect(dispatchBlock(ready, false, 2)).toBe("slots_full");
		expect(dispatchBlock(ready, false, 5)).toBe("slots_full"); // 超用（断线重连后）也是用满
		expect(dispatchBlock(ready, false, 1)).toBeNull();
		expect(dispatchBlock(ready, false, 0)).toBeNull();
	});

	it("只看连接的三条（派发先看它们，不满足就不必去数任务）", () => {
		expect(connectionBlock(undefined, false)).toBe("offline");
		expect(connectionBlock(preparing, false)).toBe("preparing");
		expect(connectionBlock(ready, true)).toBe("version_mismatch");
		expect(connectionBlock(ready, false)).toBeNull();
	});

	it("空闲槽位数不会是负数", () => {
		expect(freeSlots(4, 1)).toBe(3);
		expect(freeSlots(2, 2)).toBe(0);
		expect(freeSlots(2, 5)).toBe(0);
	});
});
