// Agent 断线负载（perf/items/06-agent-disconnect.ts）里的核对与测量（纯逻辑）。
import { describe, expect, it } from "vitest";
import { missingSeconds, replayDuration } from "../perf/disconnect.js";

describe("每秒一个点的序列里整秒缺失的点数（missingSeconds）", () => {
	const t = (second: number) => Date.UTC(2026, 10, 7, 0, 0, second);

	it("每秒都有点时不缺", () => {
		expect(missingSeconds([t(0), t(1), t(2), t(3)])).toBe(0);
	});

	it("相邻两点之间空出的秒数都算缺失，可以有多段", () => {
		expect(missingSeconds([t(0), t(1), t(5), t(6), t(8)])).toBe(4);
	});

	it("没有点或只有一个点时无从判断，算不缺", () => {
		expect(missingSeconds([])).toBe(0);
		expect(missingSeconds([t(3)])).toBe(0);
	});
});

describe("重连后补发完排队日志的耗时（replayDuration）", () => {
	const line = (seq: number, timeMs: number) => ({ seq, timeMs });
	const at = (ms: number, lastSeq: number) => ({ ms, lastSeq });
	// 断线前收到 1–3；断线期间产生的 4–6 排进队列，7–9 因队列满被丢弃；10 起是重连（ms = 100）之后产生的。
	const lines = [
		line(1, 10),
		line(2, 20),
		line(3, 30),
		line(4, 40),
		line(5, 50),
		line(6, 60),
		line(10, 110),
		line(11, 120),
	];

	it("从重连到控制面已写入的最大序号追上重连前产生、最终收到的最后一行为止", () => {
		const progress = [at(90, 3), at(100, 3), at(150, 4), at(200, 5), at(250, 6), at(300, 11)];
		expect(replayDuration(progress, lines, 100)).toBe(150);
	});

	it("重连之前的进度采样不算", () => {
		const progress = [at(50, 6), at(120, 6)];
		expect(replayDuration(progress, lines, 100)).toBe(20);
	});

	it("一直没追上时为 null", () => {
		expect(replayDuration([at(150, 4), at(200, 5)], lines, 100)).toBeNull();
	});

	it("重连前产生的行一行都没收到时无需补发，耗时为 0", () => {
		expect(replayDuration([at(150, 11)], [line(10, 110), line(11, 120)], 100)).toBe(0);
	});
});
