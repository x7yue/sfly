import type { AttemptView, NodeRunView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	defaultTimelineMode,
	nodeSegments,
	runExtent,
	ticks,
	visibleRange,
	zoomFromFractions,
} from "./timeline";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const s = (seconds: number) => T0 + seconds * 1000;

function attempt(overrides: Partial<AttemptView>): AttemptView {
	return {
		task_id: "t1",
		attempt: 1,
		status: "success",
		agent: "agent-a",
		inputs: {},
		outputs: null,
		error: null,
		queued_at: at(0),
		started_at: null,
		ended_at: null,
		wake_at: null,
		progress: null,
		...overrides,
	};
}

function node(kind: NodeRunView["kind"], attempts: AttemptView[]): NodeRunView {
	return {
		node_id: "n",
		kind,
		status: attempts.at(-1)?.status ?? "pending",
		agent: null,
		outputs: null,
		error: null,
		attempts,
	};
}

describe("节点的时间线区段", () => {
	it("排队等待 Agent 与执行分成两段", () => {
		const segs = nodeSegments(
			node("package", [attempt({ queued_at: at(1), started_at: at(4), ended_at: at(10) })]),
			s(60),
		);
		expect(segs.map((g) => [g.kind, g.start, g.end, g.live])).toEqual([
			["queue", s(1), s(4), false],
			["ok", s(4), s(10), false],
		]);
	});

	it("还在执行的尝试延伸到现在，标记为实时", () => {
		const segs = nodeSegments(
			node("package", [attempt({ status: "running", queued_at: at(0), started_at: at(2) })]),
			s(30),
		);
		expect(segs.at(-1)).toMatchObject({ kind: "run", start: s(2), end: s(30), live: true });
	});

	it("还在排队（或派发中）的尝试只有一段排队，延伸到现在", () => {
		const segs = nodeSegments(
			node("package", [attempt({ status: "dispatched", queued_at: at(5) })]),
			s(9),
		);
		expect(segs.map((g) => [g.kind, g.start, g.end, g.live])).toEqual([
			["queue", s(5), s(9), true],
		]);
	});

	it("失败的尝试与重试各自成段，带尝试序号", () => {
		const segs = nodeSegments(
			node("package", [
				attempt({
					task_id: "a1",
					status: "failed",
					queued_at: at(0),
					started_at: at(0),
					ended_at: at(3),
					error: { kind: "node_error", message: "boom" },
				}),
				attempt({
					task_id: "a2",
					attempt: 2,
					status: "success",
					queued_at: at(3),
					started_at: at(3),
					ended_at: at(8),
				}),
			]),
			s(20),
		);
		expect(segs.map((g) => [g.kind, g.attempt, g.taskId])).toEqual([
			["fail", 1, "a1"],
			["ok", 2, "a2"],
		]);
	});

	it("定时 / Sleep 节点的等待画成等待段", () => {
		const waiting = nodeSegments(
			node("sleep", [
				attempt({
					status: "waiting",
					agent: null,
					queued_at: at(2),
					started_at: at(2),
					wake_at: at(12),
				}),
			]),
			s(5),
		);
		expect(waiting.map((g) => [g.kind, g.start, g.end, g.live])).toEqual([
			["wait", s(2), s(5), true],
		]);
		const woke = nodeSegments(
			node("timer", [
				attempt({ status: "success", queued_at: at(2), started_at: at(2), ended_at: at(12) }),
			]),
			s(30),
		);
		expect(woke.map((g) => g.kind)).toEqual(["wait"]);
	});

	it("执行中被取消的尝试画成已取消段", () => {
		const segs = nodeSegments(
			node("package", [
				attempt({ status: "cancelled", queued_at: at(1), started_at: at(1), ended_at: at(6) }),
			]),
			s(20),
		);
		expect(segs.map((g) => [g.kind, g.start, g.end])).toEqual([["cancel", s(1), s(6)]]);
	});

	it("执行中被停止的尝试画成已停止段", () => {
		const segs = nodeSegments(
			node("package", [
				attempt({ status: "stopped", queued_at: at(1), started_at: at(1), ended_at: at(6) }),
			]),
			s(20),
		);
		expect(segs.map((g) => [g.kind, g.start, g.end])).toEqual([["stop", s(1), s(6)]]);
	});

	it("停止子流程节点等子流程结束的时段画成等待段", () => {
		const kinds = (status: AttemptView["status"], ended: string | null) =>
			nodeSegments(
				node("stop_subflow", [
					attempt({ status, queued_at: at(1), started_at: at(1), ended_at: ended }),
				]),
				s(20),
			).map((g) => g.kind);
		expect(kinds("waiting", null)).toEqual(["wait"]);
		expect(kinds("success", at(6))).toEqual(["wait"]);
	});

	it("定时 / Sleep 节点失败或被取消的尝试仍画成失败段、已取消段", () => {
		const kinds = (status: AttemptView["status"]) =>
			nodeSegments(
				node("timer", [attempt({ status, queued_at: at(1), started_at: at(1), ended_at: at(6) })]),
				s(20),
			).map((g) => g.kind);
		expect(kinds("failed")).toEqual(["fail"]);
		expect(kinds("cancelled")).toEqual(["cancel"]);
	});

	it("没有尝试（待执行、跳过、没开始就取消）就没有区段", () => {
		expect(nodeSegments(node("package", []), s(10))).toEqual([]);
	});
});

describe("时间范围", () => {
	const run = { started_at: at(100), ended_at: null };

	it("运行中：从开始到现在；不足 10 秒时按 10 秒显示", () => {
		expect(runExtent(run, s(160))).toEqual({ start: s(100), end: s(160) });
		expect(runExtent(run, s(103))).toEqual({ start: s(100), end: s(110) });
	});

	it("已结束：从开始到结束", () => {
		expect(runExtent({ started_at: at(100), ended_at: at(400) }, s(9999))).toEqual({
			start: s(100),
			end: s(400),
		});
	});

	it("没有缩放时跟随整个运行（运行中即跟随最新），缩放后固定在选中的范围", () => {
		const extent = { start: s(100), end: s(160) };
		expect(visibleRange(extent, null)).toEqual(extent);
		expect(visibleRange(extent, { start: s(110), end: s(120) })).toEqual({
			start: s(110),
			end: s(120),
		});
	});

	it("拖选的两端（轨道宽度的比例，顺序不限）换算成时间范围，最短 1 秒", () => {
		const range = { start: s(0), end: s(100) };
		expect(zoomFromFractions(range, 0.6, 0.2)).toEqual({ start: s(20), end: s(60) });
		expect(zoomFromFractions(range, 0.5, 0.5001)).toEqual({ start: s(50), end: s(51) });
		expect(zoomFromFractions(range, -0.2, 1.3)).toEqual(range);
	});
});

describe("刻度", () => {
	it("5 分钟以内用相对开始时间的偏移，按整数步长对齐运行开始", () => {
		const range = { start: s(100), end: s(160) };
		expect(ticks(range, { origin: s(100) })).toEqual([
			{ at: s(100), label: "+0s" },
			{ at: s(110), label: "+10s" },
			{ at: s(120), label: "+20s" },
			{ at: s(130), label: "+30s" },
			{ at: s(140), label: "+40s" },
			{ at: s(150), label: "+50s" },
			{ at: s(160), label: "+1m" },
		]);
	});

	it("缩放到中间一段时从范围内第一个整步长开始", () => {
		const range = { start: s(107), end: s(125) };
		expect(ticks(range, { origin: s(100) }).map((t) => t.label)).toEqual([
			"+10s",
			"+15s",
			"+20s",
			"+25s",
		]);
	});

	it("偏移带分钟与小时", () => {
		const range = { start: s(0), end: s(270) };
		expect(ticks(range, { origin: s(0) }).map((t) => t.label)).toEqual([
			"+0s",
			"+1m",
			"+2m",
			"+3m",
			"+4m",
		]);
		expect(ticks(range, { origin: s(0), maxTicks: 10 }).map((t) => t.label)[1]).toBe("+30s");
		expect(
			ticks({ start: s(0), end: s(200) }, { origin: s(-3570) })
				.map((t) => t.label)
				.slice(0, 2),
		).toEqual(["+59m 30s", "+1h 00m"]);
	});

	it("超过 5 分钟用当地时钟时间，按当地时间的整步长对齐", () => {
		// 当地时间 = UTC+8：00:00Z 是 08:00。
		const range = { start: s(30), end: s(30 + 40 * 60) };
		const labels = ticks(range, { origin: s(0), utcOffsetMinutes: 480 });
		expect(labels.map((t) => t.label)).toEqual([
			"08:05",
			"08:10",
			"08:15",
			"08:20",
			"08:25",
			"08:30",
			"08:35",
			"08:40",
		]);
		expect(labels[0]?.at).toBe(s(300));
	});
});

describe("时间线的默认显示模式", () => {
	it("链与节点不多时展开节点", () => {
		expect(defaultTimelineMode(2, 7)).toBe("expanded");
		expect(defaultTimelineMode(6, 18)).toBe("expanded");
	});

	it("链实例多于 6 条，或展开后多于 24 行时默认汇总", () => {
		expect(defaultTimelineMode(7, 7)).toBe("summary");
		expect(defaultTimelineMode(1, 24)).toBe("summary");
	});
});
