import type { AttemptView, ChainRunView, NodeRunView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import {
	attentionRow,
	defaultTimelineMode,
	LIVE_HEADROOM,
	liveSpan,
	nodeSegments,
	runExtent,
	ticks,
	timelineContentHeight,
	visibleRange,
	zoomFromFractions,
	zoomStep,
	zoomToSegments,
} from "./timeline-model";

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
		start_clock_offset: null,
		end_clock_offset: null,
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

	it("运行中：右端在「现在」之后留 20% 余量，取整到一级跨度；不足 10 秒时按 10 秒", () => {
		expect(runExtent(run, s(103))).toEqual({ start: s(100), end: s(110) });
		expect(runExtent(run, s(160))).toEqual({ start: s(100), end: s(190) });
		expect(runExtent(run, s(100))).toEqual({ start: s(100), end: s(110) });
		expect(runExtent(run, s(50))).toEqual({ start: s(100), end: s(110) });
	});

	it("运行中：「现在」不越过轴的 1/1.2，轴的两端就一动不动，每秒只有「现在」在推进", () => {
		const ends = new Set<number>();
		for (let elapsed = 31; elapsed <= 37; elapsed++) {
			const extent = runExtent(run, s(100 + elapsed));
			ends.add(extent.end);
			expect((elapsed * 1000) / (extent.end - extent.start)).toBeLessThanOrEqual(
				1 / (1 + LIVE_HEADROOM),
			);
		}
		expect([...ends]).toEqual([s(145)]);
	});

	it("运行中：前十分钟里扩轴的次数很少，每次最多把区段压缩到原来的 2/3", () => {
		let previous = liveSpan(0);
		const jumps: number[] = [];
		for (let elapsed = 1; elapsed <= 600; elapsed++) {
			const span = liveSpan(elapsed * 1000);
			if (span !== previous) {
				jumps.push(span / 1000);
				expect(previous / span).toBeGreaterThanOrEqual(2 / 3);
			}
			previous = span;
		}
		expect(jumps).toEqual([15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 450, 600, 900]);
	});

	it("运行中：超过一天时按整天取整", () => {
		expect(liveSpan(80_000_000)).toBe(2 * 86_400_000);
	});

	it("已结束：按实际时长定轴，末端留 8% 空白；不受「现在」影响", () => {
		const ended = { started_at: at(100), ended_at: at(400) };
		expect(runExtent(ended, s(9999))).toEqual({ start: s(100), end: s(424) });
		expect(runExtent(ended, s(401))).toEqual({ start: s(100), end: s(424) });
	});

	it("已结束的短运行不套 10 秒下限：436ms 的运行占轨道的 92%", () => {
		const start = s(100);
		const short = { started_at: at(100), ended_at: new Date(start + 436).toISOString() };
		const extent = runExtent(short, s(9999));
		expect(extent).toEqual({ start, end: start + 471 });
		expect(436 / (extent.end - extent.start)).toBeCloseTo(0.926, 3);
	});

	it("已结束的零时长运行按 100ms 定轴，轴不会缩成一点", () => {
		expect(runExtent({ started_at: at(100), ended_at: at(100) }, s(9999))).toEqual({
			start: s(100),
			end: s(100) + 108,
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

	it("放大与缩小以当前范围的中点为中心，贴到整个运行的边缘时平移回来", () => {
		const extent = { start: s(0), end: s(100) };
		expect(zoomStep({ start: s(20), end: s(60) }, 0.5, extent)).toEqual({
			start: s(30),
			end: s(50),
		});
		expect(zoomStep({ start: s(20), end: s(60) }, 2, extent)).toEqual({ start: s(0), end: s(80) });
		expect(zoomStep({ start: s(70), end: s(100) }, 2, extent)).toEqual({
			start: s(40),
			end: s(100),
		});
		expect(zoomStep({ start: s(40), end: s(40.5) }, 0.5, extent)).toEqual({
			start: s(39.75),
			end: s(40.75),
		});
	});

	it("缩小到覆盖整个运行时清除缩放（null）", () => {
		const extent = { start: s(0), end: s(100) };
		expect(zoomStep({ start: s(20), end: s(80) }, 2, extent)).toBeNull();
	});

	it("缩放到一个节点：取它所有区段的起止，两端各留 5%", () => {
		const extent = { start: s(0), end: s(1000) };
		const segments = [
			{ kind: "queue", start: s(100), end: s(110), live: false, attempt: 1, taskId: "a" },
			{ kind: "fail", start: s(110), end: s(190), live: false, attempt: 1, taskId: "a" },
			{ kind: "run", start: s(200), end: s(300), live: true, attempt: 2, taskId: "b" },
		] as const;
		expect(zoomToSegments(segments, extent)).toEqual({ start: s(90), end: s(310) });
		expect(zoomToSegments([], extent)).toBeNull();
		expect(zoomToSegments(segments, { start: s(100), end: s(300) })).toBeNull();
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

	it("不足 1 秒的运行用 0.1 / 0.2 / 0.5 秒的步长，标注带小数秒", () => {
		const range = { start: s(100), end: s(100) + 471 };
		expect(ticks(range, { origin: s(100) }).map((t) => t.label)).toEqual([
			"+0s",
			"+0.1s",
			"+0.2s",
			"+0.3s",
			"+0.4s",
		]);
		const short = { start: s(100), end: s(100) + 2700 };
		expect(ticks(short, { origin: s(100) }).map((t) => t.label)).toEqual([
			"+0s",
			"+0.5s",
			"+1s",
			"+1.5s",
			"+2s",
			"+2.5s",
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

describe("时间线要保证看得见的行", () => {
	const node = (node_id: string, status: NodeRunView["status"]) =>
		({ node_id, status }) as NodeRunView;
	const chain = (id: string, nodes: NodeRunView[]) => ({ id, nodes }) as ChainRunView;
	const main = chain("main", [node("a", "success"), node("b", "running"), node("c", "pending")]);
	const sub = chain("sub", [node("x", "failed")]);

	it("是按链的顺序第一个正在执行或失败的节点", () => {
		expect(attentionRow([main, sub], () => true)).toEqual({ chainId: "main", nodeId: "b" });
		expect(attentionRow([chain("done", [node("a", "success")]), sub], () => true)).toEqual({
			chainId: "sub",
			nodeId: "x",
		});
	});

	it("所在的链收起（汇总模式）时是链的汇总行", () => {
		expect(attentionRow([main, sub], () => false)).toEqual({ chainId: "main", nodeId: null });
	});

	it("等待、排队、待执行、成功的节点不算；没有时为 null", () => {
		const quiet = chain("q", [node("a", "waiting"), node("b", "queued"), node("c", "pending")]);
		expect(attentionRow([quiet], () => true)).toBeNull();
	});

	it("主体的内容高度是刻度行加每条链一行，展开的链再加每个节点一行，最后留 8px 空白", () => {
		expect(timelineContentHeight([main, sub], () => true)).toBe(22 + 30 + 3 * 26 + 30 + 26 + 8);
		expect(timelineContentHeight([main, sub], () => false)).toBe(22 + 30 + 30 + 8);
		expect(timelineContentHeight([], () => true)).toBe(22 + 8);
	});
});
