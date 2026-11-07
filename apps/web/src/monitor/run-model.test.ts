import type { AttemptView, RunView, TaskProgressView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { applyProgress, latestRunView } from "./run-model";

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

describe("运行视图与进度推送的合并（#110）", () => {
	const TASK = "00000000-0000-4000-8000-0000000000a1";
	const progress = (current: number, time: string): TaskProgressView => ({
		current,
		total: 100,
		message: `第 ${current} 步`,
		time,
	});
	const withPing = (attemptProgress: AttemptView["progress"]): RunView => ({
		...view("running"),
		chains: [
			{
				id: "chain-main",
				chain_id: "entry",
				parent_chain_instance_id: null,
				async_node_id: null,
				depth: 0,
				status: "running",
				params: {},
				started_at: "2026-01-01T00:00:00.000Z",
				ended_at: null,
				nodes: [
					{
						node_id: "ping",
						kind: "package",
						status: "running",
						agent: "agent-a",
						outputs: null,
						error: null,
						attempts: [
							{
								task_id: TASK,
								attempt: 1,
								status: "running",
								agent: "agent-a",
								inputs: {},
								outputs: null,
								error: null,
								queued_at: "2026-01-01T00:00:00.000Z",
								started_at: "2026-01-01T00:00:00.000Z",
								ended_at: null,
								wake_at: null,
								progress: attemptProgress,
							},
						],
					},
				],
			},
		],
	});
	const pingProgress = (run: RunView) => run.chains[0]?.nodes[0]?.attempts[0]?.progress;
	const event = (p: TaskProgressView) => ({
		run_id: view("running").id,
		chain_instance_id: "chain-main",
		node_id: "ping",
		task_id: TASK,
		progress: p,
	});

	it("进度推送之前查询、之后才到达的运行视图不把进度改回旧值", () => {
		const pushed = progress(40, "2026-01-01T00:00:02.000Z");
		const cached = applyProgress(withPing(null), event(pushed));
		expect(pingProgress(latestRunView(cached, withPing(null)))).toEqual(pushed);
		const older = withPing(progress(10, "2026-01-01T00:00:01.000Z"));
		expect(pingProgress(latestRunView(cached, older))).toEqual(pushed);
	});

	it("运行视图里的进度更新时用它", () => {
		const cached = withPing(progress(40, "2026-01-01T00:00:02.000Z"));
		const newer = withPing(progress(60, "2026-01-01T00:00:03.000Z"));
		expect(latestRunView(cached, newer)).toBe(newer);
	});
});
