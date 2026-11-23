// 控制台运行块里排队中的节点在等什么（#601）：`GET /dashboard` 的 `running_runs[].active_nodes[]` 里排队中的节点带 `queue_wait`
// 和 `queued_at`，和运行视图里排队中的尝试是同一份判断（#457，`agents/queue-wait.ts`）；其余节点两个字段都是 null。
import { type DashboardView, dashboardApi } from "@sfly/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withQueueWaits } from "../src/dashboard/queued-waits.js";
import { ApiClient } from "./support/api-client.js";
import { eventually } from "./support/eventually.js";
import { FakeAgent, type HelloInit } from "./support/fake-agent.js";
import { ManualClock } from "./support/manual-clock.js";
import { publishPackage } from "./support/package-archive.js";
import { seedForeignTask } from "./support/seed-foreign-task.js";
import { startTestControlPlane, type TestControlPlane } from "./support/test-control-plane.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** entry → a（指定 Agent、排队超时 5 分钟）。 */
const scenario = (agent: string) => ({
	default_agent: agent,
	nodes: [
		{ id: "entry", kind: "entry" },
		{
			id: "a",
			kind: "package",
			package: "stub",
			node: "echo",
			queue_timeout: 300,
			display_name: "准备环境",
		},
	],
	edges: [{ from: "entry", to: "a", kind: "chain" }],
	packages: { stub: "1.0.0" },
});

describe("控制台运行块里排队中的节点在等什么", () => {
	let clock: ManualClock;
	let cp: TestControlPlane;
	let api: ApiClient;
	const agents: FakeAgent[] = [];

	beforeEach(async () => {
		clock = new ManualClock();
		cp = await startTestControlPlane({ clock });
		api = new ApiClient(cp);
		await publishPackage(cp, "stub", "1.0.0", { echo: [] });
	});
	afterEach(async () => {
		await Promise.all(agents.splice(0).map((a) => a.disconnect()));
		await cp.close();
	});

	const connect = async (hello: HelloInit) => {
		const agent = await FakeAgent.connect(cp.grpcUrl, hello);
		agents.push(agent);
		return agent;
	};
	const dashboard = async (): Promise<DashboardView> => {
		const res = await cp.fetch("/dashboard");
		expect(res.status).toBe(200);
		return dashboardApi.get.response.parse(await res.json());
	};
	/** 某次运行在控制台上进行中的节点 a。 */
	const activeNode = async (runId: string) =>
		(await dashboard()).running_runs
			.find((r) => r.id === runId)
			?.active_nodes.find((n) => n.node_id === "a");

	it("Agent 不在线：和运行视图里同一份说明，另带这次尝试进入排队的时间", async () => {
		const gone = await connect({ name: "agent-a" });
		clock.advance(30 * SECOND);
		const lastSeen = clock.now().toISOString();
		await gone.disconnect();
		agents.splice(agents.indexOf(gone), 1);
		await eventually(async () => {
			const list = (await (await cp.fetch("/agents")).json()) as {
				agents: Array<{ name: string; status: string }>;
			};
			expect(list.agents.find((a) => a.name === "agent-a")?.status).toBe("offline");
		});
		clock.advance(2 * MINUTE);
		const queuedAt = clock.now();
		const runId = await api.triggerOk(await api.orchestrationWith(scenario("agent-a")));
		clock.advance(5 * SECOND);

		const node = await activeNode(runId);
		expect(node).toMatchObject({ node_id: "a", status: "queued", agent: "agent-a" });
		expect(node?.queued_at).toBe(queuedAt.toISOString());
		expect(node?.queue_wait).toEqual({
			agent: "agent-a",
			now: clock.now().toISOString(),
			state: "offline",
			since: lastSeen,
			expires_at: new Date(queuedAt.getTime() + 5 * MINUTE).toISOString(),
			slots: null,
			holders: [],
			other_project_holders: 0,
		});
		// 和运行视图里这次尝试的 queue_wait 是同一份。
		const attempt = (await api.node(runId, "a")).attempts.at(-1);
		expect(node?.queue_wait).toEqual(attempt?.queue_wait);
	});

	it("槽位占满：写明占着槽位的任务；别的项目的任务只给个数；派发之后不再有 queue_wait", async () => {
		const agent = await connect({ name: "agent-a", slots: 2 });
		const id = await api.orchestrationWith(scenario("agent-a"));
		const holderRun = await api.triggerOk(id);
		const holding = await agent.nextAssign();
		const foreign = await seedForeignTask(cp, {
			project: "jia",
			agent: "agent-a",
			scenarioName: "甲的秘密场景",
		});
		clock.advance(10 * SECOND);
		const waitingRun = await api.triggerOk(id);

		const node = await activeNode(waitingRun);
		expect(node?.status).toBe("queued");
		expect(node?.queue_wait).toMatchObject({
			agent: "agent-a",
			state: "slots_full",
			slots: 2,
			other_project_holders: 1,
		});
		expect(node?.queue_wait?.holders.map((h) => h.run_id)).toEqual([holderRun]);
		// 别的项目的场景名、运行编号一个字都不在响应里。
		const body = JSON.stringify(await (await cp.fetch("/dashboard")).json());
		expect(body).not.toContain("甲的秘密场景");
		expect(body).not.toContain(foreign.run);
		// 执行中的节点没有这两个字段的值。
		const holder = await activeNode(holderRun);
		expect(holder).toMatchObject({ status: "running", queue_wait: null, queued_at: null });

		// 槽位释放，排队的任务派发出去：它不再排队，两个字段都是 null。
		await agent.succeed(holding);
		await agent.nextAssign();
		await eventually(async () => {
			const after = await activeNode(waitingRun);
			expect(after?.status).toBe("running");
			expect(after?.queue_wait).toBeNull();
			expect(after?.queued_at).toBeNull();
		});
	});
});

describe("没有排队中的节点时不多查", () => {
	it("withQueueWaits：没有排队中的节点时一条查询都不发，active_nodes 的两个字段是 null", async () => {
		const db = new Proxy(
			{},
			{
				get() {
					throw new Error("没有排队中的节点时不应该查数据库");
				},
			},
		);
		const hub = {
			connection: () => undefined,
			preparingSince: () => undefined,
			versionMismatch: () => false,
			now: () => new Date(),
		};
		const node = {
			chain_instance_id: "c1",
			node_id: "a",
			status: "running",
			attempt: 1,
			agent: "agent-a",
			started_at: new Date().toISOString(),
			progress: null,
		};
		const read = {
			run: { id: "r1" },
			chains: [
				{
					id: "c1",
					nodes: [
						{
							node_id: "a",
							status: "running",
							attempts: [{ status: "running", agent: "agent-a" }],
						},
					],
				},
			],
			activeNodes: [node],
		};
		// biome-ignore lint/suspicious/noExplicitAny: 只给 withQueueWaits 用到的字段
		const result = await withQueueWaits(db as any, hub, "default" as any, [read as any]);
		expect(result.get("r1")).toEqual([{ ...node, queue_wait: null, queued_at: null }]);
	});
});
