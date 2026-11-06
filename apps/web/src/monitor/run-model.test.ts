import type { RunView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { latestRunView } from "./run-model";

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
