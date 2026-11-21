import { describe, expect, it } from "vitest";
import {
	foldLabel,
	foldStations,
	type LineChain,
	type LineNode,
	layoutLines,
	type Station,
} from "./run-lines";

const chain = (statuses: string[], prefix = "n"): LineNode[] =>
	statuses.map((status, i) => ({ node_id: `${prefix}${i + 1}`, status }));

/** 折叠结果写成一行字：节点写 ID，折起来的一段写界面上的文字（「已完成 N」「还有 N」，去掉「个」）。 */
const shape = (stations: Station[]) =>
	stations.map((s) => (s.kind === "node" ? s.node.node_id : foldLabel(s).replace(/ 个$/, "")));

const repeat = (status: string, n: number) => Array.from({ length: n }, () => status);

describe("长链折叠", () => {
	it("不超过 7 个节点时每个节点一站", () => {
		const nodes = chain([...repeat("success", 3), "running", ...repeat("pending", 3)]);
		expect(shape(foldStations(nodes))).toEqual(["n1", "n2", "n3", "n4", "n5", "n6", "n7"]);
	});

	it("30 个节点：画已完成的最后一站、执行中的站和之后两站，其余折成「已完成」「还有」", () => {
		const nodes = chain([...repeat("success", 14), "running", ...repeat("pending", 15)]);
		expect(shape(foldStations(nodes))).toEqual([
			"已完成 13",
			"n14",
			"n15",
			"n16",
			"n17",
			"还有 13",
		]);
	});

	it("当前站是进行中的节点（排队、准备、等待也算），没有时是第一个待执行的节点", () => {
		for (const status of ["queued", "dispatched", "waiting"]) {
			const nodes = chain([...repeat("success", 10), status, ...repeat("pending", 9)]);
			expect(shape(foldStations(nodes))).toEqual([
				"已完成 9",
				"n10",
				"n11",
				"n12",
				"n13",
				"还有 7",
			]);
		}
		const between = chain([...repeat("success", 10), ...repeat("pending", 10)]);
		expect(shape(foldStations(between))).toEqual([
			"已完成 9",
			"n10",
			"n11",
			"n12",
			"n13",
			"还有 7",
		]);
	});

	it("链头、链尾附近不折出空的一段；只折一个节点时直接画出它", () => {
		const start = chain(["running", ...repeat("pending", 9)]);
		expect(shape(foldStations(start))).toEqual(["n1", "n2", "n3", "还有 7"]);
		const nearEnd = chain([...repeat("success", 8), "running", "pending"]);
		expect(shape(foldStations(nearEnd))).toEqual(["已完成 7", "n8", "n9", "n10"]);
		const one = chain(["success", "success", "running", ...repeat("pending", 6)]);
		expect(shape(foldStations(one))).toEqual(["n1", "n2", "n3", "n4", "n5", "还有 4"]);
	});

	it("折起来的一段画成它最后一个节点的状态", () => {
		const nodes = chain([
			...repeat("success", 3),
			"failed",
			...repeat("skipped", 10),
			"running",
			...repeat("pending", 5),
		]);
		const folds = foldStations(nodes).flatMap((s) => (s.kind === "fold" ? [s.status] : []));
		expect(folds).toEqual(["success", "skipped", "pending"]);
	});

	it("都结束了的链只画最后一站", () => {
		const nodes = chain(repeat("success", 12));
		expect(shape(foldStations(nodes))).toEqual(["已完成 11", "n12"]);
	});

	it("失败的节点不折进「已完成」，总是画出来；被跳过的节点单独折成「已跳过 N 个」，不算进「已完成」", () => {
		const nodes = chain([
			...repeat("success", 3),
			"failed",
			...repeat("skipped", 10),
			"running",
			...repeat("pending", 5),
		]);
		expect(shape(foldStations(nodes))).toEqual([
			"已完成 3",
			"n4",
			"已跳过 9",
			"n14",
			"n15",
			"n16",
			"n17",
			"还有 3",
		]);
	});

	it("失败的运行：前面成功的、失败的、被跳过的各是一段，清理节点（always）成功后接在后面", () => {
		const nodes = chain([...repeat("success", 6), "failed", ...repeat("skipped", 6), "success"]);
		expect(shape(foldStations(nodes))).toEqual(["已完成 6", "n7", "已跳过 6", "n14"]);
		const station = foldStations(nodes)[2] as Extract<Station, { kind: "fold" }>;
		expect(foldLabel(station)).toBe("已跳过 6 个");
	});

	it("取消的运行：已取消的节点不算进「已完成」，单独折成「已取消 N 个」", () => {
		const nodes = chain([...repeat("success", 5), ...repeat("cancelled", 5)]);
		expect(shape(foldStations(nodes))).toEqual(["已完成 5", "已取消 4", "n10"]);
		const mixed = chain([...repeat("success", 3), "cancelled", ...repeat("success", 4)]);
		expect(shape(foldStations(mixed))).toEqual(["已完成 3", "n4", "已完成 3", "n8"]);
	});
});

const line = (
	id: string,
	nodes: LineNode[],
	parent: { chain: string; node: string } | null = null,
): LineChain => ({
	id,
	label: id,
	parent_chain_instance_id: parent?.chain ?? null,
	async_node_id: parent?.node ?? null,
	nodes,
});

describe("线路的排布", () => {
	it("子流程从触发它的异步任务节点那一列开始，排在父链之后；同一条链分出的，列靠右的在前", () => {
		const main = line("main", chain(["success", "success", "success", "running", "pending"], "m"));
		const early = line("early", chain(["success", "running"], "e"), { chain: "main", node: "m2" });
		const late = line("late", chain(["running"], "l"), { chain: "main", node: "m3" });
		const nested = line("nested", chain(["running"], "x"), { chain: "early", node: "e2" });
		const { rows, columns } = layoutLines([main, early, late, nested]);
		expect(rows.map((r) => [r.chain.id, r.column, r.parent])).toEqual([
			["main", 0, null],
			["late", 2, 0],
			["early", 1, 0],
			["nested", 2, 2],
		]);
		expect(columns).toBe(5);
	});

	it("触发子流程的节点被折起来时，子流程从那一段的列开始", () => {
		const main = line(
			"main",
			chain([...repeat("success", 10), "running", ...repeat("pending", 9)], "m"),
		);
		const sub = line("sub", chain(["success", "running"], "s"), { chain: "main", node: "m2" });
		const { rows } = layoutLines([main, sub]);
		expect(rows.map((r) => [r.chain.id, r.column])).toEqual([
			["main", 0],
			["sub", 0],
		]);
	});

	it("父链不在数据里的子流程当作单独一条线，从第一列开始", () => {
		const orphan = line("orphan", chain(["running"]), { chain: "gone", node: "x" });
		const { rows } = layoutLines([line("main", chain(["running"])), orphan]);
		expect(rows.map((r) => [r.chain.id, r.column, r.parent])).toEqual([
			["main", 0, null],
			["orphan", 0, null],
		]);
	});
});
