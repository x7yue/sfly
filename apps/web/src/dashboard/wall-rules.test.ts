import type { AgentView, RunningTaskView } from "@sfly/schema";
import { describe, expect, it } from "vitest";
import { agentColumn, wallLayout } from "./wall-rules";

describe("运行个数", () => {
	it("1、2 个运行：运行块，进行中的节点全列", () => {
		expect(wallLayout(1)).toEqual({ compact: false, activeLimit: null });
		expect(wallLayout(2)).toEqual({ compact: false, activeLimit: null });
	});

	it("3 到 5 个运行：运行块，进行中的节点只列前 2 个", () => {
		for (const runs of [3, 4, 5])
			expect(wallLayout(runs)).toEqual({ compact: false, activeLimit: 2 });
	});

	it("6 个以上运行：一行一个的紧凑行，点开的运行块同样只列前 2 个", () => {
		for (const runs of [6, 12]) expect(wallLayout(runs)).toEqual({ compact: true, activeLimit: 2 });
	});
});

const task = (id: string): RunningTaskView => ({
	task_id: id,
	run_id: "r",
	orchestration_id: "o",
	orchestration_name: "巡检",
	node_id: "ping",
	node_type: "demo-checks/ping",
	chain_instance_id: "c",
	chain_name: null,
	attempt: 1,
	status: "running",
	started_at: "2026-01-01T00:00:00.000Z",
	current_action: null,
});

function agent(name: string, overrides: Partial<AgentView> = {}): AgentView {
	return {
		name,
		status: "online",
		info: { agent_version: "0.1.0", os: "linux", arch: "x86_64", slots: 4, installed_packages: [] },
		last_seen_at: "2026-01-01T00:00:00.000Z",
		preparing_since: null,
		installed_packages: [],
		install: null,
		dev_packages: [],
		running_tasks: [],
		queued_tasks: [],
		version_mismatch: false,
		update: { state: "none", remaining_tasks: 0, reason: "" },
		clock_offset: null,
		referencing_orchestrations: 0,
		capabilities: [],
		endpoint: {
			address: "10.0.0.1",
			address_source: "connection",
			port: 50052,
			unavailable_reason: null,
		},
		...overrides,
	};
}

const names = (agents: AgentView[]) => agents.map((a) => a.name);

describe("Agent 合并", () => {
	it("不超过 5 台时全列，空闲的也列出来", () => {
		const agents = ["a", "b", "c", "d", "e"].map((n) => agent(n));
		expect(agentColumn(agents)).toEqual({ listed: agents, idle: 0 });
	});

	it("更多时只列忙碌、离线、更新中的，其余在线空闲的合并成一个数", () => {
		const { listed, idle } = agentColumn([
			agent("busy", { running_tasks: [task("t1")] }),
			agent("idle-1"),
			agent("offline", { status: "offline" }),
			agent("idle-2"),
			agent("updating", {
				version_mismatch: true,
				update: { state: "downloading", remaining_tasks: 0, reason: "" },
			}),
			agent("waiting", {
				queued_tasks: [
					{ ...task("t2"), queued_at: "2026-01-01T00:00:00.000Z", queue_expires_at: null },
				],
			}),
			agent("idle-3"),
		]);
		expect(names(listed)).toEqual(["busy", "offline", "updating", "waiting"]);
		expect(idle).toBe(3);
	});

	it("安装节点包中、版本不一致的 Agent 也单独列出", () => {
		const { listed, idle } = agentColumn([
			agent("installing", {
				install: { package: "demo", version: "1.0.0", state: "installing", task_id: "t" },
			}),
			agent("mismatch", { version_mismatch: true }),
			...["a", "b", "c", "d"].map((n) => agent(n)),
		]);
		expect(names(listed)).toEqual(["installing", "mismatch"]);
		expect(idle).toBe(4);
	});
});
