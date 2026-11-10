import type { ClockOffsetView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { attemptAgentTimes } from "./attempt-clock";

const DAY = 86_400_000;
const offset = (offset_ms: number, measured_at: string): ClockOffsetView => ({
	offset_ms,
	measured_at,
	exceeds_threshold: Math.abs(offset_ms) >= 2000,
});

describe("尝试的 Agent 时间", () => {
	it("开始和结束的偏差都不到阈值、或都没有记录时，不显示 Agent 时间", () => {
		expect(
			attemptAgentTimes({
				start_clock_offset: offset(1_000, "2025-03-07T00:00:00.000Z"),
				end_clock_offset: offset(-1_999, "2025-03-07T00:01:00.000Z"),
			}),
		).toBeNull();
		expect(attemptAgentTimes({ start_clock_offset: null, end_clock_offset: null })).toBeNull();
	});

	it("偏差达到阈值时给出开始和结束时的 Agent 时间（测量时刻加偏差）和各自的偏差说明", () => {
		expect(
			attemptAgentTimes({
				start_clock_offset: offset(613 * DAY, "2025-03-07T00:00:01.000Z"),
				end_clock_offset: offset(-3_000, "2025-03-07T00:01:01.000Z"),
			}),
		).toEqual({
			start: "2026-11-10T00:00:01.000Z",
			end: "2025-03-07T00:00:58.000Z",
			details: ["开始时比控制面快 613 天", "结束时慢 3 秒"],
		});
	});

	it("只有一头达到阈值时，另一头也给出 Agent 时间，说明里写一致；还没结束时只有开始", () => {
		expect(
			attemptAgentTimes({
				start_clock_offset: offset(500, "2025-03-07T00:00:00.000Z"),
				end_clock_offset: offset(90_000, "2025-03-07T00:01:00.000Z"),
			}),
		).toEqual({
			start: "2025-03-07T00:00:00.500Z",
			end: "2025-03-07T00:02:30.000Z",
			details: ["开始时一致", "结束时比控制面快 1 分钟"],
		});
		expect(
			attemptAgentTimes({
				start_clock_offset: offset(-7_200_000, "2025-03-07T02:00:00.000Z"),
				end_clock_offset: null,
			}),
		).toEqual({
			start: "2025-03-07T00:00:00.000Z",
			end: null,
			details: ["开始时比控制面慢 2 小时"],
		});
	});

	it("Agent 时间超出可表示的范围时不给出时间，偏差说明照常", () => {
		expect(
			attemptAgentTimes({
				start_clock_offset: offset(9e15, "2025-03-07T00:00:00.000Z"),
				end_clock_offset: null,
			}),
		).toMatchObject({ start: null });
	});
});
