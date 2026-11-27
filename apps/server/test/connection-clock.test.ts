// 一次连接的时间换算在心跳时重新估算（#389）：ConnectionClock 的纯逻辑。
import { describe, expect, it } from "vitest";
import { ConnectionClock } from "../src/agents/agent-clock.js";
import { recalibrationLine } from "../src/agents/agent-hub.js";
import { ManualClock } from "./support/manual-clock.js";

const T0 = Date.parse("2026-11-17T09:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** 在控制面时间 T0、单调时钟读数 1000 时收到 Hello 的连接。 */
const connection = () =>
	new ConnectionClock(
		new ManualClock(iso(T0)),
		{ agentTimeMs: T0, monotonicMs: 1000 },
		new Date(T0),
	);
const at = (clock: ConnectionClock, monotonicMs: number) =>
	clock.occurredAt(monotonicMs)?.getTime();

describe("心跳时重新估算时间换算（#389）", () => {
	it("偏差不到 2 秒不改", () => {
		const clock = connection();
		expect(clock.recalibrate(61_000, new Date(T0 + 61_900))).toBeUndefined();
		expect(at(clock, 61_000)).toBe(T0 + 60_000);
	});

	it("折算出的时间比控制面时间早：一次心跳晚到不改，连续两次才改，取两次里偏差小的那个", () => {
		const clock = connection();
		// 晚到 3 秒的一次心跳，下一次又对得上：不改。
		expect(clock.recalibrate(11_000, new Date(T0 + 13_000))).toBeUndefined();
		expect(clock.recalibrate(21_000, new Date(T0 + 20_100))).toBeUndefined();
		expect(at(clock, 31_000)).toBe(T0 + 30_000);

		// 控制面的墙上时钟拨快了 30 分钟：连续两次都对不上，第二次重新估算。
		const jump = 30 * 60_000;
		expect(clock.recalibrate(41_000, new Date(T0 + 40_000 + jump + 500))).toBeUndefined();
		expect(clock.recalibrate(51_000, new Date(T0 + 50_000 + jump))).toEqual({ driftMs: -jump });
		expect(at(clock, 61_000)).toBe(T0 + 60_000 + jump);
		// 这次心跳之前的读数仍按原来的换算：已经写下的点不变。
		expect(at(clock, 41_000)).toBe(T0 + 40_000);
	});

	it("折算出的时间比控制面时间晚：一次就改，之后的点不早于按原来的换算折算出的这次心跳的时刻，控制面时间追上来以后照新的走", () => {
		const clock = connection();
		const back = 20 * 60_000;
		// 控制面的墙上时钟被往回拨了 20 分钟。
		expect(clock.recalibrate(61_000, new Date(T0 + 60_000 - back))).toEqual({ driftMs: back });
		const heartbeatAt = T0 + 60_000;
		expect(at(clock, 61_000)).toBe(heartbeatAt);
		expect(at(clock, 121_000)).toBe(heartbeatAt);
		expect(at(clock, 61_000 + back)).toBe(heartbeatAt);
		expect(at(clock, 61_000 + back + 5_000)).toBe(heartbeatAt + 5_000);
		// 不倒退：读数越大，折算出的时间不早于前一个。
		const times = [61_000, 90_000, 61_000 + back, 61_000 + back + 1].map((m) => at(clock, m) ?? 0);
		expect([...times].sort((a, b) => a - b)).toEqual(times);
	});

	it("单调时钟走得慢：每次偏差超过 2 秒就重新估算，折算出的时间和控制面时间差不超过三次心跳累积的偏差", () => {
		const clock = connection();
		let mono = 1000;
		let now = T0;
		let worst = 0;
		for (let i = 0; i < 240; i++) {
			mono += 54_000;
			now += 60_000;
			worst = Math.max(worst, Math.abs((at(clock, mono) ?? 0) - now));
			clock.recalibrate(mono, new Date(now));
		}
		// 每分钟差 6 秒：第一次超过阈值只记下，第二次改成第一次的估算（取小的），所以最多差 3 × 6 秒。
		expect(worst).toBeLessThanOrEqual(18_000);
	});

	it("没有对应关系的连接（旧版本 Agent）不处理", () => {
		const clock = new ConnectionClock(new ManualClock(iso(T0)), undefined, new Date(T0));
		expect(clock.recalibrate(61_000, new Date(T0))).toBeUndefined();
		expect(clock.occurredAt(61_000)).toBeUndefined();
	});

	it("控制面的日志写一行：换算偏差多少、已经重新估算、已经写下的点不改", () => {
		expect(recalibrationLine("agent-a", 1_800_000)).toBe(
			"Agent「agent-a」的时间换算偏差 +1800000 ms，超过 2000 ms，已重新估算（之后的点按新的换算，偏差 0 ms；已经写下的点不改）",
		);
	});
});
