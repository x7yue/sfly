import { describe, expect, it } from "vitest";
import { layoutThumbnail, THUMB_WIDTH } from "./thumbnail";

type Kind = "entry" | "subflow_entry" | "async" | "timer" | "sleep" | "package";

/** 由若干条链组成的结构：每条链按顺序列出节点 ID，第一条是主链（以 entry 开头）。 */
function structure(
	chains: [string, Kind][][],
	dispatch: [string, string][] = [],
): Parameters<typeof layoutThumbnail>[0] {
	return {
		nodes: chains.flat().map(([id, kind]) => ({ id, kind })),
		edges: [
			...chains.flatMap((c) =>
				c.slice(1).map(([to], i) => ({ from: c[i]?.[0] as string, to, kind: "chain" as const })),
			),
			...dispatch.map(([from, to]) => ({ from, to, kind: "dispatch" as const })),
		],
	};
}

const pkg = (id: string): [string, Kind] => [id, "package"];

describe("场景缩略图布局", () => {
	it("主链按连线顺序排成一行并水平居中，相邻节点之间画连线", () => {
		// 文档里的节点顺序与链上的顺序不同。
		const s = structure([[["entry", "entry"], pkg("a"), pkg("b")]]);
		s.nodes.reverse();
		const t = layoutThumbnail(s, null);
		expect(t.nodes.map((n) => n.id)).toEqual(["entry", "a", "b"]);
		const ys = new Set(t.nodes.map((n) => n.y));
		expect(ys.size).toBe(1);
		const [first, , last] = t.nodes;
		expect(first?.x).toBeGreaterThan(0);
		expect(THUMB_WIDTH - ((last?.x ?? 0) + (last?.w ?? 0))).toBeCloseTo(first?.x ?? 0);
		expect(t.links).toHaveLength(2);
		expect(t.regions).toEqual([]);
	});

	it("主链超过一行时蛇形换行：第二行从右往左排", () => {
		const nodes = Array.from({ length: 7 }, (_, i) => pkg(`n${i}`));
		const t = layoutThumbnail(structure([[["entry", "entry"], ...nodes]]), null);
		const row1 = t.nodes.slice(0, 5);
		const row2 = t.nodes.slice(5);
		expect(new Set(row1.map((n) => n.y)).size).toBe(1);
		expect(row2[0]?.y).toBeGreaterThan(row1[0]?.y ?? 0);
		// 换行处上下对齐，第二行往左走。
		expect(row2[0]?.x).toBe(row1[4]?.x);
		expect(row2[1]?.x).toBeLessThan(row2[0]?.x ?? 0);
		expect(t.links).toHaveLength(7);
	});

	it("子流程画在主链下方的区域里，调度连线从异步任务节点连过去", () => {
		const t = layoutThumbnail(
			structure(
				[
					[["entry", "entry"], ["fan", "async"], pkg("main")],
					[["sub", "subflow_entry"], pkg("s1")],
				],
				[["fan", "sub"]],
			),
			null,
		);
		expect(t.regions).toHaveLength(1);
		const region = t.regions[0];
		const sub = t.nodes.filter((n) => n.id === "sub" || n.id === "s1");
		const mainY = t.nodes.find((n) => n.id === "entry")?.y ?? 0;
		for (const n of sub) {
			expect(n.y).toBeGreaterThan(mainY);
			expect(n.x).toBeGreaterThanOrEqual(region?.x ?? 0);
			expect(n.x + n.w).toBeLessThanOrEqual((region?.x ?? 0) + (region?.w ?? 0));
		}
		expect(t.dispatches).toHaveLength(1);
		expect(t.height).toBeGreaterThan((region?.y ?? 0) + (region?.h ?? 0) - 1);
	});

	it("节点按最近一次运行着色；没有运行时都是待执行，运行里没有的节点也是待执行", () => {
		const s = structure([[["entry", "entry"], pkg("a"), pkg("b"), pkg("c"), pkg("d")]]);
		expect(new Set(layoutThumbnail(s, null).nodes.map((n) => n.state))).toEqual(
			new Set(["pending"]),
		);
		const t = layoutThumbnail(s, {
			entry: "success",
			a: "running",
			b: "failed",
			c: "cancelled",
			old: "success",
		});
		expect(Object.fromEntries(t.nodes.map((n) => [n.id, n.state]))).toEqual({
			entry: "ok",
			a: "running",
			b: "failed",
			c: "cancelled",
			d: "pending",
		});
	});

	it("每个节点状态的种类与状态徽标一致：准备中算执行中，排队是中性的排队（不是等待）", () => {
		const statuses = [
			"pending",
			"queued",
			"dispatched",
			"running",
			"waiting",
			"success",
			"failed",
			"skipped",
			"cancelled",
			"stopped",
		] as const;
		const s = structure([[["entry", "entry"], ...statuses.map(pkg)]]);
		const t = layoutThumbnail(s, Object.fromEntries(statuses.map((id) => [id, id])));
		expect(Object.fromEntries(t.nodes.map((n) => [n.id, n.state]))).toEqual({
			entry: "pending",
			pending: "pending",
			queued: "queued",
			dispatched: "running",
			running: "running",
			waiting: "warn",
			success: "ok",
			failed: "failed",
			skipped: "skipped",
			cancelled: "cancelled",
			stopped: "stopped",
		});
	});

	it("没有连到任何链上的节点不画", () => {
		const s = structure([[["entry", "entry"], pkg("a")]]);
		s.nodes.push({ id: "loose", kind: "package" });
		expect(layoutThumbnail(s, null).nodes.map((n) => n.id)).toEqual(["entry", "a"]);
	});
});
