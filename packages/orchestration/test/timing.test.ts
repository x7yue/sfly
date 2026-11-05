// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 编排引用语法就是 ${{ ... }}，不是模板字符串
import { OrchestrationDocument } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { documentWarnings, parseDuration, timerTarget } from "../src/index.js";

describe("Sleep 时长", () => {
	it("支持 ms / s / m / h / d 及组合，数字按秒", () => {
		expect(parseDuration("30s")).toBe(30_000);
		expect(parseDuration("10m")).toBe(600_000);
		expect(parseDuration("1h")).toBe(3_600_000);
		expect(parseDuration("1h30m")).toBe(5_400_000);
		expect(parseDuration(" 2d ")).toBe(172_800_000);
		expect(parseDuration("250ms")).toBe(250);
		expect(parseDuration("0s")).toBe(0);
		expect(parseDuration(45)).toBe(45_000);
	});

	it("无法识别的时长为 null", () => {
		for (const bad of ["", "30", "s", "-5s", "1.5h", "10 minutes", "1h 30m"]) {
			expect(parseDuration(bad)).toBeNull();
		}
		expect(parseDuration(-1)).toBeNull();
		expect(parseDuration(Number.NaN)).toBeNull();
	});
});

describe("定时节点的目标时刻", () => {
	// 2026-01-01T00:00:00Z = 上海 08:00:00。
	const start = new Date("2026-01-01T00:00:00Z");

	it("HH:MM:SS 是节点开始执行当天（按时区）的这个时刻", () => {
		expect(timerTarget("09:30:00", "Asia/Shanghai", start)?.toISOString()).toBe(
			"2026-01-01T01:30:00.000Z",
		);
		// 上海当天 07:00 已经过去：仍是当天，由调用方判断 late。
		expect(timerTarget("07:00:00", "Asia/Shanghai", start)?.toISOString()).toBe(
			"2025-12-31T23:00:00.000Z",
		);
		// 纽约此刻是 2025-12-31 19:00（EST，UTC-5）。
		expect(timerTarget("20:00:00", "America/New_York", start)?.toISOString()).toBe(
			"2026-01-01T01:00:00.000Z",
		);
		expect(timerTarget("12:00:00", "UTC", start)?.toISOString()).toBe("2026-01-01T12:00:00.000Z");
	});

	it("夏令时按当天的偏移计算", () => {
		// 2026-07-01 纽约为 EDT（UTC-4）。
		const summer = new Date("2026-07-01T16:00:00Z");
		expect(timerTarget("09:00:00", "America/New_York", summer)?.toISOString()).toBe(
			"2026-07-01T13:00:00.000Z",
		);
	});

	it("完整日期时间：带偏移按偏移，不带偏移按时区", () => {
		expect(timerTarget("2026-01-02T09:00:00+08:00", "UTC", start)?.toISOString()).toBe(
			"2026-01-02T01:00:00.000Z",
		);
		expect(timerTarget("2026-01-02T09:00:00Z", "Asia/Shanghai", start)?.toISOString()).toBe(
			"2026-01-02T09:00:00.000Z",
		);
		expect(timerTarget("2026-01-02T09:00:00", "Asia/Shanghai", start)?.toISOString()).toBe(
			"2026-01-02T01:00:00.000Z",
		);
		expect(timerTarget("2026-01-02 09:00", "Asia/Shanghai", start)?.toISOString()).toBe(
			"2026-01-02T01:00:00.000Z",
		);
	});

	it("格式或时区无效时为 null", () => {
		for (const bad of ["9:30", "25:00:00", "12:60:00", "2026-02-30T00:00:00", "tomorrow", ""]) {
			expect(timerTarget(bad, "Asia/Shanghai", start)).toBeNull();
		}
		expect(timerTarget("09:00:00", "Mars/Olympus", start)).toBeNull();
	});
});

describe("定时 / Sleep 节点的静态检查", () => {
	const doc = (nodes: Array<Record<string, unknown>>) => {
		const all = [
			{ id: "entry", kind: "entry", params: [{ name: "wait", type: "string" }] },
			...nodes,
		];
		return OrchestrationDocument.parse({
			nodes: all,
			edges: all.slice(1).map((n, i) => ({ from: all[i]?.id, to: n.id, kind: "chain" })),
		});
	};
	const codes = (d: OrchestrationDocument) =>
		documentWarnings(d, new Map()).map((w) => [w.code, w.node_id]);

	it("有效配置没有警告；Sleep 时长可以是引用", () => {
		expect(
			codes(
				doc([
					{ id: "t", kind: "timer", at: "09:30:00" },
					{ id: "t2", kind: "timer", at: "2026-01-02T09:00:00Z", tz: "UTC" },
					{ id: "s", kind: "sleep", duration: "10m" },
					{ id: "s2", kind: "sleep", duration: "${{ params.wait }}" },
					{ id: "s3", kind: "sleep", duration: "${{ params.wait }}m" },
				]),
			),
		).toEqual([]);
	});

	it("无效的时刻、时区、时长产生警告", () => {
		expect(
			codes(
				doc([
					{ id: "t", kind: "timer", at: "9点半" },
					{ id: "t2", kind: "timer", at: "09:30:00", tz: "Mars/Olympus" },
					{ id: "s", kind: "sleep", duration: "ten minutes" },
				]),
			),
		).toEqual([
			["timer_at_invalid", "t"],
			["timer_tz_invalid", "t2"],
			["sleep_duration_invalid", "s"],
		]);
	});
});
