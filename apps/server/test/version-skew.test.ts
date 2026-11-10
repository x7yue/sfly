// 切入点 A：Agent 与控制面版本不一致（ADR 0014 前半部分）。控制面照常接受连接、续约和接收结果，
// 但不给它派新任务；Welcome 告诉 Agent 目标版本和对应架构的二进制；Heartbeat 上报的更新状态出现在 Agents 接口。
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentUpdateState } from "@sfly/proto";
import { type AgentView, agentsApi } from "@sfly/schema";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const SECOND = 1000;
/** 控制面默认的任务租约。 */
const LEASE = 30 * SECOND;

const orchestration = {
	default_agent: "agent-a",
	nodes: [
		{ id: "entry", kind: "entry" },
		{ id: "a", kind: "package", package: "stub", node: "echo" },
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
};

async function listAgents(cp: TestControlPlane) {
	const res = await cp.fetch("/agents");
	expect(res.status).toBe(200);
	return agentsApi.list.response.parse(await res.json());
}

async function agentView(cp: TestControlPlane, name: string): Promise<AgentView | undefined> {
	return (await listAgents(cp)).agents.find((a) => a.name === name);
}

describe("版本不一致", () => {
	let cp: TestControlPlane | undefined;
	let dir: string | undefined;
	const agents: FakeAgent[] = [];

	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp?.close();
		cp = undefined;
		if (dir) await rm(dir, { recursive: true, force: true });
		dir = undefined;
	});

	const connect = async (hello: Parameters<typeof FakeAgent.connect>[1]) => {
		if (!cp) throw new Error("no control plane");
		const agent = await FakeAgent.connect(cp.grpcUrl, hello);
		agents.push(agent);
		return agent;
	};

	it("Welcome 给出目标版本（控制面版本）和 Agent 架构对应的二进制下载地址与 sha256", async () => {
		dir = await mkdtemp(join(tmpdir(), "sfly-skew-"));
		await writeFile(join(dir, "x86"), "x86_64 的 Agent 二进制");
		await writeFile(join(dir, "arm"), "aarch64 的 Agent 二进制");
		cp = await startTestControlPlane({
			version: "2.0.0",
			agentBinaries: { x86_64: join(dir, "x86"), aarch64: join(dir, "arm") },
		});
		const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

		const arm = await connect({ name: "agent-arm", agentVersion: "1.0.0", arch: "aarch64" });
		expect(arm.welcome).toMatchObject({
			targetAgentVersion: "2.0.0",
			agentBinaryUrl: `${cp.httpUrl}/agent/binaries/2.0.0/aarch64`,
			agentBinarySha256: sha256("aarch64 的 Agent 二进制"),
		});
		// 控制面没有这个架构的二进制：只给目标版本。
		const riscv = await connect({ name: "agent-riscv", agentVersion: "1.0.0", arch: "riscv64" });
		expect(riscv.welcome).toMatchObject({
			targetAgentVersion: "2.0.0",
			agentBinaryUrl: "",
			agentBinarySha256: "",
		});
	});

	it("版本不一致的 Agent 能连接，手上任务的续约和结果正常，新任务不派给它；版本一致后恢复派发", async () => {
		const clock = new ManualClock();
		cp = await startTestControlPlane({ clock, version: "2.0.0" });
		const api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: [] });
		const id = await api.orchestrationWith(orchestration);

		const current = await connect({ name: "agent-a", agentVersion: "2.0.0" });
		const first = await api.triggerOk(id);
		const held = await current.nextAssign();

		// 控制面升级后，旧版本 Agent 带着手上的任务重新连上：任务继续，连接照常接受。
		await current.disconnect();
		const old = await connect({
			name: "agent-a",
			agentVersion: "1.0.0",
			runningTasks: [{ taskId: held.taskId, attempt: held.attempt, started: true }],
		});
		expect(old.dispositions).toEqual({ [held.taskId]: "continue" });
		const view = await agentView(cp, "agent-a");
		expect(view).toMatchObject({ status: "online", version_mismatch: true });

		// 新任务排队，不派给它。
		const second = await api.triggerOk(id);
		await old.expectNoAssign();

		// 心跳照常续约：超过一个租约，手上的任务也不会以 agent_lost 失败。
		clock.advance(LEASE - SECOND);
		await old.heartbeat([held]);
		clock.advance(LEASE - SECOND);
		await old.heartbeat([held]);
		expect((await api.node(first, "a")).status).toBe("running");

		// 结果照常接收。
		await old.succeed(held, {});
		expect((await api.run(first)).status).toBe("success");
		await old.expectNoAssign();
		expect((await api.node(second, "a")).status).toBe("queued");

		// 升级到控制面的版本后重新连上：恢复派发。
		await old.disconnect();
		const upgraded = await connect({ name: "agent-a", agentVersion: "2.0.0" });
		const next = await upgraded.nextAssign();
		expect(next.runId).toBe(second);
		expect(await agentView(cp, "agent-a")).toMatchObject({ version_mismatch: false });
	});

	it("Heartbeat 上报的更新状态出现在 Agents 接口，Agents 接口同时给出控制面版本", async () => {
		cp = await startTestControlPlane({ version: "2.0.0" });
		const agent = await connect({ name: "agent-a", agentVersion: "1.0.0" });

		// 还没上报过更新状态。
		const listed = await listAgents(cp);
		expect(listed.control_plane_version).toBe("2.0.0");
		expect(listed.agents[0]).toMatchObject({
			info: { agent_version: "1.0.0" },
			version_mismatch: true,
			update: { state: "none", remaining_tasks: 0, reason: "" },
		});

		const report = async (update: {
			state: AgentUpdateState;
			remainingTasks?: number;
			reason?: string;
		}) => {
			agent.send({ case: "heartbeat", value: { runningTasks: [], update } });
			await agent.sync();
			return (await agentView(cp as TestControlPlane, "agent-a"))?.update;
		};
		expect(await report({ state: AgentUpdateState.DOWNLOADING })).toEqual({
			state: "downloading",
			remaining_tasks: 0,
			reason: "",
		});
		expect(await report({ state: AgentUpdateState.WAITING_FOR_TASKS, remainingTasks: 2 })).toEqual({
			state: "waiting_for_tasks",
			remaining_tasks: 2,
			reason: "",
		});
		expect(await report({ state: AgentUpdateState.REPLACING })).toMatchObject({
			state: "replacing",
		});
		expect(await report({ state: AgentUpdateState.FAILED, reason: "sha256 不匹配" })).toEqual({
			state: "failed",
			remaining_tasks: 0,
			reason: "sha256 不匹配",
		});
		expect(
			await report({
				state: AgentUpdateState.MANUAL_UPGRADE_REQUIRED,
				reason: "已指定 --no-auto-update",
			}),
		).toEqual({
			state: "manual_upgrade_required",
			remaining_tasks: 0,
			reason: "已指定 --no-auto-update",
		});

		// 不带更新状态的心跳（旧版本 Agent）不改变已保存的状态。
		await agent.heartbeat([]);
		expect((await agentView(cp, "agent-a"))?.update.state).toBe("manual_upgrade_required");

		// 重新连接时清空，等新连接上报。
		await agent.disconnect();
		await connect({ name: "agent-a", agentVersion: "1.0.0" });
		await eventually(async () =>
			expect((await agentView(cp as TestControlPlane, "agent-a"))?.update.state).toBe("none"),
		);
	});
});
