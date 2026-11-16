import { describe, expect, it } from "vitest";
import { failuresInOrder } from "../src/index.js";

type Node = { id: string; status: string; at: number | null };
const node = (id: string, status: string, at: number | null = null): Node => ({ id, status, at });
const order = (chains: Array<{ id: string; nodes: Node[] }>) =>
	failuresInOrder(chains, (n) => n.at).map(({ chain, node }) => `${chain.id}/${node.id}`);

describe("第一个失败的节点", () => {
	it("按最后一次尝试结束的先后：子流程里先失败的排在主链后失败的前面，成功的不算", () => {
		expect(
			order([
				{ id: "main", nodes: [node("fetch", "success", 1), node("verify", "failed", 9)] },
				{ id: "sub", nodes: [node("probe", "failed", 5)] },
			]),
		).toEqual(["sub/probe", "main/verify"]);
	});

	it("同一时刻结束的按链实例的顺序、再按节点在链上的顺序；没有结束时间的排在最后", () => {
		expect(
			order([
				{ id: "main", nodes: [node("a", "failed", 3), node("b", "failed", null)] },
				{ id: "sub", nodes: [node("c", "failed", 3), node("d", "failed", 3)] },
			]),
		).toEqual(["main/a", "sub/c", "sub/d", "main/b"]);
	});

	it("没有失败的节点时为空", () => {
		expect(order([{ id: "main", nodes: [node("a", "success", 1)] }])).toEqual([]);
	});
});
