import type { ChainRunView, NodeRunView, OrchestrationDocument, RunView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { chainLabel, documentNodes, latestRunView, nodeTitle } from "./run-model";

const view = (status: RunView["status"], cancelled = false): RunView => ({
	id: "00000000-0000-4000-8000-000000000001",
	orchestration_id: "00000000-0000-4000-8000-0000000000f1",
	orchestration_version: 1,
	status,
	triggered_by: "tester",
	params: {},
	started_at: "2026-01-01T00:00:00.000Z",
	ended_at: status === "running" ? null : "2026-01-01T00:00:05.000Z",
	cancel: cancelled
		? { requested_by: "tester", requested_at: "2026-01-01T00:00:03.000Z", forced_at: null }
		: null,
	chains: [],
});

describe("运行视图的合并（#47）", () => {
	it("已结束的视图不被运行中的视图覆盖：运行结束前生成、之后才到达的响应不改回运行中", () => {
		const ended = view("cancelled", true);
		expect(latestRunView(ended, view("running", true))).toBe(ended);
		const failed = view("failed");
		expect(latestRunView(failed, view("running"))).toBe(failed);
	});

	it("其余情况都用新到的视图", () => {
		const running = view("running", true);
		expect(latestRunView(undefined, running)).toBe(running);
		expect(latestRunView(view("running"), running)).toBe(running);
		const ended = view("cancelled", true);
		expect(latestRunView(view("running", true), ended)).toBe(ended);
		const success = view("success");
		expect(latestRunView(view("failed"), success)).toBe(success);
	});
});

describe("子流程名称（#80 故事 1、23）", () => {
	const chain = (over: Partial<ChainRunView>): ChainRunView => ({
		id: "6f1c2d3e-0000-4000-8000-000000000002",
		chain_id: "mon",
		name: "监控",
		parent_chain_instance_id: "6f1c2d3e-0000-4000-8000-000000000001",
		async_node_id: "spawn",
		depth: 1,
		status: "running",
		params: {},
		started_at: "2026-01-01T00:00:00.000Z",
		ended_at: null,
		nodes: [],
		...over,
	});

	it("链名显示子流程名称；名称为空时显示「未命名子流程」，主链显示「主链」", () => {
		expect(chainLabel(chain({}))).toBe("子流程 监控 · 6f1c2d3e");
		expect(chainLabel(chain({ name: "" }))).toBe("子流程 未命名子流程 · 6f1c2d3e");
		expect(chainLabel(chain({ depth: 0, name: null, chain_id: "entry" }))).toBe("主链");
	});

	it("停止子流程节点的说明文字是它要停止的子流程名称", () => {
		const doc: OrchestrationDocument = {
			nodes: [
				{ id: "entry", kind: "entry", params: [] },
				{ id: "stop", kind: "stop_subflow", always: false, subflow: "mon" },
				{ id: "unset", kind: "stop_subflow", always: false },
				{ id: "mon", kind: "subflow_entry", name: "监控", params: [] },
			],
			edges: [],
			packages: {},
		};
		const decls = documentNodes(doc);
		const node = (id: string): NodeRunView => ({
			node_id: id,
			kind: "stop_subflow",
			status: "waiting",
			agent: null,
			outputs: null,
			error: null,
			attempts: [],
		});
		expect(nodeTitle(node("stop"), decls.get("stop"), decls)).toBe("停止子流程「监控」");
		expect(nodeTitle(node("unset"), decls.get("unset"), decls)).toBe("停止子流程");
	});
});
